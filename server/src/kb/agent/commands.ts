/**
 * ct 命令：整理助手（Claude Code）只能用它动知识库的结构和交改动，系统在这里把关。
 * 读、写文字文档用 Claude Code 自带的工具；挪、删、新建/改名/删除知识库、把改动交给老师，都走这里。
 */
import { db } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { loadKb } from '../access.js';
import { createKb, deleteKb, findKb, renameKb, transferFiles } from '../bases.js';
import { checkMetadata, createChange, isTidy, KEEPER_AUTHOR } from '../changes.js';
import { validateOps } from '../repo.js';
import { documentName } from '../teacher-text.js';
import type { Desk } from './desk.js';
import { record, type RunRef } from './events.js';
import { fileOriginals } from './filing.js';

export const KEEPER_NAME = '整理助手';

export interface Turn extends RunRef {
  token: string;
  kind: 'chat' | 'materials';
  desk: Desk;
  /** 老师现在在看的知识库（在最外层为 null），这个不能删 */
  contextKbId: number | null;
  submitted: boolean;
  finish: { title: string; reason: string } | null;
  changes: { kbId: number; changeId: number; status: string; title: string }[];
  /** 交资料时：这批之后还有没有、这次交的原件（按内容指纹认，挪到别的库也认得）、各批的标题依据怎么汇总 */
  batch?: {
    intakeId: number;
    last: boolean;
    hashes: Set<string>;
    commitMeta?: (finish: { title: string; reason: string } | null) => { title: string; reason: string };
    requestKey?: string;
  };
}

export const USAGE = `ct 交 "改了什么" "依据"     把这次的改动交给老师：内容改动等老师确认，只挪位置的直接生效
ct 挪 <从> <到>              挪动或改名文件、文件夹，也能挪到别的知识库的文件夹里
ct 删 <路径>                 删掉文件或文件夹（老师能撤回）
ct 新建库 <名字>             新建一个知识库
ct 改名库 <现在的名字> <新名字>
ct 删库 <名字>               删掉一个已经清空的知识库
路径从工作目录算起，第一段是知识库的文件夹，比如「王建国的知识库/第6章/函数基础.md」。`;

type Result = { ok: boolean; text: string };
const ok = (text: string): Result => ({ ok: true, text });
const fail = (text: string): Result => ({ ok: false, text });

const ALIASES: Record<string, string> = {
  交: '交',
  提交: '交',
  submit: '交',
  commit: '交',
  挪: '挪',
  移动: '挪',
  mv: '挪',
  move: '挪',
  删: '删',
  删除: '删',
  rm: '删',
  新建库: '新建库',
  改名库: '改名库',
  删库: '删库',
  帮助: '帮助',
  help: '帮助',
};

export async function runCommand(t: Turn, argv: string[]): Promise<Result> {
  const [raw = '', ...args] = argv.map((a) => String(a ?? ''));
  const cmd = Object.hasOwn(ALIASES, raw) ? ALIASES[raw] : '';
  try {
    switch (cmd) {
      case '交':
        return await submit(t, args[0] || '', args.slice(1).join(' '));
      case '挪':
        if (args.length !== 2) return fail('用法：ct 挪 <从> <到>');
        return await move(t, args[0], args[1]);
      case '删':
        if (args.length !== 1) return fail('用法：ct 删 <路径>');
        return await remove(t, args[0]);
      case '新建库':
        return await newBase(t, args.join(' '));
      case '改名库':
        if (args.length !== 2) return fail('用法：ct 改名库 <现在的名字> <新名字>');
        return renameBase(t, args[0], args[1]);
      case '删库':
        return dropBase(t, args.join(' '));
      case '帮助':
        return ok(USAGE);
      default:
        return fail(`没有「${raw}」这个命令。\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof HttpError || err instanceof Error) {
      record(t, 'tool', { name: toolName(cmd), label: LABEL[toolName(cmd)] || '整理', error: err.message });
      return fail(err.message);
    }
    throw err;
  }
}

const LABEL: Record<string, string> = {
  finish: '提交改动',
  move_file: '移动',
  delete_file: '删除',
  create_knowledge_base: '新建知识库',
  rename_knowledge_base: '知识库改名',
  delete_knowledge_base: '删除知识库',
  move_to_knowledge_base: '挪到别的知识库',
};
const toolName = (cmd: string) =>
  ({ 交: 'finish', 挪: 'move_file', 删: 'delete_file', 新建库: 'create_knowledge_base', 改名库: 'rename_knowledge_base', 删库: 'delete_knowledge_base' })[cmd] ||
  'help';

/** 这次交的原件在这个库里的条目（按内容指纹认） */
function handedIn(kbId: number, hashes: Set<string>, ids: { id: string; sourceId?: string }[]) {
  const hashOf = new Map(
    db.all<{ id: string; original_hash: string }>('SELECT id, original_hash FROM kb_sources WHERE kb_id=?', kbId).map((s) => [s.id, s.original_hash]),
  );
  return new Set(ids.filter((e) => e.sourceId && hashes.has(hashOf.get(e.sourceId) || '')).map((e) => e.id));
}

async function submit(t: Turn, title: string, reason: string): Promise<Result> {
  if (t.submitted) return fail('这次已经交过了，有新的改动请在老师下一次说话时再做');
  title = title.trim();
  if (!title) return fail('请写清改了什么：ct 交 "改了什么" "依据"');
  const problems = await t.desk.sync();
  if (problems.length) return fail('还有问题，改好再交：\n' + problems.join('\n'));
  if (t.batch && !t.batch.last) {
    t.submitted = true;
    t.finish = { title, reason };
    record(t, 'tool', { name: 'finish', label: LABEL.finish, title });
    return ok('记下了。这次交的资料还没整理完，等全部整理完一起交给老师。');
  }
  if (t.batch)
    for (const [kbId, ws] of t.desk.spaces) {
      const ids = handedIn(kbId, t.batch.hashes, await ws.list());
      if (ids.size) await fileOriginals(ws, ids);
    }
  const touched = [...t.desk.spaces].filter(([, ws]) => ws.ops().length);
  if (!touched.length) {
    if (!t.desk.structural) return fail('没有实际改动，不用交，直接回答老师就行');
    t.submitted = true;
    t.finish = { title, reason };
    record(t, 'tool', { name: 'finish', label: LABEL.finish, title });
    return ok('完成');
  }
  const meta = t.batch?.commitMeta ? t.batch.commitMeta({ title, reason }) : { title, reason };
  // 先全部核对，有一处不过就都不交，免得交了一半
  for (const [kbId, ws] of touched) {
    validateOps(kbId, ws.ops());
    checkMetadata(kbId, meta.title, meta.reason, ws.ops());
  }
  record(t, 'tool', { name: 'finish', label: LABEL.finish, title: meta.title });
  const lines: string[] = [];
  for (const [kbId, ws] of touched) {
    const ops = ws.ops(),
      kb = loadKb(kbId);
    const tidy = isTidy(kbId, ops),
      automatic = kb.kind === 'class' || tidy;
    // 这次还直接新建、挪动过知识库，那些已经生效：改动的标题只写这份改动里的几页，免得老师以为点「不要」能把新建、挪动也撤掉
    const pages = [...new Set(ops.map((op) => documentName(op.path)))];
    const name =
      t.desk.structural || touched.length > 1
        ? `改了${pages
            .slice(0, 3)
            .map((p) => `「${p}」`)
            .join('、')}${pages.length > 3 ? ` 等 ${pages.length} 份` : ''}`
        : meta.title;
    try {
      const c = await createChange({
        kbId,
        title: name.slice(0, 120),
        reason: meta.reason,
        author: 'keeper',
        authorName: KEEPER_NAME,
        kind: tidy ? 'tidy' : 'keeper',
        ops,
        runId: t.runId,
        apply: automatic ? { by: null, as: KEEPER_AUTHOR } : undefined,
        requestKey: t.batch?.requestKey,
      });
      t.changes.push({ kbId, changeId: c.id, status: c.status, title: c.title });
      record(t, 'change', { changeId: c.id, kbId, kbName: kb.name, status: c.status, title: c.title, files: ops.length });
      lines.push(`「${kb.name}」：${c.title}（${c.status === 'applied' ? '已生效' : '等老师确认'}）`);
    } catch (err) {
      lines.push(`「${kb.name}」没交上：${(err as Error).message}`);
    }
  }
  t.submitted = true;
  t.finish = { title, reason };
  return ok('已交：\n' + lines.join('\n'));
}

async function move(t: Turn, fromRaw: string, toRaw: string): Promise<Result> {
  if (t.submitted) return fail('这次已经交过了');
  const a = t.desk.locate(fromRaw),
    b = t.desk.locate(toRaw);
  if (!a.path) return fail('不能挪整个知识库；要改知识库的名字用 ct 改名库');
  await t.desk.sync();
  const fa = t.desk.folderOf(a.kbId),
    fb = t.desk.folderOf(b.kbId);
  if (a.kbId === b.kbId) {
    if (!b.path) return fail('请写清挪到哪里');
    const moved = await t.desk.moveWithin(a.kbId, a.path, b.path);
    record(t, 'tool', { name: 'move_file', label: LABEL.move_file, from: `${fa}/${a.path}`, to: `${fb}/${b.path}`, count: moved.length });
    return ok(`已挪到「${fb}/${b.path}」${moved.length > 1 ? `（${moved.length} 份）` : ''}，交的时候一起生效`);
  }
  const from = t.desk.spaces.get(a.kbId)!;
  if (from.touched(a.path)) return fail(`「${fa}/${a.path}」这次改过还没交，不能挪到别的知识库；要放在那边就直接写在那边`);
  const r = await transferFiles(a.kbId, b.kbId, [a.path], { author: 'keeper', authorName: KEEPER_NAME, as: KEEPER_AUTHOR, by: null, runId: t.runId });
  t.desk.rebase(a.kbId, from.ops());
  t.desk.rebase(b.kbId, t.desk.spaces.get(b.kbId)!.ops());
  t.desk.moveAcross(a.kbId, b.kbId, r.moved);
  t.desk.structural = true;
  let note = '';
  if (b.path && b.path !== a.path) {
    await t.desk.moveWithin(b.kbId, a.path, b.path);
    note = '，位置等交的时候一起生效';
  }
  record(t, 'tool', {
    name: 'move_to_knowledge_base',
    label: LABEL.move_to_knowledge_base,
    from: loadKb(a.kbId).name,
    to: loadKb(b.kbId).name,
    count: r.moved.length,
    ...(r.moved.length === 1 ? { path: r.moved[0] } : {}),
    paths: r.moved.slice(0, 30),
  });
  return ok(`已挪到「${fb}」（${r.moved.length} 份，已生效${note}）`);
}

async function remove(t: Turn, raw: string): Promise<Result> {
  if (t.submitted) return fail('这次已经交过了');
  const a = t.desk.locate(raw);
  if (!a.path) return fail('不能这样删整个知识库；清空以后用 ct 删库');
  await t.desk.sync();
  const gone = await t.desk.removeIn(a.kbId, a.path, t.kind === 'materials');
  record(t, 'tool', { name: 'delete_file', label: LABEL.delete_file, path: `${t.desk.folderOf(a.kbId)}/${a.path}`, count: gone.length });
  return ok(`已删${gone.length > 1 ? ` ${gone.length} 份` : ''}，交的时候一起生效，老师能撤回`);
}

async function newBase(t: Turn, name: string): Promise<Result> {
  const id = await createKb(t.teacherId, name);
  t.desk.addBase(id);
  t.desk.structural = true;
  const kb = loadKb(id);
  record(t, 'tool', { name: 'create_knowledge_base', label: LABEL.create_knowledge_base, base: kb.name });
  return ok(`已建好「${kb.name}」，文件夹是「${t.desk.folderOf(id)}」，已生效`);
}

function renameBase(t: Turn, oldName: string, newName: string): Result {
  const kb = findKb(t.teacherId, oldName);
  renameKb(kb.id, newName);
  t.desk.renameBase(kb.id);
  t.desk.structural = true;
  const after = loadKb(kb.id).name;
  record(t, 'tool', { name: 'rename_knowledge_base', label: LABEL.rename_knowledge_base, from: kb.name, to: after });
  return ok(`已改名为「${after}」，文件夹是「${t.desk.folderOf(kb.id)}」，已生效`);
}

function dropBase(t: Turn, name: string): Result {
  const kb = findKb(t.teacherId, name);
  if (kb.id === t.contextKbId) return fail('老师正在看这个知识库，不能删');
  if (t.desk.spaces.get(kb.id)?.ops().length) return fail(`「${kb.name}」这次有没交的改动，不能删`);
  deleteKb(kb, { onlyEmpty: true, busy: false });
  t.desk.dropBase(kb.id);
  t.desk.structural = true;
  record(t, 'tool', { name: 'delete_knowledge_base', label: LABEL.delete_knowledge_base, base: kb.name });
  return ok(`已删除「${kb.name}」`);
}

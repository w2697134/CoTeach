/**
 * ct 命令：整理助手（Claude Code）只能用它动知识库的结构和交改动，系统在这里把关。
 * 读、写文字文档用 Claude Code 自带的工具；挪、删、新建/改名/删除知识库、把改动交给老师，都走这里。
 */
import { db, j } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { loadKb } from '../access.js';
import { createKb, deleteKb, findKb, renameKb, transferFiles } from '../bases.js';
import { checkMetadata, countTitle, createChange, isTidy, KEEPER_AUTHOR, revertChange, shownTitle, teacherAuthor } from '../changes.js';
import { addSource, cleanPath, hashBytes, manifest, readEntry, validateOps, type FileOp } from '../repo.js';
import { documentName } from '../teacher-text.js';
import { readBlobText, setItem } from '../intake/store.js';
import { INBOX, type Desk } from './desk.js';
import { record, type RunRef } from './events.js';
import { fileOriginals } from './filing.js';

export const KEEPER_NAME = '整理助手';

/** 老师这句话带的一份文件（读好了的） */
export interface InboxItem {
  id: number;
  name: string;
  kind: string;
  hash: string;
  text_hash: string;
  method: string | null;
  notes: string | null;
}

export interface Turn extends RunRef {
  token: string;
  user: { id: number; name: string };
  /** 老师这句话带的文件：摆在桌面「老师发来的」里，键是里面的相对路径 */
  inbox?: { root: string; intakeId: number; items: Map<string, InboxItem> };
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

export const USAGE = `ct 交 "改了什么" "依据"     把这次的改动交给老师
ct 存 <老师发来的文件或文件夹> <知识库文件夹/路径>   把老师发来的文件存进知识库（存进去就生效，算老师交的原件）
ct 挪 <从> <到>              挪动或改名文件、文件夹，也能挪到别的知识库的文件夹里
ct 删 <路径>                 删掉文件或文件夹（老师能撤回）
ct 改动 [知识库]             看最近的改动：编号、时间、谁改的、改了哪几份、生效没有
ct 撤回 <编号>               把一次已经生效的改动原样改回去（照历史记录恢复，撤回也能再撤回）
ct 新建库 <名字>             新建一个知识库
ct 改名库 <现在的名字> <新名字>
ct 删库 <名字>               删掉一个已经清空的知识库
路径从工作目录算起，第一段是知识库的文件夹。`;

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
  存: '存',
  保存: '存',
  save: '存',
  改动: '改动',
  历史: '改动',
  history: '改动',
  log: '改动',
  撤回: '撤回',
  改回: '撤回',
  回退: '撤回',
  revert: '撤回',
  undo: '撤回',
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
      case '存':
        if (args.length !== 2) return fail('用法：ct 存 <老师发来的文件或文件夹> <知识库文件夹/路径>');
        return await save(t, args[0], args[1]);
      case '改动':
        return changeLog(t, args.join(' '));
      case '撤回':
        if (args.length !== 1) return fail('用法：ct 撤回 <编号>');
        return await revert(t, args[0]);
      case '帮助':
        return ok(USAGE);
      default:
        return fail(`没有「${raw}」这个命令。\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof Error) {
      // 自己写的提示原样给；文件系统之类的原话带服务器上的路径，老师那边只记一句，整理助手那边去掉桌面前缀
      const ours = err instanceof HttpError;
      if (!ours) console.error('[agent] ct', cmd, err);
      record(t, 'tool', { name: toolName(cmd), label: LABEL[toolName(cmd)] || '整理', error: ours ? err.message : '没做成' });
      return fail(ours ? err.message : err.message.split(t.desk.root).join(''));
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
  save_file: '存进知识库',
  list_changes: '查看改动',
  revert_change: '撤回改动',
};
const toolName = (cmd: string) =>
  (
    {
      交: 'finish',
      挪: 'move_file',
      删: 'delete_file',
      新建库: 'create_knowledge_base',
      改名库: 'rename_knowledge_base',
      删库: 'delete_knowledge_base',
      存: 'save_file',
      改动: 'list_changes',
      撤回: 'revert_change',
    } as Record<string, string>
  )[cmd] || 'help';

const STATUS_WORD: Record<string, string> = { applied: '已生效', reverted: '已撤回', rejected: '老师没要', pending: '等老师确认', conflict: '没生效' };
const at = (ms: number) =>
  new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** 最近的改动（老师的、整理助手的都算）：编号、时间、谁改的、改了哪几份、生效没有；撤回时按编号认 */
function changeLog(t: Turn, raw: string): Result {
  const kbIds = raw.trim() ? [t.desk.locate(raw).kbId] : [...t.desk.folders.keys()];
  if (!kbIds.length) return ok('现在没有知识库');
  const rows = db.all<{ id: number; kb_id: number; title: string; author_name: string; status: string; created_at: number; paths: string }>(
    `SELECT c.id, c.kb_id, c.title, c.author_name, c.status, c.created_at,
       (SELECT json_group_array(json_extract(value, '$.path')) FROM json_each(c.ops)) AS paths
     FROM kb_changes c WHERE c.kb_id IN (${kbIds.map(() => '?').join(',')}) ORDER BY c.id DESC LIMIT 15`,
    ...kbIds,
  );
  record(t, 'tool', { name: 'list_changes', label: LABEL.list_changes });
  if (!rows.length) return ok('还没有改动');
  return ok(
    rows
      .map((r) => {
        const paths = (j(r.paths, []) as string[]).filter(Boolean);
        const files = paths.length > 5 ? `${paths.slice(0, 5).join('、')} 等 ${paths.length} 份` : paths.join('、');
        return `#${r.id} ${at(r.created_at)} ${r.author_name}｜「${t.desk.folderOf(r.kb_id)}」${shownTitle(r.title, paths.length)}（${STATUS_WORD[r.status] || r.status}）${files ? `：${files}` : ''}`;
      })
      .join('\n'),
  );
}

/** 把一次已生效的改动原样改回去：照 git 里改之前的样子再交一次，当场生效；这个库的文件夹跟着重新摆 */
async function revert(t: Turn, raw: string): Promise<Result> {
  const id = Number(String(raw).trim().replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) return fail('用法：ct 撤回 <编号>，编号用 ct 改动 看');
  const row = db.get<{ kb_id: number; status: string; title: string; paths: number }>(
    'SELECT kb_id, status, title, json_array_length(ops) AS paths FROM kb_changes WHERE id=?',
    id,
  );
  if (!row || !t.desk.folders.has(row.kb_id)) return fail(`没有 #${id} 这次改动，编号用 ct 改动 看`);
  const folder = t.desk.folderOf(row.kb_id),
    title = shownTitle(row.title, row.paths);
  if (row.status !== 'applied') return fail(`#${id} 现在是「${STATUS_WORD[row.status] || row.status}」，只有已经生效的改动能撤回`);
  await t.desk.sync();
  if (t.desk.spaces.get(row.kb_id)!.ops().length) return fail(`「${folder}」这次还有没交的改动，先 ct 交，再撤回`);
  const r = await revertChange(row.kb_id, id, t.user, { runId: t.runId });
  await t.desk.reload(row.kb_id);
  record(t, 'tool', { name: 'revert_change', label: LABEL.revert_change, title });
  record(t, 'change', { changeId: r.id, kbId: row.kb_id, kbName: loadKb(row.kb_id).name, status: r.status, title: r.title, files: r.ops.length });
  t.changes.push({ kbId: row.kb_id, changeId: r.id, status: r.status, title: r.title });
  return ok(`已撤回「${title}」：「${folder}」里这次动过的 ${r.ops.length} 份回到了改之前（已生效，老师能再撤回）`);
}

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
    const tidy = isTidy(kbId, ops);
    const name = t.desk.structural || touched.length > 1 ? countTitle(ops.length) : meta.title;
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
        // 交了就生效，老师不满意在卡片上撤回
        apply: { by: null, as: KEEPER_AUTHOR },
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

const inInbox = (raw: string) => String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0] === INBOX;

async function move(t: Turn, fromRaw: string, toRaw: string): Promise<Result> {
  if (t.submitted) return fail('这次已经交过了');
  if (inInbox(fromRaw) || inInbox(toRaw)) return fail(`「${INBOX}」里的文件是只读的；要放进知识库用 ct 存`);
  const a = t.desk.locate(fromRaw),
    b = t.desk.locate(toRaw);
  if (!a.path) return fail('不能挪整个知识库；要改知识库的名字用 ct 改名库');
  // 像 mv：写成「文件夹/」就是放进这个文件夹
  const into = /[\\/]\s*$/.test(String(toRaw ?? ''));
  await t.desk.sync();
  const fa = t.desk.folderOf(a.kbId),
    fb = t.desk.folderOf(b.kbId);
  if (a.kbId === b.kbId) {
    const r = await t.desk.moveWithin(a.kbId, a.path, b.path, into);
    record(t, 'tool', { name: 'move_file', label: LABEL.move_file, from: `${fa}/${a.path}`, to: `${fb}/${r.to}`, count: r.moved.length });
    return ok(`已挪到「${fb}/${r.to}」${r.moved.length > 1 ? `（${r.moved.length} 份）` : ''}，交的时候一起生效`);
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
    // 已经挪过去、生效了；放到指定位置没成就照实说，文件留在原来的相对位置
    try {
      const r2 = await t.desk.moveWithin(b.kbId, a.path, b.path, into);
      note = `，放在「${fb}/${r2.to}」，位置等交的时候一起生效`;
    } catch (err) {
      note = `；没能放到「${fb}/${b.path}」（${(err as Error).message}），现在在「${fb}/${a.path}」`;
    }
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
  if (inInbox(raw)) return fail(`「${INBOX}」里的文件是只读的，不存进知识库就不会留下，不用删`);
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

/**
 * 把老师发来的文件存进知识库：和老师自己交资料一样，存进去就生效，算老师交的原件（转出来的文字受保护）。
 * 目标给了文件名就用它；给的是文件夹就照原来的名字放进去。同名的原件当新版本，和别的文件撞名时原件名后加「（原件）」。
 * 一个知识库里不放两份一模一样的原件（按原文件的指纹认，名字不同也算）：库里已经有的、这次一起存的里面重复的，只留一份，
 * 告诉整理助手哪几份一样（2026-11-11 用户定：只存一份，跟老师说一声）。别的知识库里有一样的不算，各个库各放各的。
 */
async function save(t: Turn, fromRaw: string, toRaw: string): Promise<Result> {
  if (t.submitted) return fail('这次已经交过了');
  if (!t.inbox) return fail('老师这次没发文件');
  const from = String(fromRaw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim();
  const root = t.inbox.root;
  if (from !== root && !from.startsWith(root + '/')) return fail(`老师这次发来的文件在「${root}」里`);
  const under = from === root ? '' : from.slice(root.length + 1);
  const picked = [...t.inbox.items].filter(([rel]) => !under || rel === under || rel.startsWith(under + '/'));
  if (!picked.length) return fail(`「${from}」里没有读出来的文件`);
  const b = t.desk.locate(toRaw);
  await t.desk.sync();
  const kb = loadKb(b.kbId),
    folder = t.desk.folderOf(b.kbId);
  const single = picked.length === 1 && picked[0][0] === under && /\.[^./]+$/.test(b.path);
  const entries = manifest(b.kbId);
  const taken = new Set(entries.map((e) => e.path.toLocaleLowerCase()));
  for (const f of await t.desk.spaces.get(b.kbId)!.list()) taken.add(f.path.toLocaleLowerCase());
  const ops: FileOp[] = [];
  const placed: { itemId: number; path: string; sourceId: string }[] = [];
  const hashOf = new Map(
    db.all<{ id: string; original_hash: string }>('SELECT id, original_hash FROM kb_sources WHERE kb_id=?', b.kbId).map((s) => [s.id, s.original_hash]),
  );
  /** 原文件指纹 → 库里那份的路径 */
  const have = new Map<string, string>();
  for (const e of entries) if (e.sourceId && hashOf.has(e.sourceId)) have.set(hashOf.get(e.sourceId)!, e.path);
  const same: { itemId: number; name: string; as: string }[] = [];
  for (const [rel, item] of picked) {
    const twin = have.get(item.hash);
    if (twin) {
      same.push({ itemId: item.id, name: item.name.split('/').pop()!, as: twin });
      continue;
    }
    const tail = under && rel !== under ? rel.slice(under.length + 1) : rel.split('/').pop()!;
    let path = cleanPath(single ? b.path.replace(/\.[^./]+$/, '.md') : [b.path, tail.replace(/\.[^./]+$/, '') + '.md'].filter(Boolean).join('/'));
    const prev = entries.find((e) => e.path === path && e.sourceId);
    if (!prev) for (let k = 1; taken.has(path.toLocaleLowerCase()); k++) path = path.replace(/(（原件\d*）)?\.md$/, `（原件${k > 1 ? k : ''}）.md`);
    taken.add(path.toLocaleLowerCase());
    const text = readBlobText(item.text_hash);
    const sourceId = addSource(b.kbId, { name: item.name, originalHash: item.hash, text, kind: item.kind, method: item.method, notes: j<string[]>(item.notes, []) });
    ops.push({ path, content: text, base: prev ? hashBytes(readEntry(b.kbId, prev)) : null, ...(prev ? { baseEntryId: prev.id } : {}), sourceId, sourcePart: 'text' });
    placed.push({ itemId: item.id, path, sourceId });
    have.set(item.hash, path);
  }
  const twins = same.map((s) => `「${s.name}」和「${folder}/${s.as}」一模一样`).join('；');
  // 老师发的那份在对话里标上「重复」：它回话里提不提都看得到（A3 最外层 2 遍都没提，2026-11-11）
  for (const s of same) setItem(s.itemId, { status: 'same', path: `${folder}/${s.as}` });
  if (!placed.length) return ok(`没有存：${twins}，库里已经有了，只留一份`);
  const one = placed.length === 1 ? `「${documentName(placed[0].path)}」` : `${placed.length} 份资料`;
  await createChange({
    kbId: b.kbId,
    title: `交了${one}`,
    author: 'teacher',
    authorName: t.user.name,
    kind: 'upload',
    ops,
    apply: { by: t.user.id, as: teacherAuthor(t.user) },
  });
  for (const p of placed) setItem(p.itemId, { status: 'done', path: p.path, source_id: p.sourceId });
  await t.desk.placeSaved(
    b.kbId,
    placed.map((p) => p.path),
  );
  t.desk.structural = true;
  record(t, 'tool', { name: 'save_file', label: LABEL.save_file, path: `${folder}/${placed[0].path}`, count: placed.length, base: kb.name });
  return ok(`已存进「${folder}」：${placed.map((p) => `「${p.path}」`).join('、')}（已生效）${same.length ? `\n没有存：${twins}，只留一份` : ''}`);
}

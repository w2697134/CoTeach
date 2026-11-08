import { readFileSync, writeFileSync } from 'node:fs';
import { join, sep, resolve } from 'node:path';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { bad, conflict, notFound, HttpError } from '../lib/http.js';
import { streamChat, type Msg, type ToolCall, type ToolSpec } from '../llm/index.js';
import { createChange, isTidy, KEEPER_AUTHOR, checkMetadata } from './changes.js';
import { loadKb, studentIn, students, writableKb, type KnowledgeBase } from './access.js';
import { cleanPath, isTextEntry, manifest, validateOps } from './repo.js';
import { createKb, deleteKb, findKb, listKbs, renameKb, transferFiles } from './bases.js';
import { Workspace } from './workspace.js';
import { documentName } from './teacher-text.js';
import { collectEvidence, type EvidenceFinding } from './evidence.js';
import { experienceTool, placeExperience } from './experience.js';
import { announce, loadIntake, setIntake, type Batch, type Checkpoint } from './intake/store.js';
export { Workspace } from './workspace.js';

export const KEEPER_NAME = '整理助手';
export const keeperPrompt = (kb: KnowledgeBase) => `你是这位老师的整理助手。知识库要让一个新来的助教读完，就能照这位老师的意思办事。

当前工作范围：${kb.kind === 'teacher' ? '老师的长期知识库。整理时提取课程知识和今后沿用的教法；本班本学期的安排与学情留给对应班级知识库，归属不明则留在原件中等待老师说明。内容修改提交后等老师确认；内容不变的移动会直接生效。' : '这个班级这个学期的临时知识库。内容修改提交后直接生效，老师能查看和撤回。'}
目录由你按老师的资料和使用需要组织，可以新建、改名、移动、删除。原件和转换文字由系统标记保护，只能引用和调整位置，不能改写内容。
学生个人情况只能记在对应班级的本人记录里，写入时指定名单里的 student_id。全班共有内容不包含个人情况，长期库不保留学生身份。归属不清先问老师，不创建虚构名单。

只写资料、老师交代或本次提供的来源记录所支持的内容，不替老师补充。${kb.kind === 'teacher' ? '正文直接写教学内容；引用资料时使用资料标题和章节作为出处。' : '记录真实出处；'}依据不足的结论不要写。当前交代是这次任务，历史中已拒绝或撤回的交代不能继续执行。
要修改时调用工具，做完调用 finish。只是问问题或无需改动时回答后调用 done。生效状态以工具返回和系统记录为准。跟老师说话先说结论，说清楚就停。`;

export const summaryPrompt = `你负责把本次核对到的经验整理进老师的长期知识库。
新增内容以核对到的经验及引用原句为准，保留它的原意与适用范围。阅读现有长期内容用于查重、合并和选择存放位置。
正文直接写教学内容，提到资料时使用标题，文末附上“出处：班级，学期，《资料标题》”。finish.reason 填这条出处。
来源档案只读。完成后调用 finish，等老师确认后生效；没有实际新增内容就说明后调用 done。
`;

const TOOLS: ToolSpec[] = [
  {
    name: 'list_files',
    description: '列出当前工作范围的文件、保护状态和这次暂存的改动。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description: '读取当前范围的文字文件，可以分段读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
        start_char: {
          type: 'integer',
          description: '在指定行范围内接着上次 next_char 继续读取，默认 0',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: '查找当前范围文字文件中的内容。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'write_file',
    description: '新建或改写一份完整的文字文档。个人记录须指定名单中的 student_id；已有文档的归属不能改变。受保护原文不能改。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        student_id: { type: 'integer' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '移除当前范围的一个文件，记录保留，可以撤回。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    description: '移动或改名文件，内容、归属和保护状态保持不变。',
    parameters: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'list_students',
    description: '查看当前班级已经登记的学生，个人记录使用其 id。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'finish',
    description: '提交已经完成的改动。title 说明改了什么，reason 写依据。是否需要老师确认由系统决定。',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, reason: { type: 'string' } },
      required: ['title', 'reason'],
    },
  },
  {
    name: 'done',
    description: '本次无需修改知识库，回答完毕。不能用它提交已经暂存的修改。',
    parameters: { type: 'object', properties: {} },
  },
];
/** 操作知识库本身的工具：只在老师跟整理助手说话时给，交资料整理、学期提炼、其他助手的记录都不给 */
const KB_TOOLS: ToolSpec[] = [
  {
    name: 'list_knowledge_bases',
    description: '列出老师的全部知识库和各自的文件。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_knowledge_base',
    description: '新建一个空的知识库，立即生效。',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'rename_knowledge_base',
    description: '给老师的一个知识库改名，立即生效。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '现在的名字' }, new_name: { type: 'string' } },
      required: ['name', 'new_name'],
    },
  },
  {
    name: 'move_to_knowledge_base',
    description: '把已生效的文件或整个文件夹挪到老师的另一个知识库，路径、内容和保护状态不变。立即生效，两边都留有记录，可以撤回。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        to: { type: 'string', description: '目标知识库的名字' },
        from: { type: 'string', description: '来源知识库的名字，默认是当前知识库' },
      },
      required: ['paths', 'to'],
    },
  },
  {
    name: 'delete_knowledge_base',
    description: '删除老师的一个已经清空的知识库，当前知识库不能删。',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];
const KB_TOOL_NAMES = new Set(KB_TOOLS.map((t) => t.name));
const LABEL: Record<string, string> = {
  list_knowledge_bases: '看全部知识库',
  create_knowledge_base: '新建知识库',
  rename_knowledge_base: '知识库改名',
  move_to_knowledge_base: '挪到别的知识库',
  delete_knowledge_base: '删除知识库',
  list_files: '看目录',
  read_file: '读',
  search: '查找',
  write_file: '写',
  delete_file: '删除',
  move_file: '移动',
  list_students: '看本班名单',
  finish: '提交改动',
  done: '说完了',
};
const NUDGE = '（系统注：本次尚未完成。需要修改请使用工具后调用 finish，无需修改请回答后调用 done。）';
export function textChunk(text: string, startLine = 1, endLine?: number, startChar = 0) {
  const lines = text.split('\n'),
    end = Math.min(endLine ?? lines.length, lines.length);
  if (
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    startLine > lines.length ||
    !Number.isSafeInteger(end) ||
    end < startLine ||
    !Number.isSafeInteger(startChar) ||
    startChar < 0
  )
    throw bad('读取范围不正确');
  const selected = lines.slice(startLine - 1, end).join('\n');
  let stop = Math.min(selected.length, startChar + 12000);
  if (stop < selected.length && /[\uD800-\uDBFF]/.test(selected.charAt(stop - 1))) stop--;
  return {
    start_line: startLine,
    end_line: end,
    total_lines: lines.length,
    start_char: startChar,
    next_char: stop < selected.length ? stop : null,
    text: selected.slice(startChar, stop),
  };
}

function record(kbId: number, runId: number, type: string, data: Record<string, unknown>) {
  const t = now(),
    id = db.insert('kb_events', { run_id: runId, type, data, created_at: t });
  bus.publish(`kb:${kbId}`, 'event', { runId, id, type, data, createdAt: t });
}
function publishRun(kbId: number, runId: number) {
  const row = db.get<any>('SELECT * FROM kb_runs WHERE id=?', runId);
  bus.publish(`kb:${kbId}`, 'run', publicRun(row));
}
const SOURCE_TOOLS: Record<string, string> = { list_source_files: 'list_files', read_source_file: 'read_file', search_source: 'search' };
const SOURCE_LABELS: Record<string, string> = {
  list_source_files: '查看封存目录',
  read_source_file: '阅读封存记录',
  search_source: '查找封存记录',
};
const sourceTools: ToolSpec[] = Object.entries(SOURCE_TOOLS).map(([name, original]) => ({
  ...TOOLS.find((t) => t.name === original)!,
  name,
  description: SOURCE_LABELS[name] + '，范围是本次已指定的封存班级。',
}));
/** 内部工具分发；工作区由已授权任务建立，模型不能自行指定知识库。 */
export async function runTool(ws: Workspace, call: ToolCall, source?: Workspace): Promise<{ content: string; event: Record<string, any> }> {
  const original = SOURCE_TOOLS[call.name];
  if (typeof original === 'string') {
    if (!source) throw bad('这次任务没有可读取的封存来源');
    const result = await runTool(source, { ...call, name: original });
    const kb = loadKb(source.kbId);
    return {
      content: JSON.stringify({
        source: { name: kb.name, term: kb.term },
        result: original === 'search' ? result.content : JSON.parse(result.content),
      }),
      event: { ...result.event, name: call.name, label: SOURCE_LABELS[call.name] },
    };
  }
  const a = call.args as Record<string, any>,
    base = { name: call.name, label: LABEL[call.name] || call.name };
  switch (call.name) {
    case 'list_files': {
      const files = await ws.list();
      return {
        content: JSON.stringify(
          files.map((f) => ({
            path: f.path,
            protected: f.protected,
            studentId: f.studentId,
            pending: f.pending,
          })),
        ),
        event: { ...base, count: files.length },
      };
    }
    case 'read_file': {
      const target = { ws, path: cleanPath(a.path) },
        text = target.ws.read(target.path);
      if (text === null) throw notFound('没有这个文件');
      const entry = target.ws.entry(target.path);
      if (entry && !isTextEntry(entry)) throw bad('这是二进制原件，请读取转换后的文字');
      const chunk = textChunk(
        text,
        Number(a.start_line) || 1,
        a.end_line === undefined ? undefined : Number(a.end_line),
        Number(a.start_char) || 0,
      );
      return {
        content: JSON.stringify({ path: a.path, ...chunk }),
        event: {
          ...base,
          path: a.path,
          lines: `${chunk.start_line}-${chunk.end_line}`,
          total: chunk.total_lines,
        },
      };
    }
    case 'search': {
      const q = String(a.text || '').trim();
      if (!q) throw bad('请提供要找的文字');
      const hits: string[] = [];
      for (const target of [ws])
        for (const f of await target.list())
          if (f.text) {
            for (const [i, line] of (target.read(f.path) || '').split('\n').entries())
              if (line.includes(q) && hits.length < 40) hits.push(`${f.path}:${i + 1}: ${line.slice(0, 200)}`);
          }
      return {
        content: hits.join('\n') || '没找到',
        event: { ...base, text: q, hits: hits.length },
      };
    }
    case 'write_file': {
      const p = cleanPath(a.path),
        text = String(a.content ?? '');
      const isNew = ws.read(p) === null;
      ws.write(p, text.endsWith('\n') ? text : text + '\n', a.student_id === undefined ? undefined : Number(a.student_id));
      return {
        content: '已暂存，还未提交',
        event: { ...base, path: p, chars: text.length, isNew },
      };
    }
    case 'delete_file': {
      const p = cleanPath(a.path);
      ws.remove(p);
      return { content: '已暂存删除，还未提交', event: { ...base, path: p } };
    }
    case 'move_file': {
      const from = cleanPath(a.from),
        to = cleanPath(a.to);
      ws.move(from, to);
      return { content: '已暂存移动，还未提交', event: { ...base, from, to } };
    }
    case 'list_students': {
      const list =
        loadKb(ws.kbId).kind === 'class' ? students(ws.kbId).filter((s) => ws.studentId === undefined || s.id === ws.studentId) : [];
      return {
        content: JSON.stringify(
          list.map((s) => ({
            id: s.id,
            name: s.name,
            studentNo: s.student_no,
          })),
        ),
        event: { ...base, count: list.length },
      };
    }
    case 'finish': {
      const staged = ws.ops().length > 0 && JSON.stringify(ws.ops()) !== ws.carried;
      // 只改了知识库本身（新建、改名、挪走、删除）时这些已经生效，没有要再提交的
      if (!staged && !ws.structural) throw bad('没有实际改动，无需修改时请调用 done');
      if (staged) {
        validateOps(ws.kbId, ws.ops());
        checkMetadata(ws.kbId, String(a.title || ''), String(a.reason || ''), ws.ops());
      }
      return {
        content: staged ? '准备提交' : '完成',
        event: { ...base, title: a.title, reason: a.reason },
      };
    }
    case 'done':
      if (ws.ops().length && JSON.stringify(ws.ops()) !== ws.carried) throw bad('还有暂存修改，请提交改动，不能声称没有修改');
      return { content: '完成', event: base };
    default:
      throw bad('没有这个工具');
  }
}
/** 知识库本身的操作直接生效；用名字指代知识库，不把编号给模型 */
export async function runKbTool(kb: KnowledgeBase, ws: Workspace, call: ToolCall, runId: number): Promise<{ content: string; event: Record<string, any> }> {
  const a = call.args as Record<string, any>,
    base = { name: call.name, label: LABEL[call.name] || call.name };
  switch (call.name) {
    case 'list_knowledge_bases': {
      const list = listKbs(kb.teacher_id).map((k) => {
        const files = manifest(k.id).map((e) => e.path);
        return { name: k.name, ...(k.id === kb.id ? { current: true } : {}), files: files.slice(0, 200), ...(files.length > 200 ? { more: files.length - 200 } : {}) };
      });
      return { content: JSON.stringify(list), event: { ...base, count: list.length } };
    }
    case 'create_knowledge_base': {
      const id = await createKb(kb.teacher_id, a.name);
      ws.structural = true;
      const name = loadKb(id).name;
      return { content: `已建好「${name}」`, event: { ...base, base: name } };
    }
    case 'rename_knowledge_base': {
      const target = findKb(kb.teacher_id, a.name);
      renameKb(target.id, a.new_name);
      ws.structural = true;
      const name = loadKb(target.id).name;
      return { content: `已改名为「${name}」`, event: { ...base, from: target.name, to: name } };
    }
    case 'move_to_knowledge_base': {
      const from = a.from === undefined || a.from === null || a.from === '' ? kb : findKb(kb.teacher_id, a.from),
        to = findKb(kb.teacher_id, a.to),
        paths = (Array.isArray(a.paths) ? a.paths : [a.paths]).map((p: unknown) => String(p ?? ''));
      const here = from.id === kb.id;
      if (here) for (const p of paths) if (p && ws.touched(p)) throw bad(`「${p}」这次有还没提交的改动，提交后才能挪`);
      const r = await transferFiles(from.id, to.id, paths, { author: 'keeper', authorName: KEEPER_NAME, as: KEEPER_AUTHOR, by: null, runId: here ? runId : null });
      if (here) ws.forget(r.moved);
      ws.structural = true;
      return {
        content: JSON.stringify({ 已挪到: to.name, 文件: r.moved }),
        event: {
          ...base,
          to: to.name,
          ...(here ? {} : { from: from.name }),
          count: r.moved.length,
          ...(r.moved.length === 1 ? { path: r.moved[0] } : {}),
          paths: r.moved.slice(0, 30),
        },
      };
    }
    case 'delete_knowledge_base': {
      const target = findKb(kb.teacher_id, a.name);
      if (target.id === kb.id) throw bad('当前知识库不能删');
      deleteKb(target, { onlyEmpty: true, busy: active.has(target.id) });
      ws.structural = true;
      return { content: `已删除「${target.name}」`, event: { ...base, base: target.name } };
    }
    default:
      throw bad('没有这个工具');
  }
}
const active = new Map<number, { runId: number; ctrl: AbortController; intakeId?: number }>();
export const activeRun = (kbId: number) => active.get(kbId)?.runId ?? null;
export function startRun(
  kbId: number,
  kind: 'materials' | 'chat' | 'summary' | 'observation',
  request: string,
  user: { id: number; name: string },
  sourceKbId?: number,
  inboxId?: number,
  studentId?: number,
): number {
  const kb = writableKb(kbId);
  if (kb.teacher_id !== user.id) throw bad('整理任务归属不正确');
  if (active.has(kbId)) throw conflict('整理助手正在处理上一件事，请稍后再试');
  if (studentId !== undefined) studentIn(kbId, studentId);
  const origin = inboxId ? db.get<any>('SELECT * FROM kb_inbox WHERE id=? AND kb_id=?', inboxId, kbId) : null;
  if (inboxId && !origin) throw bad('整理来源不属于当前知识库');
  if (sourceKbId) {
    const s = loadKb(sourceKbId);
    if (s.teacher_id !== user.id || s.kind !== 'class' || s.status !== 'archived') throw bad('总结来源必须是这位老师已封存的班级');
  }
  const runId = db.insert('kb_runs', {
    kb_id: kbId,
    kind,
    status: 'running',
    request,
    created_by: user.id,
    source_kb_id: sourceKbId ?? null,
    student_id: studentId ?? null,
    created_at: now(),
  });
  const ctrl = new AbortController();
  active.set(kbId, { runId, ctrl });
  publishRun(kbId, runId);
  if (inboxId)
    db.update('kb_inbox', inboxId, {
      status: 'running',
      run_id: runId,
      error: null,
    });
  void execute(kb, runId, kind, request, user, ctrl.signal, sourceKbId, studentId, origin)
    .then(() => {
      if (inboxId) db.update('kb_inbox', inboxId, { status: 'accepted' });
    })
    .catch((err) => {
      const msg = ctrl.signal.aborted ? '这次整理已停止' : (err as Error).message;
      // 老师自己让它停下不算出错：不记错误，页面显示「已停止」
      if (!ctrl.signal.aborted) record(kbId, runId, 'error', { message: msg });
      db.update('kb_runs', runId, {
        status: ctrl.signal.aborted ? 'canceled' : 'error',
        error: ctrl.signal.aborted ? null : msg,
        finished_at: now(),
      });
      if (inboxId) db.update('kb_inbox', inboxId, { status: 'error', error: msg });
    })
    .finally(() => {
      active.delete(kbId);
      publishRun(kbId, runId);
      drainInbox(kbId);
    });
  return runId;
}
export function enqueueTask(kbId: number, sender: string, sourceId: string, content: string, sourceKbId?: number): number {
  const old = db.get<any>('SELECT id FROM kb_inbox WHERE kb_id=? AND sender=? AND source_id=?', kbId, sender, sourceId);
  const id =
    old?.id ??
    db.insert('kb_inbox', {
      kb_id: kbId,
      sender,
      source_id: sourceId,
      content,
      source_kb_id: sourceKbId ?? null,
      status: 'pending',
      created_at: now(),
    });
  queueMicrotask(() => drainInbox(kbId));
  return id;
}
export function drainInbox(kbId: number) {
  if (active.has(kbId)) return;
  const kb = loadKb(kbId);
  if (kb.status !== 'active') return;
  const job = db.get<any>("SELECT * FROM kb_inbox WHERE kb_id=? AND status='pending' ORDER BY id LIMIT 1", kbId);
  if (!job) return;
  const user = db.get<any>("SELECT id,name FROM users WHERE id=? AND status='active'", kb.teacher_id);
  if (!user) return;
  if (job.sender === 'intake') return startIntakeDigest(kbId, job, user);
  try {
    startRun(
      kbId,
      job.source_kb_id ? 'summary' : job.sender === 'teacher-upload' ? 'materials' : 'observation',
      job.content,
      user,
      job.source_kb_id || undefined,
      job.id,
      job.student_id ?? undefined,
    );
  } catch (err) {
    db.update('kb_inbox', job.id, {
      status: 'error',
      error: (err as Error).message,
    });
  }
}
/**
 * 交给整理助手的话：分批时每批和只交一批时说法完全一样。分批是内部做法，
 * 告诉它「第几批」它会把批次写进目录和进度（2026-11-07 实测），所以不提。老师随资料说的话放在最前面。
 */
export function batchRequest(message: string | null, paths: string[]) {
  return `${message?.trim() ? message.trim() + '\n\n' : ''}我交了资料：\n${paths.join('\n')}\n请整理进当前知识库。`;
}

/**
 * 一次交的资料分批整理：每批重新开一段对话（上下文不会越堆越长），但共用同一个暂存区，
 * 后面的批次看得到前面暂存的笔记。每批做完记下暂存，中断后从下一批接着来，做完的批次不重做。
 * 全部做完才生成一次改动，长期库照旧等老师确认。
 */
function startIntakeDigest(kbId: number, job: any, user: { id: number; name: string }) {
  const intakeId = Number(String(job.source_id).split(':')[0]);
  let kb: KnowledgeBase;
  try {
    kb = writableKb(kbId);
    loadIntake(intakeId);
  } catch (err) {
    db.update('kb_inbox', job.id, { status: 'error', error: (err as Error).message });
    return;
  }
  const ctrl = new AbortController();
  active.set(kbId, { runId: 0, ctrl, intakeId });
  db.update('kb_inbox', job.id, { status: 'running', error: null });
  setIntake(intakeId, { status: 'digesting', error: null });
  announce(intakeId, true);
  void digestIntake(kb, intakeId, job.id, user, ctrl)
    .then(() => db.update('kb_inbox', job.id, { status: 'accepted', error: null }))
    .catch((err) => {
      const message = ctrl.signal.aborted ? '整理停下了，已整理好的部分都留着，可以接着整理' : readableKeeperError(err);
      db.update('kb_inbox', job.id, { status: 'error', error: message });
      if (loadIntake(intakeId).status === 'digesting') setIntake(intakeId, { status: 'paused', error: message });
    })
    .finally(() => {
      active.delete(kbId);
      announce(intakeId, true);
      drainInbox(kbId);
    });
}

function readableKeeperError(err: unknown) {
  const msg = String((err as Error)?.message || '');
  if (err instanceof HttpError && err.status === 409) return '整理期间知识库里的相关内容被改过，这次的整理需要重新核对';
  return msg || '整理没有完成，可以接着整理';
}

async function digestIntake(kb: KnowledgeBase, intakeId: number, jobId: number, user: { id: number; name: string }, ctrl: AbortController) {
  const first = loadIntake(intakeId);
  const plan: Batch[] = first.plan ? JSON.parse(first.plan) : [];
  const total = plan.length;
  const docs = plan.reduce((n, b) => n + b.paths.length, 0);
  if (!total) {
    setIntake(intakeId, { status: 'done', finished_at: now() });
    return;
  }
  for (let b = first.batch; b < total; b++) {
    ctrl.signal.throwIfAborted();
    const intake = loadIntake(intakeId);
    const cp: Checkpoint | null = intake.checkpoint ? JSON.parse(intake.checkpoint) : null;
    const ws = cp ? Workspace.restore(kb.id, cp.baseSha, cp.ops) : new Workspace(kb.id);
    ws.carried = JSON.stringify(ws.ops());
    const request = batchRequest(intake.message, plan[b].paths);
    const runId = db.insert('kb_runs', {
      kb_id: kb.id,
      kind: 'materials',
      status: 'running',
      request,
      created_by: user.id,
      intake_id: intakeId,
      created_at: now(),
    });
    active.get(kb.id)!.runId = runId;
    db.update('kb_inbox', jobId, { run_id: runId });
    publishRun(kb.id, runId);
    announce(intakeId, true);
    const last = b === total - 1;
    try {
      const notes = cp?.notes || [];
      const r = await execute(kb, runId, 'materials', request, user, ctrl.signal, undefined, undefined, { sender: 'teacher-upload', source_id: String(intake.change_id) }, {
        ws,
        checkpoint: !last,
        requestKey: last ? `intake:${intakeId}:${intake.change_id}:final` : undefined,
        commitMeta:
          total > 1
            ? (finish) => ({
                title: `整理了这次交的 ${docs} 份资料`,
                reason: [...notes, ...(finish ? [finish] : [])].map((n) => n.reason.trim()).filter(Boolean).join('\n'),
              })
            : undefined,
      });
      if (!last)
        setIntake(intakeId, {
          batch: b + 1,
          resumes: 0,
          checkpoint: JSON.stringify({ baseSha: ws.baseSha, ops: ws.ops(), notes: [...notes, ...(r.finish ? [r.finish] : [])] } satisfies Checkpoint),
        });
      else setIntake(intakeId, { batch: total, status: 'done', digest_change_id: r.changeId, checkpoint: null, error: null, finished_at: now() });
    } catch (err) {
      const msg = ctrl.signal.aborted ? '这次整理已停止' : (err as Error).message;
      // 老师自己让它停下不算出错：不记错误，页面显示「已停止」
      if (!ctrl.signal.aborted) record(kb.id, runId, 'error', { message: msg });
      db.update('kb_runs', runId, { status: ctrl.signal.aborted ? 'canceled' : 'error', error: ctrl.signal.aborted ? null : msg, finished_at: now() });
      throw err;
    } finally {
      publishRun(kb.id, runId);
    }
  }
}

export function cancelIntakeRun(kbId: number, intakeId: number) {
  const a = active.get(kbId);
  if (!a || a.intakeId !== intakeId) throw notFound('这次整理已经结束');
  a.ctrl.abort();
}

/** 整理停在中途时，老师选择「就整理到这里」：把已经暂存的部分作为一次改动交出来。 */
export async function commitCheckpoint(kbId: number, intakeId: number, user: { id: number; name: string }) {
  const kb = writableKb(kbId);
  if (active.get(kbId)?.intakeId === intakeId) throw conflict('整理助手还在整理这批资料');
  const intake = loadIntake(intakeId);
  const cp: Checkpoint | null = intake.checkpoint ? JSON.parse(intake.checkpoint) : null;
  let changeId: number | null = null;
  if (cp?.ops.length) {
    const tidy = isTidy(kbId, cp.ops);
    const c = await createChange({
      kbId,
      title: '整理了这次交的一部分资料',
      reason: cp.notes.map((n) => n.reason.trim()).filter(Boolean).join('\n'),
      author: 'keeper',
      authorName: KEEPER_NAME,
      kind: tidy ? 'tidy' : 'keeper',
      ops: cp.ops,
      apply: kb.kind === 'class' || tidy ? { by: null, as: KEEPER_AUTHOR } : undefined,
      requestKey: `intake:${intakeId}:${intake.change_id}:partial`,
    });
    changeId = c.id;
  }
  db.run("UPDATE kb_inbox SET status='dismissed' WHERE kb_id=? AND sender='intake' AND source_id LIKE ? AND status IN ('pending','error')", kbId, `${intakeId}:%`);
  setIntake(intakeId, { status: 'done', digest_change_id: changeId, checkpoint: null, error: null, finished_at: now() });
  announce(intakeId, true);
  void user;
}

export function cancelRun(kbId: number, runId: number) {
  const a = active.get(kbId);
  if (!a || a.runId !== runId) throw notFound('这件事已经结束');
  a.ctrl.abort();
}
export function cancelForArchive(kbId: number) {
  active.get(kbId)?.ctrl.abort();
}
const OUTCOME: Record<string, string> = {
  applied: '已生效',
  pending: '待确认，未生效',
  conflict: '未生效',
  rejected: '老师已拒绝，不得继续执行',
  reverted: '老师已撤回，不得继续执行',
};
function recentTalk(kbId: number, runId: number): Msg[] {
  return db
    .all<any>("SELECT * FROM kb_runs WHERE kb_id=? AND id<? AND kind='chat' AND source_kb_id IS NULL ORDER BY id DESC LIMIT 4", kbId, runId)
    .reverse()
    .flatMap((r) => {
      const c = r.change_id ? db.get<any>('SELECT status,title FROM kb_changes WHERE id=?', r.change_id) : null;
      // 被拒绝、撤回及失败的任务不再作为可执行用户指令送回模型。
      if (r.status !== 'done' || (c && ['rejected', 'reverted', 'conflict'].includes(c.status))) return [];
      return [
        { role: 'user' as const, content: r.request },
        {
          role: 'assistant' as const,
          content: `${r.reply || ''}\n（系统记录：${outcome(r.id, c)}）`,
        },
      ];
    });
  function outcome(runId: number, c: { status: string } | null) {
    const done = basesDone(runId);
    if (!done.length) return c ? OUTCOME[c.status] : '未修改知识库';
    return `已生效：${done.join('；')}。${c ? `改动${OUTCOME[c.status]}` : ''}`;
  }
}
/** 这次直接动过的知识库本身（新建、改名、挪走、删除）：这些不进改动记录，要另外记清楚，不能记成「未修改」 */
function basesDone(runId: number): string[] {
  return db
    .all<{ data: string }>("SELECT data FROM kb_events WHERE run_id=? AND type='tool'", runId)
    .map((e) => JSON.parse(e.data))
    .filter((d) => !d.error)
    .flatMap((d) => {
      if (d.name === 'create_knowledge_base') return [`新建知识库「${d.base}」`];
      if (d.name === 'rename_knowledge_base') return [`「${d.from}」改名为「${d.to}」`];
      if (d.name === 'move_to_knowledge_base') {
        const paths: string[] = Array.isArray(d.paths) ? d.paths : [];
        const list = paths.length ? `：${paths.join('、')}${d.count > paths.length ? ' 等' : ''}` : '';
        return [`${d.from ? `从「${d.from}」` : ''}${d.count} 份挪到「${d.to}」${list}`];
      }
      if (d.name === 'delete_knowledge_base') return [`删除知识库「${d.base}」`];
      return [];
    });
}
async function execute(
  kb: KnowledgeBase,
  runId: number,
  kind: string,
  request: string,
  user: { id: number; name: string },
  signal: AbortSignal,
  sourceKbId?: number,
  studentId?: number,
  origin?: { sender: string; source_id: string } | null,
  batch: {
    /** 分批整理沿用同一个工作区 */
    ws?: Workspace;
    /** 不是最后一批：只暂存，不生成改动 */
    checkpoint?: boolean;
    /** 最后一批：改动的标题和依据汇总各批 */
    commitMeta?: (finish: { title: string; reason: string } | null) => { title: string; reason: string };
    /** 同一次交资料只生成一次改动：最后一批提交后、记下完成前断电，重启接着跑也不会再生成一份 */
    requestKey?: string;
  } = {},
): Promise<{ finish: { title: string; reason: string } | null; changeId: number | null }> {
  const ws = batch.ws ?? new Workspace(kb.id, false, !sourceKbId && studentId === undefined, studentId),
    source = sourceKbId ? new Workspace(sourceKbId, true) : undefined;
  const model = db.get<any>(
    "SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.model='deepseek-flash' AND m.enabled=1 AND p.enabled=1 ORDER BY m.id LIMIT 1",
  );
  if (!model) throw new Error('DeepSeek V4.1 Flash 当前不可用，请检查模型配置');
  let findings: EvidenceFinding[] | null = null;
  let sourceSteps = 0;
  if (kind === 'summary' && source && !(process.env.CT_TEST_MODE === '1' && process.env.CT_EVAL_EVIDENCE_GATE === '0')) {
    const sourceKb = loadKb(source.kbId);
    const result = await collectEvidence({
      source,
      sourceName: `${sourceKb.name} · ${sourceKb.term}`,
      modelRowId: model.id,
      userId: user.id,
      signal,
      readTools: TOOLS.filter((t) => ['list_files', 'read_file', 'search'].includes(t.name)),
      read: (call) => runTool(source, call),
      record: (event) => record(kb.id, runId, 'tool', event),
    });
    findings = result.findings;
    sourceSteps = result.steps;
    if (
      process.env.CT_TEST_MODE === '1' &&
      process.env.CT_EVAL_EVIDENCE_TRACE === '1' &&
      resolve(config.dataDir).split(sep).includes('output')
    ) {
      writeFileSync(join(config.dataDir, `evidence-${runId}.json`), JSON.stringify(result, null, 2), 'utf8');
    }
    if (!findings.length) {
      db.update('kb_runs', runId, { status: 'done', reply: '这次没有找到有依据的新教学经验，知识库未改动。', finished_at: now() });
      return { finish: null, changeId: null };
    }
  }
  const useGeneralSummary = process.env.CT_TEST_MODE === '1' && process.env.CT_EVAL_SUMMARY_PROMPT === 'keeper';
  let instruction = kind === 'summary' && !useGeneralSummary ? summaryPrompt : keeperPrompt(kb);
  // 只用于隔离副本上的单变量对照，正常运行不读取外部提示词。
  if (process.env.CT_TEST_MODE === '1' && process.env.CT_KEEPER_PROMPT_FILE)
    instruction = readFileSync(process.env.CT_KEEPER_PROMPT_FILE, 'utf8');
  const sourceInfo = sourceKbId ? loadKb(sourceKbId) : null;
  const sourceContext = sourceInfo
    ? `\n封存来源（系统已核实）：班级「${sourceInfo.name}」，学期「${sourceInfo.term}」，状态「已封存」。通过封存资料工具查阅本次来源；普通文件工具处理当前长期库。提案不得带学生身份或个别情况。`
    : '';
  const citedFindings = findings?.map((f) => ({
    ...f,
    sources: f.sources.map((s) => ({
      ...s,
      title: documentName(s.path),
      readTool: 'read_source_file',
      className: sourceInfo?.name,
      term: sourceInfo?.term,
    })),
  }));
  const placement = !!findings && !(process.env.CT_TEST_MODE === '1' && process.env.CT_EVAL_SUMMARY_PLACEMENT === '0');
  const placed = new Set<number>();
  // 老师跟整理助手说话时才能动知识库本身；隔离对照时可以关掉
  const kbTools =
    kind === 'chat' && !source && studentId === undefined && !placement && !(process.env.CT_TEST_MODE === '1' && process.env.CT_EVAL_KB_TOOLS === '0');
  const currentFiles = kind === 'chat' ? (await ws.list()).map((file) => ({ path: file.path, protected: file.protected })) : null;
  const messages: Msg[] = [
    {
      role: 'system',
      content: `${instruction}\n\n当前知识库：${kb.name}${kb.term ? '，学期：' + kb.term : ''}\n今天：${new Date().toLocaleDateString('zh-CN')}\n老师：${user.name}${sourceContext}${currentFiles ? '\n当前可读文件：' + JSON.stringify(currentFiles) : ''}${studentId !== undefined ? '\n本次记录对象（系统绑定）：' + JSON.stringify({ id: studentId, name: studentIn(kb.id, studentId).name }) : ''}${origin ? '\n本次来源记录：' + JSON.stringify({ 来源: origin.sender === 'grader' ? '批改助手' : origin.sender === 'tutor' ? '答疑助手' : origin.sender === 'term-summary' ? '学期封存任务' : origin.sender === 'teacher-upload' ? '老师上传资料' : origin.sender, 编号: origin.sender === 'teacher-upload' ? undefined : origin.source_id }) : ''}`,
    },
    ...(kind === 'chat' ? recentTalk(kb.id, runId) : []),
    ...(citedFindings
      ? [
          {
            role: 'user' as const,
            content: '本次封存记录中核对到的经验与依据：' + JSON.stringify(citedFindings.map((f, i) => ({ index: i + 1, ...f }))),
          },
        ]
      : []),
    { role: 'user', content: request },
  ];
  let reply = '',
    finished = false,
    finish: { title: string; reason: string } | null = null,
    nudges = 0;
  for (let step = 0; step < (kind === 'materials' ? 60 : 30 - sourceSteps) && !finished; step++) {
    signal.throwIfAborted();
    let text = '';
    const calls: ToolCall[] = [];
    for await (const d of streamChat({
      agentKey: 'keeper',
      modelRowId: model.id,
      messages,
      tools: [
        ...TOOLS.filter(
          (t) => (t.name !== 'list_students' || kb.kind === 'class') && (!placement || !['write_file', 'delete_file'].includes(t.name)),
        ),
        ...(source ? sourceTools : []),
        ...(placement ? [experienceTool] : []),
        ...(kbTools ? KB_TOOLS : []),
      ],
      temperature: 0.3,
      maxTokens: 8192,
      userId: user.id,
      purpose: `kb:${kind}`,
      signal,
    })) {
      if (d.type === 'text') {
        text += d.text;
        bus.publish(`kb:${kb.id}`, 'delta', { runId, text: d.text });
      } else if (d.type === 'tool') calls.push(d.call);
    }
    if (text.trim()) {
      reply = text.trim();
      record(kb.id, runId, 'say', { text: reply });
    }
    if (!calls.length) {
      if (nudges++ >= 2) throw new Error('整理助手没有完成实际操作，请重试');
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: NUDGE });
      continue;
    }
    messages.push({ role: 'assistant', content: text, toolCalls: calls });
    for (const call of calls) {
      let content: string;
      try {
        signal.throwIfAborted();
        if (finished) throw bad('本次已经结束，后续操作不执行');
        if (placement && ['write_file', 'delete_file'].includes(call.name)) throw bad('请把核对后的经验放入选定文档');
        if (KB_TOOL_NAMES.has(call.name) && !kbTools) throw bad('没有这个工具');
        const out =
          placement && call.name === 'place_experience'
            ? placeExperience(ws, findings!, sourceInfo!, call.args, placed)
            : KB_TOOL_NAMES.has(call.name)
              ? await runKbTool(kb, ws, call, runId)
              : await runTool(ws, call, source);
        content = out.content;
        record(kb.id, runId, 'tool', out.event);
        if (call.name === 'finish') {
          finish = {
            title: String(call.args.title || '整理知识库').slice(0, 120),
            reason: String(call.args.reason || ''),
          };
          finished = true;
        }
        if (call.name === 'done') finished = true;
      } catch (err) {
        if (call.name === 'finish' && err instanceof HttpError && err.status === 409) throw err;
        content = (err as Error).message;
        // 拦下学生身份时补上事实：哪份文件里出现了哪些已登记的身份（只说事实，不加做法）
        const where = err instanceof HttpError && err.code === 'student_identity' ? err.details : null;
        if (where && Array.isArray(where.terms) && where.terms.length) {
          if (typeof where.path === 'string') content += `（出现在「${where.path}」：${where.terms.join('、')}）`;
          else if (typeof where.field === 'string') content += `（出现在${where.field}里：${where.terms.join('、')}）`;
        }
        record(kb.id, runId, 'tool', {
          name: call.name,
          label: LABEL[call.name],
          error: content,
          ...Object.fromEntries(
            ['path', 'from', 'to', 'title', 'text']
              .filter((key) => typeof call.args?.[key] === 'string')
              .map((key) => [key, String(call.args[key]).slice(0, 400)]),
          ),
          // 知识库的名字另放，不能顶掉工具名
          ...(KB_TOOL_NAMES.has(call.name) && typeof call.args?.name === 'string' ? { base: String(call.args.name).slice(0, 80) } : {}),
        });
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content,
      });
    }
  }
  signal.throwIfAborted();
  if (!finished) throw new Error('这次整理未完成，已保留工作记录，请重试');
  let changeId: number | null = null;
  const ops = ws.ops();
  if (batch.checkpoint) {
    db.update('kb_runs', runId, { status: 'done', reply: finish?.title || reply || null, finished_at: now() });
    return { finish, changeId: null };
  }
  const carried = !!ws.carried && ws.carried !== '[]';
  if (ops.length && (finish || carried)) {
    const meta = batch.commitMeta ? batch.commitMeta(finish) : finish!;
    const tidy = isTidy(kb.id, ops),
      automatic = kb.kind === 'class' || tidy;
    // 这次还直接新建、挪动过知识库，那些已经生效：改动的标题只写这份改动里的几页，免得老师以为点「不要」能把新建、挪动也撤掉
    const pages = [...new Set(ops.map((op) => documentName(op.path)))];
    const title = ws.structural ? `改了${pages.slice(0, 3).map((p) => `「${p}」`).join('、')}${pages.length > 3 ? ` 等 ${pages.length} 份` : ''}` : meta.title;
    const c = await createChange({
      kbId: kb.id,
      title: title.slice(0, 120),
      reason: meta.reason,
      author: 'keeper',
      authorName: KEEPER_NAME,
      kind: tidy ? 'tidy' : 'keeper',
      ops,
      runId,
      apply: automatic ? { by: null, as: KEEPER_AUTHOR } : undefined,
      requestKey: batch.requestKey,
    });
    changeId = c.id;
    record(kb.id, runId, 'change', {
      changeId: c.id,
      status: c.status,
      title: c.title,
      files: ops.length,
    });
    reply = `${c.title}（${c.status === 'applied' ? '已生效' : '待你确认'}）`;
  } else if (finish && ws.structural) reply = `${finish.title}（已生效）`;
  db.update('kb_runs', runId, {
    status: 'done',
    reply: reply || null,
    change_id: changeId,
    finished_at: now(),
  });
  return { finish, changeId };
}
export function taskSubject(item: any) {
  const source = item.source_kb_id ? db.get<any>('SELECT name,term FROM knowledge_bases WHERE id=?', item.source_kb_id) : null;
  if (source) return { label: '学期提炼', detail: `${source.name} · ${source.term}` };
  if (item.sender === 'intake') return { label: '整理这次交的资料', detail: item.content || '' };
  if (item.sender === 'teacher-upload') {
    const change = db.get<any>("SELECT ops FROM kb_changes WHERE id=? AND kb_id=? AND kind='upload'", Number(item.source_id), item.kb_id);
    return {
      label: '上传资料后的整理',
      detail: change ? (JSON.parse(change.ops) as { path: string }[]).map((op) => documentName(op.path)).join('、') : '',
    };
  }
  return {
    label: item.sender === 'grader' ? '批改助手的记录' : item.sender === 'tutor' ? '答疑助手的记录' : '其他助手的记录',
    detail: item.content || '',
  };
}
export function publicRun(r: any) {
  // 一次交资料分几批整理，排队记录只记着最后一批，前面几批按交资料找回来
  const origin =
    r.kind !== 'chat'
      ? (db.get<any>('SELECT * FROM kb_inbox WHERE run_id=?', r.id) ??
        (r.intake_id ? db.get<any>("SELECT * FROM kb_inbox WHERE sender='intake' AND source_id LIKE ? ORDER BY id DESC LIMIT 1", `${r.intake_id}:%`) : null))
      : null;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    request: r.request,
    task: origin
      ? taskSubject(origin)
      : r.kind === 'materials'
        ? { label: '上传资料后的整理', detail: '' }
        : r.kind === 'summary'
          ? taskSubject(r)
          : null,
    reply: r.reply,
    intakeId: r.intake_id ?? null,
    changeId: r.change_id,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}
export const INTERRUPTED = '服务中断，这次未完成，可以重试';
export function recoverRuns() {
  db.tx(() => {
    for (const r of db.all<any>("SELECT * FROM kb_runs WHERE status='running'")) {
      const change = db.get<any>('SELECT id,title,status FROM kb_changes WHERE run_id=? ORDER BY id DESC LIMIT 1', r.id);
      db.update(
        'kb_runs',
        r.id,
        change
          ? {
              status: 'done',
              change_id: change.id,
              reply: change.title,
              error: null,
              finished_at: now(),
            }
          : {
              status: 'error',
              error: INTERRUPTED,
              finished_at: now(),
            },
      );
      db.run(
        'UPDATE kb_inbox SET status=?,error=? WHERE run_id=?',
        change ? 'accepted' : 'error',
        change ? null : '服务中断，请重试',
        r.id,
      );
    }
  });
  for (const r of db.all<any>("SELECT DISTINCT kb_id FROM kb_inbox WHERE status='pending'")) queueMicrotask(() => drainInbox(r.kb_id));
}

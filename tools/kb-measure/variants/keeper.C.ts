import { db, now } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { conflict, notFound } from '../lib/http.js';
import { truncate } from '../lib/text.js';
import { streamChat, type Msg, type ToolCall, type ToolSpec } from '../llm/index.js';
import { createChange, isTidy, KEEPER_AUTHOR } from './changes.js';
import { cleanPath, FIXED_FILES, hashText, isTextPath, listFiles, MATERIALS_DIR, readText, type FileOp } from './repo.js';

/**
 * 整理助手：管知识库的 agent。
 * 它在一个暂存区里自由读写文件，做完把暂存区变成一次改动交给老师确认；
 * 读了什么、写了什么、说了什么都记进工作记录，老师在页面上实时看得到。
 */

export const KEEPER_NAME = '整理助手';

const prompt = (courseName: string) => `你是「${courseName}」的整理助手，负责管这门课的知识库。

知识库是给助教用的：助教回答学生、布置和批改作业之前都会先翻它。所以它要做到一个新来的助教读完，就能照这位老师的意思办事。

知识库是一个文件夹：
- 目录.md：知识库里有什么、放在哪。文件有增删时要同步改它。
- 进度.md：课讲到哪了，用老师自己的说法。
- 规矩.md：全课通用的规矩。
- 资料/：老师交的原件和转出来的文字，只能读，不能改。
- 笔记/：你整理的内容，按老师资料原来的分法组织。

做事的规矩：
- 只写老师资料里有的、老师说过的，不替老师补充。每条内容都写明出处：资料里的哪个文件、哪一部分，或者老师哪次说的。
- 这一届学生的情况（名单、成绩、谁学得怎样）不写进知识库：知识库年年都用，这些每届都不一样。
- 你写的东西不会马上生效，会作为一次改动交给老师确认。改完调用 finish，用一句话说清改了什么，再写依据。
- 老师只是问问题、不用改东西时，回答完调用 done。
- 跟老师说话时先说结论，说清楚就停。`;

const TOOLS: ToolSpec[] = [
  { name: 'list_files', description: '列出知识库里的文件，包括你这次还没交出去的改动。', parameters: { type: 'object', properties: {} } },
  {
    name: 'read_file',
    description: '读一个文字文件。文件很长时用 start_line、end_line 分段读。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: '在知识库所有文字文件里找包含这段文字的行。',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'write_file',
    description: '新建或整个重写一个 Markdown 文件，content 写完整内容。资料/ 下的文件不能改。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  { name: 'delete_file', description: '删除一个文件。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  {
    name: 'move_file',
    description: '移动或改名一个文件。',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  },
  {
    name: 'finish',
    description: '这次的改动做完了，交给老师确认。title 用一句话写改了什么；reason 写依据：老师的哪句话、哪份资料。',
    parameters: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] },
  },
  { name: 'done', description: '这次不用改知识库，话说完了。', parameters: { type: 'object', properties: {} } },
];

/** 只说话不调用工具时提醒一次：分不清它是答完了，还是嘴上说要改其实没动手 */
const NUDGE = '（系统注：你还没有调用工具。要改知识库就直接调用工具去改，改完调用 finish；不用改就调用 done。）';

const LABEL: Record<string, string> = {
  list_files: '看目录',
  read_file: '读',
  search: '查找',
  write_file: '写',
  delete_file: '删除',
  move_file: '移动',
  finish: '交给老师确认',
  done: '说完了',
};

const READ_LIMIT = 12000;

/* ---------------------------------------------------------------- 暂存区 */
class Workspace {
  private staged = new Map<string, { content: string | null; original: string | null }>();
  constructor(private courseId: number) {}

  read(path: string): string | null {
    const s = this.staged.get(path);
    return s ? s.content : readText(this.courseId, path);
  }

  private original(path: string) {
    const s = this.staged.get(path);
    return s ? s.original : readText(this.courseId, path);
  }

  private writable(path: string) {
    if (path === MATERIALS_DIR || path.startsWith(MATERIALS_DIR + '/')) throw new Error('资料/ 下是老师交的原件，不能改');
    if (!path.endsWith('.md')) throw new Error('知识库里你只能写 .md 文件');
  }

  write(path: string, content: string) {
    this.writable(path);
    this.staged.set(path, { content, original: this.original(path) });
  }

  remove(path: string) {
    this.writable(path);
    if (FIXED_FILES.includes(path)) throw new Error(`${path} 是固定文件，不能删`);
    if (this.read(path) === null) throw new Error(`没有这个文件：${path}`);
    this.staged.set(path, { content: null, original: this.original(path) });
  }

  async list(): Promise<{ path: string; size: number; pending?: string }[]> {
    const files = new Map((await listFiles(this.courseId)).map(f => [f.path, { path: f.path, size: f.size } as { path: string; size: number; pending?: string }]));
    for (const [path, s] of this.staged) {
      if (s.content === s.original) continue;
      if (s.content === null) files.set(path, { path, size: 0, pending: '待删除' });
      else files.set(path, { path, size: Buffer.byteLength(s.content), pending: s.original === null ? '待新建' : '待修改' });
    }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh'));
  }

  async textFiles(): Promise<string[]> {
    return (await this.list()).filter(f => f.pending !== '待删除' && isTextPath(f.path)).map(f => f.path);
  }

  ops(): FileOp[] {
    return [...this.staged.entries()]
      .filter(([, s]) => s.content !== s.original)
      .map(([path, s]) => ({ path, content: s.content, base: s.original === null ? null : hashText(s.original) }));
  }
}

/* ---------------------------------------------------------------- 工作记录 */
function record(courseId: number, runId: number, type: string, data: Record<string, unknown>) {
  const t = now();
  const id = db.insert('kb_events', { run_id: runId, type, data, created_at: t });
  bus.publish(`kb:${courseId}`, 'event', { runId, id, type, data, createdAt: t });
}

function publishRun(courseId: number, runId: number) {
  const r = db.get<any>('SELECT id, kind, status, request, reply, change_id, error, created_at, finished_at FROM kb_runs WHERE id = ?', runId);
  bus.publish(`kb:${courseId}`, 'run', r);
}

/* ---------------------------------------------------------------- 工具 */
async function runTool(ws: Workspace, call: ToolCall): Promise<{ content: string; event: Record<string, unknown> }> {
  const a = call.args as Record<string, any>;
  const base = { name: call.name, label: LABEL[call.name] || call.name };
  switch (call.name) {
    case 'list_files': {
      const files = await ws.list();
      return {
        content: files.map(f => `${f.path}（${f.size} 字节${f.pending ? '，' + f.pending : ''}）`).join('\n') || '知识库是空的',
        event: { ...base, count: files.length },
      };
    }
    case 'read_file': {
      const path = cleanPath(a.path);
      if (!isTextPath(path)) return { content: `${path} 不是文字文件，读它转出来的 .md`, event: { ...base, path, error: '不是文字文件' } };
      const text = ws.read(path);
      if (text === null) return { content: `没有这个文件：${path}`, event: { ...base, path, error: '没有这个文件' } };
      const lines = text.split('\n');
      const start = Math.max(1, Number(a.start_line) || 1);
      let end = Math.min(lines.length, Number(a.end_line) || lines.length);
      let chunk = lines.slice(start - 1, end).join('\n');
      if (chunk.length > READ_LIMIT) {
        let n = 0;
        let k = start - 1;
        while (k < end && n + lines[k].length + 1 <= READ_LIMIT) n += lines[k++].length + 1;
        end = Math.max(start, k);
        chunk = lines.slice(start - 1, end).join('\n');
      }
      const more = end < lines.length ? `\n\n（后面还有，从第 ${end + 1} 行接着读，共 ${lines.length} 行）` : '';
      return { content: `【${path}】第 ${start}-${end} 行\n${chunk}${more}`, event: { ...base, path, lines: `${start}-${end}`, total: lines.length } };
    }
    case 'search': {
      const q = String(a.text || '').trim().toLowerCase();
      if (!q) return { content: '没有要找的文字', event: { ...base, error: '空' } };
      const hits: string[] = [];
      for (const path of await ws.textFiles()) {
        const text = ws.read(path) || '';
        text.split('\n').forEach((line, i) => {
          if (hits.length < 40 && line.toLowerCase().includes(q)) hits.push(`${path}:${i + 1}: ${truncate(line.trim(), 120)}`);
        });
      }
      return { content: hits.join('\n') || '没找到', event: { ...base, text: a.text, hits: hits.length } };
    }
    case 'write_file': {
      const path = cleanPath(a.path);
      const content = String(a.content ?? '');
      const isNew = ws.read(path) === null;
      ws.write(path, content.endsWith('\n') ? content : content + '\n');
      return { content: `已写好（还没生效）：${path}，${content.length} 字`, event: { ...base, path, chars: content.length, isNew } };
    }
    case 'delete_file': {
      const path = cleanPath(a.path);
      ws.remove(path);
      return { content: `已标记删除（还没生效）：${path}`, event: { ...base, path } };
    }
    case 'move_file': {
      const from = cleanPath(a.from);
      const to = cleanPath(a.to);
      const text = ws.read(from);
      if (text === null) throw new Error(`没有这个文件：${from}`);
      if (ws.read(to) !== null) throw new Error(`${to} 已经有了`);
      ws.write(to, text);
      ws.remove(from);
      return { content: `已移动（还没生效）：${from} → ${to}`, event: { ...base, from, to } };
    }
    case 'finish':
      return { content: '好', event: { ...base, title: a.title, reason: a.reason } };
    case 'done':
      return { content: '好', event: base };
  }
  return { content: `没有这个工具：${call.name}`, event: { ...base, error: '没有这个工具' } };
}

/* ---------------------------------------------------------------- 运行 */
const active = new Map<number, { runId: number; ctrl: AbortController }>();

export const activeRun = (courseId: number) => active.get(courseId)?.runId ?? null;

export function startRun(courseId: number, kind: 'materials' | 'chat', request: string, user: { id: number; name: string }): number {
  if (active.has(courseId)) throw conflict('整理助手正在忙，等它做完这件再说');
  const runId = db.insert('kb_runs', { course_id: courseId, kind, status: 'running', request, created_by: user.id, created_at: now() });
  const ctrl = new AbortController();
  active.set(courseId, { runId, ctrl });
  publishRun(courseId, runId);
  execute(courseId, runId, kind, request, user, ctrl.signal)
    .catch(err => {
      const msg = ctrl.signal.aborted ? '老师让它停下了' : (err as Error)?.message || String(err);
      record(courseId, runId, 'error', { message: msg });
      db.update('kb_runs', runId, { status: ctrl.signal.aborted ? 'canceled' : 'error', error: msg, finished_at: now() });
    })
    .finally(() => {
      active.delete(courseId);
      publishRun(courseId, runId);
    });
  return runId;
}

export function cancelRun(courseId: number, runId: number) {
  const a = active.get(courseId);
  if (!a || a.runId !== runId) throw notFound('这件事已经做完了');
  a.ctrl.abort(new Error('老师让它停下了'));
}

function nowText() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`;
}

const OUTCOME: Record<string, string> = {
  applied: '老师已确认，已经生效',
  pending: '还在等老师确认，没有生效',
  conflict: '还在等老师确认，没有生效',
  rejected: '老师没同意，没有生效',
  reverted: '后来被老师撤回了，没有生效',
};

/**
 * 前面几次交代和回复，接着上次的话说。
 * 每次回复后面由系统注明那次改动到底生效没有：只给它看自己说过的话，它会把没生效的改动当成已经改了。
 */
function recentTalk(courseId: number, runId: number): Msg[] {
  const rows = db.all<{ request: string; reply: string | null; status: string; change_id: number | null }>(
    `SELECT request, reply, status, change_id FROM kb_runs WHERE course_id = ? AND id < ? ORDER BY id DESC LIMIT 6`,
    courseId,
    runId,
  );
  return rows.reverse().flatMap(r => {
    let fact = '（系统注：这次没有改知识库）';
    if (r.status !== 'done') fact = '（系统注：这次没做完，没有改知识库）';
    else if (r.change_id) {
      const c = db.get<{ title: string; status: string }>('SELECT title, status FROM kb_changes WHERE id = ?', r.change_id);
      if (c) fact = `（系统注：这次交了改动「${c.title}」，${OUTCOME[c.status] || c.status}）`;
    }
    return [
      { role: 'user' as const, content: r.request },
      { role: 'assistant' as const, content: `${r.reply || ''}\n${fact}`.trim() },
    ];
  });
}

async function execute(courseId: number, runId: number, kind: string, request: string, user: { id: number; name: string }, signal: AbortSignal) {
  const course = db.get<{ name: string }>('SELECT name FROM courses WHERE id = ?', courseId);
  if (!course) throw new Error('课程不存在');
  const ws = new Workspace(courseId);
  const tree = (await listFiles(courseId)).map(f => `- ${f.path}（${f.size} 字节）`).join('\n');
  const messages: Msg[] = [
    { role: 'system', content: `${prompt(course.name)}\n\n## 现在\n- 今天：${nowText()}\n- 老师：${user.name}\n- 知识库里的文件：\n${tree}` },
    ...recentTalk(courseId, runId),
    { role: 'user', content: request },
  ];
  const maxSteps = kind === 'materials' ? 60 : 30;
  let reply = '';
  let finish: { title: string; reason: string } | null = null;
  let ended = false;
  let nudges = 0;

  for (let step = 0; step < maxSteps && !ended; step++) {
    const calls: ToolCall[] = [];
    let text = '';
    for await (const d of streamChat({
      agentKey: 'keeper',
      messages,
      tools: step < maxSteps - 1 ? TOOLS : TOOLS.filter(t => t.name === 'finish' || t.name === 'done'),
      temperature: 0.3,
      maxTokens: 8192,
      userId: user.id,
      purpose: `kb:${kind}`,
      signal,
      countQuota: false,
    })) {
      if (d.type === 'text') {
        text += d.text;
        bus.publish(`kb:${courseId}`, 'delta', { runId, text: d.text });
      } else if (d.type === 'tool') calls.push(d.call);
      else if (d.type === 'model') text = '';
    }
    if (text.trim()) {
      record(courseId, runId, 'say', { text: text.trim() });
      reply = text.trim();
    }
    if (!calls.length) {
      if (nudges >= 2) break;
      nudges++;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: NUDGE });
      continue;
    }
    messages.push({ role: 'assistant', content: text, toolCalls: calls });
    for (const call of calls) {
      let content: string;
      try {
        const out = await runTool(ws, call);
        content = out.content;
        record(courseId, runId, 'tool', out.event);
        if (call.name === 'finish') finish = { title: String(call.args.title || '').trim(), reason: String(call.args.reason || '').trim() };
        if (call.name === 'finish' || call.name === 'done') ended = true;
      } catch (err) {
        content = `没做成：${(err as Error).message}`;
        record(courseId, runId, 'tool', { name: call.name, label: LABEL[call.name] || call.name, path: call.args.path ?? call.args.from, error: (err as Error).message });
      }
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
    }
  }

  const ops = ws.ops();
  let changeId: number | null = null;
  if (ops.length) {
    const tidy = isTidy(courseId, ops);
    const c = await createChange({
      courseId,
      title: finish?.title || truncate(reply || '整理了知识库', 60),
      reason: finish?.reason || (finish ? null : '步数用完了，先把已经整理好的部分交上来'),
      author: 'keeper',
      authorName: KEEPER_NAME,
      kind: tidy ? 'tidy' : 'keeper',
      ops,
      runId,
      apply: tidy ? { by: null, as: KEEPER_AUTHOR } : undefined,
    });
    changeId = c.id;
    record(courseId, runId, 'change', { changeId: c.id, status: c.status, title: c.title, files: ops.length });
  }
  // 交了改动时，回复就是这次改了什么；前面那些“我先读一遍”是过程，留在工作记录里
  if (finish?.title) reply = finish.title;
  db.update('kb_runs', runId, { status: 'done', reply: reply || null, change_id: changeId, finished_at: now() });
}

export function publicRun(r: any) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    request: r.request,
    reply: r.reply,
    changeId: r.change_id,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

/** 服务重启时还在跑的工作记成中断 */
export function recoverRuns() {
  db.run(`UPDATE kb_runs SET status = 'error', error = '服务重启，这次没做完', finished_at = ? WHERE status = 'running'`, now());
}

/**
 * 外壳：整理助手的一轮。
 * 以前每一轮起一个 Claude Code（命令行版，背后是 DeepSeek），它只能接带工具的 Anthropic 写法；现在在服务里直接跟模型来回，
 * 默认是服务器上的 Gemini，出错或一直没动静换 DeepSeek（llm 那层管）。
 * 工作目录还是老师的桌面（老师所有的知识库，一个文件夹一个）。工具：读、写、改、看目录、查找，都只在桌面里；
 * 挪、删、存、交改动、看改动、撤回、新建改名删除知识库照旧用 ct 命令（commands.ts），只是不再绕本机接口。
 * 一段对话记在 agent_messages（thread 就是 sessionId），接着说就是接着这一段；太长了把前面压成概要。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { db, getSetting } from '../../db/index.js';
import { streamChat, type Effort, type Msg, type ToolCall, type ToolSpec } from '../../llm/index.js';
import { append, compact, requestMessages, stored } from '../../assistant/thread.js';
import { USAGE } from './commands.js';
import { publish, record, type RunRef } from './events.js';

export interface TurnRun {
  ref: RunRef;
  /** 工作目录（老师的桌面） */
  cwd: string;
  message: string;
  systemPrompt: string;
  /** 接着哪一段对话说；没有就新开 */
  sessionId: string | null;
  /** 这一轮最多来回几次（读一份、写一份都算一次） */
  maxTurns: number;
  /** 一轮最长多久，多久没动静算卡住 */
  turnMs: number;
  quietMs: number;
  /** ct 命令：这一轮的（挪、删、存、交……） */
  ct: (args: string[]) => Promise<{ ok: boolean; text: string }>;
  userId: number;
  purpose: string;
  signal: AbortSignal;
}

export interface TurnResult {
  sessionId: string | null;
  reply: string;
  error: string | null;
  /** 对话接不上（记录丢了）：调用方换一段新对话再来 */
  lostSession: boolean;
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const PATH = str('从工作目录算起的路径，第一段是知识库的文件夹');

export const TOOLS: ToolSpec[] = [
  { name: 'read_file', description: '读一份文字文件，每行前面带行号。', parameters: obj({ path: PATH, offset: num('从第几行读，默认从头'), limit: num('读几行，默认 400') }, ['path']) },
  { name: 'write_file', description: '写一份文字文件：没有就新建，有就整份换掉。', parameters: obj({ path: PATH, content: str('全文') }, ['path', 'content']) },
  {
    name: 'edit_file',
    description: '改一份文字文件里的一段：old 要跟原文一字不差，而且只出现一次（all 为 true 时每处都换）。',
    parameters: obj({ path: PATH, old: str('原来那段'), new: str('换成'), all: { type: 'boolean', description: '每处都换' } }, ['path', 'old', 'new']),
  },
  { name: 'list_files', description: '看一个文件夹里有什么（连下面的子文件夹）。', parameters: obj({ path: str('文件夹；不写是工作目录，能看到所有知识库') }) },
  { name: 'search', description: '在文字文件里查一段字，返回在哪份文件第几行。', parameters: obj({ text: str('要查的字'), path: str('只在这个文件夹里查；不写查全部') }, ['text']) },
  {
    name: 'ct',
    description: `整理助手的命令，args 是 ct 后面那几段，比如 ["交", "改了什么", "依据"]。\n${USAGE}`,
    parameters: obj({ args: { type: 'array', items: { type: 'string' } } }, ['args']),
  },
];

const MAX_READ = 40_000;
const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

/** 桌面里的路径：不许出桌面 */
function inside(cwd: string, p: unknown): { abs: string; rel: string } {
  const raw = String(p ?? '')
    .trim()
    .replace(/\\/g, '/');
  const abs = resolve(cwd, isAbsolute(raw) ? relative('/', raw) : raw || '.');
  const rel = relative(cwd, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能用工作目录里的文件');
  return { abs, rel };
}

/** 一个文件夹下面所有的文件（不看点开头的），最多这么多个 */
function walk(dir: string, limit: number, out: string[] = [], base = dir): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort((a, b) => a.localeCompare(b, 'zh'));
  } catch {
    return out;
  }
  for (const n of names) {
    if (out.length >= limit) break;
    if (n.startsWith('.')) continue;
    const p = join(dir, n);
    const st = statSync(p);
    const rel = relative(base, p).replace(/\\/g, '/');
    if (st.isDirectory()) {
      out.push(rel + '/');
      walk(p, limit, out, base);
    } else out.push(rel);
  }
  return out;
}

/** 跑一个工具：返回给模型的话，和要记给老师看的那一条（ct 那边自己记） */
async function runTool(t: TurnRun, call: ToolCall): Promise<{ out: string; ev: Record<string, unknown> | null }> {
  const a = call.args || {};
  switch (call.name) {
    case 'read_file': {
      const { abs, rel } = inside(t.cwd, a.path);
      const ev = { name: 'read_file', label: '读', path: rel };
      if (!existsSync(abs)) throw Object.assign(new Error('没有这个文件'), { ev });
      if (statSync(abs).isDirectory()) return { out: walk(abs, 300).join('\n') || '（空文件夹）', ev: { name: 'list_files', label: '看目录', path: rel } };
      const b = readFileSync(abs);
      if (!isText(b)) throw Object.assign(new Error('这是原件（不是文字），读它旁边转出来的文字版'), { ev });
      const lines = b.toString('utf8').split('\n');
      const from = Math.max(0, Math.round(Number(a.offset) || 1) - 1);
      const n = Math.max(1, Math.round(Number(a.limit) || 400));
      let text = lines
        .slice(from, from + n)
        .map((l, i) => `${from + i + 1}\t${l}`)
        .join('\n');
      if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + '\n（太长，后面没读，分段读）';
      const rest = lines.length - from - n;
      return { out: (text || '（空文件）') + (rest > 0 ? `\n（还有 ${rest} 行，接着读 offset=${from + n + 1}）` : ''), ev };
    }
    case 'write_file': {
      const { abs, rel } = inside(t.cwd, a.path);
      const content = String(a.content ?? '');
      const ev = { name: 'write_file', label: '写', path: rel, chars: content.length };
      if (!rel || existsSync(abs) && statSync(abs).isDirectory()) throw Object.assign(new Error('要写的是一份文件，不是文件夹'), { ev });
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return { out: `写好了「${rel}」`, ev };
    }
    case 'edit_file': {
      const { abs, rel } = inside(t.cwd, a.path);
      const ev = { name: 'edit_file', label: '改', path: rel };
      if (!existsSync(abs)) throw Object.assign(new Error('没有这个文件'), { ev });
      const text = readFileSync(abs, 'utf8');
      const old = String(a.old ?? '');
      if (!old) throw Object.assign(new Error('要改的那段没写'), { ev });
      const n = text.split(old).length - 1;
      if (!n) throw Object.assign(new Error('要改的那段没找到，先读一遍再改'), { ev });
      if (n > 1 && a.all !== true) throw Object.assign(new Error(`要改的那段有 ${n} 处，多带几个字让它只出现一次，或者 all 写 true`), { ev });
      writeFileSync(abs, a.all === true ? text.split(old).join(String(a.new ?? '')) : text.replace(old, () => String(a.new ?? '')));
      return { out: `改好了「${rel}」${n > 1 ? `（${n} 处）` : ''}`, ev };
    }
    case 'list_files': {
      const { abs, rel } = inside(t.cwd, a.path);
      const ev = { name: 'list_files', label: '看目录', path: rel };
      if (!existsSync(abs)) throw Object.assign(new Error('没有这个文件夹'), { ev });
      const list = walk(abs, 400);
      return { out: list.length ? list.join('\n') + (list.length >= 400 ? '\n（太多，只列了前 400 个）' : '') : '（空文件夹）', ev };
    }
    case 'search': {
      const q = String(a.text ?? '').trim();
      const ev = { name: 'search', label: '查找', text: q.slice(0, 200) };
      if (!q) throw Object.assign(new Error('要查什么没写'), { ev });
      const { abs } = inside(t.cwd, a.path);
      const hits: string[] = [];
      const low = q.toLowerCase();
      for (const f of walk(abs, 3000)) {
        if (f.endsWith('/') || hits.length >= 60) continue;
        const p = join(abs, f);
        let b: Buffer;
        try {
          if (statSync(p).size > 2_000_000) continue;
          b = readFileSync(p);
        } catch {
          continue;
        }
        if (!isText(b)) continue;
        b.toString('utf8')
          .split('\n')
          .forEach((line, i) => {
            if (hits.length < 60 && line.toLowerCase().includes(low)) hits.push(`${relative(t.cwd, p).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 160)}`);
          });
      }
      return { out: hits.length ? hits.join('\n') : `没找到「${q}」`, ev };
    }
    case 'ct': {
      const args = (Array.isArray(a.args) ? a.args : String(a.args ?? '').split(/\s+/)).slice(0, 20).map((x: unknown) => String(x ?? '').slice(0, 4000));
      const r = await t.ct(args);
      return { out: r.text, ev: null };
    }
    default:
      return { out: `没有「${call.name}」这个工具`, ev: null };
  }
}

/** 出错的话：给模型看原话；记给老师看的不带服务器上的路径，英文的不记 */
function shown(cwd: string, msg: string) {
  if (/EACCES|EPERM|read-?only/i.test(msg)) return '原件是只读的，不能改';
  const plain = msg.split(cwd).join('');
  return /[㐀-鿿]/.test(plain) ? plain.slice(0, 200) : null;
}

/** 调一步模型（测试里换成写好的） */
export type KeeperStep = (o: { messages: Msg[]; tools: ToolSpec[]; userId: number; purpose: string; signal: AbortSignal }) => Promise<{ text: string; toolCalls: ToolCall[]; reasoning?: string }>;
const modelStep: KeeperStep = async (o) => {
  let text = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  const think = getSetting<'off' | Effort>('keeper_think', 'high');
  for await (const d of streamChat({
    agentKey: 'keeper',
    messages: o.messages,
    tools: o.tools,
    userId: o.userId,
    purpose: o.purpose,
    signal: o.signal,
    countQuota: false,
    think,
    firstTokenMs: 120_000,
    maxTokens: 32000,
  })) {
    if (d.type === 'text') text += d.text;
    else if (d.type === 'reasoning') reasoning += d.text;
    else if (d.type === 'tool') toolCalls.push(d.call);
    else if (d.type === 'model') {
      text = '';
      reasoning = '';
      toolCalls.length = 0;
    }
  }
  return { text, toolCalls, ...(reasoning ? { reasoning } : {}) };
};
let step: KeeperStep = modelStep;
/** 测试用：换成写好的回答；传 null 换回真的模型 */
export function setKeeperStep(fn: KeeperStep | null) {
  step = fn ?? modelStep;
}

const COMPACT = '把前面整理助手和老师的对话压成一段概要：老师交代过的要求和偏好、做过哪些整理（改了哪些知识库的哪些文件）、老师确认或撤回了什么、还没办完的事。';

export async function runTurn(t: TurnRun): Promise<TurnResult> {
  const owner = t.ref.teacherId;
  const exists = (k: string) => !!db.value('SELECT 1 FROM agent_messages WHERE owner_id=? AND thread=? LIMIT 1', owner, k);
  if (t.sessionId && !exists(t.sessionId)) return { sessionId: t.sessionId, reply: '', error: null, lostSession: true };
  const sid = t.sessionId || `keeper:${owner}:${t.ref.runId}`;
  const out: TurnResult = { sessionId: sid, reply: '', error: null, lostSession: false };
  const ctrl = new AbortController();
  const stop = () => ctrl.abort(t.signal.reason);
  t.signal.addEventListener('abort', stop, { once: true });
  const t0 = Date.now();
  let last = Date.now();
  const watch = setInterval(() => {
    const n = Date.now();
    if (n - t0 > t.turnMs || n - last > t.quietMs) {
      out.error ||= '这一轮太久或卡住了，已停下';
      ctrl.abort(new Error('timeout'));
    }
  }, 5000);
  try {
    if (t.sessionId)
      await compact({ ownerId: owner, key: sid, signal: ctrl.signal, who: { user: '老师', agent: '整理助手' }, instruction: COMPACT, agentKey: 'keeper', purpose: 'keeper:compact' }).catch(() => {});
    append(owner, sid, t.ref.runId, { role: 'user', content: t.message });
    for (let n = 0; n < t.maxTurns; n++) {
      ctrl.signal.throwIfAborted();
      const r = await step({ messages: requestMessages(owner, sid, t.systemPrompt), tools: TOOLS, userId: t.userId, purpose: t.purpose, signal: ctrl.signal });
      last = Date.now();
      append(owner, sid, t.ref.runId, { role: 'assistant', content: r.text, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}), ...(r.reasoning ? { reasoning: r.reasoning } : {}) });
      const say = r.text.trim();
      if (!r.toolCalls.length) {
        out.reply = say;
        if (say) publish(t.ref, 'delta', { runId: t.ref.runId, text: say });
        return out;
      }
      // 一步之间说的话记成工作记录里的一句（没有中文的是它自言自语，不记）
      if (say && /[㐀-鿿]/.test(say)) record(t.ref, 'say', { text: say });
      for (const call of r.toolCalls) {
        let text: string;
        try {
          const { out: o, ev } = await runTool(t, call);
          text = o;
          if (ev) record(t.ref, 'tool', ev);
        } catch (err) {
          const e = err as Error & { ev?: Record<string, unknown> };
          text = `没办成：${e.message}`;
          const error = shown(t.cwd, e.message);
          if (e.ev && error) record(t.ref, 'tool', { ...e.ev, error });
        }
        append(owner, sid, t.ref.runId, { role: 'tool', toolCallId: call.id, content: text });
        last = Date.now();
      }
    }
    out.error ||= '这件事步骤太多，做到一半停下了，可以接着跟它说';
    return out;
  } catch (err) {
    // 根本没有能用的模型：照以前那样往上抛（交资料就停在「暂停」，接上模型后能接着整理）
    if ((err as { status?: number })?.status === 503) throw err;
    if (!out.error && !t.signal.aborted) out.error = (err as Error).message || '整理助手没能完成';
    if (out.error) console.error('[agent] turn', t.ref.runId, out.error);
    return out;
  } finally {
    clearInterval(watch);
    t.signal.removeEventListener('abort', stop);
  }
}

/** 测试看的：这段对话记了几条 */
export const turnMessages = (owner: number, sid: string) => stored(owner, sid, 0);

/**
 * 外壳：整理助手的每一轮就是跑一次 Claude Code（命令行版），背后的模型是 DeepSeek（走它兼容 Anthropic 的接口）。
 * 照新工坊的做法：给它老师的桌面当工作目录，只放开自带的读写查找和 ct 命令，接着同一段对话说（--resume）。
 * 它的输出（stream-json）一行一条，这里翻成工作记录：读了什么、写了什么、说了什么。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { db, now } from '../../db/index.js';
import { providerConn } from '../../llm/index.js';
import { agentDir } from './desk.js';
import { publish, record, type RunRef } from './events.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Claude Code 程序：生产上是服务器装好的那个，本机测量时用环境变量指定 */
export function claudeBin() {
  if (process.env.CT_CLAUDE) return process.env.CT_CLAUDE;
  return process.platform === 'win32' ? 'claude' : '/usr/local/bin/claude';
}

/** ct 命令：一个很小的脚本，把整理助手敲的命令转给服务器（带这一轮的口令） */
export function ctBinDir() {
  const dir = join(config.dataDir, 'agent', 'bin');
  mkdirSync(dir, { recursive: true });
  const cli = [join(here, 'ct.mjs'), resolve(here, '..', '..', '..', 'dist', 'ct.mjs')].find((p) => existsSync(p)) || join(here, 'ct.mjs');
  const node = process.execPath.replace(/\\/g, '/');
  writeFileSync(join(dir, 'ct'), `#!/bin/sh\nexec "${node}" "${cli.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'bash-gate.mjs'), GATE);
  return dir;
}

/**
 * 跑命令前的关卡：只放行 ct（Claude Code 自己会放行 ls、cat 这类「只看」的命令，服务器上实测放行了，
 * 那样能看到桌面外面的东西，所以这里一律只认 ct）。双引号里的 $、反引号也不行，那会在 shell 里展开执行。
 */
const GATE = `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let cmd='';try{cmd=String(JSON.parse(s).tool_input?.command||'')}catch{}
let bad=false;let rest=cmd.replace(/'[^']*'/g,"''").replace(/"((?:[^"\\\\]|\\\\.)*)"/g,(m,inner)=>{if(/[\`$\\\\]/.test(inner))bad=true;return '""'});
if(/[;&|<>()\`$\\n\\r\\\\]/.test(rest))bad=true;
if(!bad&&/^\\s*ct(\\s|$)/.test(rest))process.exit(0);
process.stderr.write('只能用 ct 命令（ct 帮助 看用法），别的命令用不了');process.exit(2)});
`;

function gateSettings(bin: string) {
  const node = process.execPath.replace(/\\/g, '/');
  const gate = join(bin, 'bash-gate.mjs').replace(/\\/g, '/');
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${node}" "${gate}"` }] }] } });
}

/** 整理助手用的模型：DeepSeek 官方，走它兼容 Anthropic 的口子 */
export function agentModel() {
  const row = db.get<any>(
    `SELECT m.id AS mid, m.model, p.* FROM models m JOIN providers p ON p.id=m.provider_id
     WHERE m.model='deepseek-flash' AND m.enabled=1 AND p.enabled=1 ORDER BY m.id LIMIT 1`,
  );
  if (!row) throw new Error('DeepSeek V4.1 Flash 当前不可用，请检查模型配置');
  const conn = providerConn(row);
  const base = String(conn.baseUrl || '').replace(/\/+$/, '');
  return {
    modelRowId: row.mid as number,
    providerId: row.id as number,
    model: row.model as string,
    baseUrl: conn.protocol === 'anthropic' ? base : base.replace(/\/v1$/, '') + '/anthropic',
    key: conn.apiKey,
  };
}

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
  /** ct 命令找服务器用的口令 */
  token: string;
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

/** 桌面上的绝对路径换成「知识库文件夹/里面的路径」 */
function deskPath(cwd: string, p: unknown) {
  if (typeof p !== 'string' || !p) return '';
  const abs = isAbsolute(p) ? p : join(cwd, p);
  const rel = relative(cwd, abs).replace(/\\/g, '/');
  return rel.startsWith('..') ? '' : rel;
}

/** Claude Code 自带工具的一步翻成工作记录（ct 命令那边自己记） */
function toolEvent(cwd: string, name: string, input: any): Record<string, unknown> | null {
  switch (name) {
    case 'Read':
      return { name: 'read_file', label: '读', path: deskPath(cwd, input?.file_path) };
    case 'Write':
      return { name: 'write_file', label: '写', path: deskPath(cwd, input?.file_path), chars: String(input?.content ?? '').length };
    case 'Edit':
    case 'MultiEdit':
      return { name: 'edit_file', label: '改', path: deskPath(cwd, input?.file_path) };
    case 'Glob': {
      // 看的是哪个库、哪个文件夹：没给目录就从查找的样式里取开头那一段（不带通配符的）
      const lead = String(input?.pattern ?? '')
        .split('/')
        .filter((seg) => seg && !/[*?[\]{}]/.test(seg))
        .slice(0, 2)
        .join('/');
      return { name: 'list_files', label: '看目录', path: deskPath(cwd, input?.path) || lead };
    }
    case 'Grep':
      return { name: 'search', label: '查找', text: String(input?.pattern ?? '').slice(0, 200) };
    default:
      return null;
  }
}

/**
 * 自带工具出错：原话是给整理助手看的（英文、带服务器上的路径），记给老师看的换成一句话。
 * 以前原样记下，老师那边看到「EISDIR: illegal operation on a directory, read '/…/work/…'」（2026-11-11）。
 */
function errorText(cwd: string, content: unknown) {
  const s = (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text || '').join('') : '')
    .replace(/<\/?tool_use_error>/g, '')
    .trim();
  // 拿读文件去读一个文件夹：是它在看文件夹里有什么（ls 用不了），不是事情没做成，老师那边不记（真实资料测试 16 遍里 5 遍有，2026-11-11）
  if (/EISDIR|is a directory/i.test(s)) return null;
  if (/has not been read yet|read it first/i.test(s)) return '要先读一遍再改';
  if (/modified since read/i.test(s)) return '读过以后又变了，要重新读';
  if (/String to replace not found/i.test(s)) return '要改的那段没找到';
  if (/Found \d+ matches/i.test(s)) return '要改的那段有好几处';
  if (/exceeds maximum|too large|too long/i.test(s)) return '太长了，要分段读';
  if (/ENOENT|does not exist|no such file/i.test(s)) return '没有这个文件';
  if (/EACCES|EPERM|read-?only/i.test(s)) return '原件是只读的，不能改';
  // 想看桌面以外的地方被挡回去：是边界在起作用，不是事情没做成，老师那边不记
  if (/denied|not allowed|permission/i.test(s)) return null;
  const plain = s
    .split(cwd)
    .join('')
    .replace(/[A-Za-z]:\\[^\s'"，。]*|\/(?:root|var|home|tmp|opt|srv|usr)\/[^\s'"，。]*/g, '');
  return /[㐀-鿿]/.test(plain) ? plain.slice(0, 200) : '没做成';
}

function kill(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 已经结束 */
    }
}

export async function runTurn(t: TurnRun): Promise<TurnResult> {
  const m = agentModel();
  const home = agentDir(t.ref.teacherId);
  mkdirSync(join(home, 'config'), { recursive: true });
  mkdirSync(join(home, 'home'), { recursive: true });
  const bin = ctBinDir();
  const base: NodeJS.ProcessEnv =
    process.platform === 'win32'
      ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|CLAUDE|HTTPS?_PROXY|NO_PROXY)/i.test(k)))
      : { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: join(home, 'home'),
    CLAUDE_CONFIG_DIR: join(home, 'config'),
    PATH: `${bin}${delimiter}${base.PATH || base.Path || ''}`,
    ANTHROPIC_BASE_URL: m.baseUrl,
    ANTHROPIC_AUTH_TOKEN: m.key,
    ANTHROPIC_MODEL: m.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m.model,
    CLAUDE_CODE_SUBAGENT_MODEL: m.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1',
    API_TIMEOUT_MS: '600000',
    CT_AGENT_URL: `http://127.0.0.1:${config.port}/internal/agent`,
    CT_AGENT_TOKEN: t.token,
  };
  if (process.platform === 'win32') delete env.Path;
  const args = [
    '-p',
    '--model',
    m.model,
    '--effort',
    process.env.CT_AGENT_EFFORT || 'medium',
    '--max-turns',
    String(t.maxTurns),
    '--setting-sources',
    '',
    '--settings',
    gateSettings(bin),
    '--tools',
    'Read,Write,Edit,Glob,Grep,Bash',
    // 读、找、写都只在老师自己的桌面里（找文件、搜内容不单独放开：在桌面里照样能用，往外就被拦下，2026-11-10 实测）
    '--allowedTools',
    'Bash(ct:*),Read(./**),Write(./**),Edit(./**)',
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--system-prompt',
    t.systemPrompt,
    ...(t.sessionId ? ['--resume', t.sessionId] : []),
  ];
  const t0 = Date.now();
  const out: TurnResult = { sessionId: t.sessionId, reply: '', error: null, lostSession: false };
  const usage = { input: 0, output: 0 };
  const pending = new Map<string, { name: string; input: any }>();
  let pendingText = '';
  let stderr = '';
  let last = Date.now();
  const child = spawn(claudeBin(), args, { cwd: t.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const stop = () => kill(child.pid);
  t.signal.addEventListener('abort', stop, { once: true });
  const watch = setInterval(() => {
    const n = Date.now();
    if (n - t0 > t.turnMs || n - last > t.quietMs) {
      out.error ||= '这一轮太久或卡住了，已停下';
      stop();
    }
  }, 5000);
  child.stdin.end(t.message);
  child.stderr.on('data', (c) => {
    stderr = (stderr + String(c)).slice(-4000);
  });
  /**
   * 一步之间说的话：后面接着用工具的，记成工作记录里的一句；最后那段是回给老师的话。
   * 没有中文的不记：那是它自言自语（221 句里有 1 句英文「I'll start by surveying…」，2026-11-11），老师看不懂也用不着。
   */
  const flushSay = () => {
    const s = pendingText.trim();
    pendingText = '';
    if (s && /[㐀-鿿]/.test(s)) record(t.ref, 'say', { text: s });
  };
  let buf = '';
  const handle = (line: string) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    last = Date.now();
    if (e.session_id) out.sessionId = e.session_id;
    if (e.type === 'stream_event') {
      const ev = e.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text)
        publish(t.ref, 'delta', { runId: t.ref.runId, text: ev.delta.text });
      return;
    }
    if (e.type === 'assistant') {
      for (const b of e.message?.content || []) {
        if (b.type === 'text' && b.text) pendingText += b.text;
        else if (b.type === 'tool_use') {
          flushSay();
          pending.set(b.id, { name: b.name, input: b.input });
        }
      }
      return;
    }
    if (e.type === 'user') {
      for (const b of e.message?.content || []) {
        if (b.type !== 'tool_result') continue;
        const call = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        if (!call) continue;
        const ev = toolEvent(t.cwd, call.name, call.input);
        if (!ev) continue;
        if (!b.is_error) record(t.ref, 'tool', ev);
        else {
          const error = errorText(t.cwd, b.content);
          if (error) record(t.ref, 'tool', { ...ev, error });
        }
      }
      return;
    }
    if (e.type === 'result') {
      out.reply = String(e.result || pendingText || '').trim();
      pendingText = '';
      usage.input = (e.usage?.input_tokens || 0) + (e.usage?.cache_read_input_tokens || 0) + (e.usage?.cache_creation_input_tokens || 0);
      usage.output = e.usage?.output_tokens || 0;
      if (e.is_error) {
        const why = String(e.result || e.subtype || '').slice(0, 300);
        if (e.subtype === 'error_max_turns') out.error ||= '这件事步骤太多，做到一半停下了，可以接着跟它说';
        else out.error ||= why || '整理助手没能完成';
      }
    }
  };
  child.stdout.on('data', (c) => {
    buf += String(c);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });
  const code: number | null = await new Promise((done) => {
    child.on('close', (c) => done(c));
    child.on('error', (err) => {
      out.error ||= `整理助手没能启动：${err.message}`;
      done(null);
    });
  });
  clearInterval(watch);
  t.signal.removeEventListener('abort', stop);
  if (buf.trim()) handle(buf.trim());
  const tail = stderr.replaceAll(m.key, '<key>');
  if (t.sessionId && /No conversation found|session.*not found/i.test(tail + out.error)) out.lostSession = true;
  if (code && !out.reply && !out.error) out.error = `整理助手没能完成（${code}）：${tail.trim().split('\n').pop()?.slice(0, 200) || ''}`;
  if (out.error) console.error('[agent] turn', t.ref.runId, out.error, tail.slice(-500));
  db.insert('llm_calls', {
    agent_key: 'keeper',
    provider_id: m.providerId,
    model_id: m.modelRowId,
    model: m.model,
    user_id: t.userId,
    purpose: t.purpose,
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    latency_ms: Date.now() - t0,
    status: out.error ? 'error' : 'ok',
    error: out.error,
    request_preview: t.message.slice(0, 200),
    created_at: now(),
  });
  return out;
}

/**
 * CoT 助教的一轮：老师说一句（可带文件），助教调模型、用工具办事，直到给出回话，或者用问题卡片问老师、停下来等。
 * 跟模型说的每一条记在 agent_messages 里，只往后加：前面不变，DeepSeek 那边的缓存才命中得上。
 * 整理资料交给后台的整理助手（还是 Claude Code），它做完的消息在下一轮带给助教。
 */
import { config } from '../config.js';
import { db, j, now } from '../db/index.js';
import { conflict, HttpError, notFound } from '../lib/http.js';
import { estimateTokens } from '../lib/text.js';
import { streamChat } from '../llm/index.js';
import type { Msg, ToolCall, ToolSpec } from '../llm/types.js';
import { publish, record, type RunRef } from '../kb/agent/events.js';
import { findKb, listKbs } from '../kb/bases.js';
import { intakeItems, readBlobText } from '../kb/intake/store.js';
import { KIND_LABEL, type Kind } from '../kb/intake/kinds.js';
import { publishRun, setTaFilesHandler, startKeeperJob } from '../kb/keeper.js';
import { ensureThread, takeNotes, TA_THREAD } from './notes.js';
import { taPrompt, turnBlock } from './prompt.js';
import { classesOf } from './resolve.js';
import { nowLine } from './time.js';
import { ASK_TOOL, runTaTool, TOOL_SPECS, type TaContext } from './tools.js';

/** 一轮里最多来回几次（调一次工具算一次） */
const MAX_STEPS = 16;
/** 对话太长时把前面的压成一段：超过这么多（估算）就压，留最近这么多条原样 */
const COMPACT_AT = 60_000;
const KEEP_RECENT = 24;

/* ---------------- 模型那一步（测试里换成写好的） ---------------- */

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
}
export type ModelStep = (o: { messages: Msg[]; tools: ToolSpec[]; userId: number; signal: AbortSignal; onText: (t: string) => void }) => Promise<StepResult>;

const deepseekStep: ModelStep = async (o) => {
  let text = '';
  const toolCalls: ToolCall[] = [];
  for await (const d of streamChat({
    agentKey: 'ta',
    messages: o.messages,
    tools: o.tools,
    userId: o.userId,
    purpose: 'ta:chat',
    signal: o.signal,
    countQuota: false,
    maxTokens: 4000,
  })) {
    if (d.type === 'text') {
      text += d.text;
      o.onText(d.text);
    } else if (d.type === 'tool') toolCalls.push(d.call);
    else if (d.type === 'model') {
      // 换了备用模型重来：前面的不算
      text = '';
      toolCalls.length = 0;
    }
  }
  return { text, toolCalls };
};
let step: ModelStep = deepseekStep;
/** 测试用：换成写好的模型回答；传 null 换回 DeepSeek */
export function setModelStep(fn: ModelStep | null) {
  step = fn ?? deepseekStep;
}

/* ---------------- 对话记录 ---------------- */

interface Stored {
  id: number;
  run_id: number | null;
  role: Msg['role'];
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
}
const toMsg = (r: Stored): Msg => ({
  role: r.role,
  content: j<Msg['content']>(r.content, ''),
  ...(r.tool_calls ? { toolCalls: j<ToolCall[]>(r.tool_calls, []) } : {}),
  ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
});

/* ---------------- 会话：开新会话就是换个新助教，从头聊（2026-11-16） ---------------- */

/** 一段会话跟模型说的话记在哪：以前（还没有会话时）那一段是 ta，后来的是 ta:编号 */
const keyOf = (session: number | null) => (session ? `${TA_THREAD}:${session}` : TA_THREAD);

/** 老师现在这段会话：最近开的那一个；一次都没开过就是以前那一段（null） */
export function currentSession(ownerId: number): number | null {
  return db.value<number>('SELECT max(id) FROM ta_sessions WHERE owner_id=?', ownerId) ?? null;
}
/** 开一段新会话：屏幕上从头开始，模型那边也从头记 */
export function newSession(ownerId: number): number {
  if (busy.has(ownerId)) throw conflict('CoT 助教正在回上一句，等它说完');
  // 刚开的还没说话：不再开一段空的
  const last = currentSession(ownerId);
  if (last && !db.get("SELECT id FROM kb_runs WHERE session_id=? AND agent='ta' LIMIT 1", last)) return last;
  return db.insert('ta_sessions', { owner_id: ownerId, created_at: now() });
}
/** 这位老师的会话（说过话的），新的在前：第一句话当标题 */
export function sessionsOf(ownerId: number) {
  return db
    .all<{ session: number | null; first: string; at: number; last: number }>(
      `SELECT session_id AS session, (SELECT request FROM kb_runs r2 WHERE r2.teacher_id=r.teacher_id AND r2.agent='ta' AND r2.parent_id IS NULL AND r2.session_id IS r.session_id ORDER BY r2.id LIMIT 1) AS first,
         min(created_at) AS at, max(created_at) AS last
       FROM kb_runs r WHERE teacher_id=? AND agent='ta' AND parent_id IS NULL GROUP BY session_id ORDER BY last DESC`,
      ownerId,
    )
    .map((s) => ({ id: s.session, title: String(s.first || '').replace(/\s+/g, ' ').slice(0, 40), createdAt: s.at, updatedAt: s.last }));
}
/** 会话编号要是这位老师的 */
export function ownSession(ownerId: number, session: number | null | undefined): number | null {
  if (session === undefined) return currentSession(ownerId);
  if (session === null) return null;
  if (!db.get('SELECT id FROM ta_sessions WHERE id=? AND owner_id=?', session, ownerId)) throw notFound('没有这段会话');
  return session;
}

function thread(ownerId: number, key: string) {
  ensureThread(ownerId, key);
  return db.get<{ summary: string | null; summary_upto: number }>('SELECT summary, summary_upto FROM agent_threads WHERE owner_id=? AND thread=?', ownerId, key)!;
}
function stored(ownerId: number, key: string, after: number): Stored[] {
  return db.all<Stored>(
    'SELECT id, run_id, role, content, tool_calls, tool_call_id FROM agent_messages WHERE owner_id=? AND thread=? AND id>? ORDER BY id',
    ownerId,
    key,
    after,
  );
}
function append(ownerId: number, key: string, runId: number, m: Msg) {
  return db.insert('agent_messages', {
    owner_id: ownerId,
    thread: key,
    run_id: runId,
    role: m.role,
    content: JSON.stringify(m.content ?? ''),
    tool_calls: m.toolCalls?.length ? m.toolCalls.map(({ id, name, args }) => ({ id, name, args })) : null,
    tool_call_id: m.toolCallId ?? null,
    created_at: now(),
  });
}

/** 发给模型的整段：说明（加上以前的概要）+ 概要以后的每一条 */
function requestMessages(user: { id: number; name: string }, key: string): Msg[] {
  const t = thread(user.id, key);
  const system = taPrompt(user.name) + (t.summary ? `\n\n之前的对话概要：\n${t.summary}` : '');
  return [{ role: 'system', content: system }, ...stored(user.id, key, t.summary_upto).map(toMsg)];
}

/** 还没有回音的工具调用（问了老师还没答的）：下一句来之前要先补上回音 */
function dangling(ownerId: number, key: string): ToolCall[] {
  const rows = stored(ownerId, key, thread(ownerId, key).summary_upto);
  const answered = new Set(rows.filter((r) => r.role === 'tool').map((r) => r.tool_call_id));
  const last = [...rows].reverse().find((r) => r.role === 'assistant' && r.tool_calls);
  if (!last) return [];
  return j<ToolCall[]>(last.tool_calls, []).filter((c) => !answered.has(c.id));
}

/**
 * 对话太长：把前面的压成一段概要（留最近 KEEP_RECENT 条），以后每轮带概要和后面的。
 * 只在一轮开头压，切在老师说话那一条前面，不把一次工具调用和它的回音拆开。
 */
async function compact(user: { id: number; name: string }, key: string, signal: AbortSignal) {
  const t = thread(user.id, key);
  const rows = stored(user.id, key, t.summary_upto);
  const size = rows.reduce((n, r) => n + estimateTokens(r.content) + (r.tool_calls ? estimateTokens(r.tool_calls) : 0), 0);
  if (size < COMPACT_AT || rows.length <= KEEP_RECENT) return;
  let cut = rows.length - KEEP_RECENT;
  while (cut > 0 && rows[cut].role !== 'user') cut--;
  if (cut <= 0) return;
  const old = rows.slice(0, cut);
  const talk = old
    .map((r) => {
      const m = toMsg(r);
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (r.role === 'tool') return `（工具回音）${body.slice(0, 600)}`;
      if (r.role === 'assistant') return `助教：${body}${m.toolCalls?.length ? `（用了 ${m.toolCalls.map((c) => c.name).join('、')}）` : ''}`;
      return `老师：${body.slice(0, 2000)}`;
    })
    .join('\n');
  let summary = '';
  for await (const d of streamChat({
    agentKey: 'ta',
    purpose: 'ta:compact',
    userId: user.id,
    countQuota: false,
    signal,
    maxTokens: 1500,
    messages: [
      { role: 'system', content: '把老师和助教之前的对话压成一段要点，给助教接着干活用：还没办完的事、老师交代过的要求和习惯、办过的事和它们的记录编号。' },
      { role: 'user', content: `${t.summary ? `更早的概要：\n${t.summary}\n\n` : ''}对话：\n${talk}` },
    ],
  }))
    if (d.type === 'text') summary += d.text;
  if (!summary.trim()) return;
  db.run('UPDATE agent_threads SET summary=?, summary_upto=?, updated_at=? WHERE owner_id=? AND thread=?', summary.trim(), old[old.length - 1].id, now(), user.id, key);
}

/* ---------------- 每一轮 ---------------- */

interface Busy {
  runId: number;
  ctrl: AbortController;
  /** 这句话带了文件，还在收、在读 */
  waitingFiles?: boolean;
}
/** 助教一次回一句：老师同一时间只有一轮在跑 */
const busy = new Map<number, Busy>();
export const taBusy = (teacherId: number) => busy.get(teacherId) ?? null;

interface Turn {
  message: string;
  kbId: number | null;
  file: string | null;
  intakeId: number | null;
  /** 哪段会话（以前那一段为 null） */
  session: number | null;
  /** 回答问题卡片：问题那一次调用的编号 → 老师怎么答的 */
  answers?: Map<string, string>;
}

function checkQuota(userId: number) {
  const limit = config.keeperDailyTurns;
  if (!limit || db.get('SELECT id FROM users WHERE id=? AND is_super=1', userId)) return;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const used = db.value<number>("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND agent='ta' AND created_at>=?", userId, since.getTime()) || 0;
  if (used >= limit) throw new HttpError(429, `CoT 助教今天已经回了 ${limit} 句，明天再来`, 'rate_limited');
}

function newRun(user: { id: number }, kbId: number | null, message: string, session: number | null) {
  if (busy.has(user.id)) throw conflict('CoT 助教正在回上一句，等它说完');
  checkQuota(user.id);
  // 还挂着没答的问题卡片：老师接着说了别的，那一问就算过去了（卡片上显示没选）
  for (const w of db.all<{ id: number; kb_id: number | null }>("SELECT id, kb_id FROM kb_runs WHERE teacher_id=? AND agent='ta' AND status='waiting'", user.id)) {
    const ev = db.get<{ id: number; data: string }>("SELECT id, data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", w.id);
    if (ev) db.update('kb_events', ev.id, { data: { ...j<object>(ev.data, {}), skipped: true } });
    db.update('kb_runs', w.id, { status: 'done', finished_at: now() });
    publishRun(w.kb_id, w.id);
  }
  return db.insert('kb_runs', {
    kb_id: kbId,
    teacher_id: user.id,
    agent: 'ta',
    kind: 'chat',
    status: 'running',
    request: message,
    session_id: session,
    created_by: user.id,
    created_at: now(),
  });
}

/** 老师说了一句（没带文件）：开一轮 */
export function startTaTurn(user: { id: number; name: string }, o: { message: string; kbId: number | null; file?: string | null; session?: number | null }): number {
  const session = ownSession(user.id, o.session);
  const runId = newRun(user, o.kbId, o.message, session);
  launch(user, runId, { message: o.message, kbId: o.kbId, file: o.file ?? null, intakeId: null, session });
  return runId;
}

/** 老师说的这句带了文件：先占住，等文件收完读完（filesRead）再开始 */
export function openTaFileTurn(user: { id: number; name: string }, o: { message: string; kbId: number | null; file?: string | null; session?: number | null }): number {
  const runId = newRun(user, o.kbId, o.message, ownSession(user.id, o.session));
  busy.set(user.id, { runId, ctrl: new AbortController(), waitingFiles: true });
  publishRun(o.kbId, runId);
  return runId;
}

/** 带的文件读完了（整理助手那边的读文件流程叫过来的） */
function filesRead(runId: number, intakeId: number) {
  const run = db.get<any>('SELECT * FROM kb_runs WHERE id=?', runId);
  if (!run || run.status !== 'running') return;
  const b = busy.get(run.teacher_id);
  if (!b || b.runId !== runId || !b.waitingFiles) return;
  busy.delete(run.teacher_id);
  const user = db.get<{ id: number; name: string }>('SELECT id, name FROM users WHERE id=?', run.teacher_id)!;
  launch(user, runId, { message: run.request || '', kbId: run.kb_id ?? null, file: null, intakeId, session: run.session_id ?? null });
}
setTaFilesHandler(filesRead);

/** 文件没收成：这一轮结束 */
export function failTaFileTurn(teacherId: number, runId: number, message: string) {
  const b = busy.get(teacherId);
  if (!b || b.runId !== runId) return;
  busy.delete(teacherId);
  db.update('kb_runs', runId, { status: 'error', error: message, finished_at: now() });
  publishRun(null, runId);
}

/** 回答问题卡片：answers 跟问题一一对应（选了哪几个、或者自己写的话） */
export function answerAsk(user: { id: number; name: string }, askRunId: number, answers: { picks?: string[]; text?: string }[]): number {
  const run = db.get<any>("SELECT * FROM kb_runs WHERE id=? AND teacher_id=? AND agent='ta'", askRunId, user.id);
  if (!run) throw notFound('没有这次提问');
  if (run.status !== 'waiting') throw conflict('这个问题已经答过了');
  const ev = db.get<{ id: number; data: string }>("SELECT id, data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", askRunId);
  if (!ev) throw notFound('没有这次提问');
  const ask = j<{ toolCallId: string; questions: { question: string; options: string[] }[] }>(ev.data, { toolCallId: '', questions: [] });
  const said = ask.questions.map((q, i) => {
    const a = answers[i] || {};
    const words = [...(a.picks || []).filter(Boolean), ...(a.text?.trim() ? [a.text.trim()] : [])];
    return { q: q.question, a: words.join('、') };
  });
  if (said.every((s) => !s.a)) throw conflict('还没选');
  const reply = said.map((s) => `${s.q} ${s.a || '（没选）'}`).join('\n');
  const message = said.map((s) => s.a || '（没选）').join('；');
  const runId = newRun(user, run.kb_id ?? null, message, run.session_id ?? null);
  db.update('kb_events', ev.id, { data: { ...ask, answered: said } });
  db.update('kb_runs', askRunId, { status: 'done', finished_at: run.finished_at || now() });
  // 这一轮是在卡片上答的：页面上不再摆老师的气泡，卡片收起来那一行已经写着答了什么
  record({ teacherId: user.id, runId, kbId: run.kb_id ?? null }, 'answer', { askRunId });
  publishRun(run.kb_id ?? null, askRunId);
  launch(user, runId, {
    message,
    kbId: run.kb_id ?? null,
    file: null,
    intakeId: null,
    session: run.session_id ?? null,
    answers: new Map([[ask.toolCallId, `老师答：\n${reply}`]]),
  });
  return runId;
}

export function cancelTaRun(teacherId: number, runId: number) {
  const b = busy.get(teacherId);
  if (b && b.runId === runId) {
    b.ctrl.abort(new Error('已停止'));
    if (b.waitingFiles) {
      busy.delete(teacherId);
      db.update('kb_runs', runId, { status: 'canceled', finished_at: now() });
      publishRun(null, runId);
    }
    return;
  }
  // 问了老师、老师不答了：这一问就算了
  const run = db.get<any>("SELECT * FROM kb_runs WHERE id=? AND teacher_id=? AND agent='ta' AND status='waiting'", runId, teacherId);
  if (run) {
    db.update('kb_runs', runId, { status: 'done', finished_at: now() });
    publishRun(run.kb_id ?? null, runId);
  }
}

function launch(user: { id: number; name: string }, runId: number, turn: Turn) {
  const ctrl = new AbortController();
  busy.set(user.id, { runId, ctrl });
  const ref: RunRef = { teacherId: user.id, runId, kbId: turn.kbId };
  publishRun(turn.kbId, runId);
  void execute(user, ref, turn, ctrl.signal)
    .then((status) => {
      db.update('kb_runs', runId, { status, error: null, finished_at: status === 'waiting' ? null : now() });
    })
    .catch((err) => {
      const stopped = ctrl.signal.aborted;
      const msg = stopped ? null : (err as Error).message || 'CoT 助教没能回完';
      if (!stopped) {
        console.error('[ta] turn', runId, err);
        record(ref, 'error', { message: msg });
      }
      db.update('kb_runs', runId, { status: stopped ? 'canceled' : 'error', error: msg, finished_at: now() });
    })
    .finally(() => {
      if (busy.get(user.id)?.runId === runId) busy.delete(user.id);
      publishRun(turn.kbId, runId);
    });
}

/** 老师这句话带的文件，给助教看的样子：编号、名字、类型、大小，文字版的开头一段 */
function filesBlock(intakeId: number): string | null {
  const items = intakeItems(intakeId).filter((i) => i.method !== 'archive');
  if (!items.length) return null;
  const lines = items.slice(0, 40).map((i) => {
    const kind = KIND_LABEL[i.kind as Kind] || '文件';
    const size = i.size < 1024 ? `${i.size} B` : i.size < 1024 * 1024 ? `${Math.round(i.size / 1024)} KB` : `${(i.size / 1024 / 1024).toFixed(1)} MB`;
    const head = `#${i.id} ${i.name}（${kind}，${size}）`;
    if (i.status === 'failed' || i.status === 'skipped') return `${head}：没读出来，${i.reason || ''}`;
    if (!i.text_hash) return head;
    const text = readBlobText(i.text_hash).replace(/\s+/g, ' ').trim();
    return `${head}：${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`;
  });
  const more = items.length > 40 ? `\n还有 ${items.length - 40} 份` : '';
  return `（老师这句话带了文件，编号用于工具；要看全文用 read_attachment）\n${lines.join('\n')}${more}`;
}

/** 后台还在做的整理 */
function runningJobs(teacherId: number) {
  return db
    .all<{ id: number; request: string; status: string }>(
      "SELECT id, request, status FROM kb_runs WHERE teacher_id=? AND agent='keeper' AND kind='job' AND status IN ('queued','running') ORDER BY id",
      teacherId,
    )
    .map((r) => `任务 ${r.id}「${r.request.slice(0, 30)}」${r.status === 'queued' ? '排队中' : '进行中'}`);
}

/** 一个班最近的作业标题（老师说「第一次作业」时它知道在哪个班），最多 8 份 */
function homeworkTitles(classId: number) {
  const rows = db.all<{ title: string }>('SELECT title FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 8', classId);
  return rows.length ? `（作业：${rows.reverse().map((r) => `「${r.title}」`).join('、')}）` : '';
}

function whereLine(kbId: number | null, file: string | null) {
  if (!kbId) return null;
  const kb = db.get<{ name: string }>('SELECT name FROM knowledge_bases WHERE id=?', kbId);
  return kb ? `老师现在在知识库「${kb.name}」里${file ? `，看着「${file}」` : ''}` : null;
}

/** 跑一轮：返回这一轮停在哪（办完了 done，问了老师在等 waiting） */
async function execute(user: { id: number; name: string }, ref: RunRef, turn: Turn, signal: AbortSignal): Promise<'done' | 'waiting'> {
  const key = keyOf(turn.session);
  // 上一轮问了老师没等到回答（或者老师直接说了别的）：先给那一问补上回音
  for (const call of dangling(user.id, key))
    append(user.id, key, ref.runId, {
      role: 'tool',
      toolCallId: call.id,
      content: turn.answers?.get(call.id) ?? '（老师没有在卡片上选，直接说了下面这句）',
    });
  await compact(user, key, signal).catch((err) => console.error('[ta] compact', err));
  const block = turnBlock({
    now: nowLine(),
    classes: classesOf(user.id).map((k) => `「${k.name}」${k.archived_at ? '（已归档）' : ''}${homeworkTitles(k.id)}`),
    kbs: listKbs(user.id)
      .filter((k) => k.status === 'active')
      .map((k) => `「${k.name}」`),
    where: whereLine(turn.kbId, turn.file),
    jobs: runningJobs(user.id),
    notes: takeNotes(user.id),
    files: turn.intakeId ? filesBlock(turn.intakeId) : null,
  });
  append(user.id, key, ref.runId, { role: 'user', content: `${block}\n${turn.message.trim() || '（老师只发了文件，没写话）'}` });

  const ctx: TaContext = {
    user,
    ref,
    startJob: (brief, kbName, attachmentIds) => {
      const kbId = kbName ? findKb(user.id, kbName).id : turn.kbId;
      const jobId = startKeeperJob(user, ref.runId, brief, kbId, attachmentIds.length ? attachmentIds : null);
      record(ref, 'job', { jobRunId: jobId, title: brief.slice(0, 80) });
      return jobId;
    },
  };
  for (let n = 0; n < MAX_STEPS; n++) {
    signal.throwIfAborted();
    const r = await step({
      messages: requestMessages(user, key),
      tools: TOOL_SPECS,
      userId: user.id,
      signal,
      onText: (text) => publish(ref, 'delta', { runId: ref.runId, text }),
    });
    signal.throwIfAborted();
    append(user.id, key, ref.runId, { role: 'assistant', content: r.text, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}) });
    if (!r.toolCalls.length) {
      db.update('kb_runs', ref.runId, { reply: r.text.trim() || null });
      return 'done';
    }
    if (r.text.trim()) record(ref, 'say', { text: r.text.trim() });
    // 先办别的，问老师放最后：问了就停下等回答
    const asks = r.toolCalls.filter((c) => c.name === ASK_TOOL);
    for (const call of r.toolCalls.filter((c) => c.name !== ASK_TOOL)) {
      const out = await runTaTool(ctx, call);
      append(user.id, key, ref.runId, { role: 'tool', toolCallId: call.id, content: out.content });
    }
    if (asks.length) {
      const questions = asks.flatMap((c) => askQuestions(c.args));
      // 好几次问合成一张卡片；除了第一次，别的先回一句「一起问了」
      for (const c of asks.slice(1)) append(user.id, key, ref.runId, { role: 'tool', toolCallId: c.id, content: '（跟上一个问题放在同一张卡片里问了）' });
      record(ref, 'ask', { toolCallId: asks[0].id, questions, answered: null });
      return 'waiting';
    }
  }
  db.update('kb_runs', ref.runId, { reply: '这件事步骤太多，做到一半停下了，可以接着跟我说' });
  return 'done';
}

function askQuestions(args: Record<string, any>): { question: string; options: string[]; multiple: boolean }[] {
  const list = Array.isArray(args?.questions) ? args.questions : [args];
  return list
    .map((q: any) => ({
      question: String(q?.question ?? '').trim(),
      options: (Array.isArray(q?.options) ? q.options : []).map((o: unknown) => String(o ?? '').trim()).filter(Boolean).slice(0, 6),
      multiple: q?.multiple === true || q?.multiple === 'true',
    }))
    .filter((q: { question: string }) => q.question)
    .slice(0, 4);
}

/** 服务重启：还在跑的那一轮算没回完；问了老师在等的留着 */
export function recoverTaRuns() {
  db.run(
    "UPDATE kb_runs SET status='error', error='服务中断，这句没回完，可以再说一遍', finished_at=? WHERE agent='ta' AND status='running'",
    now(),
  );
}

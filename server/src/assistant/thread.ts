/**
 * 跟模型说的每一条记在 agent_messages 里，只往后加：前面不变，DeepSeek 那边的缓存才命中得上。
 * 老师和助教、学生和学伴，各段对话一样存；太长了把前面压成一段概要。
 */
import { db, j, now } from '../db/index.js';
import { estimateTokens } from '../lib/text.js';
import { streamChat } from '../llm/index.js';
import type { Msg, ToolCall } from '../llm/types.js';
import { ensureThread } from './notes.js';

/** 对话太长时把前面的压成一段：超过这么多（估算）就压，留最近这么多条原样 */
const COMPACT_AT = 60_000;
const KEEP_RECENT = 24;

export interface Stored {
  id: number;
  run_id: number | null;
  role: Msg['role'];
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  reasoning: string | null;
}
export const toMsg = (r: Stored): Msg => ({
  role: r.role,
  content: j<Msg['content']>(r.content, ''),
  ...(r.tool_calls ? { toolCalls: j<ToolCall[]>(r.tool_calls, []) } : {}),
  ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
  ...(r.reasoning ? { reasoning: r.reasoning } : {}),
});

export function threadRow(ownerId: number, key: string) {
  ensureThread(ownerId, key);
  return db.get<{ summary: string | null; summary_upto: number }>('SELECT summary, summary_upto FROM agent_threads WHERE owner_id=? AND thread=?', ownerId, key)!;
}
export function stored(ownerId: number, key: string, after: number): Stored[] {
  return db.all<Stored>(
    'SELECT id, run_id, role, content, tool_calls, tool_call_id, reasoning FROM agent_messages WHERE owner_id=? AND thread=? AND id>? ORDER BY id',
    ownerId,
    key,
    after,
  );
}
export function append(ownerId: number, key: string, runId: number | null, m: Msg) {
  return db.insert('agent_messages', {
    owner_id: ownerId,
    thread: key,
    run_id: runId,
    role: m.role,
    content: JSON.stringify(m.content ?? ''),
    tool_calls: m.toolCalls?.length ? m.toolCalls.map(({ id, name, args }) => ({ id, name, args })) : null,
    tool_call_id: m.toolCallId ?? null,
    reasoning: m.reasoning || null,
    created_at: now(),
  });
}

/** 发给模型的整段：说明（加上以前的概要）+ 概要以后的每一条 */
export function requestMessages(ownerId: number, key: string, system: string): Msg[] {
  const t = threadRow(ownerId, key);
  return [{ role: 'system', content: system + (t.summary ? `\n\n之前的对话概要：\n${t.summary}` : '') }, ...stored(ownerId, key, t.summary_upto).map(toMsg)];
}

/** 还没有回音的工具调用（问了老师还没答的）：下一句来之前要先补上回音 */
export function dangling(ownerId: number, key: string): ToolCall[] {
  const rows = stored(ownerId, key, threadRow(ownerId, key).summary_upto);
  const answered = new Set(rows.filter((r) => r.role === 'tool').map((r) => r.tool_call_id));
  const last = [...rows].reverse().find((r) => r.role === 'assistant' && r.tool_calls);
  if (!last) return [];
  return j<ToolCall[]>(last.tool_calls, []).filter((c) => !answered.has(c.id));
}

/**
 * 对话太长：把前面的压成一段概要（留最近 KEEP_RECENT 条），以后每轮带概要和后面的。
 * 只在一轮开头压，切在对方说话那一条前面，不把一次工具调用和它的回音拆开。
 */
export async function compact(o: {
  ownerId: number;
  key: string;
  signal: AbortSignal;
  /** 对话里两边怎么称呼：老师/助教，学生/学伴 */
  who: { user: string; agent: string };
  /** 压的时候要留下什么 */
  instruction: string;
  agentKey: string;
  purpose: string;
}) {
  const t = threadRow(o.ownerId, o.key);
  const rows = stored(o.ownerId, o.key, t.summary_upto);
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
      if (r.role === 'assistant') return `${o.who.agent}：${body}${m.toolCalls?.length ? `（用了 ${m.toolCalls.map((c) => c.name).join('、')}）` : ''}`;
      return `${o.who.user}：${body.slice(0, 2000)}`;
    })
    .join('\n');
  let summary = '';
  for await (const d of streamChat({
    agentKey: o.agentKey,
    purpose: o.purpose,
    userId: o.ownerId,
    countQuota: false,
    signal: o.signal,
    maxTokens: 1500,
    messages: [
      { role: 'system', content: o.instruction },
      { role: 'user', content: `${t.summary ? `更早的概要：\n${t.summary}\n\n` : ''}对话：\n${talk}` },
    ],
  }))
    if (d.type === 'text') summary += d.text;
  if (!summary.trim()) return;
  db.run('UPDATE agent_threads SET summary=?, summary_upto=?, updated_at=? WHERE owner_id=? AND thread=?', summary.trim(), old[old.length - 1].id, now(), o.ownerId, o.key);
}

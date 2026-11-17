import { extractJson, parseToolArgs } from '../../lib/json.js';
import { joinUrl, normalizeOpenAiBase, readSse, request } from '../net.js';
import { throttle } from '../partial.js';
import { LlmError, textOf, type Adapter, type ChatParams, type Msg, type ProviderConn, type RemoteModel, type ToolCall, type ToolSpec } from '../types.js';

/**
 * 服务器本机上的 Gemini 接口。
 * 写法照 OpenAI，但它不收 tools：要用工具时，把工具写进要求里，让模型按固定的格式（json_schema）交「这一步要说的话」和「要用的工具」，
 * 这里再拆成工具调用；前面几步用过的工具和结果，写成对话里的文字。
 * 想多深：我们的 low / high / max 对它的 low / medium / high。
 */
const EFFORT: Record<string, string> = { low: 'low', high: 'medium', max: 'high' };

function headers(conn: ProviderConn): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', 'User-Agent': 'coteach' };
  if (conn.apiKey) h.Authorization = `Bearer ${conn.apiKey}`;
  return { ...h, ...conn.headers };
}

/** 工具写进要求里：名字、说明、参数的格式 */
function toolText(tools: ToolSpec[]) {
  return [
    '可以用下面这些工具。回复写成 JSON：say 是这一步要说的话，calls 是这一步要用的工具（tool 写名字，args 写参数），一步可以用几个；不用工具 calls 就空着。用了工具，结果会在下一条消息里给你，看了再接着办。',
    '',
    '工具：',
    ...tools.map((t) => `- ${t.name}：${t.description}\n  参数：${JSON.stringify(t.parameters)}`),
  ].join('\n');
}

function schemaOf(tools: ToolSpec[]) {
  return {
    type: 'object',
    properties: {
      say: { type: 'string' },
      calls: {
        type: 'array',
        items: { type: 'object', properties: { tool: { type: 'string', enum: tools.map((t) => t.name) }, args: { type: 'object' } }, required: ['tool', 'args'] },
      },
    },
    required: ['say', 'calls'],
  };
}

type Wire = { role: string; content: unknown };

/** 一条消息里的图片照 OpenAI 的样子传（接口会存成附件） */
function contentOf(m: Msg): unknown {
  if (typeof m.content === 'string') return m.content;
  return m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }));
}

/** 消息排成它认的样子：用了工具的那一步写成跟它要交的一样的 JSON，工具的结果当成下一条消息 */
function toWire(messages: Msg[], tools?: ToolSpec[]): Wire[] {
  const names = new Map<string, string>();
  const out: Wire[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const name = (m.toolCallId && names.get(m.toolCallId)) || m.name || '工具';
      out.push({ role: 'user', content: `（${name} 的结果）\n${textOf(m.content)}` });
      continue;
    }
    if (m.role === 'assistant') {
      for (const c of m.toolCalls || []) names.set(c.id, c.name);
      const say = textOf(m.content);
      out.push({
        role: 'assistant',
        content: tools?.length ? JSON.stringify({ say, calls: (m.toolCalls || []).map((c) => ({ tool: c.name, args: c.args ?? {} })) }) : say,
      });
      continue;
    }
    out.push({ role: m.role, content: contentOf(m) });
  }
  if (tools?.length) out.unshift({ role: 'system', content: toolText(tools) });
  return out;
}

/** 交上来的 JSON 拆成要说的话和工具调用；拆不开就整段当成要说的话 */
function parseStep(content: string): { say: string; calls: ToolCall[] } {
  const j = extractJson<{ say?: unknown; calls?: unknown }>(content);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { say: content, calls: [] };
  const calls: ToolCall[] = [];
  for (const [i, c] of (Array.isArray(j.calls) ? j.calls : []).entries()) {
    const name = String(c?.tool ?? c?.name ?? '').trim();
    if (!name) continue;
    const args = typeof c?.args === 'string' ? parseToolArgs(c.args) : c?.args && typeof c.args === 'object' ? (c.args as Record<string, unknown>) : {};
    calls.push({ id: `agy_${Date.now().toString(36)}_${i}`, name, args, raw: JSON.stringify(args) });
  }
  return { say: typeof j.say === 'string' ? j.say : '', calls };
}

export const agyAdapter: Adapter = {
  async *stream(conn, p: ChatParams) {
    const url = joinUrl(normalizeOpenAiBase(conn.baseUrl), '/chat/completions');
    const tools = p.tools?.length ? p.tools : undefined;
    const body: Record<string, unknown> = {
      model: p.model,
      messages: toWire(p.messages, tools),
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: EFFORT[p.effort || 'low'] || 'low',
    };
    if (tools) body.response_format = { type: 'json_schema', json_schema: { name: 'step', schema: schemaOf(tools) } };
    let res: Response;
    try {
      res = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal: p.signal, timeoutMs: 15 * 60_000 });
    } catch (err) {
      // 没号、号在冷却、排队排满：不在这里重试，直接让上面换备用模型（DeepSeek）
      if (err instanceof LlmError && err.status) throw new LlmError(err.message, err.status, false, err.body);
      throw err;
    }
    // 头到了就是开始出了（它出第一段字才发头）：报一声，免得上面的看门狗当它没动静
    yield { type: 'reasoning', text: '' };
    let content = '';
    let finish = 'stop';
    let ended = false;
    const due = throttle();
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const j: any = await res.json();
      content = String(j.choices?.[0]?.message?.content ?? '');
      if (j.usage) yield { type: 'usage', input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
      ended = true;
    } else {
      for await (const ev of readSse(res, p.signal, 10 * 60_000)) {
        if (ev.data === '[DONE]') {
          ended = true;
          break;
        }
        let j: any;
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) yield { type: 'usage', input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
        const choice = j.choices?.[0];
        if (!choice) continue;
        const piece = choice.delta?.content;
        if (typeof piece === 'string' && piece) {
          content += piece;
          // 不用工具的：一边出一边给；用工具的：写到一半的整步 JSON 隔一会儿报一次（备课页边写边显示）
          if (!tools) yield { type: 'text', text: piece };
          else if (due(content.length)) yield { type: 'partial', name: '', text: content, wrapped: true };
        }
        if (choice.finish_reason) {
          finish = choice.finish_reason;
          if (finish === 'error') throw new LlmError(`Gemini 接口出错：${content.slice(-300)}`, 502, false);
          ended = true;
        }
      }
    }
    if (!ended) throw new LlmError('Gemini 接口中途断开，内容不完整', 502, false);
    if (!tools) {
      yield { type: 'finish', reason: finish };
      return;
    }
    const step = parseStep(content);
    if (step.say) yield { type: 'text', text: step.say };
    for (const call of step.calls) yield { type: 'tool', call };
    yield { type: 'finish', reason: step.calls.length ? 'tool_calls' : finish };
  },

  async listModels(conn, signal) {
    const url = joinUrl(normalizeOpenAiBase(conn.baseUrl), '/models');
    const res = await request(url, { method: 'GET', headers: headers(conn), signal, timeoutMs: 120_000 });
    const j: any = await res.json();
    return ((j.data || []) as any[]).map((m): RemoteModel => ({ id: String(m.id), label: m.name, ownedBy: m.owned_by })).filter((m) => m.id);
  },
};

export const agyForTest = { toWire, parseStep, schemaOf, toolText };

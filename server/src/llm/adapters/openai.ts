import { parseToolArgs } from '../../lib/json.js';
import { joinUrl, normalizeOpenAiBase, readSse, request } from '../net.js';
import { LlmError, type Adapter, type ChatParams, type Delta, type Msg, type ProviderConn, type RemoteModel, type ToolCall } from '../types.js';

/**
 * OpenAI Chat Completions 协议适配器。
 * 同时服务 OpenAI、xAI、DeepSeek、Kimi、通义千问、智谱、豆包、硅基流动、OpenRouter、Ollama 及任意兼容接口。
 */
function headers(conn: ProviderConn): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
  if (conn.apiKey) h.Authorization = `Bearer ${conn.apiKey}`;
  return { ...h, ...conn.headers };
}

function toWire(m: Msg): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
  if (m.role === 'assistant') {
    const out: Record<string, unknown> = {
      role: 'assistant',
      content: typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join(''),
    };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) } }));
      if (!out.content) out.content = null;
    }
    // DeepSeek 思考模式带工具：之前每一步的思考要原样传回去（它的文档这么要求，传了会接进上下文）
    if (m.reasoning) out.reasoning_content = m.reasoning;
    return out;
  }
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map(p =>
      p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } },
    ),
  };
}

interface Knobs {
  maxTokensField: 'max_tokens' | 'max_completion_tokens' | null;
  temperature: boolean;
  streamOptions: boolean;
  thinking: boolean;
  effort: boolean;
}

function buildBody(conn: ProviderConn, p: ChatParams, k: Knobs) {
  const body: Record<string, unknown> = { model: p.model, messages: p.messages.map(toWire), stream: true };
  if (k.streamOptions) body.stream_options = { include_usage: true };
  if (k.temperature && p.temperature !== undefined) body.temperature = p.temperature;
  if (k.maxTokensField && p.maxTokens) body[k.maxTokensField] = p.maxTokens;
  if (k.thinking && p.thinking !== undefined) body.thinking = { type: p.thinking ? 'enabled' : 'disabled' };
  if (k.effort && p.thinking && p.effort) body.reasoning_effort = p.effort;
  if (p.tools?.length) {
    body.tools = p.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  return body;
}

/** 针对 400 错误自动降级参数（不同厂商对参数的支持不一） */
function adjustKnobs(k: Knobs, errBody: string): Knobs | null {
  const s = errBody.toLowerCase();
  if (k.maxTokensField === 'max_tokens' && s.includes('max_completion_tokens')) return { ...k, maxTokensField: 'max_completion_tokens' };
  if (k.maxTokensField && (s.includes('max_tokens') || s.includes('max_completion_tokens'))) return { ...k, maxTokensField: null };
  if (k.temperature && s.includes('temperature')) return { ...k, temperature: false };
  if (k.streamOptions && (s.includes('stream_options') || s.includes('include_usage'))) return { ...k, streamOptions: false };
  if (k.thinking && s.includes('thinking')) return { ...k, thinking: false };
  if (k.effort && s.includes('reasoning_effort')) return { ...k, effort: false };
  return null;
}

export const openaiAdapter: Adapter = {
  async *stream(conn, p) {
    const url = joinUrl(normalizeOpenAiBase(conn.baseUrl), '/chat/completions');
    let knobs: Knobs = {
      maxTokensField: conn.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens',
      temperature: true,
      streamOptions: conn.kind !== 'ollama',
      thinking: true,
      effort: true,
    };
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4 && !res; attempt++) {
      try {
        res = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(buildBody(conn, p, knobs)), signal: p.signal });
      } catch (err) {
        if (err instanceof LlmError && err.status === 400) {
          const next = adjustKnobs(knobs, err.body || err.message);
          if (next) {
            knobs = next;
            continue;
          }
        }
        throw err;
      }
    }
    if (!res) throw new LlmError('模型请求失败');

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      // 服务端忽略了 stream 参数，按非流式结果解析
      const j: any = await res.json();
      yield* fromCompletion(j);
      return;
    }

    const calls = new Map<string, { id: string; name: string; args: string }>();
    let lastKey = '';
    let finish = 'stop';
    let ended = false;
    for await (const ev of readSse(res, p.signal)) {
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
      if (j.error) throw new LlmError(`模型返回错误：${j.error.message || JSON.stringify(j.error)}`, 500, false);
      if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) {
        yield { type: 'usage', input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
      }
      const choice = j.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || choice.message || {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
      if (typeof d.content === 'string' && d.content) yield { type: 'text', text: d.content };
      if (Array.isArray(d.tool_calls)) {
        for (let i = 0; i < d.tool_calls.length; i++) {
          const tc = d.tool_calls[i];
          let key = tc.index !== undefined ? `i${tc.index}` : tc.id ? `id${tc.id}` : lastKey || `p${i}`;
          if (tc.index === undefined && tc.id && calls.size && !calls.has(key)) key = `id${tc.id}`;
          const cur = calls.get(key) || { id: tc.id || '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          calls.set(key, cur);
          lastKey = key;
        }
      }
      if (choice.finish_reason) {
        finish = choice.finish_reason;
        ended = true;
      }
    }
    if (!ended) throw new LlmError('模型输出中途断开，内容不完整', 502, true);
    let n = 0;
    for (const c of calls.values()) {
      if (!c.name) continue;
      const call: ToolCall = { id: c.id || `call_${Date.now()}_${n++}`, name: c.name, args: parseToolArgs(c.args), raw: c.args };
      yield { type: 'tool', call };
    }
    yield { type: 'finish', reason: calls.size ? 'tool_calls' : finish };
  },

  async listModels(conn, signal) {
    const url = joinUrl(normalizeOpenAiBase(conn.baseUrl), '/models');
    const res = await request(url, { method: 'GET', headers: headers(conn), signal, timeoutMs: 20_000 });
    const j: any = await res.json();
    const list: any[] = Array.isArray(j) ? j : j.data || j.models || [];
    return list
      .map((m): RemoteModel => ({
        id: String(m.id ?? m.name ?? m.model ?? ''),
        label: m.display_name || m.name,
        contextWindow: m.context_length || m.context_window,
        ownedBy: m.owned_by,
      }))
      .filter(m => m.id);
  },
};

function* fromCompletion(j: any): Generator<Delta> {
  const msg = j.choices?.[0]?.message || {};
  if (msg.reasoning_content) yield { type: 'reasoning', text: msg.reasoning_content };
  if (msg.content) yield { type: 'text', text: msg.content };
  for (const [i, tc] of ((msg.tool_calls || []) as any[]).entries()) {
    const raw = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {});
    yield { type: 'tool', call: { id: tc.id || `call_${i}`, name: tc.function?.name, args: parseToolArgs(raw), raw } };
  }
  if (j.usage) yield { type: 'usage', input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
  yield { type: 'finish', reason: j.choices?.[0]?.finish_reason || 'stop' };
}

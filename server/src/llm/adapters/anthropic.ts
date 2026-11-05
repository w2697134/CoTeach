import { parseToolArgs } from '../../lib/json.js';
import { joinUrl, readSse, request } from '../net.js';
import { LlmError, type Adapter, type ChatParams, type Msg, type ProviderConn, type RemoteModel } from '../types.js';

/** Anthropic Messages 协议适配器（官方 API 与兼容网关） */
function base(conn: ProviderConn): string {
  let b = conn.baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/messages$/, '');
  if (!/\/v1$/.test(b)) b += '/v1';
  return b;
}

function headers(conn: ProviderConn): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    'anthropic-version': '2023-06-01',
    ...(conn.apiKey ? { 'x-api-key': conn.apiKey } : {}),
    ...conn.headers,
  };
}

type Block = Record<string, unknown>;

/** 转换为 Anthropic 消息格式：system 独立、角色严格交替、工具结果作为 user 消息的 tool_result 块 */
function convert(messages: Msg[]): { system: string; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n');
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]);
      continue;
    }
    const blocks: Block[] = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else {
      for (const p of m.content) {
        if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        if (p.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } });
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
    }
    push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '（继续）' }] });
  return { system, messages: out };
}

function body(p: ChatParams, withTemp: boolean) {
  const { system, messages } = convert(p.messages);
  const b: Record<string, unknown> = { model: p.model, max_tokens: p.maxTokens || 4096, messages, stream: true };
  if (system) b.system = system;
  if (withTemp && p.temperature !== undefined) b.temperature = Math.min(1, Math.max(0, p.temperature));
  if (p.tools?.length) b.tools = p.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  return b;
}

export const anthropicAdapter: Adapter = {
  async *stream(conn, p) {
    const url = joinUrl(base(conn), '/messages');
    let res: Response;
    try {
      res = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body(p, true)), signal: p.signal });
    } catch (err) {
      if (err instanceof LlmError && err.status === 400 && /temperature/i.test(err.body)) {
        res = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body(p, false)), signal: p.signal });
      } else throw err;
    }

    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const j: any = await res.json();
      for (const blk of j.content || []) {
        if (blk.type === 'text') yield { type: 'text', text: blk.text };
        if (blk.type === 'thinking') yield { type: 'reasoning', text: blk.thinking };
        if (blk.type === 'tool_use') yield { type: 'tool', call: { id: blk.id, name: blk.name, args: blk.input || {}, raw: JSON.stringify(blk.input || {}) } };
      }
      if (j.usage) yield { type: 'usage', input: j.usage.input_tokens || 0, output: j.usage.output_tokens || 0 };
      yield { type: 'finish', reason: j.stop_reason || 'stop' };
      return;
    }

    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    let input = 0;
    let output = 0;
    let stop = 'stop';
    let ended = false;
    for await (const ev of readSse(res, p.signal)) {
      let j: any;
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (j.type) {
        case 'message_start':
          input = j.message?.usage?.input_tokens || 0;
          output = j.message?.usage?.output_tokens || 0;
          break;
        case 'content_block_start': {
          const cb = j.content_block || {};
          blocks.set(j.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
          if (cb.type === 'text' && cb.text) yield { type: 'text', text: cb.text };
          break;
        }
        case 'content_block_delta': {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
          else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking };
          else if (d.type === 'input_json_delta') {
            const b = blocks.get(j.index);
            if (b) b.json += d.partial_json || '';
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(j.index);
          if (b?.type === 'tool_use' && b.name) {
            yield { type: 'tool', call: { id: b.id || `toolu_${j.index}`, name: b.name, args: parseToolArgs(b.json), raw: b.json } };
          }
          break;
        }
        case 'message_stop':
          ended = true;
          break;
        case 'message_delta':
          if (j.delta?.stop_reason) {
            stop = j.delta.stop_reason;
            ended = true;
          }
          if (j.usage?.output_tokens) output = j.usage.output_tokens;
          if (j.usage?.input_tokens) input = j.usage.input_tokens;
          break;
        case 'error':
          throw new LlmError(`模型返回错误：${j.error?.message || '未知错误'}`, 500, j.error?.type === 'overloaded_error');
      }
    }
    if (!ended) throw new LlmError('模型输出中途断开，内容不完整', 502, true);
    yield { type: 'usage', input, output };
    yield { type: 'finish', reason: stop === 'tool_use' ? 'tool_calls' : stop };
  },

  async listModels(conn, signal) {
    const res = await request(joinUrl(base(conn), '/models?limit=200'), { method: 'GET', headers: headers(conn), signal, timeoutMs: 20_000 });
    const j: any = await res.json();
    return ((j.data || []) as any[]).map((m): RemoteModel => ({ id: m.id, label: m.display_name })).filter(m => m.id);
  },
};

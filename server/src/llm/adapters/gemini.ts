import { joinUrl, readSse, request } from '../net.js';
import { LlmError, type Adapter, type ChatParams, type Msg, type ProviderConn, type RemoteModel } from '../types.js';

/** Google Gemini 原生协议（generateContent / streamGenerateContent）适配器 */
function base(conn: ProviderConn): string {
  let b = conn.baseUrl.trim().replace(/\/+$/, '');
  b = b.replace(/\/models(\/.*)?$/, '');
  if (!/\/v1(beta|alpha)?\d*$/.test(b)) b += '/v1beta';
  return b;
}

function headers(conn: ProviderConn): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(conn.apiKey ? { 'x-goog-api-key': conn.apiKey } : {}), ...conn.headers };
}

/** Gemini 的函数参数只支持 OpenAPI 子集，去掉不支持的 JSON Schema 关键字 */
function cleanSchema(s: any): any {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (['$schema', 'additionalProperties', 'default', '$id', 'examples', 'title'].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

type GPart = Record<string, unknown>;

function convert(messages: Msg[]) {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n');
  const contents: { role: 'user' | 'model'; parts: GPart[] }[] = [];
  const toolNames = new Map<string, string>();
  const push = (role: 'user' | 'model', parts: GPart[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const name = m.name || toolNames.get(m.toolCallId || '') || 'tool';
      push('user', [{ functionResponse: { name, response: { content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) } } }]);
      continue;
    }
    const parts: GPart[] = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const p of m.content) {
        if (p.type === 'text' && p.text) parts.push({ text: p.text });
        if (p.type === 'image') parts.push({ inlineData: { mimeType: p.mime, data: p.data } });
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        toolNames.set(tc.id, tc.name);
        const part: GPart = { functionCall: { name: tc.name, args: tc.args ?? {} } };
        if (tc.extra?.thoughtSignature) part.thoughtSignature = tc.extra.thoughtSignature;
        parts.push(part);
      }
    }
    push(m.role === 'assistant' ? 'model' : 'user', parts);
  }
  return { system, contents };
}

function body(p: ChatParams) {
  const { system, contents } = convert(p.messages);
  const b: Record<string, unknown> = { contents, generationConfig: {} as Record<string, unknown> };
  const gc = b.generationConfig as Record<string, unknown>;
  if (p.temperature !== undefined) gc.temperature = p.temperature;
  if (p.maxTokens) gc.maxOutputTokens = p.maxTokens;
  if (system) b.systemInstruction = { parts: [{ text: system }] };
  if (p.tools?.length)
    b.tools = [{ functionDeclarations: p.tools.map(t => ({ name: t.name, description: t.description, parameters: cleanSchema(t.parameters) })) }];
  return b;
}

export const geminiAdapter: Adapter = {
  async *stream(conn, p) {
    const model = p.model.replace(/^models\//, '');
    const url = joinUrl(base(conn), `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`);
    const res = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body(p)), signal: p.signal });
    let input = 0;
    let output = 0;
    let finish = 'stop';
    let n = 0;
    let hadTool = false;
    const handle = function* (j: any) {
      if (j.error) throw new LlmError(`模型返回错误：${j.error.message || '未知错误'}`, j.error.code || 500, false);
      const cand = j.candidates?.[0];
      for (const part of cand?.content?.parts || []) {
        if (typeof part.text === 'string' && part.text) {
          if (part.thought) yield { type: 'reasoning' as const, text: part.text };
          else yield { type: 'text' as const, text: part.text };
        }
        if (part.functionCall) {
          hadTool = true;
          const args = part.functionCall.args || {};
          yield {
            type: 'tool' as const,
            call: {
              id: `gcall_${Date.now()}_${n++}`,
              name: part.functionCall.name,
              args,
              raw: JSON.stringify(args),
              extra: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined,
            },
          };
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (j.usageMetadata) {
        input = j.usageMetadata.promptTokenCount || input;
        output = (j.usageMetadata.candidatesTokenCount || 0) + (j.usageMetadata.thoughtsTokenCount || 0) || output;
      }
      if (cand?.finishReason === 'SAFETY') throw new LlmError('内容被模型安全策略拦截', 400, false);
    };
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const j: any = await res.json();
      for (const item of Array.isArray(j) ? j : [j]) yield* handle(item);
    } else {
      for await (const ev of readSse(res, p.signal)) {
        let j: any;
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue;
        }
        yield* handle(j);
      }
    }
    yield { type: 'usage', input, output };
    yield { type: 'finish', reason: hadTool ? 'tool_calls' : String(finish).toLowerCase() };
  },

  async listModels(conn, signal) {
    const res = await request(joinUrl(base(conn), '/models?pageSize=200'), { method: 'GET', headers: headers(conn), signal, timeoutMs: 20_000 });
    const j: any = await res.json();
    return ((j.models || []) as any[])
      .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m): RemoteModel => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName, contextWindow: m.inputTokenLimit }))
      .filter(m => m.id);
  },
};

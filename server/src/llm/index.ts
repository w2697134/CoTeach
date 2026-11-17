import { config } from '../config.js';
import { db, getSetting, j, now } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { estimateTokens, truncate } from '../lib/text.js';
import { anthropicAdapter } from './adapters/anthropic.js';
import { agyAdapter } from './adapters/agy.js';
import { geminiAdapter } from './adapters/gemini.js';
import { openaiAdapter } from './adapters/openai.js';
import { LlmError, textOf, type Adapter, type Delta, type Effort, type Msg, type Protocol, type ProviderConn, type ToolCall, type ToolSpec } from './types.js';

export * from './types.js';

const adapters: Record<Protocol, Adapter> = { openai: openaiAdapter, anthropic: anthropicAdapter, gemini: geminiAdapter };
export const adapterFor = (p: Protocol) => adapters[p];
/** 服务器本机的 Gemini 接口登记成 OpenAI 写法（kind='agy'），但它不收工具，走自己的接法 */
const adapterOf = (conn: ProviderConn) => (conn.kind === 'agy' ? agyAdapter : adapters[conn.protocol]);

export interface ModelRef {
  modelRowId: number;
  model: string;
  label: string;
  providerId: number;
  providerName: string;
  conn: ProviderConn;
  caps: { tools?: boolean; vision?: boolean; reasoning?: boolean };
}

export function providerConn(p: any): ProviderConn {
  return { kind: p.kind, protocol: p.protocol, baseUrl: p.base_url, apiKey: decrypt(p.api_key_enc), headers: j(p.headers, {}) };
}

/** 根据模型表 id 取完整调用信息 */
export function modelRef(modelRowId: number | null | undefined): ModelRef | null {
  if (!modelRowId) return null;
  const row = db.get<any>(
    `SELECT m.*, p.id AS pid, p.name AS pname, p.kind, p.protocol, p.base_url, p.api_key_enc, p.headers, p.enabled AS penabled
     FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`,
    modelRowId,
  );
  if (!row || !row.enabled || !row.penabled) return null;
  return {
    modelRowId: row.id,
    model: row.model,
    label: row.label,
    providerId: row.pid,
    providerName: row.pname,
    conn: providerConn(row),
    caps: j(row.caps, {}),
  };
}

/** 系统默认模型：设置项 default_model_id，否则取第一个可用模型 */
export function defaultModelRef(): ModelRef | null {
  const id = getSetting<number | null>('default_model_id', null);
  const ref = modelRef(id);
  if (ref) return ref;
  const first = db.get<{ id: number }>(
    `SELECT m.id FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY p.sort, m.sort, m.id LIMIT 1`,
  );
  return modelRef(first?.id);
}

export interface CallOptions {
  agentKey?: string;
  /** 指定模型（覆盖智能体配置） */
  modelRowId?: number | null;
  fallbackModelRowId?: number | null;
  messages: Msg[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  userId?: number | null;
  purpose?: string;
  signal?: AbortSignal;
  /** 是否计入用户每日额度 */
  countQuota?: boolean;
  /** 这一次思考不思考、开到哪一档（DeepSeek 和 Gemini 起作用）；不传按模型设置 */
  think?: 'off' | Effort;
  /** 主模型多少毫秒还没动静就换备用模型；不传用设置项 first_token_timeout_ms（45 秒） */
  firstTokenMs?: number;
}

export interface CallResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  model: string;
  modelLabel: string;
  modelRowId: number;
  finish: string;
}

function checkQuota(userId?: number | null) {
  if (!userId || !config.dailyCallLimit) return;
  const user = db.get<{ role: string; is_super: number }>('SELECT role, is_super FROM users WHERE id = ?', userId);
  if (!user || user.is_super) return;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const count = db.value<number>('SELECT COUNT(*) FROM llm_calls WHERE user_id = ? AND created_at >= ?', userId, since.getTime()) || 0;
  const limit = user.role === 'student' ? config.dailyCallLimit : config.dailyCallLimit * 3;
  if (count >= limit) throw new HttpError(429, `今日 AI 调用次数已达上限（${limit} 次）`);
}

function logCall(
  ref: ModelRef,
  o: CallOptions,
  r: { input: number; output: number; latency: number; firstToken: number | null; status: string; error?: string; response?: string },
) {
  try {
    const lastUser = [...o.messages].reverse().find(m => m.role === 'user');
    db.insert('llm_calls', {
      agent_key: o.agentKey || null,
      provider_id: ref.providerId,
      model_id: ref.modelRowId,
      model: ref.model,
      user_id: o.userId || null,
      purpose: o.purpose || null,
      prompt_tokens: r.input,
      completion_tokens: r.output,
      latency_ms: r.latency,
      first_token_ms: r.firstToken,
      status: r.status,
      error: r.error ? truncate(r.error, 500) : null,
      request_preview: lastUser ? truncate(textOf(lastUser.content), 400) : null,
      response_preview: r.response ? truncate(r.response, 400) : null,
      created_at: now(),
    });
  } catch (err) {
    console.error('[llm] log failed', err);
  }
}

/** 部分模型对单次输出长度有硬上限，超出会直接报错，这里按模型收紧 */
const OUTPUT_CAPS: [RegExp, number][] = [[/deepseek-v3/i, 8192]];

/** DeepSeek V4 默认开启深度思考，按模型的「推理」能力决定开关（这一次指定了就按指定的）；其他模型不传 */
export function thinkingFor(ref: { model: string; caps: { reasoning?: boolean } }, want?: 'off' | Effort) {
  if (!/^deepseek-(flash|v4)/i.test(ref.model)) return undefined;
  return want ? want !== 'off' : ref.caps.reasoning === true;
}
export function capMaxTokens(model: string, n?: number) {
  if (!n) return n;
  const cap = OUTPUT_CAPS.find(([re]) => re.test(model))?.[1];
  return cap ? Math.min(n, cap) : n;
}

/** 可被取消的等待：用户点停止后，不再等到下一次重试 */
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('已取消'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 流式调用模型。内置：额度检查、可重试错误的自动重试（仅在尚未输出内容时）、备用模型切换、调用日志。
 * 额外产出 `{type:'model'}` 事件告知实际使用的模型。
 */
export async function* streamChat(
  o: CallOptions,
): AsyncGenerator<Delta | { type: 'model'; model: string; label: string; modelRowId: number; switched?: boolean }> {
  if (o.countQuota !== false) checkQuota(o.userId);
  const primary = modelRef(o.modelRowId) || defaultModelRef();
  if (!primary) throw new HttpError(503, '尚未配置可用的大模型，请管理员在「模型服务」中接入');
  const chain: ModelRef[] = [primary];
  // 没指定备用的，用设置里的备用模型
  const fb = modelRef(o.fallbackModelRowId ?? getSetting<number | null>('fallback_model_id', null));
  if (fb && fb.modelRowId !== primary.modelRowId) chain.push(fb);

  // 首字看门狗：主模型迟迟不出字时直接切换备用模型，不让用户干等
  const firstTokenMs = o.firstTokenMs ?? getSetting<number>('first_token_timeout_ms', 45_000);
  let lastErr: unknown;
  for (let ci = 0; ci < chain.length; ci++) {
    const ref = chain[ci];
    yield { type: 'model', model: ref.model, label: ref.label, modelRowId: ref.modelRowId, switched: ci > 0 };
    const tools = o.tools?.length && ref.caps.tools !== false ? o.tools : undefined;
    const hasNext = ci < chain.length - 1;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (o.signal?.aborted) throw o.signal.reason ?? new Error('已取消');
      const started = Date.now();
      let firstToken: number | null = null;
      let emitted = false;
      let stalled = false;
      let input = 0;
      let output = 0;
      let text = '';
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(o.signal?.reason);
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const watchdog =
        hasNext && firstTokenMs > 0 ? setTimeout(() => ((stalled = true), ctrl.abort(new Error('first-token-timeout'))), firstTokenMs) : undefined;
      try {
        const gen = adapterOf(ref.conn).stream(ref.conn, {
          model: ref.model,
          messages: o.messages,
          tools,
          temperature: o.temperature,
          maxTokens: capMaxTokens(ref.model, o.maxTokens),
          thinking: thinkingFor(ref, o.think),
          effort: o.think && o.think !== 'off' ? o.think : undefined,
          signal: ctrl.signal,
        });
        for await (const d of gen) {
          if (d.type === 'usage') {
            input = Math.max(input, d.input);
            output = Math.max(output, d.output);
            continue;
          }
          if ((d.type === 'text' || d.type === 'reasoning' || d.type === 'tool' || d.type === 'partial') && firstToken === null) {
            firstToken = Date.now() - started;
            clearTimeout(watchdog);
          }
          if (d.type === 'text') text += d.text;
          // 空的一段不算出了内容（Gemini 接口头一到先报一段空的，只为让看门狗知道它在动；后面出错照样能换备用模型）
          // 写到一半的工具参数只是预览，也不算（出错了照样重试、换备用模型，页面上的预览跟着换）
          if (d.type !== 'finish' && d.type !== 'partial' && !((d.type === 'text' || d.type === 'reasoning') && !d.text)) emitted = true;
          yield d;
        }
        if (!input) input = o.messages.reduce((s, m) => s + estimateTokens(textOf(m.content)), 0);
        if (!output) output = estimateTokens(text);
        logCall(ref, o, { input, output, latency: Date.now() - started, firstToken, status: 'ok', response: text });
        return;
      } catch (err: any) {
        lastErr = stalled ? new LlmError(`${ref.label} 超过 ${Math.round(firstTokenMs / 1000)} 秒没有输出`, 504, true) : err;
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        logCall(ref, o, {
          input,
          output: estimateTokens(text),
          latency: Date.now() - started,
          firstToken,
          status: o.signal?.aborted ? 'canceled' : 'error',
          error: stalled ? `${msg}，已切换备用模型` : msg,
          response: text,
        });
        if (o.signal?.aborted) throw err;
        // 已经输出了部分内容：不再重试或切换模型，避免内容重复
        if (emitted) throw new HttpError(502, msg);
        if (stalled) break;
        const retryable = err instanceof LlmError ? err.retryable : true;
        if (!retryable) break;
        await pause(800 * (attempt + 1) + Math.random() * 400, o.signal);
      } finally {
        clearTimeout(watchdog);
        o.signal?.removeEventListener('abort', onAbort);
      }
    }
  }
  const m = lastErr instanceof Error ? lastErr.message : '模型调用失败';
  throw new HttpError(502, m);
}

/** 非流式调用：收集完整结果 */
export async function chat(o: CallOptions): Promise<CallResult> {
  let text = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  let usage = { input: 0, output: 0 };
  let model = '';
  let modelLabel = '';
  let modelRowId = 0;
  let finish = 'stop';
  for await (const d of streamChat(o)) {
    if (d.type === 'text') text += d.text;
    else if (d.type === 'reasoning') reasoning += d.text;
    else if (d.type === 'tool') toolCalls.push(d.call);
    else if (d.type === 'usage') usage = { input: d.input, output: d.output };
    else if (d.type === 'model') {
      model = d.model;
      modelLabel = d.label;
      modelRowId = d.modelRowId;
      text = '';
      reasoning = '';
      toolCalls.length = 0;
    } else if (d.type === 'finish') finish = d.reason;
  }
  return { text, reasoning, toolCalls, usage, model, modelLabel, modelRowId, finish };
}

/** 测试连接：拉取模型列表 + （可选）发一条极短的对话 */
export async function testProvider(conn: ProviderConn, model?: string) {
  const t0 = Date.now();
  const result: { ok: boolean; latencyMs: number; models: number | null; reply?: string; error?: string; listError?: string } = {
    ok: false,
    latencyMs: 0,
    models: null,
  };
  try {
    const list = await adapterOf(conn).listModels(conn);
    result.models = list.length;
  } catch (err: any) {
    result.listError = err?.message || String(err);
  }
  if (model) {
    try {
      let reply = '';
      const gen = adapterOf(conn).stream(conn, {
        model,
        messages: [{ role: 'user', content: '请只回复“连接成功”四个字。' }],
        maxTokens: 64,
        temperature: 0,
        signal: AbortSignal.timeout(60_000),
      });
      for await (const d of gen) if (d.type === 'text') reply += d.text;
      result.reply = reply.trim().slice(0, 60) || '(空回复)';
      result.ok = true;
    } catch (err: any) {
      result.error = err?.message || String(err);
    }
  } else result.ok = result.models !== null;
  result.latencyMs = Date.now() - t0;
  if (!result.ok && !result.error) result.error = result.listError;
  return result;
}

import { LlmError } from './types.js';

/** 规范化 Base URL：去掉末尾斜杠；只有域名时自动补 /v1（OpenAI 兼容习惯） */
export function normalizeOpenAiBase(base: string): string {
  let b = base.trim().replace(/\/+$/, '');
  b = b.replace(/\/chat\/completions$/, '');
  try {
    const u = new URL(b);
    if (u.pathname === '' || u.pathname === '/') b = b + '/v1';
  } catch {
    /* 非法 URL 交给后续请求报错 */
  }
  return b;
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/** 带超时与中断的 fetch，统一把 HTTP 错误转换为 LlmError */
export async function request(url: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal }): Promise<Response> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error('timeout')), init.timeoutMs ?? 120_000);
  const onAbort = () => ctrl.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', onAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err: any) {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', onAbort);
    if (init.signal?.aborted) throw new LlmError('请求已取消', 499, false);
    const reason = err?.cause?.code || err?.message || String(err);
    throw new LlmError(reason === 'timeout' ? '连接模型服务超时' : `无法连接模型服务：${reason}`, 0, true);
  }
  // 连接建立后取消总超时，改由流式读取自行控制
  clearTimeout(timeout);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    init.signal?.removeEventListener('abort', onAbort);
    throw new LlmError(describeHttpError(res.status, text), res.status, res.status === 429 || res.status >= 500, text.slice(0, 2000));
  }
  return res;
}

export function describeHttpError(status: number, body: string): string {
  if (status === 402) return '模型服务的账户余额不足，充值后才能继续（HTTP 402）';
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message || j?.message || j?.error || j?.detail || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  detail = detail.slice(0, 300);
  const hint =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 404
        ? '接口地址或模型名称不存在'
        : status === 429
          ? '请求过于频繁或额度不足'
          : status >= 500
            ? '模型服务暂时不可用'
            : '请求被拒绝';
  return `${hint}（HTTP ${status}）${detail ? '：' + detail : ''}`;
}

/** 解析 Server-Sent Events 流 */
export async function* readSse(res: Response, signal?: AbortSignal, idleMs = 90_000): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  try {
    while (true) {
      if (signal?.aborted) throw new LlmError('请求已取消', 499);
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LlmError('模型长时间没有返回内容', 504, true)), idleMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        let val = c < 0 ? '' : line.slice(c + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'data') {
          // 兼容部分服务不输出空行分隔：遇到新的完整 JSON 行时直接产出
          if (data.length && isCompleteJson(data.join('\n'))) {
            yield { event, data: data.join('\n') };
            data = [];
          }
          data.push(val);
        } else if (field === 'event') event = val;
      }
    }
    buf += decoder.decode();
    if (buf.trim().startsWith('data:')) data.push(buf.trim().slice(5).trim());
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.cancel().catch(() => {});
  }
}

function isCompleteJson(s: string): boolean {
  const t = s.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

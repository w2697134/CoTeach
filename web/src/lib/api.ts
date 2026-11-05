/**
 * 接口调用：统一附带 CSRF 请求头、JSON 编解码与中文错误信息；
 * streamSSE 解析 POST 返回的 Server-Sent Events（聊天、生成等流式输出）。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

type Json = Record<string, any> | any[] | null;

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: Json | FormData; signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'x-tv2': '1', ...(opts.body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
    signal: opts.signal,
    keepalive: opts.keepalive,
    credentials: 'same-origin',
  }).catch(err => {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError('网络连接失败，请检查网络后重试', 0);
  });
  const ctype = res.headers.get('content-type') || '';
  const data = ctype.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const message = (data && typeof data === 'object' && (data as any).error) || (typeof data === 'string' && data) || `请求失败（${res.status}）`;
    throw new ApiError(String(message), res.status, (data as any)?.code);
  }
  return data as T;
}

export const get = <T = any>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T = any>(path: string, body?: Json | FormData) => api<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T = any>(path: string, body?: Json) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export interface SseHandlers {
  onEvent: (event: string, data: any) => void;
  signal?: AbortSignal;
}

/** 以 POST 发起请求并逐条解析返回的 SSE 事件；流结束时 resolve */
export async function streamSSE(path: string, body: Json, h: SseHandlers): Promise<void> {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'x-tv2': '1', 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    signal: h.signal,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status);
  }
  await readEventStream(res, h.onEvent);
}

export async function readEventStream(res: Response, onEvent: (event: string, data: any) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join('\n');
    let parsed: any = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* 纯文本 */
    }
    if (event !== 'ping') onEvent(event, parsed);
    event = 'message';
    data = [];
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let val = c < 0 ? '' : line.slice(c + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') event = val;
      else if (field === 'data') data.push(val);
    }
  }
  dispatch();
}

/** 订阅 GET 型 SSE（自动重连由浏览器 EventSource 负责） */
export function subscribe(path: string, handlers: Record<string, (data: any) => void>, onError?: () => void): () => void {
  const es = new EventSource('/api' + path, { withCredentials: true });
  for (const [ev, fn] of Object.entries(handlers)) {
    es.addEventListener(ev, e => {
      try {
        fn(JSON.parse((e as MessageEvent).data));
      } catch {
        fn((e as MessageEvent).data);
      }
    });
  }
  es.onerror = () => onError?.();
  return () => es.close();
}

export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

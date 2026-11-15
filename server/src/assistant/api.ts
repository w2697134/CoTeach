/**
 * 助教替老师办事：在服务器里直接调页面用的那些接口（班级、作业、成绩）。
 * 走的是同一套检查，老师在页面上能做的它才能做，报错也是同样的话。
 */
import type { Hono } from 'hono';
import { HttpError } from '../lib/http.js';

let app: Hono<any> | null = null;
/** 服务启动（createApp）时登记；测试里每建一个 app 也登记一次 */
export function setInternalApp(a: Hono<any>) {
  app = a;
}

/** 下载类接口（导出成绩、附件）回来的是文件 */
export interface FileReply {
  bytes: Uint8Array;
  type: string;
  disposition: string | null;
}

export async function callApi<T = any>(userId: number, method: string, path: string, body?: unknown): Promise<T> {
  if (!app) throw new Error('服务还没准备好');
  const raw = body instanceof Uint8Array;
  const headers: Record<string, string> = { 'x-tv2': '1' };
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const res = await app.request(
    '/api' + path,
    { method, headers, body: body === undefined ? undefined : raw ? (body as Uint8Array) : JSON.stringify(body) },
    { ctInternalUser: userId },
  );
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!res.ok) throw new HttpError(res.status, '没办成');
    return { bytes: new Uint8Array(await res.arrayBuffer()), type, disposition: res.headers.get('content-disposition') } as T;
  }
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new HttpError(res.status, json?.error || '没办成', json?.code);
  return json as T;
}

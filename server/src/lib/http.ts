import type { Context } from 'hono';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = '请先登录') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = '没有权限执行此操作') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = '内容不存在或已被删除') => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');
export const tooMany = (msg = '操作太频繁，请稍后再试') => new HttpError(429, msg, 'rate_limited');

/** 用 zod 校验请求体，失败时返回中文错误 */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw bad('请求格式不正确');
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path?.join('.') || '';
    throw bad(`参数错误${path ? `（${path}）` : ''}：${issue?.message || '格式不正确'}`);
  }
  return r.data;
}

export function query<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw bad('查询参数错误');
  return r.data;
}

export function intParam(c: Context, name = 'id'): number {
  const v = Number(c.req.param(name));
  if (!Number.isInteger(v) || v <= 0) throw bad('参数错误');
  return v;
}

export function clientIp(c: Context): string {
  return (c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0] || '').trim() || 'local';
}

/** 限流（内存里按滑动窗口计数） */
const buckets = new Map<string, number[]>();
export function rateLimit(key: string, limit: number, windowMs: number) {
  const t = Date.now();
  const arr = (buckets.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= limit) throw tooMany();
  arr.push(t);
  buckets.set(key, arr);
}
setInterval(() => {
  const t = Date.now();
  for (const [k, arr] of buckets) if (!arr.some(x => t - x < 3600_000)) buckets.delete(k);
}, 600_000).unref();

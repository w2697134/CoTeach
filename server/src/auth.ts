import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config, isProd } from './config.js';
import { db, j, now } from './db/index.js';
import { randomToken, sha256 } from './lib/crypto.js';
import { clientIp, forbidden, unauthorized } from './lib/http.js';

export type Role = 'admin' | 'teacher' | 'student';

export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
  avatar: string | null;
  gender: string | null;
  email: string | null;
  phone: string | null;
  student_no: string | null;
  title: string | null;
  bio: string | null;
  is_demo: number;
  is_super: number;
  status: string;
  settings: Record<string, any>;
  created_at: number;
  last_login_at: number | null;
}

export type AppEnv = { Variables: { user: User | null } };

const COOKIE = 'ct_sid';

export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    avatar: u.avatar,
    gender: u.gender,
    email: u.email,
    phone: u.phone,
    studentNo: u.student_no,
    title: u.title,
    bio: u.bio,
    isDemo: !!u.is_demo,
    isSuper: !!u.is_super,
    settings: u.settings,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

export function loadUserById(id: number): User | null {
  const row = db.get<any>('SELECT * FROM users WHERE id = ?', id);
  if (!row) return null;
  row.settings = j(row.settings, {});
  return row as User;
}

export function createSession(c: Context, userId: number) {
  const previous = getCookie(c, COOKIE);
  if (previous) db.run('DELETE FROM sessions WHERE id=?', sha256(previous));
  const token = randomToken(32);
  const t = now();
  db.insert('sessions', {
    id: sha256(token),
    user_id: userId,
    created_at: t,
    expires_at: t + config.sessionDays * 86400_000,
    ip: clientIp(c),
    ua: (c.req.header('user-agent') || '').slice(0, 200),
  });
  db.run('UPDATE users SET last_login_at = ?, last_active_at = ? WHERE id = ?', t, t, userId);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    // HTTPS 访问时才加 Secure，用 http 部署时也能登录
    secure: isProd && ((c.req.header('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || new URL(c.req.url).protocol === 'https:'),
    path: '/',
    maxAge: config.sessionDays * 86400,
  });
}

export function destroySession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
  deleteCookie(c, COOKIE, { path: '/' });
}

export function sessionStillActive(c: Context<AppEnv>): boolean {
  const current = c.get('user'),
    token = getCookie(c, COOKIE);
  if (!current || !token) return false;
  return !!db.get(
    'SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.id=? AND u.role=? AND u.status=? AND s.expires_at>?',
    sha256(token),
    current.id,
    current.role,
    'active',
    now(),
  );
}

const lastTouch = new Map<number, number>();

/**
 * 助教替老师办事时，在服务器里直接调这些接口（app.request 的第三个参数带 ctInternalUser）：
 * 跟老师在页面上点按钮走同一套检查，老师能做的它才能做。外面来的请求带不上这个参数。
 */
export interface InternalEnv {
  ctInternalUser?: number;
}

/** 根据会话 Cookie 取出当前用户 */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const internal = (c.env as InternalEnv | undefined)?.ctInternalUser;
  if (typeof internal === 'number') {
    const u = loadUserById(internal);
    if (u && u.status === 'active') c.set('user', u);
    await next();
    return;
  }
  const token = getCookie(c, COOKIE);
  if (token) {
    const s = db.get<{ user_id: number; expires_at: number }>('SELECT user_id, expires_at FROM sessions WHERE id = ?', sha256(token));
    if (s && s.expires_at > now()) {
      const u = loadUserById(s.user_id);
      if (u && u.status === 'active') {
        c.set('user', u);
        const t = now();
        if (t - (lastTouch.get(u.id) || 0) > 60_000) {
          lastTouch.set(u.id, t);
          db.run('UPDATE users SET last_active_at = ? WHERE id = ?', t, u.id);
        }
      }
    }
  }
  await next();
};

/** 防 CSRF：除 GET/HEAD/OPTIONS 外的请求必须带 x-tv2 请求头 */
export const csrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && c.req.header('x-tv2') !== '1') {
    return c.json({ error: '请求来源校验失败，请刷新页面后重试' }, 403);
  }
  await next();
};

export function me(c: Context<AppEnv>): User {
  const u = c.get('user');
  if (!u) throw unauthorized();
  return u;
}

export function requireRole(c: Context<AppEnv>, ...roles: Role[]): User {
  const u = me(c);
  if (!roles.includes(u.role)) throw forbidden();
  return u;
}

export const auth =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (roles.length) requireRole(c, ...roles);
    else me(c);
    await next();
  };

export function audit(c: Context<AppEnv>, action: string, target?: string, detail?: unknown) {
  db.insert('audit_logs', {
    user_id: c.get('user')?.id ?? null,
    action,
    target: target ?? null,
    detail: detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip: clientIp(c),
    created_at: now(),
  });
}

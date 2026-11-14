import { Hono } from 'hono';
import { z } from 'zod';
import { audit, createSession, destroySession, loadUserById, publicUser, type AppEnv } from '../auth.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { startingKb } from '../kb/repo.js';
import { verifyPassword } from '../lib/crypto.js';
import { bad, body, clientIp, forbidden, rateLimit, unauthorized } from '../lib/http.js';

export const authRoutes = new Hono<AppEnv>();

const DEMO_ACCOUNTS = [
  { role: 'teacher', username: 'teacher', label: '教师' },
  { role: 'student', username: 'student', label: '学生' },
] as const;

authRoutes.get('/config', c => {
  const demos = config.demoMode
    ? DEMO_ACCOUNTS.map(d => {
        const u = db.get<{ name: string }>('SELECT name FROM users WHERE username = ? AND is_demo = 1', d.username);
        return u ? { ...d, name: u.name } : null;
      }).filter(Boolean)
    : [];
  return c.json({ demoMode: config.demoMode, demoAccounts: demos });
});

authRoutes.post('/login', async c => {
  const { username, password } = await body(c, z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }));
  rateLimit(`login:${clientIp(c)}`, 20, 10 * 60_000);
  rateLimit(`login:${username.toLowerCase()}`, 10, 10 * 60_000);
  const row = db.get<{ id: number; password_hash: string; status: string }>('SELECT id, password_hash, status FROM users WHERE username = ?', username.trim());
  if (!row || !verifyPassword(password, row.password_hash)) throw unauthorized('账号或密码不正确');
  if (row.status !== 'active') throw forbidden('账号已被停用，请联系管理员');
  createSession(c, row.id);
  c.set('user', loadUserById(row.id));
  audit(c, 'login', `user:${row.id}`);
  return c.json({ user: publicUser(loadUserById(row.id)!) });
});

/** 演示模式一键登录 */
authRoutes.post('/demo', async c => {
  if (!config.demoMode) throw forbidden('演示入口已关闭');
  const { role } = await body(c, z.object({ role: z.enum(['teacher', 'student']) }));
  rateLimit(`demo:${clientIp(c)}`, 30, 10 * 60_000);
  const acct = DEMO_ACCOUNTS.find(d => d.role === role)!;
  const row = db.get<{ id: number }>('SELECT id FROM users WHERE username = ? AND is_demo = 1', acct.username);
  if (!row) throw bad('演示账号不存在');
  createSession(c, row.id);
  return c.json({ user: publicUser(loadUserById(row.id)!) });
});

authRoutes.post('/logout', c => {
  destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', async c => {
  const u = c.get('user');
  if (!u) return c.json({ user: null });
  // 老师最早的那个知识库；自己全删了就是空
  const kbId = u.role === 'teacher' || u.role === 'admin' ? await startingKb(u.id) : null;
  return c.json({ user: { ...publicUser(u), kbId } });
});

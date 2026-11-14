import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { audit, requireRole, type AppEnv } from '../auth.js';
import { db, getSetting, setSetting } from '../db/index.js';
import { hashPassword } from '../lib/crypto.js';
import { bad, body, forbidden, intParam, notFound } from '../lib/http.js';

/**
 * 管理页（只有管理员）：看所有账号、停用和恢复、重置密码、看今天每人调了几次模型；开关老师注册。
 * 没有短信和邮箱，老师忘了密码就在这里重置。
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', async (c, next) => {
  requireRole(c, 'admin');
  await next();
});

const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

adminRoutes.get('/users', (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 40);
  const role = c.req.query('role') || '';
  if (role && !['teacher', 'student', 'admin'].includes(role)) throw bad('身份不对');
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const users = db.all<Record<string, any>>(
    `SELECT u.id, u.username, u.name, u.role, u.is_demo, u.is_super, u.status, u.created_at, u.last_active_at,
       (SELECT count(*) FROM llm_calls l WHERE l.user_id=u.id AND l.created_at>=?) AS calls_today,
       (SELECT count(*) FROM classes k WHERE k.teacher_id=u.id AND k.deleted_at IS NULL) AS classes,
       (SELECT count(*) FROM class_students s WHERE s.user_id=u.id) AS joined
     FROM users u
     WHERE (?='' OR u.name LIKE ? OR u.username LIKE ?) AND (?='' OR u.role=?)
     ORDER BY u.is_super DESC, u.created_at DESC LIMIT 300`,
    today(),
    q,
    like,
    like,
    role,
    role,
  );
  const counts = db.all<{ role: string; n: number }>('SELECT role, count(*) AS n FROM users GROUP BY role');
  return c.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      demo: !!u.is_demo,
      super: !!u.is_super,
      active: u.status === 'active',
      createdAt: u.created_at,
      lastActiveAt: u.last_active_at,
      callsToday: u.calls_today,
      classes: u.classes,
      joined: u.joined,
    })),
    counts: Object.fromEntries(counts.map((r) => [r.role, r.n])),
  });
});

function target(c: Parameters<typeof requireRole>[0]) {
  const me = requireRole(c, 'admin');
  const id = intParam(c);
  const u = db.get<{ id: number; name: string; is_super: number }>('SELECT id, name, is_super FROM users WHERE id=?', id);
  if (!u) throw notFound('没有这个账号');
  if (u.id === me.id) throw bad('自己的账号在右上角菜单里改');
  if (u.is_super) throw forbidden('管理员账号不能在这里改');
  return u;
}

/** 重置密码：给 6 位数字，只显示这一次；这个账号在别处登着的都退出 */
adminRoutes.post('/users/:id/password', (c) => {
  const u = target(c);
  const password = String(randomInt(100000, 1000000));
  db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), u.id);
  db.run('DELETE FROM sessions WHERE user_id=?', u.id);
  audit(c, 'admin.password', `user:${u.id}`);
  return c.json({ password });
});

/** 停用、恢复：停用的登不进来，登着的马上退出 */
adminRoutes.post('/users/:id/status', async (c) => {
  const u = target(c);
  const d = await body(c, z.object({ active: z.boolean() }));
  db.run('UPDATE users SET status=? WHERE id=?', d.active ? 'active' : 'disabled', u.id);
  if (!d.active) db.run('DELETE FROM sessions WHERE user_id=?', u.id);
  audit(c, d.active ? 'admin.enable' : 'admin.disable', `user:${u.id}`);
  return c.json({ ok: true });
});

adminRoutes.get('/settings', (c) => c.json({ teacherSignup: getSetting('teacher_signup', true) }));

adminRoutes.put('/settings', async (c) => {
  const d = await body(c, z.object({ teacherSignup: z.boolean() }));
  setSetting('teacher_signup', d.teacherSignup);
  audit(c, 'admin.settings', 'settings', d);
  return c.json({ ok: true });
});

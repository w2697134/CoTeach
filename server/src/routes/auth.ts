import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { audit, createSession, destroySession, loadUserById, mayUsePassword, me, publicUser, type AppEnv } from '../auth.js';
import { anyLoginKey, findLoginKey, touchLoginKey } from '../login-keys.js';
import { config } from '../config.js';
import { db, getSetting, now, setSetting } from '../db/index.js';
import { startingKb } from '../kb/repo.js';
import { hashPassword, sha256, verifyPassword } from '../lib/crypto.js';
import { bad, body, clientIp, conflict, forbidden, HttpError, rateLimit, unauthorized } from '../lib/http.js';

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
  const only = config.loginOnly.length > 0,
    closed = only || !config.passwordLogin;
  return c.json({
    demoMode: config.demoMode && !closed,
    demoAccounts: closed ? [] : demos,
    teacherSignup: !closed && getSetting('teacher_signup', true),
    loginOnly: only,
    passwordLogin: config.passwordLogin,
    keyLogin: anyLoginKey(),
  });
});

/** 老师的账号用手机号（照课堂派、学习通）；现在不发验证码，以后接短信也还是这个号 */
function phoneOf(raw: string) {
  const phone = raw.replace(/[\s-]/g, '');
  if (!/^1\d{10}$/.test(phone)) throw bad('手机号填 11 位数字');
  return phone;
}
function nameOf(raw: string) {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 20) throw bad('姓名填得不对');
  return name;
}
function passwordOf(raw: string) {
  if (raw.length < 6) throw bad('密码至少 6 位');
  return raw;
}

/**
 * 老师注册：手机号、姓名、密码，注册完直接登录，给一个空的「我的知识库」。照课堂派、雨课堂，不审核、不要邀请码；
 * 管理员可以在管理页关掉老师注册。学生不在这里注册，拿加课码在加入页注册。
 */
authRoutes.post('/register', async c => {
  if (c.get('user')) throw bad('已经登录了，先退出再注册');
  if (!config.passwordLogin) throw forbidden('注册暂未开放');
  if (config.loginOnly.length) throw forbidden('现在只开放给指定的账号，不能注册');
  if (!getSetting('teacher_signup', true)) throw forbidden('现在不开放老师注册');
  rateLimit(`register:${clientIp(c)}`, 30, 60 * 60_000);
  const d = await body(c, z.object({ phone: z.string().max(30), name: z.string().max(40), password: z.string().max(128) }));
  const phone = phoneOf(d.phone),
    name = nameOf(d.name),
    password = passwordOf(d.password);
  if (db.get('SELECT id FROM users WHERE username = ?', phone)) throw new HttpError(409, '这个手机号已经注册过了，直接登录就行', 'registered');
  const id = db.insert('users', { username: phone, phone, name, role: 'teacher', password_hash: hashPassword(password), created_at: now() });
  await startingKb(id);
  createSession(c, id);
  c.set('user', loadUserById(id));
  audit(c, 'user.register', `user:${id}`, { role: 'teacher' });
  return c.json({ user: publicUser(loadUserById(id)!) });
});

/**
 * 演示老师设成自己的正式账号：填手机号、姓名、密码，以后用手机号登录，里面的东西都还在。
 * 设好以后别人登着的这个演示账号都退出，演示入口也不再补一个新的演示老师。
 */
authRoutes.post('/claim', async c => {
  const u = me(c);
  // 只有登录页上那个演示老师能设成自己的；给评委的体验账号也标着演示，但不能被一个人拿走
  if (!u.is_demo || u.role !== 'teacher' || u.username !== DEMO_ACCOUNTS.find((d) => d.role === 'teacher')!.username) throw forbidden('这个账号不用设');
  rateLimit(`claim:${u.id}`, 10, 10 * 60_000);
  const d = await body(c, z.object({ phone: z.string().max(30), name: z.string().max(40), password: z.string().max(128) }));
  const phone = phoneOf(d.phone),
    name = nameOf(d.name),
    password = passwordOf(d.password);
  if (db.get('SELECT id FROM users WHERE username = ? AND id <> ?', phone, u.id)) throw conflict('这个手机号已经注册过了');
  db.update('users', u.id, { username: phone, phone, name, title: null, password_hash: hashPassword(password), is_demo: 0 });
  const token = getCookie(c, 'ct_sid');
  db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, token ? sha256(token) : '');
  setSetting('demo_teacher_claimed', true);
  audit(c, 'user.claim', `user:${u.id}`);
  return c.json({ user: publicUser(loadUserById(u.id)!) });
});

authRoutes.post('/login', async c => {
  const { username, password } = await body(c, z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }));
  // 按 IP 放宽（一个教室共用出口 IP），按账号的限制不变，挡住对一个账号猜密码
  rateLimit(`login:${clientIp(c)}`, 300, 10 * 60_000);
  rateLimit(`login:${username.toLowerCase()}`, 10, 10 * 60_000);
  const row = db.get<{ id: number; username: string; role: string; is_super: number; password_hash: string; status: string }>(
    'SELECT id, username, role, is_super, password_hash, status FROM users WHERE username = ?',
    username.trim(),
  );
  // 账号密码登录关着：除了管理员，密码对不对都不看，免得关着还能拿来试密码
  if (!config.passwordLogin && !(row && (row.role === 'admin' || row.is_super))) throw forbidden('账号密码登录暂未开放，用登录密钥进');
  if (!row || !verifyPassword(password, row.password_hash)) throw unauthorized('账号或密码不正确');
  if (row.status !== 'active') throw forbidden('账号已被停用，请联系管理员');
  if (!mayUsePassword(row)) throw forbidden('现在只开放给指定的账号');
  createSession(c, row.id);
  c.set('user', loadUserById(row.id));
  audit(c, 'login', `user:${row.id}`);
  return c.json({ user: publicUser(loadUserById(row.id)!) });
});

/** 用登录密钥进：贴上密钥就进对应的号，不用输账号密码。密钥在管理页发，或者服务器上用 tools/login-keys 发 */
authRoutes.post('/key', async (c) => {
  const { key } = await body(c, z.object({ key: z.string().min(1).max(100) }));
  rateLimit(`key:${clientIp(c)}`, 60, 10 * 60_000);
  const k = findLoginKey(key);
  if (!k) throw unauthorized('这把密钥不对，或者已经停用了');
  const u = loadUserById(k.user_id);
  if (!u || u.status !== 'active') throw forbidden('账号已被停用，请联系管理员');
  createSession(c, u.id);
  touchLoginKey(k.id);
  c.set('user', u);
  audit(c, 'login.key', `user:${u.id}`);
  return c.json({ user: publicUser(loadUserById(u.id)!) });
});

/** 演示模式一键登录 */
authRoutes.post('/demo', async c => {
  if (!config.demoMode || config.loginOnly.length || !config.passwordLogin) throw forbidden('演示入口已关闭');
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

/** 自己改密码：要对上原密码；改完别的地方登着的都退出，这里的留着 */
authRoutes.post('/password', async c => {
  const u = me(c);
  if (u.is_demo) throw forbidden('演示账号不能改密码');
  const d = await body(c, z.object({ old: z.string().max(128), password: z.string().max(128) }));
  rateLimit(`password:${u.id}`, 10, 10 * 60_000);
  if (d.password.length < 6) throw bad('新密码至少 6 位');
  const row = db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', u.id);
  if (!row || !verifyPassword(d.old, row.password_hash)) throw bad('原密码不对');
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(d.password), u.id);
  const token = getCookie(c, 'ct_sid');
  db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, token ? sha256(token) : '');
  audit(c, 'user.password', `user:${u.id}`);
  return c.json({ ok: true });
});

authRoutes.get('/me', async c => {
  const u = c.get('user');
  if (!u) return c.json({ user: null });
  // 老师最早的那个知识库；自己全删了就是空
  const kbId = u.role === 'teacher' || u.role === 'admin' ? await startingKb(u.id) : null;
  return c.json({ user: { ...publicUser(u), kbId } });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// 比赛期间线上只开放给评委的账号（CT_LOGIN_ONLY）：名单外的登不进、已登着的算退出，注册和演示入口关掉；管理员总能进
const dir = mkdtempSync(join(tmpdir(), 'coteach-login-only-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_LOGIN_ONLY = 'judge, judge-xs';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const app = createApp();

const user = (username: string, role: string, extra: Record<string, unknown> = {}) =>
  db.insert('users', { username, name: username, role, password_hash: hashPassword('pass1234'), created_at: Date.now(), ...extra });
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
async function call(path: string, body?: unknown, ck = '') {
  const res = await app.request('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-tv2': '1', 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

test('只开放给指定账号：名单里的和管理员能登，别人登不进、登着的算退出，注册和演示入口关掉', async () => {
  user('judge', 'teacher');
  user('judge-xs', 'student');
  const other = user('t0', 'teacher');
  user('root', 'admin', { is_super: 1 });

  assert.equal((await call('/auth/login', { username: 'judge', password: 'pass1234' })).status, 200);
  assert.equal((await call('/auth/login', { username: 'judge-xs', password: 'pass1234' })).status, 200);
  assert.equal((await call('/auth/login', { username: 'root', password: 'pass1234' })).status, 200);
  const no = await call('/auth/login', { username: 't0', password: 'pass1234' });
  assert.equal(no.status, 403);
  assert.match(no.json.error, /指定的账号/);
  // 密码不对还是说密码不对，不先说名单
  assert.equal((await call('/auth/login', { username: 't0', password: 'wrong-pass' })).status, 401);

  // 名单外已经登着的：当成没登录
  assert.equal((await call('/auth/me', undefined, cookie(other))).json.user, null);

  // 注册、学生拿加课码注册、演示入口都关了；登录页不显示注册
  assert.equal((await call('/auth/register', { phone: '13800000009', name: '新老师', password: 'abc123' })).status, 403);
  assert.equal((await call('/classes/join/register', { code: 'ABCDEF', studentNo: '2025990199', name: '新同学', password: 'abc123' })).status, 403);
  assert.equal((await call('/auth/demo', { role: 'teacher' })).status, 403);
  const cfg = (await call('/auth/config')).json;
  assert.equal(cfg.loginOnly, true);
  assert.equal(cfg.teacherSignup, false);
  assert.equal(cfg.demoMode, false);
});

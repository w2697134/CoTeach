import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// 账号密码登录关掉（CT_PASSWORD_LOGIN=off，比赛期间「直接就剩密钥」）：只能用登录密钥进，管理员除外；注册、演示入口关掉
const dir = mkdtempSync(join(tmpdir(), 'coteach-keys-only-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_PASSWORD_LOGIN = 'off';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { issueLoginKey } = await import('../src/login-keys.js');
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

test('账号密码登录关了：拿密钥的能进，密码进不来（对不对都一样说暂未开放），管理员照常；没密钥的登着也算退出；注册关掉', async () => {
  const t = user('t0', 'teacher');
  const s = user('s0', 'student');
  user('root', 'admin', { is_super: 1 });
  const key = issueLoginKey(t);

  const cfg = (await call('/auth/config')).json;
  assert.equal(cfg.passwordLogin, false);
  assert.equal(cfg.keyLogin, true);
  assert.equal(cfg.teacherSignup, false);
  assert.equal(cfg.demoMode, false);

  // 密码对不对都说暂未开放，关着的时候不能拿来试密码；管理员照常
  for (const password of ['pass1234', 'wrong-pass']) {
    const r = await call('/auth/login', { username: 't0', password });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /暂未开放/);
  }
  assert.match((await call('/auth/login', { username: 'nobody', password: 'x' })).json.error, /暂未开放/);
  assert.equal((await call('/auth/login', { username: 'root', password: 'pass1234' })).status, 200);
  assert.equal((await call('/auth/login', { username: 'root', password: 'wrong-pass' })).status, 401);

  // 密钥照常进；有密钥的登着算数，没密钥的登着算退出
  assert.equal((await call('/auth/key', { key })).json.user.username, 't0');
  assert.equal((await call('/auth/me', undefined, cookie(t))).json.user.username, 't0');
  assert.equal((await call('/auth/me', undefined, cookie(s))).json.user, null);

  // 注册、拿加课码注册、演示入口都关着
  assert.match((await call('/auth/register', { phone: '13800000009', name: '新老师', password: 'abc123' })).json.error, /暂未开放/);
  assert.match((await call('/classes/join/register', { code: 'ABCDEF', studentNo: '2025990199', name: '新同学', password: 'abc123' })).json.error, /暂未开放/);
  assert.equal((await call('/auth/demo', { role: 'teacher' })).status, 403);
});

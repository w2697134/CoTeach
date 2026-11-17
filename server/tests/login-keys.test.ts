import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 登录密钥（一个号一把，贴上就进）：比赛期间线上只开放给指定账号，手里有密钥的也算，但只能用密钥进
const dir = mkdtempSync(join(tmpdir(), 'coteach-login-keys-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_LOGIN_ONLY = 'judge';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const app = createApp();

const user = (username: string, role: string, extra: Record<string, unknown> = {}) =>
  db.insert('users', { username, name: username, role, password_hash: hashPassword('pass1234'), created_at: Date.now(), ...extra });
async function call(path: string, body?: unknown, ck = '', method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'x-tv2': '1', 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, json: (await res.json()) as any, cookie };
}
const login = async (username: string) => (await call('/auth/login', { username, password: 'pass1234' })).cookie;
const KEY = /^CT-[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/;

test('一个号一把密钥：管理员发，贴上就进；名单外的号有密钥只能用密钥进；换一把旧的作废；停用了登着的也退出', async () => {
  user('judge', 'teacher');
  const stu = user('stu', 'student');
  user('other', 'student');
  user('root', 'admin', { is_super: 1 });
  const admin = await login('root');

  assert.equal((await call('/auth/config')).json.keyLogin, false);

  // 不是管理员发不了
  const judge = await login('judge');
  assert.equal((await call(`/admin/users/${stu}/key`, {}, judge)).status, 403);

  const first = await call(`/admin/users/${stu}/key`, {}, admin);
  assert.equal(first.status, 200);
  assert.match(first.json.key, KEY);
  assert.equal((await call('/auth/config')).json.keyLogin, true);

  // 贴上就进；大小写、空格、横杠、前面的 CT 都不讲究
  const byKey = await call('/auth/key', { key: first.json.key });
  assert.equal(byKey.status, 200);
  assert.equal(byKey.json.user.username, 'stu');
  const loose = first.json.key.toLowerCase().replace(/-/g, ' ').replace(/^ct /, '');
  assert.equal((await call('/auth/key', { key: ` ${loose} ` })).status, 200);

  // 名单外，但手里有密钥：也算指定的号，登着算数，用密码也能进（「账密也开着吧优先密钥」）
  assert.equal((await call('/auth/me', undefined, byKey.cookie)).json.user.username, 'stu');
  assert.equal((await call('/auth/login', { username: 'stu', password: 'pass1234' })).status, 200);
  const no = await call('/auth/login', { username: 'other', password: 'pass1234' });
  assert.equal(no.status, 403);
  assert.match(no.json.error, /指定的账号/);

  // 不对的、乱填的
  const wrong = await call('/auth/key', { key: 'CT-2222-3333-4444-5555' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /密钥不对/);
  assert.equal((await call('/auth/key', { key: 'hello' })).status, 401);

  // 管理页看得到末 4 位
  const list = (await call('/admin/users', undefined, admin)).json.users as any[];
  assert.equal(list.find((u) => u.username === 'stu').key.hint, first.json.key.slice(-4));
  assert.equal(list.find((u) => u.username === 'other').key, null);

  // 换一把：旧的作废，新的能用
  const second = await call(`/admin/users/${stu}/key`, {}, admin);
  assert.notEqual(second.json.key, first.json.key);
  assert.equal((await call('/auth/key', { key: first.json.key })).status, 401);
  const again = await call('/auth/key', { key: second.json.key });
  assert.equal(again.status, 200);

  // 停用：密钥不能用，登着的也退出
  assert.equal((await call(`/admin/users/${stu}/key`, undefined, admin, 'DELETE')).status, 200);
  assert.equal((await call('/auth/key', { key: second.json.key })).status, 401);
  assert.equal((await call('/auth/me', undefined, again.cookie)).json.user, null);
  assert.equal((await call(`/admin/users/${stu}/key`, undefined, admin, 'DELETE')).status, 400);
  assert.equal((await call('/auth/config')).json.keyLogin, false);
  // 密钥停了就不算指定的号了，密码也进不来
  assert.equal((await call('/auth/login', { username: 'stu', password: 'pass1234' })).status, 403);

  // 停用的账号拿着密钥也进不来
  const k3 = (await call(`/admin/users/${stu}/key`, {}, admin)).json.key;
  db.run("UPDATE users SET status='disabled' WHERE id=?", stu);
  assert.equal((await call('/auth/key', { key: k3 })).status, 403);
});

test('服务器上的发密钥工具：没有的号建好、发的密钥登录页能用、密码统一改、重复跑不再发', async () => {
  const tool = resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/login-keys/issue.mjs');
  const dbFile = join(dir, 'coteach.db');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', tool, dbFile, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ACCOUNT_PASSWORD: 'same5678' },
    });
  user('s1', 'student', { student_no: 's1' });
  const r = run('t0-t1', 's0-s2');
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n');
  assert.equal(rows[0], '账号,姓名,身份,密钥');
  assert.equal(rows.length, 1 + 5);
  const keys = Object.fromEntries(rows.slice(1).map((l) => [l.split(',')[0], l.split(',')]));
  assert.equal(keys.t1[2], '老师');
  assert.equal(keys.s2[2], '学生');
  for (const k of Object.values(keys)) assert.match(k[3], KEY);
  assert.equal(db.get<{ student_no: string }>("SELECT student_no FROM users WHERE username='s2'")!.student_no, 's2');

  // 工具发的密钥，登录页贴上就进；密码也统一改了，有密钥的号用这个密码也能进
  const via = await call('/auth/key', { key: keys.t1[3] });
  assert.equal(via.status, 200);
  assert.equal(via.json.user.role, 'teacher');
  assert.equal((await call('/auth/login', { username: 's1', password: 'same5678' })).status, 200);

  // 再跑一遍：都有密钥了，不再发
  const again = run('t0-t1', 's0-s2');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim().split('\n').length, 1);
  // 别的名字只给已经有的号发（评委的号），没有的不新建
  const judge = run('judge');
  assert.equal(judge.status, 0, judge.stderr);
  assert.match(judge.stdout, /^judge,judge,老师,CT-/m);
  const ghost = run('ghost');
  assert.equal(ghost.status, 1);
  assert.match(ghost.stderr, /没有 ghost 这个号/);

  // 身份对不上（t 开头的却是学生账号）就整个不动
  db.run("UPDATE users SET role='student' WHERE username='t0'");
  const mismatch = run('t0-t1', '--renew');
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /不是老师账号/);
  assert.equal((await call('/auth/key', { key: keys.t1[3] })).status, 200);
});

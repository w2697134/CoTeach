import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-accounts-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_KEEPER_DAILY_TURNS = '3';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { startRun } = await import('../src/kb/keeper.js');
const app = createApp();

function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const user = (name: string, role: string, extra: Record<string, unknown> = {}) =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now(), ...extra });
const root = cookie(user('系统管理员', 'admin', { is_super: 1, username: 'root' }));
async function call(path: string, body?: unknown, ck = '', method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'x-tv2': '1', 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sid = (res.headers.get('set-cookie') || '').match(/ct_sid=[^;]+/)?.[0] || '';
  return { status: res.status, json: (await res.json()) as any, sid };
}

test('账号：老师注册、登录、演示老师设成正式账号、管理页、整理助手次数', async (t) => {
  let teacher = '';
  await t.test('老师用手机号注册，注册完就登录了，有一个「我的知识库」', async () => {
    const r = await call('/auth/register', { phone: '138 0000 0001', name: '张老师', password: 'abc123' });
    assert.equal(r.status, 200);
    assert.deepEqual({ username: r.json.user.username, role: r.json.user.role, name: r.json.user.name }, { username: '13800000001', role: 'teacher', name: '张老师' });
    teacher = r.sid;
    const me = await call('/auth/me', undefined, teacher);
    assert.equal(me.json.user.username, '13800000001');
    assert.ok(me.json.user.kbId > 0);
    assert.equal((await call('/auth/login', { username: '13800000001', password: 'abc123' })).status, 200);
    // 能建班
    assert.equal((await call('/classes', { name: '张老师的班' }, teacher)).status, 200);
  });
  await t.test('手机号不对、密码太短、重复注册、登录着注册，都不行', async () => {
    assert.equal((await call('/auth/register', { phone: '12345', name: '李老师', password: 'abc123' })).status, 400);
    assert.equal((await call('/auth/register', { phone: '13800000002', name: '李老师', password: '123' })).status, 400);
    assert.equal((await call('/auth/register', { phone: '13800000002', name: '', password: 'abc123' })).status, 400);
    const again = await call('/auth/register', { phone: '13800000001', name: '冒名', password: 'abc123' });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'registered');
    assert.equal((await call('/auth/register', { phone: '13800000003', name: '王老师', password: 'abc123' }, teacher)).status, 400);
  });
  await t.test('演示老师设手机号和密码，就成了正式账号，东西都在，别人登着的退出', async () => {
    const demoId = user('王建国', 'teacher', { is_demo: 1, username: 'teacher', title: '副教授' });
    const mine = cookie(demoId),
      others = cookie(demoId);
    assert.equal((await call('/classes', { name: '演示老师的班' }, mine)).status, 200);
    assert.equal((await call('/auth/claim', { phone: '13800000001', name: '王建国', password: 'abc123' }, mine)).status, 409);
    const r = await call('/auth/claim', { phone: '13900000009', name: '刘洋', password: 'secret1' }, mine);
    assert.equal(r.status, 200);
    assert.deepEqual({ username: r.json.user.username, name: r.json.user.name, isDemo: r.json.user.isDemo, title: r.json.user.title }, { username: '13900000009', name: '刘洋', isDemo: false, title: null });
    assert.equal((await call('/auth/me', undefined, others)).json.user, null);
    assert.deepEqual(
      (await call('/classes', undefined, mine)).json.classes.map((k: any) => k.name),
      ['演示老师的班'],
    );
    assert.equal((await call('/auth/login', { username: '13900000009', password: 'secret1' })).status, 200);
    // 正式账号不用再设；普通老师也不行
    assert.equal((await call('/auth/claim', { phone: '13900000008', name: '刘洋', password: 'secret1' }, mine)).status, 403);
    assert.equal((await call('/auth/claim', { phone: '13900000007', name: 'x', password: 'secret1' }, teacher)).status, 403);
    assert.equal(db.value('SELECT value FROM settings WHERE key=?', 'demo_teacher_claimed'), 'true');
  });
  await t.test('管理页：只有管理员进得去；看账号、今天调模型的次数', async () => {
    assert.equal((await call('/admin/users', undefined, teacher)).status, 403);
    assert.equal((await call('/admin/users')).status, 401);
    const all = (await call('/admin/users', undefined, root)).json;
    assert.equal(all.users[0].username, 'root');
    assert.ok(all.users.some((u: any) => u.username === '13800000001' && u.classes === 1 && u.callsToday === 0));
    assert.equal(all.counts.teacher, 2);
    const found = (await call('/admin/users?q=' + encodeURIComponent('张'), undefined, root)).json.users;
    assert.deepEqual(
      found.map((u: any) => u.name),
      ['张老师'],
    );
    assert.equal((await call('/admin/users?role=student', undefined, root)).json.users.length, 0);
  });
  await t.test('管理员重置老师密码、停用和恢复；不能改自己和管理员', async () => {
    const zhang = (await call('/admin/users?q=13800000001', undefined, root)).json.users[0];
    const r = await call(`/admin/users/${zhang.id}/password`, {}, root);
    assert.match(r.json.password, /^\d{6}$/);
    assert.equal((await call('/auth/me', undefined, teacher)).json.user, null);
    assert.equal((await call('/auth/login', { username: '13800000001', password: 'abc123' })).status, 401);
    const back = await call('/auth/login', { username: '13800000001', password: r.json.password });
    assert.equal(back.status, 200);
    assert.equal((await call(`/admin/users/${zhang.id}/status`, { active: false }, root)).status, 200);
    assert.equal((await call('/auth/me', undefined, back.sid)).json.user, null);
    assert.equal((await call('/auth/login', { username: '13800000001', password: r.json.password })).status, 403);
    assert.equal((await call(`/admin/users/${zhang.id}/status`, { active: true }, root)).status, 200);
    assert.equal((await call('/auth/login', { username: '13800000001', password: r.json.password })).status, 200);
    const rootId = db.value<number>("SELECT id FROM users WHERE username='root'");
    assert.equal((await call(`/admin/users/${rootId}/password`, {}, root)).status, 400);
  });
  await t.test('关掉老师注册就注册不了，配置里能看到', async () => {
    assert.equal((await call('/admin/settings', { teacherSignup: false }, root, 'PUT')).status, 200);
    assert.equal((await call('/auth/config')).json.teacherSignup, false);
    assert.equal((await call('/auth/register', { phone: '13800000005', name: '赵老师', password: 'abc123' })).status, 403);
    await call('/admin/settings', { teacherSignup: true }, root, 'PUT');
    assert.equal((await call('/auth/register', { phone: '13800000005', name: '赵老师', password: 'abc123' })).status, 200);
  });
  await t.test('整理助手每人每天有次数上限，到了就不让再跑；管理员不限', async () => {
    const zhaoId = db.value<number>("SELECT id FROM users WHERE username='13800000005'")!;
    const kb = db.value<number>('SELECT id FROM knowledge_bases WHERE teacher_id=?', zhaoId)!;
    for (let i = 0; i < 3; i++) db.insert('llm_calls', { agent_key: 'keeper', model: 'x', user_id: zhaoId, status: 'ok', created_at: Date.now() });
    assert.throws(() => startRun(kb, 'chat', '整理一下', { id: zhaoId, name: '赵老师' }), /今天已经用了 3 次/);
  });
});

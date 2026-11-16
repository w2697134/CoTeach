import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'coteach-demo-accounts-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '1';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { ensureAccounts } = await import('../src/demo/seed.js');
const { studentNo } = await import('../src/demo/spec.js');
const app = createApp();

async function call(path: string, body?: unknown, cookie?: string) {
  const res = await app.request('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-tv2': '1', 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, json: (await res.json()) as any, cookie: set.split(';')[0] };
}

test('评委的体验账号：没有就建、标成演示账号，老师有一个空知识库；再建一次不重复', async () => {
  const list = [
    { username: 'pingwei', name: '评委老师', role: 'teacher' as const, password: 'judge-pass-1' },
    { username: 'pingwei-xs', name: '评委同学', role: 'student' as const, password: 'judge-pass-1' },
  ];
  await ensureAccounts(list, () => {});
  await ensureAccounts(list, () => {});
  const rows = db.all<any>("SELECT username, role, is_demo, student_no FROM users WHERE username LIKE 'pingwei%' ORDER BY id");
  assert.deepEqual(
    rows.map((r) => [r.username, r.role, r.is_demo, r.student_no]),
    [
      ['pingwei', 'teacher', 1, null],
      ['pingwei-xs', 'student', 1, 'pingwei-xs'],
    ],
  );
  const t = db.value<number>("SELECT id FROM users WHERE username='pingwei'");
  assert.equal(db.value('SELECT count(*) FROM knowledge_bases WHERE teacher_id=?', t), 1);
  assert.equal(studentNo(0, '20259901'), '2025990101');
  assert.equal(studentNo(35), '2025010136');
});

test('体验账号能登录，但改不了密码，也不能被一个人设成自己的正式账号', async () => {
  const login = await call('/auth/login', { username: 'pingwei', password: 'judge-pass-1' });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.isDemo, true);
  const pw = await call('/auth/password', { old: 'judge-pass-1', password: 'mine-now-1' }, login.cookie);
  assert.equal(pw.status, 403);
  const claim = await call('/auth/claim', { phone: '13900000001', name: '某评委', password: 'mine-now-1' }, login.cookie);
  assert.equal(claim.status, 403);
  // 还是原来的密码能登
  assert.equal((await call('/auth/login', { username: 'pingwei', password: 'judge-pass-1' })).status, 200);
  const stu = await call('/auth/login', { username: 'pingwei-xs', password: 'judge-pass-1' });
  assert.equal(stu.status, 200);
  assert.equal((await call('/auth/password', { old: 'judge-pass-1', password: 'mine-now-1' }, stu.cookie)).status, 403);
});

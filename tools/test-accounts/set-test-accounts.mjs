#!/usr/bin/env node
// 测试账号（2026-11-15 定的）：演示老师改成 t0，演示学生改成 s0，再补 s1–s9，密码都一样，从环境变量 TEST_PASSWORD 读。
// 演示老师里原来的知识库、资料都跟着 t0 走。改完演示账号就没了，重启也不再补（bootstrap.ts 看 demo_teacher_claimed）。
// 能重复跑：已经有的号只把密码设回 TEST_PASSWORD。
// 用法：node set-test-accounts.mjs <coteach.db 路径>
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PASSWORD = process.env.TEST_PASSWORD;
const STUDENTS = ['李明', '孙思雨', '张浩然', '刘欣怡', '陈子轩', '杨梓涵', '赵宇航', '黄诗琪', '周俊杰', '吴佳怡'];

// 和 server/src/lib/crypto.ts 一样：scrypt$N$r$p$salt$hash
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), hash.toString('base64url')].join('$');
}
function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const file = process.argv[2];
if (!file) {
  console.error('用法：node set-test-accounts.mjs <coteach.db 路径>');
  process.exit(2);
}
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 10000');
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const now = Date.now();
const done = [];

db.exec('BEGIN IMMEDIATE');
try {
  let t = one("SELECT id, role FROM users WHERE username = 't0'");
  if (!t) {
    const demo = one("SELECT id, role FROM users WHERE username = 'teacher' AND is_demo = 1 AND role = 'teacher'");
    if (!demo) throw new Error('没有演示老师，也没有 t0');
    run("UPDATE users SET username = 't0', is_demo = 0 WHERE id = ?", demo.id);
    run('DELETE FROM sessions WHERE user_id = ?', demo.id);
    t = demo;
    done.push(`演示老师改成 t0（id ${demo.id}）`);
  }
  if (t.role !== 'teacher') throw new Error('t0 不是老师账号');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(PASSWORD), t.id);

  STUDENTS.forEach((name, i) => {
    const no = `s${i}`;
    let s = one('SELECT id, role FROM users WHERE username = ?', no);
    if (!s && i === 0) {
      const demo = one("SELECT id, role FROM users WHERE username = 'student' AND is_demo = 1 AND role = 'student'");
      if (demo) {
        run("UPDATE users SET username = 's0', is_demo = 0 WHERE id = ?", demo.id);
        run('DELETE FROM sessions WHERE user_id = ?', demo.id);
        s = demo;
        done.push(`演示学生改成 s0（id ${demo.id}）`);
      }
    }
    if (!s) {
      run("INSERT INTO users (username, name, role, student_no, password_hash, created_at) VALUES (?, ?, 'student', ?, ?, ?)", no, name, no, hashPassword(PASSWORD), now);
      done.push(`新建 ${no} ${name}`);
      return;
    }
    if (s.role !== 'student') throw new Error(`${no} 不是学生账号`);
    // 学号跟账号一样，进班时学号就定死是它（classes/routes.ts 的 ownNo）
    run('UPDATE users SET password_hash = ?, student_no = ? WHERE id = ?', hashPassword(PASSWORD), no, s.id);
  });

  run("INSERT INTO settings (key, value) VALUES ('demo_teacher_claimed', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  run("INSERT INTO audit_logs (user_id, action, target, detail, ip, created_at) VALUES (NULL, 'accounts.test', NULL, ?, NULL, ?)", JSON.stringify({ password: 'reset', done }), now);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('没改：' + e.message);
  process.exit(1);
}

const names = ['t0', ...STUDENTS.map((_, i) => `s${i}`)];
const rows = db
  .prepare(`SELECT username, name, role, is_demo, status, student_no, password_hash FROM users WHERE username IN (${names.map(() => '?').join(',')})`)
  .all(...names);
const order = new Map(names.map((n, i) => [n, i]));
rows.sort((a, b) => order.get(a.username) - order.get(b.username));
for (const r of rows)
  console.log([r.username, r.name, r.role, r.student_no || '-', r.is_demo ? '演示' : '正式', r.status, verifyPassword(PASSWORD, r.password_hash) ? '密码对' : '密码不对'].join('\t'));
console.log(`共 ${rows.length} 个号；剩下的演示账号 ${one('SELECT COUNT(*) AS n FROM users WHERE is_demo = 1').n} 个`);
for (const d of done) console.log(d);
db.close();

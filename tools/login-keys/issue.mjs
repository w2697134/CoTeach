#!/usr/bin/env node
// 登录密钥：给一串账号各发一把密钥，没有的号先建好。
// 用法：node issue.mjs <coteach.db 路径> t0-t3 s0-s50 pingwei [--renew]
//   t 开头的建成老师，s 开头的建成学生；也可以一个一个写（t0 s7）。别的名字（比如评委的 pingwei）只给已经有的号发，不新建。
//   环境变量 ACCOUNT_PASSWORD 设了，就顺手把这些号的密码统一改成它（不写在命令行上）。
//   --renew：已经有密钥的也换一把新的（旧的停用）。不加就只给还没有密钥的发，能重复跑。
// 只把这回新发的密钥打出来（CSV：账号,姓名,身份,密钥），库里只存 sha256，原文丢了只能换一把。
// 要在服务升级到第 24 次迁移（login_keys 表）之后跑。算法和 server/src/login-keys.ts 一样。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, scryptSync } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newKey = () => {
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return { key: 'CT-' + s.match(/.{4}/g).join('-'), core: s };
};
const keyHash = (core) => createHash('sha256').update('ct-login-key:' + core).digest('hex');

// 和 server/src/lib/crypto.ts 一样：scrypt$N$r$p$salt$hash
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

// 新建的号用的名字（s0–s9 是 11-15 建的，名字在 tools/test-accounts 里）
const TEACHERS = { t1: '陈静', t2: '林涛', t3: '周敏' };
const STUDENTS = '王思远 郑雨桐 冯博文 何佳琪 许嘉豪 邓子涵 曹雨萱 彭宇轩 田欣然 董浩宇 袁诗涵 潘俊熙 蒋雅琪 蔡明轩 余若曦 杜文博 叶紫萱 程子豪 魏思琪 苏晨阳 吕雨欣 丁一鸣 沈书瑶 任泽宇 姚欣妍 卢俊豪 姜梦琪 崔宇杰 钟雨晴 谭子墨 陆思彤 汪俊辰 范可欣 金天佑 石佳宁 廖晨曦 贾明哲 夏语桐 韦博涛 付佳慧 方景行'.split(' ');
const nameOf = (u) => (u[0] === 't' ? TEACHERS[u] || `老师${u.slice(1)}` : STUDENTS[Number(u.slice(1)) - 10] || `同学${u.slice(1)}`);

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.db'));
const renew = args.includes('--renew');
const specs = args.filter((a) => a !== file && !a.startsWith('--'));
if (!file || !specs.length) {
  console.error('用法：node issue.mjs <coteach.db 路径> t0-t3 s0-s50 pingwei [--renew]');
  process.exit(2);
}
const names = [],
  existing = new Set();
for (const s of specs) {
  const m = s.match(/^([ts])(\d+)(?:-\1?(\d+))?$/);
  if (!m && /^[A-Za-z0-9_.-]{1,64}$/.test(s)) {
    names.push(s);
    existing.add(s);
    continue;
  }
  if (!m) {
    console.error(`看不懂：${s}（写成 t0-t3、s0-s50、s7 或已有的账号名）`);
    process.exit(2);
  }
  const a = Number(m[2]),
    b = m[3] === undefined ? a : Number(m[3]);
  if (b < a || b - a > 500) {
    console.error(`范围不对：${s}`);
    process.exit(2);
  }
  for (let i = a; i <= b; i++) names.push(m[1] + i);
}
const password = process.env.ACCOUNT_PASSWORD || undefined;
if (password !== undefined && password.length < 6) {
  console.error('ACCOUNT_PASSWORD 至少 6 位');
  process.exit(2);
}

const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 10000');
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
if (!one("SELECT name FROM sqlite_master WHERE type='table' AND name='login_keys'")) {
  console.error('库里还没有 login_keys 表：先把服务升级到带登录密钥的版本');
  process.exit(1);
}
const now = Date.now();
const out = [],
  created = [];
let passwords = 0;

db.exec('BEGIN IMMEDIATE');
try {
  for (const u of [...new Set(names)]) {
    let row = one('SELECT id, name, role, status FROM users WHERE username = ?', u);
    if (!row && existing.has(u)) throw new Error(`没有 ${u} 这个号`);
    const role = existing.has(u) ? row.role : u[0] === 't' ? 'teacher' : 'student';
    if (!row) {
      const id = Number(
        run(
          'INSERT INTO users (username, name, role, student_no, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          u,
          nameOf(u),
          role,
          role === 'student' ? u : null,
          hashPassword(password || randomBytes(18).toString('base64url')),
          now,
        ).lastInsertRowid,
      );
      row = { id, name: nameOf(u), role, status: 'active' };
      created.push(u);
    } else {
      if (row.role !== role) throw new Error(`${u} 已经有了，但不是${role === 'teacher' ? '老师' : '学生'}账号`);
      if (row.status !== 'active') throw new Error(`${u} 停用了，先在管理页恢复`);
      if (password !== undefined) {
        run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), row.id);
        passwords++;
      }
    }
    if (created.includes(u) && password !== undefined) passwords++;
    const has = one('SELECT id FROM login_keys WHERE user_id = ? AND revoked_at IS NULL', row.id);
    if (has && !renew) continue;
    if (has) run('UPDATE login_keys SET revoked_at = ? WHERE id = ?', now, has.id);
    const { key, core } = newKey();
    run('INSERT INTO login_keys (user_id, key_hash, hint, created_at) VALUES (?, ?, ?, ?)', row.id, keyHash(core), core.slice(-4), now);
    out.push([u, row.name, { teacher: '老师', student: '学生', admin: '管理员' }[role] || role, key]);
  }
  run(
    "INSERT INTO audit_logs (user_id, action, target, detail, ip, created_at) VALUES (NULL, 'keys.issue', NULL, ?, NULL, ?)",
    JSON.stringify({ accounts: names.length, created, keys: out.map((r) => r[0]), passwords }),
    now,
  );
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('没改：' + e.message);
  process.exit(1);
}
db.close();

console.log('账号,姓名,身份,密钥');
for (const r of out) console.log(r.join(','));
console.error(`共 ${names.length} 个号：新建 ${created.length} 个，这回发了 ${out.length} 把密钥${password !== undefined ? `，改了 ${passwords} 个号的密码` : ''}`);

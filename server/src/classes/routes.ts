import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { audit, createSession, loadUserById, me, publicUser, requireRole, type AppEnv, type User } from '../auth.js';
import { db, now } from '../db/index.js';
import { hashPassword } from '../lib/crypto.js';
import { bad, body, clientIp, conflict, forbidden, intParam, notFound, rateLimit, HttpError } from '../lib/http.js';
import { cleanName, looksName, looksNo, rosterFromFile, rosterFromText, tableFromFile, type RosterStudent } from './roster.js';

/**
 * 班级：照课堂派、雨课堂。老师建班只起名字，系统给加课码；学生扫码、点链接或输加课码自己加入，填学号姓名。
 * 没账号的学生在加入的同时注册，账号名就是学号。老师手上有教务名单的可以导进来，只为对一对谁还没加入。
 * 老师可以换加课码、停止加入；学期完了归档，归档的班只能看。全是程序，不经过模型。
 * 学生只看得到自己加入了的班。
 */
export const classRoutes = new Hono<AppEnv>();

interface ClassRow {
  id: number;
  teacher_id: number;
  name: string;
  join_open: number;
  archived_at: number | null;
}
interface StudentRow {
  id: number;
  student_no: string;
  name: string;
  user_id: number | null;
  in_roster: number;
  joined_at: number | null;
}

const NAME = z.string().trim().min(1).max(40);
const ROSTER = z.string().max(200_000);
const MAX_FILE = 10 * 1024 * 1024;
const JOINED = `c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM class_students s WHERE s.class_id=c.id AND s.user_id=?)`;
const COUNT = `(SELECT count(*) FROM class_students s WHERE s.class_id=c.id AND s.user_id IS NOT NULL)`;
const MIN_PASSWORD = 6;

/** 加课码：6 位，去掉容易看错的 0 O 1 I */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < 6; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!db.get('SELECT id FROM classes WHERE join_code=?', s)) return s;
  }
}
/** 第 9 次改表以前建的班没有加课码，用到时补一个 */
function codeOf(classId: number): string {
  const had = db.get<{ join_code: string | null }>('SELECT join_code FROM classes WHERE id=?', classId)?.join_code;
  if (had) return had;
  const code = newCode();
  db.run('UPDATE classes SET join_code=? WHERE id=?', code, classId);
  return code;
}
const normalCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

function owned(u: User, id: number): ClassRow {
  const k = db.get<ClassRow>('SELECT id, teacher_id, name, join_open, archived_at FROM classes WHERE id=? AND teacher_id=? AND deleted_at IS NULL', id, u.id);
  if (!k) throw notFound('这个班不存在或已经删掉了');
  return k;
}
/** 归档的班只能看：名单、加课码都不能再动，要改先恢复 */
function editable(k: ClassRow) {
  if (k.archived_at) throw conflict('这个班已经归档了，要改先恢复');
  return k;
}

/** 加课码找班；学生和还没登录的人都用它 */
function byCode(code: string) {
  const k = db.get<ClassRow & { teacher: string }>(
    'SELECT c.id, c.teacher_id, c.name, c.join_open, c.archived_at, t.name AS teacher FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.join_code=? AND c.deleted_at IS NULL',
    normalCode(code),
  );
  if (!k) throw notFound('加课码不对，再核对一下，或者问问老师');
  return k;
}
function joinable(k: ClassRow) {
  if (k.archived_at) throw conflict('这个班已经归档了，不能再加入');
  if (!k.join_open) throw conflict('这个班已经停止加入了，问问老师');
}

/** 老师看到的成员：已经加入的在前，再是名单上还没加入的；都按学号排。canReset：自己注册的学生账号，老师能帮他重置密码 */
const students = (classId: number) =>
  db
    .all<StudentRow & { is_demo: number | null }>(
      `SELECT s.id, s.student_no, s.name, s.user_id, s.in_roster, s.joined_at, u.is_demo FROM class_students s LEFT JOIN users u ON u.id=s.user_id
       WHERE s.class_id=? ORDER BY s.user_id IS NULL, s.student_no, s.id`,
      classId,
    )
    .map((s) => ({
      id: s.id,
      studentNo: s.student_no,
      name: s.name,
      joined: s.user_id !== null,
      inRoster: !!s.in_roster,
      joinedAt: s.joined_at,
      canReset: s.user_id !== null && s.is_demo === 0,
    }));

/** 老师贴的、或者从文件读出来再改过的名单；有认不出的行就退回去，不悄悄丢人 */
function readRoster(text: string): RosterStudent[] {
  if (!text.trim()) return [];
  const r = rosterFromText(text);
  if (r.unread.length)
    throw bad(`这几行没认出学号和姓名：${r.unread.slice(0, 5).map((l) => `「${l}」`).join('、')}${r.unread.length > 5 ? ` 等 ${r.unread.length} 行` : ''}`);
  return r.students;
}
function uniqueName(teacherId: number, name: string, except = 0) {
  if (db.get('SELECT id FROM classes WHERE teacher_id=? AND name=? AND deleted_at IS NULL AND id<>?', teacherId, name, except))
    throw conflict(`已经有叫「${name}」的班了`);
}

/** 加入时填的学号、姓名 */
function identity(d: { studentNo: string; name: string }) {
  const no = d.studentNo.trim(),
    name = cleanName(d.name);
  if (!looksNo(no)) throw bad('学号只能是字母和数字，至少带三位数字');
  if (!looksName(name)) throw bad('姓名填得不对');
  return { no, name };
}
/** 名单上有这个学号的，姓名得对得上；这个学号在班里已经有人用了的不让进 */
function checkRoster(classId: number, no: string, name: string) {
  const row = db.get<StudentRow>('SELECT id, student_no, name, user_id, in_roster, joined_at FROM class_students WHERE class_id=? AND student_no=?', classId, no);
  if (row?.user_id) throw conflict('这个学号已经有人加入了，问问老师');
  if (row && cleanName(row.name) !== name) throw conflict('老师名单上这个学号的姓名跟你填的对不上，再核对一下，或者问问老师');
  return row;
}
/** 挂到班里：名单上有的挂上去，没有的照样进，老师那边标「不在名单里」 */
function enroll(classId: number, userId: number, no: string, name: string): 'already' | 'matched' | 'new' {
  if (db.get('SELECT id FROM class_students WHERE class_id=? AND user_id=?', classId, userId)) return 'already';
  const row = checkRoster(classId, no, name);
  const t = now();
  if (row) db.update('class_students', row.id, { user_id: userId, joined_at: t });
  else db.insert('class_students', { class_id: classId, student_no: no, name, user_id: userId, in_roster: 0, joined_at: t, created_at: t });
  // 账号上还没有学号的记下来，下次加别的班不用再填
  db.run("UPDATE users SET student_no=? WHERE id=? AND (student_no IS NULL OR student_no='')", no, userId);
  db.update('classes', classId, { updated_at: t });
  return row ? 'matched' : 'new';
}
/** 自己用学号注册的账号，学号就是账号名，加别的班也只能用这个学号 */
const ownNo = (u: User) => (u.student_no && u.username.toLowerCase() === u.student_no.toLowerCase() ? u.student_no : null);

classRoutes.get('/', (c) => {
  const u = me(c);
  if (u.role === 'student')
    return c.json({
      classes: db
        .all<{ id: number; name: string; teacher: string; count: number; archived: number }>(
          `SELECT c.id, c.name, t.name AS teacher, ${COUNT} AS count, c.archived_at IS NOT NULL AS archived FROM classes c JOIN users t ON t.id=c.teacher_id WHERE ${JOINED} ORDER BY c.id`,
          u.id,
        )
        .map((k) => ({ ...k, archived: !!k.archived })),
    });
  requireRole(c, 'teacher', 'admin');
  // 每个班带前 5 个已经加入的学生，班级卡片上摆他们的头像
  const preview = new Map<number, { id: number; name: string }[]>();
  for (const s of db.all<{ class_id: number; id: number; name: string }>(
    `SELECT class_id, id, name FROM (SELECT s.class_id, s.id, s.name, ROW_NUMBER() OVER (PARTITION BY s.class_id ORDER BY s.student_no, s.id) AS n
       FROM class_students s JOIN classes c ON c.id=s.class_id WHERE c.teacher_id=? AND c.deleted_at IS NULL AND s.user_id IS NOT NULL) WHERE n<=5 ORDER BY class_id, n`,
    u.id,
  ))
    preview.set(s.class_id, [...(preview.get(s.class_id) || []), { id: s.id, name: s.name }]);
  return c.json({
    classes: db
      .all<{ id: number; name: string; count: number; code: string | null; join_open: number; archived: number }>(
        `SELECT c.id, c.name, ${COUNT} AS count, c.join_code AS code, c.join_open, c.archived_at IS NOT NULL AS archived FROM classes c WHERE c.teacher_id=? AND c.deleted_at IS NULL ORDER BY c.id`,
        u.id,
      )
      .map(({ join_open, ...k }) => ({ ...k, code: k.code || codeOf(k.id), joinOpen: !!join_open, archived: !!k.archived, preview: preview.get(k.id) || [] })),
  });
});

/**
 * 拖进来的名单文件：表头有「学号」「姓名」的直接读出来；
 * 认不出表头的把表原样退回去（带上猜的两列），老师在页面上选哪一列是学号、哪一列是姓名。
 */
classRoutes.post('/roster', async (c) => {
  requireRole(c, 'teacher', 'admin');
  if (Number(c.req.header('content-length') || 0) > MAX_FILE) throw bad('文件太大了');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) throw bad('文件是空的');
  if (bytes.length > MAX_FILE) throw bad('文件太大了');
  const file = (c.req.query('file') || '').slice(0, 200);
  try {
    return c.json(rosterFromFile(file, bytes));
  } catch (err) {
    if (!(err instanceof HttpError) || !/没认出学号和姓名/.test(err.message)) throw err;
    return c.json({ table: tableFromFile(file, bytes) });
  }
});

/** 建班只要名字；建好就有加课码 */
classRoutes.post('/', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const d = await body(c, z.object({ name: NAME }));
  const id = db.tx(() => {
    uniqueName(u.id, d.name);
    const t = now();
    return db.insert('classes', { teacher_id: u.id, name: d.name, join_code: newCode(), created_at: t, updated_at: t });
  });
  audit(c, 'class.create', `class:${id}`, {});
  return c.json({ id });
});

/**
 * 输了加课码、扫了二维码：先给他看是哪个班、哪位老师，再填学号姓名加入。
 * 没登录也能看（扫码的学生多半还没账号）；老师账号不用加入班级。
 */
classRoutes.get('/join/:code', (c) => {
  const u = c.get('user');
  if (u && u.role !== 'student') throw forbidden('老师账号不用加入班级');
  rateLimit(`class-peek:${u ? `u${u.id}` : clientIp(c)}`, 60, 10 * 60_000);
  const k = byCode(c.req.param('code'));
  const joined = !!u && !!db.get('SELECT id FROM class_students WHERE class_id=? AND user_id=?', k.id, u.id);
  return c.json({ id: k.id, name: k.name, teacher: k.teacher, joined, open: !!k.join_open && !k.archived_at, archived: !!k.archived_at });
});

/**
 * 学生加入：按学号对老师的名单。名单上有这个学号的，姓名得对得上才挂上去；名单上没有的照样能进，老师那边标「不在名单里」。
 * 一个学号在一个班里只能一个账号用；已经在班里的再输一次就直接进。
 */
classRoutes.post('/join', async (c) => {
  const u = requireRole(c, 'student');
  const d = await body(c, z.object({ code: z.string().max(20), studentNo: z.string().max(40), name: z.string().max(40) }));
  const { no, name } = identity(d);
  const fixed = ownNo(u);
  if (fixed && fixed !== no) throw bad(`你的账号学号是 ${fixed}，用这个学号加入`);
  const k = byCode(d.code);
  const result = db.tx(() => {
    if (db.get('SELECT id FROM class_students WHERE class_id=? AND user_id=?', k.id, u.id)) return 'already';
    joinable(k);
    return enroll(k.id, u.id, no, name);
  });
  if (result !== 'already') audit(c, 'class.join', `class:${k.id}`, { studentNo: no, matched: result === 'matched' });
  return c.json({ id: k.id, name: k.name });
});

/**
 * 还没账号的学生扫码进来：学号、姓名、设个密码，注册和加入一步做完，顺手登录。账号名就是学号，下回用学号和密码登录。
 * 只能拿着能加入的加课码注册，没有单独的注册入口。名单上姓名对不上的先退回去，不留下没进班的账号。
 */
classRoutes.post('/join/register', async (c) => {
  if (c.get('user')) throw bad('已经登录了，刷新一下页面');
  rateLimit(`class-register:${clientIp(c)}`, 10, 60 * 60_000);
  const d = await body(c, z.object({ code: z.string().max(20), studentNo: z.string().max(40), name: z.string().max(40), password: z.string().max(128) }));
  const { no, name } = identity(d);
  if (d.password.length < MIN_PASSWORD) throw bad(`密码至少 ${MIN_PASSWORD} 位`);
  const k = byCode(d.code);
  joinable(k);
  const uid = db.tx(() => {
    if (db.get('SELECT id FROM users WHERE username=?', no)) throw new HttpError(409, '这个学号已经注册过了，直接登录就行', 'registered');
    checkRoster(k.id, no, name);
    const id = db.insert('users', { username: no, name, role: 'student', student_no: no, password_hash: hashPassword(d.password), created_at: now() });
    enroll(k.id, id, no, name);
    return id;
  });
  createSession(c, uid);
  const user = loadUserById(uid)!;
  c.set('user', user);
  audit(c, 'user.register', `user:${uid}`, { classId: k.id, studentNo: no });
  return c.json({ id: k.id, name: k.name, user: publicUser(user) });
});

classRoutes.get('/:id', (c) => {
  const u = me(c),
    id = intParam(c);
  if (u.role === 'student') {
    const k = db.get<{ id: number; name: string; teacher: string; archived: number }>(
      `SELECT c.id, c.name, t.name AS teacher, c.archived_at IS NOT NULL AS archived FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.id=? AND ${JOINED}`,
      id,
      u.id,
    );
    if (!k) throw notFound('这个班不存在或已经删掉了');
    // 同学只给名字，不给学号
    const classmates = db
      .all<{ id: number; name: string; user_id: number }>('SELECT id, name, user_id FROM class_students WHERE class_id=? AND user_id IS NOT NULL ORDER BY student_no, id', k.id)
      .map((s) => ({ id: s.id, name: s.name, me: s.user_id === u.id }));
    return c.json({ ...k, archived: !!k.archived, classmates });
  }
  requireRole(c, 'teacher', 'admin');
  const k = owned(u, id);
  return c.json({ id: k.id, name: k.name, code: codeOf(k.id), joinOpen: !!k.join_open, archived: !!k.archived_at, students: students(k.id) });
});

/** 改名、停止或允许加入、归档或恢复 */
classRoutes.patch('/:id', async (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  const d = await body(c, z.object({ name: NAME.optional(), joinOpen: z.boolean().optional(), archived: z.boolean().optional() }));
  const patch: Record<string, unknown> = { updated_at: now() };
  if (d.name !== undefined) {
    uniqueName(u.id, d.name, k.id);
    patch.name = d.name;
  }
  if (d.joinOpen !== undefined) {
    editable(k);
    patch.join_open = d.joinOpen ? 1 : 0;
  }
  if (d.archived !== undefined) patch.archived_at = d.archived ? k.archived_at || now() : null;
  db.update('classes', k.id, patch);
  if (d.name !== undefined && d.name !== k.name) audit(c, 'class.rename', `class:${k.id}`, { from: k.name, to: d.name });
  if (d.joinOpen !== undefined) audit(c, d.joinOpen ? 'class.join.open' : 'class.join.close', `class:${k.id}`);
  if (d.archived !== undefined) audit(c, d.archived ? 'class.archive' : 'class.restore', `class:${k.id}`);
  return c.json({ ok: true });
});

/** 换一个加课码：原来的码和二维码就不能用了 */
classRoutes.post('/:id/code', (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = editable(owned(u, intParam(c)));
  const code = newCode();
  db.update('classes', k.id, { join_code: code, updated_at: now() });
  audit(c, 'class.code.reset', `class:${k.id}`);
  return c.json({ code });
});

/** 删班只做记号，名单还在 */
classRoutes.delete('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  db.update('classes', k.id, { deleted_at: now(), updated_at: now() });
  audit(c, 'class.delete', `class:${k.id}`, { name: k.name });
  return c.json({ ok: true });
});

/** 学生自己退出：老师名单上有他的，退回「还没加入」；名单上没有的，整行去掉 */
classRoutes.post('/:id/leave', (c) => {
  const u = requireRole(c, 'student'),
    id = intParam(c);
  const row = db.get<{ id: number; in_roster: number }>(
    'SELECT s.id, s.in_roster FROM class_students s JOIN classes c ON c.id=s.class_id WHERE s.class_id=? AND s.user_id=? AND c.deleted_at IS NULL',
    id,
    u.id,
  );
  if (!row) throw notFound('你不在这个班里');
  if (row.in_roster) db.update('class_students', row.id, { user_id: null, joined_at: null });
  else db.run('DELETE FROM class_students WHERE id=?', row.id);
  db.update('classes', id, { updated_at: now() });
  audit(c, 'class.leave', `class:${id}`);
  return c.json({ ok: true });
});

/**
 * 导入名单：按学号对。名单上新的人记成「还没加入」；已经自己加入的，学号对上了就记成在名单上；
 * 同一学号名字对不上的不改，告诉老师。
 */
classRoutes.post('/:id/students', async (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = editable(owned(u, intParam(c)));
  const d = await body(c, z.object({ roster: ROSTER }));
  const incoming = readRoster(d.roster);
  if (!incoming.length) throw bad('名单是空的');
  const result = db.tx(() => {
    const have = new Map(
      db.all<StudentRow>('SELECT id, student_no, name, user_id, in_roster, joined_at FROM class_students WHERE class_id=?', k.id).map((s) => [s.student_no, s]),
    );
    const conflicts: { studentNo: string; name: string; existingName: string }[] = [];
    let added = 0,
      matched = 0;
    const t = now();
    for (const s of incoming) {
      const old = have.get(s.studentNo);
      if (!old) {
        db.insert('class_students', { class_id: k.id, student_no: s.studentNo, name: s.name, in_roster: 1, created_at: t });
        have.set(s.studentNo, { id: 0, student_no: s.studentNo, name: s.name, user_id: null, in_roster: 1, joined_at: null });
        added++;
      } else if (cleanName(old.name) !== s.name) conflicts.push({ studentNo: s.studentNo, name: s.name, existingName: old.name });
      else if (!old.in_roster) {
        db.update('class_students', old.id, { in_roster: 1 });
        old.in_roster = 1;
        matched++;
      }
    }
    db.update('classes', k.id, { updated_at: t });
    return { added, matched, conflicts };
  });
  audit(c, 'class.students.add', `class:${k.id}`, { added: result.added, matched: result.matched, conflicts: result.conflicts.length });
  return c.json({ ...result, students: students(k.id) });
});

classRoutes.delete('/:id/students/:sid', (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = editable(owned(u, intParam(c)));
  const s = db.get<{ id: number; student_no: string; name: string }>('SELECT id, student_no, name FROM class_students WHERE id=? AND class_id=?', intParam(c, 'sid'), k.id);
  if (!s) throw notFound('名单里没有这个学生');
  db.run('DELETE FROM class_students WHERE id=?', s.id);
  db.update('classes', k.id, { updated_at: now() });
  audit(c, 'class.students.remove', `class:${k.id}`, { studentNo: s.student_no, name: s.name });
  return c.json({ students: students(k.id) });
});

/**
 * 学生忘了密码：没有短信和邮箱，老师在班里帮他重置成一个 6 位数字，告诉他，他登录后自己再改。
 * 只给自己注册的学生账号重置；重置后这个账号在别处登着的都退出。
 */
classRoutes.post('/:id/students/:sid/password', (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  rateLimit(`class-reset:${u.id}`, 30, 60 * 60_000);
  const s = db.get<{ user_id: number | null }>('SELECT user_id FROM class_students WHERE id=? AND class_id=?', intParam(c, 'sid'), k.id);
  if (!s?.user_id) throw notFound('这个学生还没加入');
  const acct = db.get<{ id: number; role: string; is_demo: number }>('SELECT id, role, is_demo FROM users WHERE id=?', s.user_id);
  if (!acct || acct.role !== 'student' || acct.is_demo) throw bad('这个账号不能在这里重置密码');
  const password = String(randomInt(100000, 1000000));
  db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), acct.id);
  db.run('DELETE FROM sessions WHERE user_id=?', acct.id);
  audit(c, 'class.students.password', `user:${acct.id}`, { classId: k.id });
  return c.json({ password });
});

const when = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
/** 导出名单：学号、姓名、加入了没有、什么时候加入的 */
classRoutes.get('/:id/export', (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  const list = db.all<StudentRow>('SELECT id, student_no, name, user_id, in_roster, joined_at FROM class_students WHERE class_id=? ORDER BY student_no, id', k.id);
  const roster = list.some((s) => s.in_roster);
  const rows = [
    ['学号', '姓名', '状态', '加入时间'],
    ...list.map((s) => [
      s.student_no,
      s.name,
      s.user_id === null ? '还没加入' : roster && !s.in_roster ? '已加入（不在名单里）' : '已加入',
      s.joined_at ? when.format(s.joined_at) : '',
    ]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 20 }, { wch: 20 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '学生');
  const bytes: Buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  audit(c, 'class.students.export', `class:${k.id}`, { count: list.length });
  const file = `${k.name.replace(/[\\/:*?"<>|]/g, '')}-学生名单.xlsx`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="students.xlsx"; filename*=UTF-8''${encodeURIComponent(file)}`,
    },
  });
});

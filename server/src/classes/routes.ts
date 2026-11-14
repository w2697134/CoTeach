import { Hono } from 'hono';
import { z } from 'zod';
import { audit, me, requireRole, type AppEnv, type User } from '../auth.js';
import { db, now } from '../db/index.js';
import { bad, body, conflict, intParam, notFound } from '../lib/http.js';
import { rosterFromFile, rosterFromText, type RosterStudent } from './roster.js';

/**
 * 班级：老师建班、管名单；学生看自己在的班。全是程序，不经过模型。
 * 学生能进的班：名单上挂着他的账号的，或者演示学生进演示老师的班。
 */
export const classRoutes = new Hono<AppEnv>();

interface ClassRow {
  id: number;
  teacher_id: number;
  name: string;
}

const NAME = z.string().trim().min(1).max(40);
const ROSTER = z.string().max(200_000);
const MAX_FILE = 10 * 1024 * 1024;
const VISIBLE = `c.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM class_students s WHERE s.class_id=c.id AND s.user_id=?) OR (?=1 AND t.is_demo=1))`;

function owned(u: User, id: number): ClassRow {
  const k = db.get<ClassRow>('SELECT id, teacher_id, name FROM classes WHERE id=? AND teacher_id=? AND deleted_at IS NULL', id, u.id);
  if (!k) throw notFound('这个班不存在或已经删掉了');
  return k;
}
const students = (classId: number) =>
  db
    .all<{ id: number; student_no: string; name: string }>('SELECT id, student_no, name FROM class_students WHERE class_id=? ORDER BY student_no, id', classId)
    .map((s) => ({ id: s.id, studentNo: s.student_no, name: s.name }));

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

classRoutes.get('/', (c) => {
  const u = me(c);
  if (u.role === 'student')
    return c.json({
      classes: db.all(
        `SELECT c.id, c.name, t.name AS teacher, (SELECT count(*) FROM class_students s WHERE s.class_id=c.id) AS count FROM classes c JOIN users t ON t.id=c.teacher_id WHERE ${VISIBLE} ORDER BY c.id`,
        u.id,
        u.is_demo,
      ),
    });
  requireRole(c, 'teacher', 'admin');
  // 每个班带前 5 个学生，班级卡片上摆他们的头像
  const preview = new Map<number, { id: number; name: string }[]>();
  for (const s of db.all<{ class_id: number; id: number; name: string }>(
    `SELECT class_id, id, name FROM (SELECT s.class_id, s.id, s.name, ROW_NUMBER() OVER (PARTITION BY s.class_id ORDER BY s.student_no, s.id) AS n
       FROM class_students s JOIN classes c ON c.id=s.class_id WHERE c.teacher_id=? AND c.deleted_at IS NULL) WHERE n<=5 ORDER BY class_id, n`,
    u.id,
  ))
    preview.set(s.class_id, [...(preview.get(s.class_id) || []), { id: s.id, name: s.name }]);
  return c.json({
    classes: db
      .all<{ id: number; name: string; count: number }>(
        'SELECT c.id, c.name, (SELECT count(*) FROM class_students s WHERE s.class_id=c.id) AS count FROM classes c WHERE c.teacher_id=? AND c.deleted_at IS NULL ORDER BY c.id',
        u.id,
      )
      .map((k) => ({ ...k, preview: preview.get(k.id) || [] })),
  });
});

/** 拖进来的名单文件：读出班名和学号姓名，还没建班，给老师看过再建 */
classRoutes.post('/roster', async (c) => {
  requireRole(c, 'teacher', 'admin');
  if (Number(c.req.header('content-length') || 0) > MAX_FILE) throw bad('文件太大了');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) throw bad('文件是空的');
  if (bytes.length > MAX_FILE) throw bad('文件太大了');
  return c.json(rosterFromFile((c.req.query('file') || '').slice(0, 200), bytes));
});

classRoutes.post('/', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const d = await body(c, z.object({ name: NAME, roster: ROSTER.optional() }));
  const list = readRoster(d.roster || '');
  const id = db.tx(() => {
    uniqueName(u.id, d.name);
    const t = now();
    const id = db.insert('classes', { teacher_id: u.id, name: d.name, created_at: t, updated_at: t });
    for (const s of list) db.insert('class_students', { class_id: id, student_no: s.studentNo, name: s.name, created_at: t });
    return id;
  });
  audit(c, 'class.create', `class:${id}`, { students: list.length });
  return c.json({ id });
});

classRoutes.get('/:id', (c) => {
  const u = me(c),
    id = intParam(c);
  if (u.role === 'student') {
    const k = db.get(`SELECT c.id, c.name, t.name AS teacher FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.id=? AND ${VISIBLE}`, id, u.id, u.is_demo);
    if (!k) throw notFound('这个班不存在或已经删掉了');
    return c.json(k);
  }
  requireRole(c, 'teacher', 'admin');
  const k = owned(u, id);
  return c.json({ id: k.id, name: k.name, students: students(k.id) });
});

classRoutes.patch('/:id', async (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  const d = await body(c, z.object({ name: NAME }));
  uniqueName(u.id, d.name, k.id);
  db.update('classes', k.id, { name: d.name, updated_at: now() });
  audit(c, 'class.rename', `class:${k.id}`, { from: k.name, to: d.name });
  return c.json({ ok: true });
});

/** 删班只做记号，名单还在 */
classRoutes.delete('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  db.update('classes', k.id, { deleted_at: now(), updated_at: now() });
  audit(c, 'class.delete', `class:${k.id}`, { name: k.name });
  return c.json({ ok: true });
});

/** 往名单里补人：按学号对，已经在的不动；同一学号名字对不上的不改，告诉老师 */
classRoutes.post('/:id/students', async (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  const d = await body(c, z.object({ roster: ROSTER }));
  const incoming = readRoster(d.roster);
  if (!incoming.length) throw bad('名单是空的');
  const result = db.tx(() => {
    const have = new Map(db.all<{ student_no: string; name: string }>('SELECT student_no, name FROM class_students WHERE class_id=?', k.id).map((s) => [s.student_no, s.name]));
    const conflicts: { studentNo: string; name: string; existingName: string }[] = [];
    let added = 0;
    const t = now();
    for (const s of incoming) {
      const old = have.get(s.studentNo);
      if (old === undefined) {
        db.insert('class_students', { class_id: k.id, student_no: s.studentNo, name: s.name, created_at: t });
        have.set(s.studentNo, s.name);
        added++;
      } else if (old !== s.name) conflicts.push({ studentNo: s.studentNo, name: s.name, existingName: old });
    }
    db.update('classes', k.id, { updated_at: t });
    return { added, conflicts };
  });
  audit(c, 'class.students.add', `class:${k.id}`, { added: result.added, conflicts: result.conflicts.length });
  return c.json({ ...result, students: students(k.id) });
});

classRoutes.delete('/:id/students/:sid', (c) => {
  const u = requireRole(c, 'teacher', 'admin'),
    k = owned(u, intParam(c));
  const s = db.get<{ id: number; student_no: string; name: string }>('SELECT id, student_no, name FROM class_students WHERE id=? AND class_id=?', intParam(c, 'sid'), k.id);
  if (!s) throw notFound('名单里没有这个学生');
  db.run('DELETE FROM class_students WHERE id=?', s.id);
  db.update('classes', k.id, { updated_at: now() });
  audit(c, 'class.students.remove', `class:${k.id}`, { studentNo: s.student_no, name: s.name });
  return c.json({ students: students(k.id) });
});

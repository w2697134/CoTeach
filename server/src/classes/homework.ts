import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { audit, me, requireRole, type AppEnv, type User } from '../auth.js';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { bad, body, conflict, forbidden, intParam, notFound, rateLimit } from '../lib/http.js';
import { packOnHomework, packOnHomeworkDeleted } from '../assistant/pack-jobs.js';

/**
 * 作业：照 Google Classroom、课堂派。老师布置（标题、要求、附件、截止、满分、允不允许迟交、定时发布，一次发几个班），
 * 学生交文字和文件，截止前能改；老师看谁交了谁没交、打分、写评语、退回重交；成绩表算平均分、导出 Excel。
 * 全是程序，不经过模型。
 */
export const homeworkRoutes = new Hono<AppEnv>();

const MAX_FILE = 50 * 1024 * 1024;
const MAX_FILES = 20;
/** 给同一台服务器上的其他服务留的磁盘 */
const RESERVE = config.intake.reserveBytes;
const DIR = resolve(config.dataDir, 'homework');

interface ClassRow {
  id: number;
  teacher_id: number;
  name: string;
  archived_at: number | null;
}
interface AssignmentRow {
  id: number;
  class_id: number;
  teacher_id: number;
  title: string;
  body: string;
  points: number;
  due_at: number | null;
  allow_late: number;
  publish_at: number;
  created_at: number;
  updated_at: number;
}
interface SubmissionRow {
  id: number;
  assignment_id: number;
  user_id: number;
  text: string;
  submitted_at: number;
  late: number;
  score: number | null;
  comment: string | null;
  graded_at: number | null;
  returned_at: number | null;
}
interface FileRow {
  id: number;
  owner_id: number;
  assignment_id: number | null;
  submission_id: number | null;
  name: string;
  size: number;
  path: string;
}

/* ---------------- 谁能看、谁能改 ---------------- */

function ownedClass(u: User, id: number): ClassRow {
  const k = db.get<ClassRow>('SELECT id, teacher_id, name, archived_at FROM classes WHERE id=? AND teacher_id=? AND deleted_at IS NULL', id, u.id);
  if (!k) throw notFound('这个班不存在或已经删掉了');
  return k;
}
/** 学生加入了的班；返回他在这个班里的那一行 */
function joinedClass(u: User, id: number) {
  const k = db.get<ClassRow & { csid: number }>(
    'SELECT c.id, c.teacher_id, c.name, c.archived_at, s.id AS csid FROM classes c JOIN class_students s ON s.class_id=c.id AND s.user_id=? WHERE c.id=? AND c.deleted_at IS NULL',
    u.id,
    id,
  );
  if (!k) throw notFound('这个班不存在或已经删掉了');
  return k;
}
const live = (k: ClassRow) => {
  if (k.archived_at) throw conflict('这个班已经归档了，要改先恢复');
  return k;
};
const ASSIGNMENT = 'SELECT id, class_id, teacher_id, title, body, points, due_at, allow_late, publish_at, created_at, updated_at FROM assignments';
/** 作业和它的班；老师得是这个班的老师，学生得在班里、作业已经发布 */
function assignmentFor(u: User, id: number) {
  const a = db.get<AssignmentRow>(`${ASSIGNMENT} WHERE id=? AND deleted_at IS NULL`, id);
  if (!a) throw notFound('这份作业不存在或已经删掉了');
  if (u.role === 'student') {
    const k = joinedClass(u, a.class_id);
    if (a.publish_at > now()) throw notFound('这份作业不存在或已经删掉了');
    return { a, k };
  }
  if (u.role !== 'teacher' && u.role !== 'admin') throw forbidden();
  return { a, k: ownedClass(u, a.class_id) };
}

/* ---------------- 文件 ---------------- */

function freeBytes() {
  try {
    const s = statfsSync(config.dataDir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
const files = (col: 'assignment_id' | 'submission_id', id: number) =>
  db.all<{ id: number; name: string; size: number }>(`SELECT id, name, size FROM homework_files WHERE ${col}=? ORDER BY id`, id);
/**
 * 把这次要挂上的文件挂好：只能挂自己传的、还没挂到别处的，或者本来就挂在这里的；原来挂着这次没带的摘下来。
 */
function attach(u: User, col: 'assignment_id' | 'submission_id', id: number, ids: number[]) {
  const want = [...new Set(ids)];
  if (want.length > MAX_FILES) throw bad(`附件最多 ${MAX_FILES} 个`);
  for (const fid of want) {
    const f = db.get<FileRow>('SELECT id, owner_id, assignment_id, submission_id FROM homework_files WHERE id=?', fid);
    const free = f && f.owner_id === u.id && f.assignment_id === null && f.submission_id === null;
    if (!f || !(free || f[col] === id)) throw bad('附件没传上，重新加一下');
  }
  db.run(`UPDATE homework_files SET ${col}=NULL WHERE ${col}=?`, id);
  for (const fid of want) db.run(`UPDATE homework_files SET ${col}=? WHERE id=?`, id, fid);
}

/** 传文件：先传上来拿到编号，布置作业、交作业时再带上编号 */
homeworkRoutes.post('/files', async (c) => {
  const u = me(c);
  rateLimit(`hw-upload:${u.id}`, 200, 60 * 60_000);
  if (Number(c.req.header('content-length') || 0) > MAX_FILE) throw bad('一个文件最大 50 MB');
  const name = (c.req.query('name') || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 120);
  if (!name) throw bad('文件名不对');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) throw bad('文件是空的');
  if (bytes.length > MAX_FILE) throw bad('一个文件最大 50 MB');
  if (freeBytes() - bytes.length < RESERVE) throw bad('服务器的存储空间不够了，请联系管理员');
  const t = now();
  const rel = `${new Date(t).toISOString().slice(0, 7)}/${randomBytes(16).toString('hex')}`;
  const abs = resolve(DIR, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  const id = db.insert('homework_files', { owner_id: u.id, name, size: bytes.length, path: rel, created_at: t });
  return c.json({ id, name, size: bytes.length });
});

const INLINE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
/** 下载附件：老师看自己班的，学生看发给他的作业附件和自己交的；图片和 PDF 能直接打开看 */
homeworkRoutes.get('/files/:id', (c) => {
  const u = me(c);
  const f = db.get<FileRow>('SELECT * FROM homework_files WHERE id=?', intParam(c));
  if (!f) throw notFound('文件不存在');
  let ok = f.owner_id === u.id;
  if (!ok && f.assignment_id) {
    try {
      assignmentFor(u, f.assignment_id);
      ok = true;
    } catch {}
  }
  if (!ok && f.submission_id) {
    const s = db.get<{ assignment_id: number; user_id: number }>('SELECT assignment_id, user_id FROM submissions WHERE id=?', f.submission_id);
    if (s && u.role !== 'student') {
      try {
        assignmentFor(u, s.assignment_id);
        ok = true;
      } catch {}
    }
  }
  if (!ok) throw notFound('文件不存在');
  const abs = resolve(DIR, f.path);
  if (!abs.startsWith(DIR) || !existsSync(abs)) throw notFound('文件不在了');
  const type = INLINE[extname(f.name).toLowerCase()];
  const inline = !!type && c.req.query('inline') === '1';
  return new Response(new Uint8Array(readFileSync(abs)), {
    headers: {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="file${extname(f.name).replace(/[^.\w]/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
});

/* ---------------- 作业的状态 ---------------- */

type Status = 'todo' | 'missing' | 'submitted' | 'late' | 'graded' | 'returned';
/** 一个学生在一份作业上的状态：没交（截止前是「未交」，过了是「缺交」）、已交、迟交、已批、已退回 */
function statusOf(a: Pick<AssignmentRow, 'due_at'>, s: Pick<SubmissionRow, 'submitted_at' | 'late' | 'score' | 'returned_at'> | undefined, t = now()): Status {
  if (!s) return a.due_at && t > a.due_at ? 'missing' : 'todo';
  if (s.returned_at && s.returned_at >= s.submitted_at) return 'returned';
  if (s.score !== null) return 'graded';
  return s.late ? 'late' : 'submitted';
}
/** 学生还能不能交、改；不能的给原因 */
function lockReason(a: AssignmentRow, k: ClassRow, s: SubmissionRow | undefined, t = now()): string | null {
  if (k.archived_at) return '这个班已经归档了';
  const returned = !!s?.returned_at && s.returned_at >= s.submitted_at;
  if (s && s.score !== null && !returned) return '已经批改了，要改找老师退回';
  if (!returned && a.due_at && t > a.due_at && !a.allow_late) return '已经截止了';
  return null;
}
const pub = (a: AssignmentRow) => ({
  id: a.id,
  classId: a.class_id,
  title: a.title,
  body: a.body,
  points: a.points,
  dueAt: a.due_at,
  allowLate: !!a.allow_late,
  publishAt: a.publish_at,
  createdAt: a.created_at,
});

/* ---------------- 布置、改、删 ---------------- */

const FIELDS = {
  title: z.string().trim().min(1).max(80),
  body: z.string().max(20_000),
  points: z.number().min(1).max(1000),
  dueAt: z.number().int().positive().nullable(),
  allowLate: z.boolean(),
  publishAt: z.number().int().positive().nullable(),
  fileIds: z.array(z.number().int().positive()).max(MAX_FILES),
};
function checkTimes(publishAt: number, dueAt: number | null) {
  if (dueAt && dueAt <= publishAt) throw bad('截止时间要在发布时间之后');
}

/** 布置作业：一次可以发给几个班，每个班一份，附件各挂一份 */
homeworkRoutes.post('/', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const d = await body(c, z.object({ classIds: z.array(z.number().int().positive()).min(1).max(30), ...FIELDS }));
  const classes = [...new Set(d.classIds)].map((id) => live(ownedClass(u, id)));
  const t = now();
  const publishAt = d.publishAt && d.publishAt > t ? d.publishAt : t;
  checkTimes(publishAt, d.dueAt);
  const ids = db.tx(() => {
    const made: number[] = [];
    for (const k of classes) {
      const id = db.insert('assignments', {
        class_id: k.id,
        teacher_id: u.id,
        title: d.title,
        body: d.body,
        points: d.points,
        due_at: d.dueAt,
        allow_late: d.allowLate ? 1 : 0,
        publish_at: publishAt,
        created_at: t,
        updated_at: t,
      });
      if (!made.length) attach(u, 'assignment_id', id, d.fileIds);
      else
        for (const f of files('assignment_id', made[0]))
          db.run(
            'INSERT INTO homework_files (owner_id, assignment_id, name, size, path, created_at) SELECT owner_id, ?, name, size, path, ? FROM homework_files WHERE id=?',
            id,
            t,
            f.id,
          );
      made.push(id);
    }
    return made;
  });
  audit(c, 'homework.create', `class:${classes.map((k) => k.id).join(',')}`, { ids, title: d.title });
  // 助教在后台给每个班的资料包写这份作业的说明
  ids.forEach(packOnHomework);
  return c.json({ ids });
});

homeworkRoutes.patch('/:id', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const d = await body(c, z.object(FIELDS).partial());
  const t = now();
  // 已经发出去的作业不能再改成以后发
  const publishAt = d.publishAt === undefined ? a.publish_at : a.publish_at <= t ? a.publish_at : d.publishAt && d.publishAt > t ? d.publishAt : t;
  const dueAt = d.dueAt === undefined ? a.due_at : d.dueAt;
  checkTimes(publishAt, dueAt);
  db.tx(() => {
    db.update('assignments', a.id, {
      ...(d.title !== undefined && { title: d.title }),
      ...(d.body !== undefined && { body: d.body }),
      ...(d.points !== undefined && { points: d.points }),
      ...(d.allowLate !== undefined && { allow_late: d.allowLate ? 1 : 0 }),
      due_at: dueAt,
      publish_at: publishAt,
      updated_at: t,
    });
    if (d.fileIds) attach(u, 'assignment_id', a.id, d.fileIds);
  });
  audit(c, 'homework.update', `homework:${a.id}`);
  // 标题、要求改了：说明重写（只改截止、满分不用，资料包里那些是现取的）
  if ((d.title !== undefined && d.title !== a.title) || (d.body !== undefined && d.body !== a.body)) packOnHomework(a.id);
  return c.json({ ok: true });
});

/** 删作业只做记号，交上来的东西还在 */
homeworkRoutes.delete('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  db.update('assignments', a.id, { deleted_at: now(), updated_at: now() });
  audit(c, 'homework.delete', `homework:${a.id}`, { title: a.title });
  packOnHomeworkDeleted(a.id);
  return c.json({ ok: true });
});

/* ---------------- 看作业 ---------------- */

/** 班里的学生：老师名单和自己加入的都在，按学号排；没加入的交不了 */
const members = (classId: number) =>
  db.all<{ id: number; student_no: string; name: string; user_id: number | null }>(
    'SELECT id, student_no, name, user_id FROM class_students WHERE class_id=? ORDER BY user_id IS NULL, student_no, id',
    classId,
  );
const subsOf = (assignmentId: number) =>
  new Map(db.all<SubmissionRow>('SELECT * FROM submissions WHERE assignment_id=?', assignmentId).map((s) => [s.user_id, s]));

/** 一个班的作业：老师看全部（带交了几个、批了几个），学生只看已经发布的（带自己的状态） */
homeworkRoutes.get('/class/:id', (c) => {
  const u = me(c),
    id = intParam(c);
  const t = now();
  if (u.role === 'student') {
    joinedClass(u, id);
    const list = db.all<AssignmentRow>(`${ASSIGNMENT} WHERE class_id=? AND deleted_at IS NULL AND publish_at<=? ORDER BY publish_at DESC, id DESC`, id, t);
    return c.json({
      homework: list.map((a) => {
        const s = db.get<SubmissionRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', a.id, u.id);
        return { ...pub(a), status: statusOf(a, s, t), score: s?.score ?? null };
      }),
    });
  }
  requireRole(c, 'teacher', 'admin');
  ownedClass(u, id);
  const joined = members(id).filter((m) => m.user_id !== null).length;
  const list = db.all<AssignmentRow & { submitted: number; graded: number }>(
    `SELECT a.id, a.class_id, a.teacher_id, a.title, a.body, a.points, a.due_at, a.allow_late, a.publish_at, a.created_at, a.updated_at,
       (SELECT count(*) FROM submissions s JOIN class_students m ON m.class_id=a.class_id AND m.user_id=s.user_id WHERE s.assignment_id=a.id) AS submitted,
       (SELECT count(*) FROM submissions s JOIN class_students m ON m.class_id=a.class_id AND m.user_id=s.user_id WHERE s.assignment_id=a.id AND s.score IS NOT NULL
          AND (s.returned_at IS NULL OR s.returned_at < s.submitted_at)) AS graded
     FROM assignments a WHERE a.class_id=? AND a.deleted_at IS NULL ORDER BY a.publish_at DESC, a.id DESC`,
    id,
  );
  return c.json({ homework: list.map((a) => ({ ...pub(a), submitted: a.submitted, graded: a.graded, total: joined })) });
});

/** 一份作业：老师看要求和每个学生交的情况；学生看要求和自己交的 */
homeworkRoutes.get('/:id', (c) => {
  const u = me(c);
  const { a, k } = assignmentFor(u, intParam(c));
  const t = now();
  const base = { ...pub(a), className: k.name, archived: !!k.archived_at, files: files('assignment_id', a.id) };
  if (u.role === 'student') {
    const s = db.get<SubmissionRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', a.id, u.id);
    return c.json({
      ...base,
      status: statusOf(a, s, t),
      lock: lockReason(a, k, s, t),
      mine: s
        ? {
            text: s.text,
            submittedAt: s.submitted_at,
            late: !!s.late,
            score: s.score,
            comment: s.comment,
            gradedAt: s.graded_at,
            returnedAt: s.returned_at,
            files: files('submission_id', s.id),
          }
        : null,
    });
  }
  const subs = subsOf(a.id);
  return c.json({
    ...base,
    students: members(a.class_id).map((m) => {
      const s = m.user_id === null ? undefined : subs.get(m.user_id);
      return {
        id: m.id,
        studentNo: m.student_no,
        name: m.name,
        joined: m.user_id !== null,
        status: m.user_id === null ? null : statusOf(a, s, t),
        submittedAt: s?.submitted_at ?? null,
        late: !!s?.late,
        score: s?.score ?? null,
      };
    }),
  });
});

/* ---------------- 交作业 ---------------- */

/** 交作业：文字和文件，截止前能改；过了截止、允许迟交的标「迟交」；退回的可以重交 */
homeworkRoutes.post('/:id/submit', async (c) => {
  const u = requireRole(c, 'student');
  const { a, k } = assignmentFor(u, intParam(c));
  const d = await body(c, z.object({ text: z.string().max(20_000), fileIds: z.array(z.number().int().positive()).max(MAX_FILES) }));
  if (!d.text.trim() && !d.fileIds.length) throw bad('写点内容或者加个附件再交');
  const t = now();
  const id = db.tx(() => {
    const s = db.get<SubmissionRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', a.id, u.id);
    const why = lockReason(a, k, s, t);
    if (why) throw conflict(why);
    const returned = !!s?.returned_at && s.returned_at >= s.submitted_at;
    const late = returned ? s!.late : a.due_at && t > a.due_at ? 1 : 0;
    // 退回后重交：分数清掉等老师重新批，评语留着
    const row = { text: d.text, submitted_at: t, late, updated_at: t, ...(returned && { score: null, graded_at: null }) };
    const sid = s ? (db.update('submissions', s.id, row), s.id) : db.insert('submissions', { assignment_id: a.id, user_id: u.id, ...row });
    attach(u, 'submission_id', sid, d.fileIds);
    return sid;
  });
  audit(c, 'homework.submit', `homework:${a.id}`, { submission: id });
  return c.json({ ok: true });
});

/* ---------------- 批作业 ---------------- */

/** 老师点开一个学生：他交的文字、文件、分数、评语 */
function studentOf(classId: number, csid: number) {
  const m = db.get<{ id: number; student_no: string; name: string; user_id: number | null }>(
    'SELECT id, student_no, name, user_id FROM class_students WHERE id=? AND class_id=?',
    csid,
    classId,
  );
  if (!m) throw notFound('班里没有这个学生');
  return m;
}
homeworkRoutes.get('/:id/students/:sid', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a } = assignmentFor(u, intParam(c));
  const m = studentOf(a.class_id, intParam(c, 'sid'));
  const s = m.user_id === null ? undefined : db.get<SubmissionRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', a.id, m.user_id);
  return c.json({
    id: m.id,
    studentNo: m.student_no,
    name: m.name,
    joined: m.user_id !== null,
    status: m.user_id === null ? null : statusOf(a, s),
    submission: s
      ? {
          text: s.text,
          submittedAt: s.submitted_at,
          late: !!s.late,
          score: s.score,
          comment: s.comment,
          gradedAt: s.graded_at,
          returnedAt: s.returned_at,
          files: files('submission_id', s.id),
        }
      : null,
  });
});

function submissionOf(a: AssignmentRow, csid: number) {
  const m = studentOf(a.class_id, csid);
  const s = m.user_id === null ? undefined : db.get<SubmissionRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', a.id, m.user_id);
  if (!s) throw conflict('这个学生还没交');
  return s;
}

/** 打分、写评语；分数不超过满分 */
homeworkRoutes.post('/:id/students/:sid/grade', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const d = await body(c, z.object({ score: z.number().min(0).nullable(), comment: z.string().max(5000) }));
  if (d.score !== null && d.score > a.points) throw bad(`分数不能超过满分 ${a.points}`);
  const s = submissionOf(a, intParam(c, 'sid'));
  const t = now();
  db.update('submissions', s.id, {
    score: d.score === null ? null : Math.round(d.score * 10) / 10,
    comment: d.comment.trim() || null,
    graded_at: d.score === null ? null : t,
    returned_at: null,
    updated_at: t,
  });
  audit(c, 'homework.grade', `homework:${a.id}`, { submission: s.id, score: d.score });
  return c.json({ ok: true });
});

/** 退回重交：分数清掉，学生那边显示「已退回」，截止了也能重交 */
homeworkRoutes.post('/:id/students/:sid/return', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const d = await body(c, z.object({ comment: z.string().max(5000) }));
  const s = submissionOf(a, intParam(c, 'sid'));
  const t = now();
  db.update('submissions', s.id, { score: null, graded_at: null, comment: d.comment.trim() || null, returned_at: t, updated_at: t });
  audit(c, 'homework.return', `homework:${a.id}`, { submission: s.id });
  return c.json({ ok: true });
});

/* ---------------- 成绩 ---------------- */

/**
 * 成绩表：一行一个学生，一列一份已经发布的作业。平均分折成百分制：批了的按分数算，过了截止还没交的算 0，
 * 还没到截止、交了还没批的不算进去。
 */
function gradeTable(classId: number, onlyUser?: number) {
  const t = now();
  const list = db.all<AssignmentRow>(`${ASSIGNMENT} WHERE class_id=? AND deleted_at IS NULL AND publish_at<=? ORDER BY publish_at, id`, classId, t);
  const subs = new Map(list.map((a) => [a.id, subsOf(a.id)]));
  const rows = members(classId)
    .filter((m) => onlyUser === undefined || m.user_id === onlyUser)
    .map((m) => {
      const cells: Record<number, { status: Status | null; score: number | null }> = {};
      let sum = 0,
        n = 0;
      for (const a of list) {
        const s = m.user_id === null ? undefined : subs.get(a.id)!.get(m.user_id);
        const status = m.user_id === null ? (a.due_at && t > a.due_at ? 'missing' : null) : statusOf(a, s, t);
        cells[a.id] = { status, score: status === 'graded' ? s!.score : null };
        if (status === 'graded') (sum += (s!.score! / a.points) * 100), n++;
        else if (status === 'missing') n++;
      }
      return { id: m.id, studentNo: m.student_no, name: m.name, joined: m.user_id !== null, cells, average: n ? Math.round((sum / n) * 10) / 10 : null };
    });
  return { homework: list.map((a) => ({ id: a.id, title: a.title, points: a.points, dueAt: a.due_at })), rows };
}

homeworkRoutes.get('/class/:id/grades', (c) => {
  const u = me(c),
    id = intParam(c);
  if (u.role === 'student') {
    joinedClass(u, id);
    return c.json(gradeTable(id, u.id));
  }
  requireRole(c, 'teacher', 'admin');
  ownedClass(u, id);
  return c.json(gradeTable(id));
});

const WORD: Record<Status, string> = { todo: '未交', missing: '缺交', submitted: '待批', late: '待批', graded: '', returned: '已退回' };
homeworkRoutes.get('/class/:id/grades/export', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const k = ownedClass(u, intParam(c));
  const g = gradeTable(k.id);
  const rows = [
    ['学号', '姓名', ...g.homework.map((h) => `${h.title}（满分 ${h.points}）`), '平均分（百分制）'],
    ...g.rows.map((r) => [
      r.studentNo,
      r.name,
      ...g.homework.map((h) => {
        const cell = r.cells[h.id];
        return cell.score !== null ? cell.score : cell.status ? WORD[cell.status] : '';
      }),
      r.average ?? '',
    ]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 16 }, { wch: 10 }, ...g.homework.map(() => ({ wch: 16 })), { wch: 16 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '成绩');
  const bytes: Buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  audit(c, 'homework.grades.export', `class:${k.id}`);
  const file = `${k.name.replace(/[\\/:*?"<>|]/g, '')}-成绩.xlsx`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="grades.xlsx"; filename*=UTF-8''${encodeURIComponent(file)}`,
    },
  });
});

/** 班级卡片上的数：学生是还要交的份数，老师是交上来还没批的份数 */
export function homeworkCounts(u: User, classIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!classIds.length) return out;
  const t = now();
  const marks = classIds.map(() => '?').join(',');
  if (u.role === 'student') {
    for (const r of db.all<{ class_id: number; n: number }>(
      `SELECT a.class_id, count(*) AS n FROM assignments a LEFT JOIN submissions s ON s.assignment_id=a.id AND s.user_id=?
       WHERE a.class_id IN (${marks}) AND a.deleted_at IS NULL AND a.publish_at<=?
         AND (s.id IS NULL OR (s.returned_at IS NOT NULL AND s.returned_at >= s.submitted_at))
         AND (a.due_at IS NULL OR a.due_at>=? OR a.allow_late=1 OR s.id IS NOT NULL)
       GROUP BY a.class_id`,
      u.id,
      ...classIds,
      t,
      t,
    ))
      out.set(r.class_id, r.n);
    return out;
  }
  for (const r of db.all<{ class_id: number; n: number }>(
    `SELECT a.class_id, count(*) AS n FROM submissions s JOIN assignments a ON a.id=s.assignment_id
       JOIN class_students m ON m.class_id=a.class_id AND m.user_id=s.user_id
     WHERE a.class_id IN (${marks}) AND a.deleted_at IS NULL AND s.score IS NULL AND (s.returned_at IS NULL OR s.returned_at < s.submitted_at)
     GROUP BY a.class_id`,
    ...classIds,
  ))
    out.set(r.class_id, r.n);
  return out;
}

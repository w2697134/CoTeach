/**
 * 老师说的班名、作业名、学生名 → 系统里的哪一个。
 * 对不上、对上好几个，程序在这里就拦下，报的话里列出现有的，让助教拿去问老师，不靠它自己猜。
 */
import { db } from '../db/index.js';
import { bad } from '../lib/http.js';
import { showTime } from './time.js';

export interface ClassRow {
  id: number;
  name: string;
  join_code: string | null;
  join_open: number;
  archived_at: number | null;
  deleted_at: number | null;
}
export interface HomeworkRow {
  id: number;
  class_id: number;
  title: string;
  body: string;
  points: number;
  due_at: number | null;
  allow_late: number;
  publish_at: number;
  created_at: number;
  deleted_at: number | null;
}
export interface StudentRow {
  id: number;
  class_id: number;
  student_no: string;
  name: string;
  user_id: number | null;
}

/** 比较时不管空格、全半角括号、书名号、大小写 */
const norm = (s: string) =>
  String(s ?? '')
    .replace(/[\s「」『』《》"'“”‘’]/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase();

/** 先认编号，再认一模一样的，最后认包含的（两头都试） */
function pick<T extends { id: number }>(rows: T[], ref: string, name: (r: T) => string[]): T[] {
  const raw = String(ref ?? '').trim();
  const id = raw.match(/^#?(\d+)$/);
  if (id) {
    const hit = rows.filter((r) => r.id === Number(id[1]));
    if (hit.length) return hit;
  }
  const q = norm(raw);
  if (!q) return [];
  const exact = rows.filter((r) => name(r).some((n) => norm(n) === q));
  if (exact.length) return exact;
  return rows.filter((r) => name(r).some((n) => norm(n).includes(q) || (norm(n).length >= 2 && q.includes(norm(n)))));
}

export function classesOf(teacherId: number): ClassRow[] {
  return db.all<ClassRow>(
    'SELECT id, name, join_code, join_open, archived_at, deleted_at FROM classes WHERE teacher_id=? AND deleted_at IS NULL ORDER BY id',
    teacherId,
  );
}

const classList = (rows: ClassRow[]) => (rows.length ? rows.map((k) => `「${k.name}」${k.archived_at ? '（已归档）' : ''}`).join('、') : '还没有班');

export function findClass(teacherId: number, ref: string): ClassRow {
  const all = classesOf(teacherId);
  const hit = pick(all, ref, (k) => [k.name]);
  if (!hit.length) throw bad(`没有叫「${ref}」的班。老师现在的班：${classList(all)}`);
  if (hit.length > 1) throw bad(`「${ref}」对得上好几个班：${classList(hit)}。先问老师是哪一个`);
  return hit[0];
}

const homeworkLine = (h: HomeworkRow, className: string) =>
  `「${h.title}」（${className}${h.due_at ? `，截止 ${showTime(h.due_at)}` : '，不设截止'}）`;

/**
 * 找作业：可以限定班。一份作业发给几个班时每个班一份，标题一样、一起建的（created_at 相同）算同一份，一起返回；
 * 不是一起建的同名作业对上好几份，就要问老师。
 */
export function findHomework(teacherId: number, ref: string, classRef?: string | null): { rows: HomeworkRow[]; classes: Map<number, ClassRow> } {
  const classes = new Map(classesOf(teacherId).map((k) => [k.id, k]));
  const only = classRef ? findClass(teacherId, classRef) : null;
  const all = db.all<HomeworkRow>(
    `SELECT a.id, a.class_id, a.title, a.body, a.points, a.due_at, a.allow_late, a.publish_at, a.created_at, a.deleted_at
     FROM assignments a JOIN classes c ON c.id=a.class_id WHERE c.teacher_id=? AND c.deleted_at IS NULL AND a.deleted_at IS NULL ${only ? 'AND a.class_id=?' : ''}
     ORDER BY a.id`,
    ...(only ? [teacherId, only.id] : [teacherId]),
  );
  const hit = pick(all, ref, (h) => [h.title]);
  if (!hit.length) {
    const recent = all.slice(-8).map((h) => homeworkLine(h, classes.get(h.class_id)?.name || ''));
    throw bad(`${only ? `「${only.name}」里` : ''}没有对得上「${ref}」的作业。${recent.length ? `最近的作业：${recent.join('、')}` : '还没有布置过作业'}`);
  }
  const together = hit.every((h) => h.created_at === hit[0].created_at && h.title === hit[0].title);
  if (hit.length > 1 && !together)
    throw bad(`「${ref}」对得上好几份作业：${hit.map((h) => homeworkLine(h, classes.get(h.class_id)?.name || '')).join('、')}。先问老师是哪一份`);
  return { rows: hit, classes };
}

export function findStudent(classId: number, className: string, ref: string): StudentRow {
  const all = db.all<StudentRow>('SELECT id, class_id, student_no, name, user_id FROM class_students WHERE class_id=? ORDER BY student_no, id', classId);
  const hit = pick(all, ref, (s) => [s.name, s.student_no]);
  if (!hit.length) throw bad(`「${className}」里没有「${ref}」。${all.length ? `班里有：${all.slice(0, 30).map((s) => `${s.name}（${s.student_no}）`).join('、')}` : '班里还没有学生'}`);
  if (hit.length > 1) throw bad(`「${className}」里「${ref}」对得上好几个人：${hit.map((s) => `${s.name}（${s.student_no}）`).join('、')}。先问老师是哪一个`);
  return hit[0];
}

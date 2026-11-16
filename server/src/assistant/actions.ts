/**
 * 助教办的每件事记一笔：办了什么（卡片上显示），连同办之前的样子（撤回时改回去）。
 * 撤回前先看后来有没有人又改过：改过就不动，免得把老师后来改的冲掉。
 */
import { db, j, now } from '../db/index.js';
import { conflict, notFound } from '../lib/http.js';
import { publish, record, type RunRef } from '../kb/agent/events.js';

export type ActionKind =
  | 'class.create'
  | 'class.update'
  | 'class.delete'
  | 'homework.create'
  | 'homework.update'
  | 'homework.delete'
  | 'submission.grade'
  | 'grades.export'
  | 'student.password'
  | 'students.notify'
  | 'student.reply'
  | 'pack.update'
  | 'pack.files';

/** 卡片上显示的东西 */
export interface ActionCard {
  title: string;
  lines?: string[];
  links?: { label: string; to?: string; href?: string }[];
  /** 建班的卡片上直接摆加课码 */
  code?: string;
  className?: string;
  /** 重置的新密码：只在老师看的卡片上，不发给模型 */
  secret?: string;
  classId?: number;
}

type Snapshot = Record<string, unknown>;
export type Undo =
  | { kind: 'class.create'; classId: number }
  | { kind: 'class.update'; classId: number; before: Snapshot; after: Snapshot }
  | { kind: 'class.delete'; classId: number }
  | { kind: 'homework.create'; ids: number[] }
  | { kind: 'homework.update'; rows: { id: number; before: Snapshot; after: Snapshot }[] }
  | { kind: 'homework.delete'; ids: number[] }
  | { kind: 'submission.grade'; submissionId: number; before: Snapshot; after: Snapshot };

/** 记一笔，卡片发到这一轮里；返回编号（助教撤回时用） */
export function recordAction(ref: RunRef, kind: ActionKind, card: ActionCard, undo: Undo | null): number {
  const id = db.insert('ta_actions', {
    teacher_id: ref.teacherId,
    run_id: ref.runId,
    kind,
    title: card.title,
    data: card,
    undo,
    status: 'done',
    created_at: now(),
  });
  record(ref, 'action', { actionId: id, kind, undoable: !!undo, ...card });
  return id;
}

export function actionsOfRun(runId: number) {
  return db
    .all<{ id: number; kind: string; status: string; undo: string | null }>('SELECT id, kind, status, undo FROM ta_actions WHERE run_id=? ORDER BY id', runId)
    .map((a) => ({ id: a.id, kind: a.kind, status: a.status, undoable: !!a.undo }));
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
/** 现在这一行还是不是办完时的样子 */
function unchanged(table: string, id: number, after: Snapshot) {
  const row = db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id=?`, id);
  if (!row) return false;
  return Object.entries(after).every(([k, v]) => same(row[k], v));
}

/** 撤回一件事；成功返回一句话 */
export function undoAction(teacherId: number, id: number): string {
  const a = db.get<{ id: number; teacher_id: number; run_id: number | null; kind: string; title: string; undo: string | null; status: string }>(
    'SELECT * FROM ta_actions WHERE id=? AND teacher_id=?',
    id,
    teacherId,
  );
  if (!a) throw notFound('没有这条记录');
  if (a.status === 'undone') return `「${a.title}」已经撤回过了`;
  const u = j<Undo | null>(a.undo, null);
  if (!u) throw conflict(`「${a.title}」撤不回`);
  const t = now();
  db.tx(() => {
    switch (u.kind) {
      case 'class.create':
        ownClass(teacherId, u.classId, true);
        db.run('UPDATE classes SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL', t, t, u.classId);
        break;
      case 'class.delete': {
        const k = ownClass(teacherId, u.classId, true);
        if (db.get('SELECT id FROM classes WHERE teacher_id=? AND name=? AND deleted_at IS NULL AND id<>?', teacherId, k.name, k.id))
          throw conflict(`现在已经有一个叫「${k.name}」的班了，撤不回`);
        db.run('UPDATE classes SET deleted_at=NULL, updated_at=? WHERE id=?', t, u.classId);
        break;
      }
      case 'class.update':
        ownClass(teacherId, u.classId, false);
        if (!unchanged('classes', u.classId, u.after)) throw conflict('这个班后来又改过了，撤不回');
        db.update('classes', u.classId, { ...u.before, updated_at: t });
        break;
      case 'homework.create':
        for (const hid of u.ids) ownHomework(teacherId, hid);
        db.run(`UPDATE assignments SET deleted_at=?, updated_at=? WHERE id IN (${u.ids.map(() => '?').join(',')}) AND deleted_at IS NULL`, t, t, ...u.ids);
        break;
      case 'homework.delete':
        for (const hid of u.ids) ownHomework(teacherId, hid);
        db.run(`UPDATE assignments SET deleted_at=NULL, updated_at=? WHERE id IN (${u.ids.map(() => '?').join(',')})`, t, ...u.ids);
        break;
      case 'homework.update':
        for (const r of u.rows) {
          ownHomework(teacherId, r.id);
          if (!unchanged('assignments', r.id, r.after)) throw conflict('这份作业后来又改过了，撤不回');
        }
        for (const r of u.rows) db.update('assignments', r.id, { ...r.before, updated_at: t });
        break;
      case 'submission.grade': {
        const s = db.get<{ assignment_id: number }>('SELECT assignment_id FROM submissions WHERE id=?', u.submissionId);
        if (!s) throw notFound('这份作业不在了');
        ownHomework(teacherId, s.assignment_id);
        if (!unchanged('submissions', u.submissionId, u.after)) throw conflict('这份作业后来又批过或重交了，撤不回');
        db.update('submissions', u.submissionId, { ...u.before, updated_at: t });
        break;
      }
    }
    db.update('ta_actions', a.id, { status: 'undone', undone_at: t });
  });
  if (a.run_id) publish({ teacherId, runId: a.run_id, kbId: null }, 'action', { actionId: a.id, status: 'undone' });
  return `已撤回「${a.title}」`;
}

function ownClass(teacherId: number, classId: number, includeDeleted: boolean) {
  const k = db.get<{ id: number; name: string }>(
    `SELECT id, name FROM classes WHERE id=? AND teacher_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    classId,
    teacherId,
  );
  if (!k) throw notFound('这个班不在了');
  return k;
}
function ownHomework(teacherId: number, hid: number) {
  if (!db.get('SELECT a.id FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.id=? AND c.teacher_id=?', hid, teacherId)) throw notFound('这份作业不在了');
}

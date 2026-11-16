/**
 * 班级资料包自动写。
 * 建班、布置作业、改了作业要求时，助教在后台给这个班的资料包写一条说明；老师那边不用等。
 * 一个班的活一件一件做；服务重启后没做完的接着做。老师还没有资料（知识库是空的）就不写：没有可整理的。
 */
import { db, getSetting, now, setSetting } from '../db/index.js';
import { listKbs } from '../kb/bases.js';
import { manifest } from '../kb/repo.js';
import { runHelper } from './helper.js';
import { dropHomeworkNote, putPack } from './pack.js';

/** 测试里关掉（各自的测试会直接调 runPackJob） */
let auto = process.env.CT_PACK_AUTO !== '0';
export function setPackAuto(on: boolean) {
  auto = on;
}

interface Job {
  id: number;
  class_id: number;
  kind: 'course' | 'homework';
  ref_id: number | null;
  status: string;
}

const hasMaterials = (teacherId: number) =>
  listKbs(teacherId)
    .filter((k) => k.status === 'active')
    .some((k) => {
      try {
        return manifest(k.id).length > 0;
      } catch {
        return false;
      }
    });

function enqueue(classId: number, kind: Job['kind'], refId: number | null) {
  if (!auto) return;
  // 同一件还排着没做：不再排一件
  if (db.get("SELECT id FROM pack_jobs WHERE class_id=? AND kind=? AND ref_id IS ? AND status='queued'", classId, kind, refId)) return;
  db.insert('pack_jobs', { class_id: classId, kind, ref_id: refId, status: 'queued', created_at: now() });
  queueMicrotask(() => void drain());
}

export const packOnClassCreated = (classId: number) => enqueue(classId, 'course', null);
export function packOnHomework(homeworkId: number) {
  const h = db.get<{ class_id: number }>('SELECT class_id FROM assignments WHERE id=?', homeworkId);
  if (h) enqueue(h.class_id, 'homework', homeworkId);
}
export const packOnHomeworkDeleted = (homeworkId: number) => dropHomeworkNote(homeworkId);

let running = false;
/** 一件一件做（同一时间只做一件，免得一下子开很多个模型调用） */
export async function drain() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = db.get<Job>("SELECT * FROM pack_jobs WHERE status='queued' ORDER BY id LIMIT 1");
      if (!job) break;
      db.update('pack_jobs', job.id, { status: 'running' });
      try {
        const runId = await runPackJob(job.class_id, job.kind, job.ref_id);
        db.update('pack_jobs', job.id, { status: 'done', run_id: runId, finished_at: now() });
      } catch (err) {
        console.error('[pack] job', job.id, err);
        db.update('pack_jobs', job.id, { status: 'error', error: (err as Error).message || '没写成', finished_at: now() });
      }
    }
  } finally {
    running = false;
  }
}

/** 服务重启：做到一半的重新排上，接着做 */
export function recoverPackJobs() {
  db.run("UPDATE pack_jobs SET status='queued' WHERE status='running'");
  if (auto) queueMicrotask(() => void drain());
}

/**
 * 有资料包以前就建好的班（2026-11-16 上线前的）：补写一次课程说明和还没截止的作业说明。只补一次。
 */
export function backfillPacks() {
  if (!auto || getSetting<boolean>('pack_backfilled', false)) return;
  const t = now();
  for (const k of db.all<{ id: number }>('SELECT id FROM classes WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY id')) {
    if (db.get('SELECT id FROM pack_jobs WHERE class_id=?', k.id)) continue;
    enqueue(k.id, 'course', null);
    for (const h of db.all<{ id: number }>('SELECT id FROM assignments WHERE class_id=? AND deleted_at IS NULL AND (due_at IS NULL OR due_at>?) ORDER BY id', k.id, t))
      enqueue(k.id, 'homework', h.id);
  }
  setSetting('pack_backfilled', true);
}

/** 写一条：课程说明，或者一份作业的说明。返回助教那一轮的编号（没写就是 null） */
export async function runPackJob(classId: number, kind: Job['kind'], refId: number | null): Promise<number | null> {
  const k = db.get<{ id: number; name: string; teacher_id: number; deleted_at: number | null }>('SELECT id, name, teacher_id, deleted_at FROM classes WHERE id=?', classId);
  if (!k || k.deleted_at || !hasMaterials(k.teacher_id)) return null;
  if (kind === 'course') {
    const r = await runHelper({
      teacherId: k.teacher_id,
      classId,
      mode: 'pack',
      request: `给「${k.name}」写课程说明`,
      task: `「${k.name}」这个班刚建好。看看老师的知识库里有没有这个班要用的资料：有的话写一段课程说明给学伴（这个班学什么、主要资料是哪几份、各讲什么），能发给学生的原件用 give_files 放进来；对不上就只写一句「还没有对应的资料」。说明用 save_note 存。`,
    });
    if (r.note) putPack(classId, 'course', '课程', r.note);
    return r.runId;
  }
  const h = db.get<{ id: number; title: string; body: string; points: number; due_at: number | null; deleted_at: number | null }>(
    'SELECT id, title, body, points, due_at, deleted_at FROM assignments WHERE id=?',
    refId,
  );
  if (!h || h.deleted_at) return null;
  const r = await runHelper({
    teacherId: k.teacher_id,
    classId,
    mode: 'pack',
    request: `给「${k.name}」的作业「${h.title}」写说明`,
    task: `「${k.name}」布置了作业「${h.title}」。\n要求：${h.body.trim() || '（没写要求）'}\n给这份作业写一条说明给学伴：考的是什么、对应哪些资料（哪份、哪一节）、学生卡住时可以怎么提示；答案不要写进来。用得上的原件用 give_files 放进来。说明用 save_note 存。`,
  });
  if (r.note) putPack(classId, 'homework', h.title, r.note, h.id);
  return r.runId;
}

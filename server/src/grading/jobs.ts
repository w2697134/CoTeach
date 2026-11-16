/**
 * 助教批改排队（2026-11-16）：学生一交就排上，几份同时批（默认 3 份），服务重启后没批完的接着批。
 * 批改方式看作业的 ai_mode：release 批完直接发，hold 批完等老师发，off 不自动批。
 */
import { db, getSetting, now } from '../db/index.js';
import { addNote } from '../assistant/notes.js';
import { assignmentRow, classRow, submissionRow, type AiGradeRow } from './common.js';
import { runGrade } from './grader.js';

/** 测试里关掉自动开批（测试直接调 drainGrades） */
let auto = process.env.CT_GRADE_AUTO !== '0';
export function setGradeAuto(on: boolean) {
  auto = on;
}

/**
 * 排一份：这一版已经排着、正在批、或者批好了（不是重批）就不再排。返回排上的编号。
 */
export function enqueueGrade(submissionId: number, o: { release: boolean; redo?: boolean }): number | null {
  const s = submissionRow(submissionId);
  if (!s) return null;
  const same = db.get<{ id: number; status: string }>(
    "SELECT id, status FROM ai_grades WHERE submission_id=? AND submitted_at=? AND status IN ('queued','running','done') ORDER BY id DESC LIMIT 1",
    s.id,
    s.submitted_at,
  );
  if (same && (same.status !== 'done' || !o.redo)) return null;
  // 前面排着的旧版本作废
  db.run("UPDATE ai_grades SET status='stale', finished_at=? WHERE submission_id=? AND status='queued'", now(), s.id);
  const id = db.insert('ai_grades', {
    submission_id: s.id,
    assignment_id: s.assignment_id,
    user_id: s.user_id,
    submitted_at: s.submitted_at,
    status: 'queued',
    auto_release: o.release ? 1 : 0,
    created_at: now(),
  });
  kick();
  return id;
}

/** 学生交了（或者重交）：这份作业用助教批的话排上 */
export function gradeOnSubmit(submissionId: number) {
  const s = submissionRow(submissionId);
  const a = s && assignmentRow(s.assignment_id);
  if (!s || !a || a.ai_mode === 'off') return null;
  return enqueueGrade(s.id, { release: a.ai_mode === 'release' });
}

/** 老师让助教批：还没批的（redo 时连助教批过的也重批；老师自己批过的不动） */
export function gradeAssignment(assignmentId: number, o: { redo?: boolean; userIds?: number[] } = {}) {
  const a = assignmentRow(assignmentId);
  if (!a) return 0;
  const subs = db.all<{ id: number; user_id: number; score: number | null; graded_by: string | null; returned_at: number | null; submitted_at: number }>(
    `SELECT s.id, s.user_id, s.score, s.graded_by, s.returned_at, s.submitted_at FROM submissions s
     JOIN class_students m ON m.class_id=? AND m.user_id=s.user_id WHERE s.assignment_id=?`,
    a.class_id,
    a.id,
  );
  let n = 0;
  for (const s of subs) {
    if (o.userIds && !o.userIds.includes(s.user_id)) continue;
    if (s.returned_at && s.returned_at >= s.submitted_at) continue;
    if (s.score !== null && s.graded_by === 'teacher') continue;
    if (s.score !== null && !o.redo) continue;
    if (enqueueGrade(s.id, { release: a.ai_mode === 'release', redo: o.redo })) n++;
  }
  return n;
}

let running = 0;
/** 同时批几份：一个班截止前后一起交，6 份同时批两三分钟就批完（2026-11-16 演示班：3 份时 36 人要排七八分钟） */
const limit = () => Math.max(1, Math.min(10, getSetting<number>('grade_concurrency', 6)));
const controllers = new Map<number, AbortController>();

function claim(): AiGradeRow | null {
  return db.tx(() => {
    const g = db.get<AiGradeRow>("SELECT * FROM ai_grades WHERE status='queued' ORDER BY id LIMIT 1");
    if (!g) return null;
    db.update('ai_grades', g.id, { status: 'running', started_at: now() });
    return { ...g, status: 'running' };
  });
}

/** 有空位就开批 */
export function kick() {
  if (!auto) return;
  while (running < limit()) {
    const g = claim();
    if (!g) return;
    running++;
    void work(g).finally(() => {
      running--;
      kick();
    });
  }
}

async function work(g: AiGradeRow) {
  const ctrl = new AbortController();
  controllers.set(g.id, ctrl);
  try {
    await runGrade(g, ctrl.signal);
  } catch (err) {
    console.error('[grade]', g.id, (err as Error).message);
  } finally {
    controllers.delete(g.id);
    afterBatch(g.assignment_id);
  }
}

/** 每份作业上回告诉老师是什么时候 */
const told = new Map<number, number>();
/**
 * 一份作业排着的都批完了：告诉老师的助教一声（下回老师说话时它会提）。
 * 学生零零散散交的，一份一份说太吵：攒到 3 份以上，或者有要老师看的、没批成的才说。
 */
function afterBatch(assignmentId: number) {
  const left = db.value<number>("SELECT count(*) FROM ai_grades WHERE assignment_id=? AND status IN ('queued','running')", assignmentId) || 0;
  if (left) return;
  const a = assignmentRow(assignmentId);
  const k = a && classRow(a.class_id);
  if (!a || !k) return;
  const since = told.get(assignmentId) ?? now() - 6 * 3600_000;
  const done = db.all<{ flag: string | null; status: string }>(
    "SELECT flag, status FROM ai_grades WHERE assignment_id=? AND finished_at>? AND status IN ('done','error')",
    assignmentId,
    since,
  );
  const flagged = done.filter((x) => x.status === 'done' && x.flag).length;
  const failed = done.filter((x) => x.status === 'error').length;
  if (done.length < 3 && !flagged && !failed) return;
  told.set(assignmentId, now());
  addNote(
    a.teacher_id,
    `「${k.name}」的「${a.title}」助教批完了 ${done.length} 份${flagged ? `，${flagged} 份要老师看` : ''}${failed ? `，${failed} 份没批成` : ''}`,
  );
}

/** 测试用：把排着的一份一份批完 */
export async function drainGrades() {
  for (;;) {
    const g = claim();
    if (!g) return;
    await work(g);
  }
}

/** 服务重启：批到一半的重新排上 */
export function recoverGrades() {
  db.run("UPDATE ai_grades SET status='queued', started_at=NULL WHERE status='running'");
  kick();
}

/** 一份作业正在批几份（排着的 + 正在批的） */
export const gradingCount = (assignmentId: number) =>
  db.value<number>("SELECT count(*) FROM ai_grades WHERE assignment_id=? AND status IN ('queued','running')", assignmentId) || 0;

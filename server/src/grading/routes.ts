/**
 * 助教批改、评分标准、讲评的接口（2026-11-16），挂在 /api/homework 下面。只有这个班的老师能用；学生看讲评走作业详情。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { audit, requireRole, type AppEnv } from '../auth.js';
import { db } from '../db/index.js';
import { bad, body, conflict, intParam } from '../lib/http.js';
import { assignmentFor, live, ownedClass, studentOf, submissionOf } from '../classes/homework.js';
import { insightsOf, writeInsights } from './insights.js';
import { gradeItems, noteChange, showNum, userName, type GradeItem, type SubmissionRow } from './common.js';
import { gradeAssignment } from './jobs.js';
import { releaseDrafts } from './grader.js';
import { draftRubric, rubricOf, setRubric } from './rubric.js';
import { reviewDocx, reviewOf, shareReview, writeReview } from './review.js';
import { similarPairs } from './similar.js';

export const gradingRoutes = new Hono<AppEnv>();

/* ---------------- 学情：一个班卡在哪（老师看） ---------------- */
gradingRoutes.get('/class/:id/insights', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const k = ownedClass(u, intParam(c));
  return c.json(insightsOf(k.id));
});
/** 让助教再看一遍（后台看，页面上转圈） */
gradingRoutes.post('/class/:id/insights', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const k = ownedClass(u, intParam(c));
  void writeInsights(k.id).catch((err) => console.error('[insights]', k.id, err));
  audit(c, 'class.insights', `class:${k.id}`);
  return c.json(insightsOf(k.id));
});

/* ---------------- 评分标准 ---------------- */

gradingRoutes.get('/:id/rubric', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a } = assignmentFor(u, intParam(c));
  return c.json({ rubric: rubricOf(a.id) });
});

gradingRoutes.put('/:id/rubric', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const d = await body(c, z.object({ items: z.array(z.object({ title: z.string(), points: z.number(), criteria: z.string(), answer: z.string() })).max(20) }));
  const items = setRubric(a.id, d.items);
  audit(c, 'homework.rubric', `homework:${a.id}`, { items: items.length });
  return c.json({ rubric: rubricOf(a.id) });
});

/** 让助教重拟（后台拟，页面上看到「助教在拟」） */
gradingRoutes.post('/:id/rubric/draft', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  void draftRubric(a.id, { force: true }).catch((err) => console.error('[rubric]', a.id, err));
  audit(c, 'homework.rubric.draft', `homework:${a.id}`);
  return c.json({ ok: true });
});

/* ---------------- 让助教批、发布 ---------------- */

/** 让助教批：没批的都批；redo 连助教批过的也重批（老师自己批过的不动）；sid 只批这一个学生 */
gradingRoutes.post('/:id/ai-grade', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const d = await body(c, z.object({ redo: z.boolean().optional(), sid: z.number().int().positive().optional() }));
  let userIds: number[] | undefined;
  if (d.sid) {
    const m = studentOf(a.class_id, d.sid);
    if (m.user_id === null) throw conflict('这个学生还没加入');
    userIds = [m.user_id];
  }
  const n = gradeAssignment(a.id, { redo: d.redo || !!d.sid, userIds });
  audit(c, 'homework.ai_grade', `homework:${a.id}`, { n, redo: !!d.redo });
  return c.json({ queued: n });
});

/** 批完先给老师看的：老师点「发布」，批好的一起发给学生（要老师看的除外） */
gradingRoutes.post('/:id/ai-release', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const n = releaseDrafts(a.id);
  audit(c, 'homework.ai_release', `homework:${a.id}`, { n });
  return c.json({ released: n });
});

/* ---------------- 同样的问题一起改 ---------------- */

/**
 * 老师改了一个学生某一项的分：找出这一项助教给了同样分数的其他学生（老师还没自己改过的），带上助教当时写的原因，让老师挑着一起改。
 */
gradingRoutes.get('/:id/same', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a } = assignmentFor(u, intParam(c));
  const sid = Number(c.req.query('sid')),
    item = Number(c.req.query('item')),
    from = Number(c.req.query('from'));
  if (!Number.isInteger(item) || item < 0 || !Number.isFinite(from)) throw bad('参数不对');
  const me = studentOf(a.class_id, sid);
  const subs = db.all<SubmissionRow & { csid: number; name: string }>(
    `SELECT s.*, m.id AS csid, m.name FROM submissions s JOIN class_students m ON m.class_id=? AND m.user_id=s.user_id
     WHERE s.assignment_id=? AND s.score IS NOT NULL AND s.graded_by='ai' AND m.id<>?`,
    a.class_id,
    a.id,
    me.id,
  );
  const list = subs
    .map((s) => ({ s, it: gradeItems(s.items)[item] }))
    .filter((x) => x.it && Math.abs(x.it.got - from) < 0.01)
    .map((x) => ({ sid: x.s.csid, name: x.s.name, got: x.it.got, max: x.it.max, why: x.it.why }));
  return c.json({ students: list });
});

/** 一起改：这几个学生的这一项都改成 got 分，总分跟着加；改过的算老师批的 */
gradingRoutes.post('/:id/same', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const d = await body(c, z.object({ item: z.number().int().min(0), got: z.number().min(0), why: z.string().max(1000).optional(), sids: z.array(z.number().int().positive()).min(1).max(500) }));
  let n = 0;
  db.tx(() => {
    for (const sid of d.sids) {
      const s = submissionOf(a, sid);
      const items = gradeItems(s.items);
      const it = items[d.item];
      if (!it || s.score === null) continue;
      const ai = gradeItems(s.ai_grade_id ? db.value<string>('SELECT items FROM ai_grades WHERE id=?', s.ai_grade_id) : null);
      const next: GradeItem[] = items.map((x, i) =>
        i === d.item ? noteChange({ ...x, got: Math.min(x.max, Math.round(d.got * 2) / 2), why: d.why?.trim() || x.why }, ai[i]?.got) : x,
      );
      const score = Math.round(next.reduce((m, x) => m + x.got, 0) * 10) / 10;
      db.update('submissions', s.id, { items: JSON.stringify(next), score, graded_by: 'teacher', graded_at: Date.now(), updated_at: Date.now() });
      n++;
    }
  });
  audit(c, 'homework.same_fix', `homework:${a.id}`, { item: d.item, got: d.got, n });
  return c.json({ changed: n });
});

/** 这个学生的作业和谁的很像（程序比的） */
gradingRoutes.get('/:id/students/:sid/similar', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a } = assignmentFor(u, intParam(c));
  const m = studentOf(a.class_id, intParam(c, 'sid'));
  if (m.user_id === null) return c.json({ similar: [] });
  const pairs = await similarPairs(a.id);
  const ids = new Map(db.all<{ id: number; user_id: number }>('SELECT id, user_id FROM class_students WHERE class_id=? AND user_id IS NOT NULL', a.class_id).map((x) => [x.user_id, x.id]));
  return c.json({
    similar: pairs
      .filter((p) => p.a === m.user_id || p.b === m.user_id)
      .map((p) => {
        const other = p.a === m.user_id ? p.b : p.a;
        return { sid: ids.get(other) ?? null, name: userName(other), ratio: p.ratio };
      }),
  });
});

/* ---------------- 讲评 ---------------- */

gradingRoutes.get('/:id/review', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  const graded = db.value<number>('SELECT count(*) FROM submissions WHERE assignment_id=? AND score IS NOT NULL', a.id) || 0;
  return c.json({ review: reviewOf(a.id), graded, title: a.title, className: k.name, classId: k.id, points: a.points });
});

/** 写（重写）讲评：后台写，页面上看到「助教在写」 */
gradingRoutes.post('/:id/review', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const graded = db.value<number>('SELECT count(*) FROM submissions WHERE assignment_id=? AND score IS NOT NULL', a.id) || 0;
  if (!graded) throw conflict('还没有批好的作业，批完再写讲评');
  void writeReview(a.id).catch((err) => console.error('[review]', a.id, err));
  audit(c, 'homework.review', `homework:${a.id}`);
  return c.json({ ok: true });
});

gradingRoutes.post('/:id/review/share', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a, k } = assignmentFor(u, intParam(c));
  live(k);
  const d = await body(c, z.object({ on: z.boolean() }));
  shareReview(a.id, d.on);
  audit(c, 'homework.review.share', `homework:${a.id}`, { on: d.on });
  return c.json({ ok: true });
});

gradingRoutes.get('/:id/review/docx', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const { a } = assignmentFor(u, intParam(c));
  const f = await reviewDocx(a.id);
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="review.docx"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    },
  });
});

export const scoreLine = (n: number | null, points: number) => (n === null ? '—' : `${showNum(n)}/${showNum(points)}`);

/**
 * 课堂的接口。老师：正在上的和上过的课、开课、上课时轮询、翻页、大屏放哪道题、推题、公布答案、随机点名、下课、删掉上过的；
 * 学生：自己班正在上的课、上课时轮询（打开就算到课）、作答、提问。
 * 老师只管得了自己的课，学生只看得到自己班的课；公布之前学生拿不到答案和别人的作答（lecture.ts 里拦）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { audit, me, requireRole, type AppEnv } from '../auth.js';
import { db, j, now } from '../db/index.js';
import { bad, body, conflict, intParam, rateLimit } from '../lib/http.js';
import {
  answer,
  ask,
  attend,
  call,
  endLecture,
  endStale,
  joinedLecture,
  lectureCard,
  liveOnly,
  materialOf,
  ownLecture,
  pushQuestion,
  questionIn,
  reveal,
  startLecture,
  studentState,
  teacherState,
  touch,
  type LectureRow,
} from './lecture.js';

export const classroomRoutes = new Hono<AppEnv>();

const OWN = 'SELECT l.* FROM lectures l JOIN classes c ON c.id=l.class_id AND c.deleted_at IS NULL WHERE l.teacher_id=? AND l.deleted_at IS NULL';

/** 老师的「课堂」页：正在上的放上面，下面是上过的（新的在前） */
classroomRoutes.get('/', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  endStale();
  const rows = db.all<LectureRow>(`${OWN} ORDER BY l.id DESC LIMIT 200`, u.id);
  return c.json({
    live: rows.filter((l) => l.status === 'live').map(lectureCard),
    past: rows.filter((l) => l.status === 'ended').map(lectureCard),
  });
});

/** 正在上的课：老师看自己的（侧栏、备课页的「上课」用），学生看自己班的（学伴页顶上的卡片） */
classroomRoutes.get('/live', (c) => {
  const u = me(c);
  endStale();
  if (u.role === 'student') {
    const rows = db.all<{ id: number; title: string; class_id: number; class_name: string; teacher: string; started_at: number }>(
      `SELECT l.id, l.title, l.class_id, c.name AS class_name, t.name AS teacher, l.started_at FROM lectures l
       JOIN classes c ON c.id=l.class_id AND c.deleted_at IS NULL JOIN users t ON t.id=l.teacher_id
       JOIN class_students s ON s.class_id=l.class_id AND s.user_id=?
       WHERE l.status='live' AND l.deleted_at IS NULL ORDER BY l.id DESC`,
      u.id,
    );
    return c.json({ live: rows.map((r) => ({ id: r.id, title: r.title, classId: r.class_id, className: r.class_name, teacher: r.teacher, startedAt: r.started_at })) });
  }
  requireRole(c, 'teacher', 'admin');
  return c.json({ live: db.all<LectureRow>(`${OWN} AND l.status='live' ORDER BY l.id DESC`, u.id).map(lectureCard) });
});

/** 开课：挑班，挑一节备好的课（不挑也行，只推题和点名） */
classroomRoutes.post('/', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const d = await body(
    c,
    z.object({
      classId: z.number().int().positive(),
      lessonId: z.number().int().positive().nullable().optional(),
      title: z.string().trim().max(80).nullable().optional(),
    }),
  );
  const id = startLecture(u.id, d.classId, d.lessonId ?? null, d.title ?? null);
  audit(c, 'lecture.start', `lecture:${id}`, { classId: d.classId, lessonId: d.lessonId ?? null });
  return c.json({ id });
});

/* ---------------- 老师上课 ---------------- */

/** 打开一堂课：头上的样子、课件（带讲稿）、课堂练习；下课了的带小结 */
classroomRoutes.get('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = ownLecture(u.id, intParam(c));
  const { deck, practice } = materialOf(l);
  return c.json({ lecture: lectureCard(l), deck, practice, summary: j(l.summary, null) });
});

/** 上课时轮询（约 1.5 秒一次）：到了谁、推了的题和作答、学生提的问题、最近一次点名、翻到哪页 */
classroomRoutes.get('/:id/state', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = ownLecture(u.id, intParam(c));
  touch(l);
  return c.json(teacherState(l));
});

/** 翻页：老师翻到哪页记下来（学生那边跟着这页；老师用手机翻，大屏上的页面也跟着翻） */
classroomRoutes.post('/:id/page', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = liveOnly(ownLecture(u.id, intParam(c)));
  const d = await body(c, z.object({ page: z.number().int().min(0).max(10_000) }));
  const { deck } = materialOf(l);
  const page = deck ? Math.min(d.page, deck.slides.length - 1) : 0;
  db.update('lectures', l.id, { page, updated_at: now() });
  return c.json({ page });
});

/** 大屏上放哪道题的作答（空着就放课件） */
classroomRoutes.post('/:id/screen', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = liveOnly(ownLecture(u.id, intParam(c)));
  const d = await body(c, z.object({ question: z.number().int().positive().nullable() }));
  if (d.question) questionIn(l, d.question);
  db.update('lectures', l.id, { screen: d.question, updated_at: now() });
  return c.json({ ok: true });
});

/** 推题：课堂练习里的一道（source 是题的 id）、课件上的小测（source 是 slide:页的 id），或者当堂出一道（question） */
classroomRoutes.post('/:id/questions', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = ownLecture(u.id, intParam(c));
  const d = await body(c, z.object({ source: z.string().trim().min(1).max(40).nullable().optional(), question: z.unknown().optional() }));
  if (!d.source && d.question === undefined) throw bad('推哪道题？');
  const id = pushQuestion(l, { source: d.source ?? null, question: d.question });
  audit(c, 'lecture.push', `lecture:${l.id}`, { question: id, source: d.source ?? null });
  return c.json({ id });
});

/** 公布答案：学生看到对错和解析，这道题不再收 */
classroomRoutes.post('/:id/questions/:qid/reveal', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = ownLecture(u.id, intParam(c));
  reveal(l, intParam(c, 'qid'));
  return c.json({ ok: true });
});

/** 随机点名：从进了课堂的学生里挑，一轮里不重复 */
classroomRoutes.post('/:id/call', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  return c.json(call(ownLecture(u.id, intParam(c))));
});

/** 下课：程序算小结存下来 */
classroomRoutes.post('/:id/end', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = ownLecture(u.id, intParam(c));
  endLecture(l);
  audit(c, 'lecture.end', `lecture:${l.id}`);
  const after = ownLecture(u.id, l.id);
  return c.json({ lecture: lectureCard(after), summary: j(after.summary, null) });
});

/** 删掉上过的一堂（只做记号）；在上的先下课 */
classroomRoutes.delete('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const l = ownLecture(u.id, intParam(c));
  if (l.status === 'live') throw conflict('这堂课还在上，先下课');
  db.update('lectures', l.id, { deleted_at: now() });
  audit(c, 'lecture.delete', `lecture:${l.id}`);
  return c.json({ ok: true });
});

/* ---------------- 学生上课 ---------------- */

/** 上课时轮询（约 2 秒一次）；打开就算到课 */
classroomRoutes.get('/:id/student', (c) => {
  const u = requireRole(c, 'student');
  const l = joinedLecture(u.id, intParam(c));
  attend(l, u.id);
  return c.json(studentState(l, u.id));
});

/** 作答：选择题交选项序号，别的交一段字（判断题交「对」「错」）；交了不能改 */
classroomRoutes.post('/:id/questions/:qid/answer', async (c) => {
  const u = requireRole(c, 'student');
  const l = joinedLecture(u.id, intParam(c));
  const d = await body(c, z.object({ choice: z.array(z.number().int()).max(10).optional(), text: z.string().max(6000).optional() }));
  return c.json(answer(l, u.id, intParam(c, 'qid'), d));
});

/** 提问：一句话发给老师 */
classroomRoutes.post('/:id/asks', async (c) => {
  const u = requireRole(c, 'student');
  const l = joinedLecture(u.id, intParam(c));
  rateLimit(`lecture-ask:${u.id}`, 12, 60_000);
  const d = await body(c, z.object({ text: z.string().max(1000) }));
  return c.json({ id: ask(l, u.id, d.text) });
});

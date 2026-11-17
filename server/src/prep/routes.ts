/**
 * 备课的接口（老师）：备过的课、开始备一节、看一节、在页面上改、跟助教说着改、撤回、重做一份、发作业到班里、下载 Word、删掉。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { audit, requireRole, type AppEnv } from '../auth.js';
import { db, j } from '../db/index.js';
import { bad, body, conflict, intParam } from '../lib/http.js';
import { callApi } from '../assistant/api.js';
import { weekLater } from '../assistant/time.js';
import { setRubric } from '../grading/rubric.js';
import {
  PARTS,
  cleanDeck,
  cleanPlan,
  cleanQuestions,
  homeworkBody,
  homeworkRubric,
  lessonDocx,
  lessonView,
  ownLesson,
  savePart,
  undoPart,
  type LessonRow,
  type Part,
  type Plan,
  type Question,
} from './lessons.js';
import { asksOf, isAsking, isMaking, redoLesson, startAsk, startLesson, stopLesson } from './make.js';

export const prepRoutes = new Hono<AppEnv>();

prepRoutes.get('/', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const cls = Number(c.req.query('class') || 0) || null;
  const rows = db.all<LessonRow>(
    `SELECT l.* FROM lessons l JOIN classes c ON c.id=l.class_id AND c.deleted_at IS NULL
     WHERE l.teacher_id=? AND l.deleted_at IS NULL ${cls ? 'AND l.class_id=?' : ''} ORDER BY l.id DESC LIMIT 100`,
    ...(cls ? [u.id, cls] : [u.id]),
  );
  return c.json({ lessons: rows.map((r) => ({ ...lessonView(r, false), making: isMaking(r.id) })) });
});

prepRoutes.post('/', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const d = await body(
    c,
    z.object({
      classId: z.number().int().positive(),
      request: z.string().trim().max(500).nullable().optional(),
      minutes: z.number().int().min(10).max(300).nullable().optional(),
    }),
  );
  const id = startLesson(u.id, d.classId, d.request ?? null, d.minutes ?? null);
  audit(c, 'prep.start', `class:${d.classId}`);
  return c.json({ id });
});

prepRoutes.get('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  return c.json({ lesson: { ...lessonView(r, true), making: isMaking(r.id), asking: isAsking(r.id), asks: asksOf(r.id) } });
});

/** 老师在页面上改了一份：整份存下（留一版，能撤回） */
prepRoutes.put('/:id/:part', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  const part = c.req.param('part') as Part;
  if (!PARTS.includes(part)) throw bad('没有这一份');
  if (isMaking(r.id)) throw conflict('这节课还在备，备好了再改');
  const d = await body(c, z.object({ data: z.unknown() }));
  let data: unknown;
  try {
    data =
      part === 'plan'
        ? cleanPlan(d.data)
        : part === 'deck'
          ? cleanDeck(d.data)
          : cleanQuestions(d.data, part === 'homework');
  } catch (err) {
    throw bad((err as Error).message);
  }
  savePart(r.id, part, data, 'teacher');
  return c.json({ ok: true, data });
});

prepRoutes.post('/:id/undo', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  const d = await body(c, z.object({ part: z.enum(['plan', 'deck', 'practice', 'homework']) }));
  if (isMaking(r.id) || isAsking(r.id)) throw conflict('助教还在改这节课');
  undoPart(r.id, d.part);
  return c.json({ ok: true });
});

/** 跟助教说要怎么改（后台改，页面上轮着看） */
prepRoutes.post('/:id/ask', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  const d = await body(
    c,
    z.object({
      message: z.string().trim().min(1).max(4000),
      focus: z
        .object({ part: z.string().max(20).optional(), page: z.number().int().positive().optional(), number: z.number().int().positive().optional() })
        .nullable()
        .optional(),
    }),
  );
  return c.json({ askId: startAsk(u.id, r.id, d.message, d.focus ?? null) });
});

/** 重做（或者补做）其中几份 */
prepRoutes.post('/:id/redo', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  const d = await body(c, z.object({ lanes: z.array(z.enum(['brief', 'plan', 'deck', 'questions', 'check'])).min(1) }));
  redoLesson(u.id, r.id, d.lanes);
  return c.json({ ok: true });
});

/** 课后作业发到班里：作业要求是题目，评分标准一题一项带参考答案，交上来助教照着批 */
prepRoutes.post('/:id/publish', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  const d = await body(c, z.object({ dueAt: z.number().int().positive().nullable().optional(), allowLate: z.boolean().optional() }));
  if (r.assignment_id && db.get('SELECT id FROM assignments WHERE id=? AND deleted_at IS NULL', r.assignment_id))
    throw conflict('这节课的作业已经发到班里了');
  const qs = j<Question[]>(r.homework, []);
  if (!qs.length) throw bad('还没有课后作业');
  const plan = j<Plan | null>(r.plan, null);
  const points = Math.round(qs.reduce((n, q) => n + (q.points ?? 10), 0) * 2) / 2;
  const res = await callApi<{ ids: number[] }>(u.id, 'POST', '/homework', {
    classIds: [r.class_id],
    title: `${plan?.title || r.title || '课后作业'} 课后作业`.slice(0, 120),
    body: homeworkBody(qs),
    points,
    dueAt: d.dueAt === undefined ? weekLater() : d.dueAt,
    allowLate: d.allowLate ?? true,
    publishAt: null,
    fileIds: [],
    aiMode: 'release',
  });
  const hid = res.ids[0];
  setRubric(hid, homeworkRubric(qs));
  db.update('lessons', r.id, { assignment_id: hid });
  audit(c, 'prep.publish', `homework:${hid}`);
  return c.json({ assignmentId: hid, classId: r.class_id });
});

prepRoutes.get('/:id/docx', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const f = await lessonDocx(ownLesson(u.id, intParam(c)));
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="lesson.docx"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    },
  });
});

prepRoutes.delete('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  stopLesson(r.id);
  db.update('lessons', r.id, { deleted_at: Date.now() });
  audit(c, 'prep.delete', `lesson:${r.id}`);
  return c.json({ ok: true });
});

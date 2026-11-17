/**
 * 备课的接口（老师）：备过的课、开始备一节（可以带文件）、看一节、看带的文件、在页面上改、跟助教说着改、撤回、重做一份、发作业到班里、下载 Word、删掉。
 */
import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { z } from 'zod';
import { audit, requireRole, type AppEnv } from '../auth.js';
import { db, j } from '../db/index.js';
import { bad, body, conflict, intParam, notFound } from '../lib/http.js';
import { callApi } from '../assistant/api.js';
import { weekLater } from '../assistant/time.js';
import { classRow } from '../grading/common.js';
import { setRubric } from '../grading/rubric.js';
import { landingKb } from '../kb/keeper.js';
import { createIntake } from '../kb/intake/service.js';
import { blobPath } from '../kb/intake/store.js';
import { MAX_FILES, checkFiles, intakeFiles } from './files.js';
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

/**
 * 开始备一节。带了文件的：先照交资料的路子登记进老师的知识库（整理助手后台整理成笔记，备课不等它），
 * 页面接着分块上传（返回 intake、uploads），这节课传完、读完再写教案。
 */
prepRoutes.post('/', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const d = await body(
    c,
    z.object({
      classId: z.number().int().positive(),
      request: z.string().trim().max(500).nullable().optional(),
      minutes: z.number().int().min(10).max(300).nullable().optional(),
      files: z
        .array(z.object({ name: z.string().min(1).max(1000), size: z.number().int().min(0) }))
        .max(MAX_FILES)
        .optional(),
    }),
  );
  const files = d.files ?? [];
  let intake: ReturnType<typeof createIntake> | null = null;
  if (files.length) {
    checkFiles(files);
    if (classRow(d.classId)?.teacher_id !== u.id) throw bad('这个班不在了');
    intake = createIntake(await landingKb(u.id), u, { files, route: true });
  }
  const id = startLesson(u.id, d.classId, d.request ?? null, d.minutes ?? null, intake?.intake.id ?? null);
  audit(c, 'prep.start', `class:${d.classId}`);
  return c.json({ id, ...(intake ? { intake: intake.intake, uploads: intake.uploads, chunkSize: intake.chunkSize } : {}) });
});

prepRoutes.get('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  return c.json({ lesson: { ...lessonView(r, true), making: isMaking(r.id), asking: isAsking(r.id), asks: asksOf(r.id) } });
});

const INLINE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
/** 这节课带的文件：原件，图片和 PDF 能直接打开看，别的下载 */
prepRoutes.get('/:id/files/:item', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  const f = intakeFiles(r.intake_id).find((i) => i.id === intParam(c, 'item'));
  if (!f?.hash || !existsSync(blobPath(f.hash))) throw notFound('这份文件不在了');
  const name = f.name.split('/').pop() || f.name;
  const type = INLINE[name.split('.').pop()?.toLowerCase() || ''];
  const inline = !!type && c.req.query('inline') === '1';
  return new Response(new Uint8Array(readFileSync(blobPath(f.hash))), {
    headers: {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
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

/** 跟助教说要怎么改（后台改，页面上轮着看）；可以带先传上来的文件 */
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
      fileIds: z.array(z.number().int().positive()).max(MAX_FILES).optional(),
    }),
  );
  return c.json({ askId: startAsk(u.id, r.id, d.message, d.focus ?? null, d.fileIds ?? []) });
});

/** 重做（或者补做）其中几份 */
prepRoutes.post('/:id/redo', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const r = ownLesson(u.id, intParam(c));
  const d = await body(c, z.object({ lanes: z.array(z.enum(['read', 'brief', 'plan', 'deck', 'questions', 'check'])).min(1) }));
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

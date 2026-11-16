/**
 * 学生的 CoT 学伴。
 * 学生跟它说话，问作业、截止、分数、课上的知识。它看的是各个班的资料包（老师的助教整理的）和学生自己的作业分数；
 * 资料包里没有、拿不准、要老师拍板的，去问助教（helper），助教要老师定就在老师那边弹卡片。
 * 跟老师的助教一样：每一轮记在 kb_runs（agent='stu'，teacher_id 是学生自己），跟模型说的话只往后加，会话可以开新的。
 */
import { db, getSetting, j, now } from '../db/index.js';
import { gradeItems, gradeMarks } from '../grading/common.js';
import { bad, conflict, HttpError, notFound } from '../lib/http.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { publish, record, type RunRef } from '../kb/agent/events.js';
import { publishRun } from '../kb/keeper.js';
import { askHelper, studentSession, stuKey } from './bridge.js';
import { modelStep } from './model.js';
import { takeNotes } from './notes.js';
import { classFiles, renderPack, teacherTitle } from './pack.js';
import { nowLine, showTime } from './time.js';
import { append, compact, dangling, requestMessages } from './thread.js';

export const BUDDY_NAME = 'CoT 学伴';
const MAX_STEPS = 10;

export const buddyPrompt = `你是学生的 CoT 学伴。学生问作业、截止、分数、课上的知识，你来回答。

下面是学生所在各个班的资料包，是老师的助教整理的。跟这门课有关的事（老师的资料、作业要求、规矩、通知）只按资料包和工具查到的说；资料包里没有、拿不准的，用 ask_ta 问助教，不要自己编。
学生要老师拍板的事（晚交、对分数有意见、请假、找老师）也用 ask_ta。
作业不代写，也不直接给答案（资料包的规矩里老师说了可以才给），可以讲思路和知识点，课上没讲到的知识点也照样讲。
跟学生说话先说结论，简短。`;

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

export const BUDDY_TOOLS: ToolSpec[] = [
  {
    name: 'my_homework',
    description: '查学生自己的作业：交了没有、交的什么、分数和评语。不传 homework 是列出各个班的作业。',
    parameters: obj({ homework: str('作业标题'), class: str('哪个班的；同名作业在几个班里时才填') }),
  },
  {
    name: 'send_file',
    description: '把资料包里「能发给学生的文件」或者作业的附件发给学生，学生那边是一张能下载的文件卡片。',
    parameters: obj({ name: str('文件名'), class: str('哪个班的资料包；学生只在一个班里时不用填') }, ['name']),
  },
  {
    name: 'ask_ta',
    description: '问老师的助教：资料包里没有、拿不准的，要老师拍板的。助教会翻老师的资料回答，或者去问老师。',
    parameters: obj({ question: str('要问的事，写清楚是哪份作业、哪一章、学生想要什么'), class: str('哪个班的事；学生只在一个班里时不用填') }, ['question']),
  },
];

/* ---------------- 学生的班和作业 ---------------- */

interface MyClass {
  id: number;
  name: string;
  teacher: string;
  teacher_id: number;
  archived_at: number | null;
}
export const myClasses = (studentId: number) =>
  db.all<MyClass>(
    `SELECT c.id, c.name, u.name AS teacher, c.teacher_id, c.archived_at FROM classes c JOIN class_students s ON s.class_id=c.id AND s.user_id=?
     JOIN users u ON u.id=c.teacher_id WHERE c.deleted_at IS NULL ORDER BY c.id`,
    studentId,
  );

const norm = (s: string) =>
  String(s ?? '')
    .replace(/[\s「」『』《》"'“”‘’]/g, '')
    .toLowerCase();
function pickClass(classes: MyClass[], ref: unknown): MyClass {
  const q = norm(String(ref ?? ''));
  if (!q) {
    if (classes.length === 1) return classes[0];
    throw bad(`学生在好几个班：${classes.map((k) => `「${k.name}」`).join('、')}，说是哪个班的`);
  }
  const hit = classes.filter((k) => norm(k.name) === q);
  const loose = hit.length ? hit : classes.filter((k) => norm(k.name).includes(q) || q.includes(norm(k.name)));
  if (loose.length === 1) return loose[0];
  throw bad(`${loose.length ? '对得上好几个班' : `学生不在「${ref}」`}。学生的班：${classes.map((k) => `「${k.name}」`).join('、') || '还没有'}`);
}

interface HwRow {
  id: number;
  class_id: number;
  title: string;
  body: string;
  points: number;
  due_at: number | null;
  allow_late: number;
  publish_at: number;
}
interface SubRow {
  id: number;
  text: string;
  submitted_at: number;
  late: number;
  score: number | null;
  comment: string | null;
  graded_at: number | null;
  returned_at: number | null;
  graded_by: 'ai' | 'teacher' | null;
  items: string | null;
  ai_grade_id: number | null;
}
const score = (n: number) => String(Math.round(n * 10) / 10);

/** 批过的作业：谁批的、每项得分和原因、批注（学生问「我哪里错了」时用；参考答案不在这里面） */
function gradedLines(s: SubRow): string[] {
  if (s.score === null || (s.returned_at && s.returned_at >= s.submitted_at)) return [];
  const items = gradeItems(s.items);
  const marks = s.ai_grade_id ? gradeMarks(db.value<string>('SELECT marks FROM ai_grades WHERE id=?', s.ai_grade_id)) : [];
  return [
    `批改：${s.graded_by === 'ai' ? 'CoT 助教批的（老师可以改）' : '老师批的'}`,
    ...items.map((x) => `- ${x.title} ${score(x.got)}/${score(x.max)}：${x.why}`),
    ...(marks.length ? ['批注：', ...marks.map((m) => `- ${m.kind === 'good' ? '写得好' : '有问题'}「${m.quote.slice(0, 120)}」：${m.note}`)] : []),
  ];
}

function homeworkOf(classIds: number[]): HwRow[] {
  if (!classIds.length) return [];
  return db.all<HwRow>(
    `SELECT id, class_id, title, body, points, due_at, allow_late, publish_at FROM assignments WHERE class_id IN (${classIds.map(() => '?').join(',')})
     AND deleted_at IS NULL AND publish_at<=? ORDER BY publish_at, id`,
    ...classIds,
    now(),
  );
}
/** 交的情况，一句话 */
function stateOf(h: HwRow, s: SubRow | undefined, t: number) {
  if (s?.returned_at && s.returned_at >= s.submitted_at) return '老师退回了，要重交';
  if (s) {
    const when = `${showTime(s.submitted_at)} 交的${s.late ? '（迟交）' : ''}`;
    if (s.score !== null) return `${when}，${score(s.score)} 分（满分 ${score(h.points)}）${s.comment ? `，评语：${s.comment}` : ''}`;
    return `${when}，${s.comment ? `还没打分，评语：${s.comment}` : '老师还没批'}`;
  }
  if (h.due_at && h.due_at < t) return h.allow_late ? '没交，已经过了截止（现在交算迟交）' : '没交，已经截止，不收了';
  return '还没交';
}

/** 每轮带给学伴的：还没交的作业 */
function todoLines(studentId: number, classes: MyClass[]) {
  const t = now();
  const names = new Map(classes.map((k) => [k.id, k.name]));
  return homeworkOf(classes.filter((k) => !k.archived_at).map((k) => k.id))
    .map((h) => ({ h, s: db.get<SubRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', h.id, studentId) }))
    .filter(({ h, s }) => (!s || (s.returned_at && s.returned_at >= s.submitted_at)) && (!h.due_at || h.due_at >= t || h.allow_late))
    .slice(-10)
    .map(({ h, s }) => `「${h.title}」（${names.get(h.class_id)}，${h.due_at ? `截止 ${showTime(h.due_at)}${h.due_at < t ? '，已过截止' : ''}` : '不设截止'}${s ? '，退回要重交' : ''}）`);
}

/* ---------------- 工具 ---------------- */

interface Ctx {
  student: { id: number; name: string };
  ref: RunRef;
  session: number;
  signal: AbortSignal;
  /** 这一轮说到了哪些班（老师只看得到说自己班的那几轮） */
  touched: Set<number>;
}

const tool = (ref: RunRef, name: string, label: string, text: string) => record(ref, 'tool', { name, label, text });

async function runTool(ctx: Ctx, call: ToolCall): Promise<string> {
  const a = call.args || {};
  const classes = myClasses(ctx.student.id);
  try {
    switch (call.name) {
      case 'my_homework': {
        const t = now();
        const only = a.class ? [pickClass(classes, a.class)] : classes;
        const names = new Map(classes.map((k) => [k.id, k.name]));
        const rows = homeworkOf(only.map((k) => k.id));
        const want = norm(String(a.homework ?? ''));
        if (!want) {
          tool(ctx.ref, 'stu_look', '查看', '作业');
          only.forEach((k) => ctx.touched.add(k.id));
          if (!rows.length) return '还没有发布的作业';
          return rows
            .map((h) => {
              const s = db.get<SubRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', h.id, ctx.student.id);
              return `「${h.title}」（${names.get(h.class_id)}，${h.due_at ? `截止 ${showTime(h.due_at)}` : '不设截止'}）：${stateOf(h, s, t)}`;
            })
            .join('\n');
        }
        let hit = rows.filter((h) => norm(h.title) === want);
        if (!hit.length) hit = rows.filter((h) => norm(h.title).includes(want) || want.includes(norm(h.title)));
        if (!hit.length) throw bad(`没有对得上「${a.homework}」的作业。现在的作业：${rows.map((h) => `「${h.title}」`).join('、') || '没有'}`);
        if (hit.length > 1) throw bad(`对得上好几份：${hit.map((h) => `「${h.title}」（${names.get(h.class_id)}）`).join('、')}，说是哪个班的`);
        const h = hit[0];
        ctx.touched.add(h.class_id);
        tool(ctx.ref, 'stu_look', '查看', `「${h.title}」`);
        const s = db.get<SubRow>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', h.id, ctx.student.id);
        const files = db.all<{ name: string }>('SELECT name FROM homework_files WHERE assignment_id=? ORDER BY id', h.id).map((f) => f.name);
        const mine = s ? db.all<{ name: string }>('SELECT name FROM homework_files WHERE submission_id=? ORDER BY id', s.id).map((f) => f.name) : [];
        return [
          `「${h.title}」（${names.get(h.class_id)}，满分 ${score(h.points)}，${h.due_at ? `截止 ${showTime(h.due_at)}` : '不设截止'}${h.due_at ? (h.allow_late ? '，截止后还能交（算迟交）' : '，截止后不收') : ''}）`,
          h.body.trim() ? `要求：${h.body.trim().slice(0, 3000)}` : '',
          files.length ? `附件：${files.join('、')}` : '',
          `学生的情况：${stateOf(h, s, t)}`,
          ...(s ? gradedLines(s) : []),
          s?.text?.trim() ? `学生交的文字：${s.text.trim().slice(0, 2000)}` : '',
          mine.length ? `学生交的附件：${mine.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      case 'send_file': {
        const name = norm(String(a.name ?? ''));
        if (!name) throw bad('发哪份没说');
        const scope = a.class ? [pickClass(classes, a.class)] : classes;
        const names = new Map(classes.map((k) => [k.id, k.name]));
        // 资料包里放着的文件，和作业的附件（作业页上本来就能下载；2026-11-16 试跑：学伴发不出作业附件，就去问了老师）
        const pool = [
          ...scope.flatMap((k) => classFiles(k.id).map((f) => ({ id: f.id, hw: false, name: f.name, note: f.note, classId: k.id }))),
          ...homeworkOf(scope.map((k) => k.id)).flatMap((h) =>
            db
              .all<{ id: number; name: string }>('SELECT id, name FROM homework_files WHERE assignment_id=? ORDER BY id', h.id)
              .map((f) => ({ id: f.id, hw: true, name: f.name, note: `「${h.title}」的附件`, classId: h.class_id })),
          ),
        ];
        const hit = pool.filter((f) => norm(f.name) === name);
        const loose = hit.length ? hit : pool.filter((f) => norm(f.name).includes(name) || name.includes(norm(f.name)));
        if (!loose.length) throw bad(`没有「${a.name}」能发。${pool.length ? `能发的：${pool.map((f) => `「${f.name}」`).join('、')}` : '现在没有能发的文件'}；要别的问助教`);
        const f = loose[0];
        ctx.touched.add(f.classId);
        record(ctx.ref, 'file', { ...(f.hw ? { hwFileId: f.id } : { fileId: f.id }), name: f.name, note: f.note, className: names.get(f.classId) });
        return `发给学生了「${f.name}」`;
      }
      case 'ask_ta': {
        const k = pickClass(
          classes.filter((x) => !x.archived_at),
          a.class,
        );
        ctx.touched.add(k.id);
        tool(ctx.ref, 'stu_ask', '问助教', String(a.question ?? '').slice(0, 60));
        return await askHelper({
          studentId: ctx.student.id,
          classId: k.id,
          question: String(a.question ?? ''),
          stuRunId: ctx.ref.runId,
          session: ctx.session,
          signal: ctx.signal,
        });
      }
      default:
        return `没有「${call.name}」这个工具`;
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const msg = (err as Error).message || '没办成';
    if (!(err instanceof Error) || !('status' in err)) console.error('[stu] tool', call.name, err);
    return `没办成：${msg}`;
  }
}

/* ---------------- 会话 ---------------- */

export function newStuSession(studentId: number): number {
  if (busy.has(studentId)) throw conflict('CoT 学伴正在回上一句，等它说完');
  const last = db.value<number>('SELECT max(id) FROM ta_sessions WHERE owner_id=?', studentId);
  if (last && !db.get("SELECT id FROM kb_runs WHERE session_id=? AND agent='stu' LIMIT 1", last)) return last;
  return db.insert('ta_sessions', { owner_id: studentId, created_at: now() });
}
export function stuSessions(studentId: number) {
  return db
    .all<{ session: number; first: string | null; at: number; last: number }>(
      `SELECT session_id AS session, (SELECT request FROM kb_runs r2 WHERE r2.teacher_id=r.teacher_id AND r2.agent='stu' AND r2.kind='chat' AND r2.session_id=r.session_id ORDER BY r2.id LIMIT 1) AS first,
         min(created_at) AS at, max(created_at) AS last
       FROM kb_runs r WHERE teacher_id=? AND agent='stu' AND session_id IS NOT NULL GROUP BY session_id ORDER BY last DESC`,
      studentId,
    )
    .map((s) => ({ id: s.session, title: String(s.first || '老师的消息').replace(/\s+/g, ' ').slice(0, 40), createdAt: s.at, updatedAt: s.last }));
}
export function ownStuSession(studentId: number, session: number | null | undefined): number {
  if (!session) return studentSession(studentId);
  if (!db.get('SELECT id FROM ta_sessions WHERE id=? AND owner_id=?', session, studentId)) throw notFound('没有这段会话');
  return session;
}

/* ---------------- 每一轮 ---------------- */

const busy = new Map<number, { runId: number; ctrl: AbortController }>();
export const stuBusy = (studentId: number) => busy.get(studentId) ?? null;

/** 每个学生每天最多说几句（花的是老师那边同一把模型钥匙），设置 stu_daily_turns 可改，0 不限 */
function checkQuota(studentId: number) {
  const limit = getSetting<number>('stu_daily_turns', 50);
  if (!limit) return;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const used = db.value<number>("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND agent='stu' AND kind='chat' AND created_at>=?", studentId, since.getTime()) || 0;
  if (used >= limit) throw new HttpError(429, `今天已经问了 ${limit} 句，明天再来`, 'rate_limited');
}

export function startStuTurn(student: { id: number; name: string }, o: { message: string; session?: number | null }): number {
  if (busy.has(student.id)) throw conflict('CoT 学伴正在回上一句，等它说完');
  const message = o.message.trim();
  if (!message) throw bad('写点什么');
  checkQuota(student.id);
  const session = ownStuSession(student.id, o.session);
  const runId = db.insert('kb_runs', {
    teacher_id: student.id,
    agent: 'stu',
    kind: 'chat',
    status: 'running',
    request: message.slice(0, 4000),
    session_id: session,
    created_by: student.id,
    created_at: now(),
  });
  const ctrl = new AbortController();
  busy.set(student.id, { runId, ctrl });
  const ref: RunRef = { teacherId: student.id, runId, kbId: null };
  const touched = new Set<number>();
  publishRun(null, runId);
  void execute(student, ref, { message: message.slice(0, 4000), session, signal: ctrl.signal, touched })
    .then(() => db.update('kb_runs', runId, { status: 'done', error: null, finished_at: now() }))
    .catch((err) => {
      const stopped = ctrl.signal.aborted;
      const msg = stopped ? null : (err as Error).message || 'CoT 学伴没能回完';
      if (!stopped) {
        console.error('[stu] turn', runId, err);
        record(ref, 'error', { message: msg });
      }
      db.update('kb_runs', runId, { status: stopped ? 'canceled' : 'error', error: msg, finished_at: now() });
    })
    .finally(() => {
      if (touched.size) db.update('kb_runs', runId, { class_ids: JSON.stringify([...touched]) });
      if (busy.get(student.id)?.runId === runId) busy.delete(student.id);
      publishRun(null, runId);
    });
  return runId;
}

export function cancelStuRun(studentId: number, runId: number) {
  const b = busy.get(studentId);
  if (b && b.runId === runId) b.ctrl.abort(new Error('已停止'));
}

/** 发给学伴的说明：说明（不变）+ 学生各个班的资料包（班里有了新东西才变） */
function system(classes: MyClass[]) {
  const packs = classes.map((k) => renderPack(k.id)).filter(Boolean);
  return `${buddyPrompt}\n\n${packs.length ? packs.join('\n\n') : '学生还没有加入班级。'}`;
}

async function execute(student: { id: number; name: string }, ref: RunRef, o: { message: string; session: number; signal: AbortSignal; touched: Set<number> }) {
  const key = stuKey(o.session);
  for (const call of dangling(student.id, key)) append(student.id, key, ref.runId, { role: 'tool', toolCallId: call.id, content: '（没有回音）' });
  await compact({
    ownerId: student.id,
    key,
    signal: o.signal,
    who: { user: '学生', agent: '学伴' },
    instruction: '把学生和学伴之前的对话压成一段要点，给学伴接着用：学生在学什么、卡在哪、问过助教什么、还在等老师回的事。',
    agentKey: 'stu',
    purpose: 'stu:compact',
  }).catch((err) => console.error('[stu] compact', err));
  const classes = myClasses(student.id);
  // 每轮带「还没交的作业」（v4 试过不带：顺手提作业的没少，回话短了一点，还冒出一句偷懒的回答，没采用）
  const todo = todoLines(student.id, classes);
  const head = [
    `现在是 ${nowLine()}`,
    `学生是${student.name}，在${classes.length ? classes.map((k) => `「${k.name}」（${teacherTitle(k.teacher)}${k.archived_at ? '，已归档' : ''}）`).join('、') : '还没有加入班级'}`,
    todo.length ? `还没交的作业：${todo.join('、')}` : '',
  ].filter(Boolean);
  const notes = takeNotes(student.id, key);
  const block = [`（${head.join('。')}）`, ...(notes.length ? [`（这期间收到的：${notes.join('；')}）`] : [])].join('\n');
  append(student.id, key, ref.runId, { role: 'user', content: `${block}\n${o.message}` });
  const ctx: Ctx = { student, ref, session: o.session, signal: o.signal, touched: o.touched };
  for (let n = 0; n < MAX_STEPS; n++) {
    o.signal.throwIfAborted();
    const r = await modelStep({
      agent: 'stu',
      messages: requestMessages(student.id, key, system(classes)),
      tools: BUDDY_TOOLS,
      userId: student.id,
      signal: o.signal,
      onText: (text) => publish(ref, 'delta', { runId: ref.runId, text }),
    });
    o.signal.throwIfAborted();
    append(student.id, key, ref.runId, {
      role: 'assistant',
      content: r.text,
      ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
      ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    });
    if (!r.toolCalls.length) {
      db.update('kb_runs', ref.runId, { reply: r.text.trim() || null });
      return;
    }
    if (r.text.trim()) record(ref, 'say', { text: r.text.trim() });
    for (const call of r.toolCalls) {
      const out = await runTool(ctx, call);
      append(student.id, key, ref.runId, { role: 'tool', toolCallId: call.id, content: out });
    }
  }
  db.update('kb_runs', ref.runId, { reply: '这件事步骤太多，做到一半停下了，可以接着跟我说' });
}

/* ---------------- 给页面的 ---------------- */

export function stuRun(r: any) {
  return {
    id: r.id,
    kind: r.kind as string,
    status: r.status as string,
    request: r.request as string,
    reply: r.reply as string | null,
    error: r.error as string | null,
    classIds: j<number[]>(r.class_ids, []),
    createdAt: r.created_at as number,
    finishedAt: r.finished_at as number | null,
    events: db.all<any>('SELECT * FROM kb_events WHERE run_id=? ORDER BY id', r.id).map((e) => ({ id: e.id, type: e.type, data: j(e.data, {}), createdAt: e.created_at })),
  };
}

/**
 * 老师看一个学生跟学伴说的：说到这位老师的班的那几轮；学生的班全是这位老师的，就都能看（2026-11-16：学生可能还有别的老师）。
 */
export function runsSeenBy(teacherId: number, studentId: number) {
  const classes = myClasses(studentId);
  const mine = new Set(classes.filter((k) => k.teacher_id === teacherId).map((k) => k.id));
  if (!mine.size) return [];
  const all = classes.every((k) => k.teacher_id === teacherId);
  return db
    .all<any>("SELECT * FROM kb_runs WHERE teacher_id=? AND agent='stu' ORDER BY id DESC LIMIT 300", studentId)
    .reverse()
    .filter((r) => all || j<number[]>(r.class_ids, []).some((id) => mine.has(id)))
    .map(stuRun);
}

export function recoverStuRuns() {
  db.run("UPDATE kb_runs SET status='error', error='服务中断，这句没回完，可以再说一遍', finished_at=? WHERE agent IN ('stu','helper') AND status='running'", now());
}

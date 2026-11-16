/**
 * 学伴、助教、老师之间传话。
 * 学伴拿不准 → 问助教（helper 回）；助教要老师拍板 → 老师的对话里弹一张卡片；老师答了 → 助教转告学生，送进学生的对话。
 * 老师让助教通知学生 → 也送进学生的对话。送进去的话学伴下一轮会知道（记在它那段对话的消息里）。
 */
import { db, j, now } from '../db/index.js';
import { bad } from '../lib/http.js';
import { record } from '../kb/agent/events.js';
import { publishRun } from '../kb/keeper.js';
import { addNote } from './notes.js';
import { runHelper } from './helper.js';
import { putPack, teacherTitle } from './pack.js';

export const STU_THREAD = 'stu';
/** 学生和学伴的一段会话跟模型说的话记在哪 */
export const stuKey = (session: number | null) => (session ? `${STU_THREAD}:${session}` : STU_THREAD);

/** 学生现在这段会话：最近开的；一段都没有就开一段 */
export function studentSession(studentId: number): number {
  const last = db.value<number>('SELECT max(id) FROM ta_sessions WHERE owner_id=?', studentId);
  return last ?? db.insert('ta_sessions', { owner_id: studentId, created_at: now() });
}

/** 学生来问的卡片上带的：谁问的、哪个班、问的什么、助教拟的回复；classId、sid（班里名单那一行）让老师点开他跟学伴的对话 */
export interface StudentAskCard {
  askId: number;
  student: string;
  className: string;
  classId?: number;
  sid?: number;
  question: string;
  draft: string;
}

interface AskRow {
  id: number;
  student_id: number;
  class_id: number;
  teacher_id: number;
  stu_run_id: number | null;
  stu_session: number | null;
  question: string;
  answer: string | null;
  status: string;
  card_run_id: number | null;
  reply: string | null;
  created_at: number;
}

const classOf = (classId: number) =>
  db.get<{ id: number; name: string; teacher_id: number; teacher: string }>(
    'SELECT c.id, c.name, c.teacher_id, u.name AS teacher FROM classes c JOIN users u ON u.id=c.teacher_id WHERE c.id=? AND c.deleted_at IS NULL',
    classId,
  );
/** 学生在这个班里叫什么（名单上的名字） */
const nameIn = (classId: number, studentId: number) =>
  db.value<string>('SELECT name FROM class_students WHERE class_id=? AND user_id=?', classId, studentId) ||
  db.value<string>('SELECT name FROM users WHERE id=?', studentId) ||
  '学生';

/* ---------------- 送进学生的对话 ---------------- */

/**
 * 送一段话进学生的对话：页面上是一条从老师那边来的消息（不是学伴说的），学伴下一轮也知道。
 * session 不传就送进学生现在这段会话。
 */
export function deliver(studentId: number, o: { classId: number; text: string; kind: 'reply' | 'notice'; session?: number | null; question?: string }) {
  const k = classOf(o.classId);
  if (!k) return null;
  const session = o.session ?? studentSession(studentId);
  const t = now();
  const runId = db.insert('kb_runs', {
    teacher_id: studentId,
    agent: 'stu',
    kind: 'notice',
    status: 'done',
    request: '',
    reply: o.text,
    session_id: session,
    class_ids: JSON.stringify([o.classId]),
    created_by: k.teacher_id,
    created_at: t,
    finished_at: t,
  });
  record({ teacherId: studentId, runId, kbId: null }, 'notice', {
    kind: o.kind,
    teacher: k.teacher,
    className: k.name,
    ...(o.question ? { question: o.question } : {}),
  });
  addNote(
    studentId,
    o.kind === 'reply'
      ? `${k.name}的${teacherTitle(k.teacher)}回复了你之前问的「${o.question || ''}」：${o.text}`
      : `${k.name}的${teacherTitle(k.teacher)}发了通知：${o.text}`,
    stuKey(session),
  );
  publishRun(null, runId);
  return runId;
}

/* ---------------- 学伴问助教 ---------------- */

/**
 * 学伴拿不准来问助教：助教翻资料回答；要老师拍板就在老师那边弹卡片，返回给学伴的话说已经问了老师。
 * 返回给学伴看的那段话。
 */
export async function askHelper(o: { studentId: number; classId: number; question: string; stuRunId: number | null; session: number | null; signal?: AbortSignal }): Promise<string> {
  const k = classOf(o.classId);
  if (!k) throw bad('这个班不在了');
  const student = nameIn(o.classId, o.studentId);
  const question = o.question.trim().slice(0, 2000);
  if (!question) throw bad('要问什么没写');
  const askId = db.insert('student_asks', {
    student_id: o.studentId,
    class_id: o.classId,
    teacher_id: k.teacher_id,
    stu_run_id: o.stuRunId,
    stu_session: o.session,
    question,
    status: 'thinking',
    created_at: now(),
  });
  try {
    const r = await runHelper({
      teacherId: k.teacher_id,
      classId: o.classId,
      mode: 'answer',
      request: `${student}的学伴来问：${question}`,
      task: `「${k.name}」的学生${student}的学伴来问：\n${question}`,
      signal: o.signal,
    });
    if (r.escalation) {
      // 拟的回复只给老师看：学伴看到了容易当成老师已经答应
      escalate(askId, r.escalation);
      return '这件事要老师定，助教已经帮学生问了老师。老师回了会直接送到学生这里。';
    }
    db.update('student_asks', askId, { status: 'answered', answer: r.text, helper_run_id: r.runId, answered_at: now() });
    return r.text || '助教没有找到能回答的资料';
  } catch (err) {
    db.update('student_asks', askId, { status: 'error', answer: (err as Error).message || null });
    throw err;
  }
}

/** 助教要老师拍板：老师现在那段会话里弹一张卡片，一直等老师回（老师说别的也不收起来） */
function escalate(askId: number, e: { question: string; options: string[]; draft: string }) {
  const ask = db.get<AskRow>('SELECT * FROM student_asks WHERE id=?', askId)!;
  const k = classOf(ask.class_id)!;
  const student = nameIn(ask.class_id, ask.student_id);
  // 学生说的同一句话里已经给这位老师弹过卡片（学生在这位老师的两个班里，学伴每个班问了一次）：并进那张，不再弹第二张
  const same = ask.stu_run_id
    ? db.get<AskRow>(
        "SELECT a.* FROM student_asks a JOIN kb_runs r ON r.id=a.card_run_id WHERE a.stu_run_id=? AND a.teacher_id=? AND a.status='teacher' AND r.status='waiting' AND a.id<>? ORDER BY a.id LIMIT 1",
        ask.stu_run_id,
        ask.teacher_id,
        askId,
      )
    : undefined;
  if (same?.card_run_id) {
    const ev = db.get<{ id: number; data: string }>("SELECT id, data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", same.card_run_id);
    if (ev) {
      const data = j<{ questions: { question: string; options: string[] }[] }>(ev.data, { questions: [] });
      if (data.questions[0] && e.question && !data.questions[0].question.includes(e.question))
        data.questions[0].question += `\n另外（${k.name}）：${e.question}`;
      db.update('kb_events', ev.id, { data });
    }
    db.update('student_asks', askId, { status: 'merged', card_run_id: same.card_run_id, answered_at: now() });
    publishRun(null, same.card_run_id);
    return;
  }
  const session = db.value<number>('SELECT max(id) FROM ta_sessions WHERE owner_id=?', k.teacher_id) ?? null;
  const t = now();
  const runId = db.insert('kb_runs', {
    teacher_id: k.teacher_id,
    agent: 'ta',
    kind: 'student_ask',
    status: 'waiting',
    request: '',
    session_id: session,
    class_ids: JSON.stringify([k.id]),
    created_by: ask.student_id,
    created_at: t,
  });
  const sid = db.value<number>('SELECT id FROM class_students WHERE class_id=? AND user_id=?', ask.class_id, ask.student_id) ?? undefined;
  const card: StudentAskCard = { askId, student, className: k.name, classId: k.id, sid, question: e.question || ask.question, draft: e.draft };
  record({ teacherId: k.teacher_id, runId, kbId: null }, 'ask', {
    toolCallId: '',
    questions: [{ question: card.question, options: e.options.length ? e.options : ['可以', '不行'], multiple: false }],
    answered: null,
    from: card,
  });
  db.update('student_asks', askId, { status: 'teacher', card_run_id: runId, answered_at: t });
  publishRun(null, runId);
}

/**
 * 重写一张还在等老师回的学生来问卡片：学伴转来的那句话再交给助教，换上它这回写的问老师的话和选项。
 * 演示班重来时用（2026-11-16 卡片改短以后，老卡片还是又长又带拟回复）。助教这回不转老师了就不动。
 */
export async function rewriteCard(askId: number): Promise<boolean> {
  const ask = db.get<AskRow>('SELECT * FROM student_asks WHERE id=?', askId);
  if (!ask || ask.status !== 'teacher' || !ask.card_run_id) return false;
  const k = classOf(ask.class_id);
  if (!k) return false;
  const student = nameIn(ask.class_id, ask.student_id);
  const r = await runHelper({
    teacherId: k.teacher_id,
    classId: ask.class_id,
    mode: 'answer',
    request: `${student}的学伴来问：${ask.question}`,
    task: `「${k.name}」的学生${student}的学伴来问：
${ask.question}`,
  });
  if (!r.escalation) return false;
  const ev = db.get<{ id: number; data: string }>("SELECT id, data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", ask.card_run_id);
  if (!ev) return false;
  const data = j<{ questions: { question: string; options: string[]; multiple?: boolean }[]; from?: StudentAskCard }>(ev.data, { questions: [] });
  const question = r.escalation.question || ask.question;
  const sid = db.value<number>('SELECT id FROM class_students WHERE class_id=? AND user_id=?', ask.class_id, ask.student_id) ?? undefined;
  data.questions = [{ question, options: r.escalation.options.length ? r.escalation.options : ['可以', '不行'], multiple: false }];
  data.from = { askId: ask.id, student, className: k.name, classId: k.id, sid, question, draft: r.escalation.draft };
  db.update('kb_events', ev.id, { data });
  publishRun(null, ask.card_run_id);
  return true;
}

/** 学生自己是怎么问的（卡片上引他的原话；学伴转述给助教的是第三人称，学生看着别扭） */
const askedAs = (ask: AskRow) => (ask.stu_run_id ? db.value<string>('SELECT request FROM kb_runs WHERE id=?', ask.stu_run_id) : null) || ask.question;

/** 老师还没回的学生来问：每轮带给助教，老师在对话里直接说「张浩然那个可以」它也知道是哪件 */
export function pendingAsksLine(teacherId: number): string | null {
  const rows = db.all<AskRow & { class_name: string }>(
    "SELECT a.*, c.name AS class_name FROM student_asks a JOIN classes c ON c.id=a.class_id WHERE a.teacher_id=? AND a.status='teacher' ORDER BY a.id LIMIT 10",
    teacherId,
  );
  if (!rows.length) return null;
  return `（学生在等老师回：${rows.map((r) => `${r.class_name}的${nameIn(r.class_id, r.student_id)}问「${r.question.slice(0, 60)}」`).join('；')}）`;
}

/** 收起老师那边的卡片：记上答了什么 */
function closeCard(ask: AskRow, said: string) {
  if (!ask.card_run_id) return;
  const run = db.get<{ status: string }>('SELECT status FROM kb_runs WHERE id=?', ask.card_run_id);
  if (run?.status !== 'waiting') return;
  const ev = db.get<{ id: number; data: string }>("SELECT id, data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", ask.card_run_id);
  if (ev) {
    const data = j<{ questions: { question: string }[] }>(ev.data, { questions: [] });
    db.update('kb_events', ev.id, { data: { ...data, answered: [{ q: data.questions[0]?.question || '', a: said }] } });
  }
  db.update('kb_runs', ask.card_run_id, { status: 'done', finished_at: now() });
  publishRun(null, ask.card_run_id);
}

/**
 * 助教把老师的意思转告学生：找这个学生还在等老师回的那一问（同一个人有几件时按问的话对，对不上取最近的）。
 */
export function replyStudent(teacherId: number, o: { student: string; reply: string; question?: string }): { ask: AskRow; student: string; className: string } {
  const reply = o.reply.trim();
  if (!reply) throw bad('要回学生什么没写');
  const want = o.student.trim();
  const rows = db
    .all<AskRow>("SELECT * FROM student_asks WHERE teacher_id=? AND status='teacher' ORDER BY id DESC", teacherId)
    .filter((r) => {
      const name = nameIn(r.class_id, r.student_id);
      const no = db.value<string>('SELECT student_no FROM class_students WHERE class_id=? AND user_id=?', r.class_id, r.student_id) || '';
      return !want || name.includes(want) || want.includes(name) || no === want;
    });
  if (!rows.length) {
    const waiting = db.all<AskRow>("SELECT * FROM student_asks WHERE teacher_id=? AND status='teacher' ORDER BY id DESC LIMIT 6", teacherId);
    throw bad(
      waiting.length
        ? `「${want}」没有在等老师回的问题。在等的：${waiting.map((r) => `${nameIn(r.class_id, r.student_id)}问「${r.question.slice(0, 40)}」`).join('、')}`
        : '现在没有学生在等老师回',
    );
  }
  const q = o.question?.trim();
  const ask = (q && rows.find((r) => r.question.includes(q) || q.includes(r.question.slice(0, 20)))) || rows[0];
  deliver(ask.student_id, { classId: ask.class_id, text: reply, kind: 'reply', session: ask.stu_session, question: askedAs(ask) });
  db.update('student_asks', ask.id, { status: 'replied', reply, replied_at: now() });
  closeMerged(ask, reply);
  closeCard(ask, reply);
  return { ask, student: nameIn(ask.class_id, ask.student_id), className: classOf(ask.class_id)?.name || '' };
}

/** 老师在卡片上答了，助教那一轮结束了还没转告：照老师的原话转（不让学生干等） */
export function afterTeacherAnswer(askId: number, words: string) {
  const ask = db.get<AskRow>('SELECT * FROM student_asks WHERE id=?', askId);
  if (!ask || ask.status !== 'teacher') return;
  const text = `老师的回复：${words}`;
  deliver(ask.student_id, { classId: ask.class_id, text, kind: 'reply', session: ask.stu_session, question: askedAs(ask) });
  db.update('student_asks', ask.id, { status: 'replied', reply: text, replied_at: now() });
  closeMerged(ask, text);
}

/** 并进同一张卡片的那几问（同一句话、同一位老师）：一起算回了 */
function closeMerged(ask: AskRow, reply: string) {
  if (ask.card_run_id) db.run("UPDATE student_asks SET status='replied', reply=?, replied_at=? WHERE card_run_id=? AND status='merged'", reply, now(), ask.card_run_id);
}

/* ---------------- 老师通知学生 ---------------- */

/**
 * 通知一个班：全班（也写进资料包，学伴以后被问到也知道），或者只发给某份作业还没交的。
 * 返回发给了谁。
 */
export function notifyClass(o: { classId: number; text: string; missingHomework?: number | null; title?: string }): string[] {
  let rows = db.all<{ user_id: number; name: string }>('SELECT user_id, name FROM class_students WHERE class_id=? AND user_id IS NOT NULL ORDER BY student_no', o.classId);
  if (o.missingHomework) {
    const done = new Set(
      db
        .all<{ user_id: number; submitted_at: number; returned_at: number | null }>('SELECT user_id, submitted_at, returned_at FROM submissions WHERE assignment_id=?', o.missingHomework)
        .filter((s) => !(s.returned_at && s.returned_at >= s.submitted_at))
        .map((s) => s.user_id),
    );
    rows = rows.filter((r) => !done.has(r.user_id));
  } else putPack(o.classId, 'notice', o.title?.trim() || o.text.slice(0, 20), o.text);
  for (const r of rows) deliver(r.user_id, { classId: o.classId, text: o.text, kind: 'notice' });
  return rows.map((r) => r.name);
}

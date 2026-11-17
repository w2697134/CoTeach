/**
 * 课堂（2026-11-17）：上课时的课堂互动，照雨课堂的授课、课堂派的课堂互动。
 * 老师给一个班开一堂课（带一节备好的课就放它的课件、推它的课堂练习；不带也能当堂出题、点名），
 * 学生打开上课的页面就算到课，老师推的题在手机上作答，对不对程序判；老师看实时统计、公布答案、随机点名、看学生提的问题；
 * 下课程序算一份小结存下来。全是程序，不经过模型。表在 db/schema.ts 第 22 次。
 */
import { randomInt } from 'node:crypto';
import { db, j, now } from '../db/index.js';
import { bad, conflict, notFound } from '../lib/http.js';
import { cleanQuestion, lessonRow, type Deck, type QType, type Question, type Slide } from '../prep/lessons.js';

export interface LectureRow {
  id: number;
  class_id: number;
  teacher_id: number;
  lesson_id: number | null;
  title: string;
  status: 'live' | 'ended';
  page: number;
  screen: number | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  updated_at: number;
  deleted_at: number | null;
}
interface QuestionRow {
  id: number;
  lecture_id: number;
  source: string | null;
  data: string;
  status: 'open' | 'revealed';
  pushed_at: number;
  revealed_at: number | null;
}
interface AnswerRow {
  question_id: number;
  user_id: number;
  answer: string;
  correct: number | null;
  created_at: number;
}
/** 学生交上来的：选择题是选项序号，别的是一段字（判断题是「对」「错」） */
export interface Reply {
  choice?: number[];
  text?: string;
}

/* ---------------- 谁能看、谁能管 ---------------- */

const LECTURE = 'SELECT l.* FROM lectures l JOIN classes c ON c.id=l.class_id AND c.deleted_at IS NULL';

/** 老师自己的一堂课（别的老师的、删掉的班的当没有） */
export function ownLecture(teacherId: number, id: number): LectureRow {
  const l = db.get<LectureRow>(`${LECTURE} WHERE l.id=? AND l.teacher_id=? AND l.deleted_at IS NULL`, id, teacherId);
  if (!l) throw notFound('这堂课不在了');
  return l;
}
/** 学生只看得到自己班的课 */
export function joinedLecture(userId: number, id: number): LectureRow {
  const l = db.get<LectureRow>(
    `${LECTURE} JOIN class_students s ON s.class_id=l.class_id AND s.user_id=? WHERE l.id=? AND l.deleted_at IS NULL`,
    userId,
    id,
  );
  if (!l) throw notFound('这堂课不在了');
  return l;
}
export function liveOnly(l: LectureRow) {
  if (l.status !== 'live') throw conflict('已经下课了');
  return l;
}

/* ---------------- 开课、下课 ---------------- */

/** 老师很久没动（页面也没开着）的课自己下课，免得学生那边一直显示在上课；结束时间记老师最后一次动的时候 */
const STALE = 4 * 3600_000;
let sweptAt = 0;
/** 一分钟最多查一次（列表、学伴页的卡片都会调）；force 是测试用的 */
export function endStale(force = false) {
  const t = now();
  if (!force && t - sweptAt < 60_000) return;
  sweptAt = t;
  for (const l of db.all<LectureRow>("SELECT * FROM lectures WHERE status='live' AND updated_at<?", t - STALE)) endLecture(l, l.updated_at);
}

/** 老师开着上课的页面就算在动；一分钟记一次，不用每次轮询都写库 */
const touched = new Map<number, number>();
export function touch(l: LectureRow) {
  const t = now();
  if (l.status !== 'live' || t - (touched.get(l.id) || 0) < 60_000) return;
  touched.set(l.id, t);
  db.run("UPDATE lectures SET updated_at=? WHERE id=? AND status='live'", t, l.id);
}

export const liveIn = (classId: number) => db.get<LectureRow>("SELECT * FROM lectures WHERE class_id=? AND status='live'", classId);

/** 开一堂课。同一个班同一时间只有一堂在上（表上也有唯一索引兜着） */
export function startLecture(teacherId: number, classId: number, lessonId: number | null, title: string | null): number {
  endStale();
  const k = db.get<{ id: number; name: string; archived_at: number | null }>(
    'SELECT id, name, archived_at FROM classes WHERE id=? AND teacher_id=? AND deleted_at IS NULL',
    classId,
    teacherId,
  );
  if (!k) throw notFound('这个班不存在或已经删掉了');
  if (k.archived_at) throw conflict('这个班已经归档了，要上课先恢复');
  let name = (title || '').trim().slice(0, 80);
  if (lessonId) {
    const r = lessonRow(lessonId);
    if (!r || r.teacher_id !== teacherId) throw notFound('这节课不在了');
    if (r.status === 'making') throw conflict('这节课还在备，备好了再上');
    name = r.title || j<{ title?: string } | null>(r.plan, null)?.title || r.request || name;
  }
  const busy = liveIn(k.id);
  if (busy) throw conflict(`「${k.name}」正在上「${busy.title}」，先下课再开`);
  const t = now();
  try {
    return db.insert('lectures', {
      class_id: k.id,
      teacher_id: teacherId,
      lesson_id: lessonId,
      title: name || '随堂互动',
      status: 'live',
      page: 0,
      started_at: t,
      updated_at: t,
    });
  } catch (err) {
    if (/UNIQUE/i.test(String((err as Error).message))) throw conflict(`「${k.name}」正在上课，先下课再开`);
    throw err;
  }
}

/** 下课：程序算小结存下（at 是结束时间，默认现在） */
export function endLecture(l: LectureRow, at = now()) {
  if (l.status !== 'live') return;
  db.tx(() => {
    const changed = db.run("UPDATE lectures SET status='ended', ended_at=?, updated_at=?, screen=NULL WHERE id=? AND status='live'", at, now(), l.id).changes;
    if (!changed) return;
    db.update('lectures', l.id, { summary: JSON.stringify(summarize({ ...l, status: 'ended', ended_at: at })) });
  });
  touched.delete(l.id);
  for (const key of present) if (key.startsWith(`${l.id}:`)) present.delete(key);
}

/* ---------------- 课件、课堂练习（从备好的那节课取） ---------------- */

const lessonCache = new Map<number, { at: number; deck: Deck | null; practice: Question[] }>();
/** 这堂课用的课件和练习；课改过了（updated_at 变了）才重新读，学生两秒一轮询不用每次都解析一遍 */
export function materialOf(l: Pick<LectureRow, 'lesson_id'>): { deck: Deck | null; practice: Question[] } {
  if (!l.lesson_id) return { deck: null, practice: [] };
  const at = db.value<number>('SELECT updated_at FROM lessons WHERE id=? AND deleted_at IS NULL', l.lesson_id);
  if (at === undefined) return { deck: null, practice: [] };
  const had = lessonCache.get(l.lesson_id);
  if (had && had.at === at) return had;
  const r = lessonRow(l.lesson_id)!;
  const deck = j<Deck | null>(r.deck, null);
  const got = { at, deck: deck?.slides?.length ? deck : null, practice: j<Question[] | null>(r.practice, null) || [] };
  lessonCache.set(l.lesson_id, got);
  return got;
}

/** 给学生看的那一页：不带讲稿，课件上的小测不带答案和解析 */
export function studentSlide(s: Slide): Slide {
  const { notes: _, quiz, ...rest } = s;
  return quiz ? { ...rest, quiz: { question: quiz.question, options: quiz.options, answer: [] } } : rest;
}

/** 课件上的一道小测当成一道选择题推（雨课堂的习题页） */
function slideQuestion(s: Slide): Question {
  if (!s.quiz) throw bad('这一页不是题');
  return {
    ...cleanQuestion(
      { type: s.quiz.answer.length > 1 ? 'multi' : 'single', stem: s.quiz.question, options: s.quiz.options, choice: s.quiz.answer, explain: s.quiz.explain },
      false,
    ),
    id: `slide-${s.id}`,
  };
}

/* ---------------- 推题、作答、公布 ---------------- */

const questionsOf = (lectureId: number) => db.all<QuestionRow>('SELECT * FROM lecture_questions WHERE lecture_id=? ORDER BY id', lectureId);

/**
 * 推一道题：课堂练习里的（source 是题的 id）、课件上的小测（source 是 slide:页的 id），或者当堂出的（question）。
 * 同一道题一堂课只推一次。题目照 Question 原样存一份，课后改了练习也不影响这堂课的记录。
 */
export function pushQuestion(l: LectureRow, input: { source?: string | null; question?: unknown }): number {
  liveOnly(l);
  let q: Question,
    source: string | null = null;
  if (input.source) {
    source = input.source;
    const { deck, practice } = materialOf(l);
    if (source.startsWith('slide:')) {
      const s = deck?.slides.find((x) => x.id === source!.slice(6));
      if (!s) throw notFound('课件上没有这一页了');
      q = slideQuestion(s);
    } else {
      const found = practice.find((x) => x.id === source);
      if (!found) throw notFound('课堂练习里没有这道题了');
      q = found;
    }
    if (db.get('SELECT id FROM lecture_questions WHERE lecture_id=? AND source=?', l.id, source)) throw conflict('这道题已经推过了');
  } else {
    try {
      q = cleanQuestion(input.question, false);
    } catch (err) {
      throw bad((err as Error).message);
    }
  }
  const { points: _p, rubric: _r, ...copy } = q;
  const id = db.insert('lecture_questions', { lecture_id: l.id, source, data: JSON.stringify(copy), status: 'open', pushed_at: now() });
  db.update('lectures', l.id, { updated_at: now() });
  return id;
}

export function questionIn(l: LectureRow, qid: number): QuestionRow {
  const r = db.get<QuestionRow>('SELECT * FROM lecture_questions WHERE id=? AND lecture_id=?', qid, l.id);
  if (!r) throw notFound('这道题不在了');
  return r;
}

export function reveal(l: LectureRow, qid: number) {
  liveOnly(l);
  const r = questionIn(l, qid);
  if (r.status !== 'revealed') db.update('lecture_questions', r.id, { status: 'revealed', revealed_at: now() });
  db.update('lectures', l.id, { updated_at: now() });
}

const letter = (n: number) => String.fromCharCode(65 + n);
const isChoice = (t: QType) => t === 'single' || t === 'multi';
/** 填空比对用：全角半角统一、去掉空白、不分大小写，几个空之间的「、；」当成逗号 */
export const normBlank = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[、;]/g, ',');

/** 程序判对错：选择照选项，判断照对错，填空照答案比对；简答、编程不判（null）。题上没给答案的也不判 */
export function judge(q: Question, a: Reply): boolean | null {
  if (isChoice(q.type)) {
    const want = [...new Set(q.choice ?? [])].sort((x, y) => x - y);
    if (!want.length) return null;
    const got = [...new Set(a.choice ?? [])].sort((x, y) => x - y);
    return got.length === want.length && got.every((x, i) => x === want[i]);
  }
  if (q.type === 'judge') return a.text === q.answer;
  if (q.type === 'blank') {
    const want = normBlank(q.answer || '');
    return want ? normBlank(a.text || '') === want : null;
  }
  return null;
}
const judged = (q: Question) => (isChoice(q.type) ? !!q.choice?.length : q.type === 'judge' || (q.type === 'blank' && !!normBlank(q.answer || '')));

/** 交上来的东西先看像不像样：选择题选项在范围内、单选只能一个；判断只认对错；别的要写字 */
function cleanReply(q: Question, raw: Reply): Reply {
  if (isChoice(q.type)) {
    const n = q.options?.length ?? 0;
    const choice = [...new Set((raw.choice ?? []).filter((x) => Number.isInteger(x) && x >= 0 && x < n))].sort((x, y) => x - y);
    if (!choice.length) throw bad('先选一个');
    if (q.type === 'single' && choice.length > 1) throw bad('单选题只能选一个');
    return { choice };
  }
  const text = String(raw.text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (q.type === 'judge') {
    if (text !== '对' && text !== '错') throw bad('选对或错');
    return { text };
  }
  if (!text) throw bad('先写答案');
  return { text: text.slice(0, q.type === 'blank' ? 200 : 5000) };
}

/** 学生打开上课的页面就算到课（只记第一次）；记过的在内存里留个记号，两秒一次的轮询不用每次去写库 */
const present = new Set<string>();
export function attend(l: LectureRow, userId: number) {
  if (l.status !== 'live') return;
  const key = `${l.id}:${userId}`;
  if (present.has(key)) return;
  db.run('INSERT OR IGNORE INTO lecture_attendance (lecture_id, user_id, joined_at) VALUES (?, ?, ?)', l.id, userId, now());
  present.add(key);
}

/** 学生作答：在上课、题还没公布才收；一人一题一份，交了不能改 */
export function answer(l: LectureRow, userId: number, qid: number, raw: Reply) {
  liveOnly(l);
  const r = questionIn(l, qid);
  if (r.status === 'revealed') throw conflict('老师已经公布答案了');
  const q = j<Question>(r.data, null as any);
  const reply = cleanReply(q, raw);
  const ok = judge(q, reply);
  attend(l, userId);
  try {
    db.insert('lecture_answers', {
      question_id: r.id,
      user_id: userId,
      answer: JSON.stringify(reply),
      correct: ok === null ? null : ok ? 1 : 0,
      created_at: now(),
    });
  } catch (err) {
    if (/UNIQUE/i.test(String((err as Error).message))) throw conflict('这道题已经交过了');
    throw err;
  }
  return { correct: ok };
}

/** 学生提问：一句话给老师 */
export function ask(l: LectureRow, userId: number, text: string) {
  liveOnly(l);
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) throw bad('先写要问的');
  attend(l, userId);
  return db.insert('lecture_asks', { lecture_id: l.id, user_id: userId, text: t, created_at: now() });
}

/* ---------------- 随机点名 ---------------- */

/** 这个班里的名字（学生在班里填的姓名），按账号找 */
const namesIn = (classId: number) =>
  new Map(
    db
      .all<{ user_id: number; name: string }>('SELECT user_id, name FROM class_students WHERE class_id=? AND user_id IS NOT NULL', classId)
      .map((s) => [s.user_id, s.name]),
  );

/** 从进了课堂（还在班里）的学生里挑一个；一轮里不重复，人都点过了开新一轮 */
export function call(l: LectureRow) {
  liveOnly(l);
  const names = namesIn(l.class_id);
  const here = db
    .all<{ user_id: number }>('SELECT user_id FROM lecture_attendance WHERE lecture_id=? ORDER BY joined_at, user_id', l.id)
    .map((a) => a.user_id)
    .filter((u) => names.has(u));
  if (!here.length) throw conflict('还没有学生进课堂');
  const last = db.get<{ round: number }>('SELECT round FROM lecture_calls WHERE lecture_id=? ORDER BY id DESC LIMIT 1', l.id);
  let round = last?.round ?? 1;
  const done = new Set(db.all<{ user_id: number }>('SELECT user_id FROM lecture_calls WHERE lecture_id=? AND round=?', l.id, round).map((c) => c.user_id));
  let pool = here.filter((u) => !done.has(u));
  if (!pool.length) {
    round++;
    pool = here;
  }
  const pick = pool[randomInt(pool.length)];
  const id = db.insert('lecture_calls', { lecture_id: l.id, user_id: pick, round, created_at: now() });
  db.update('lectures', l.id, { updated_at: now() });
  return { id, name: names.get(pick)!, round, left: pool.length - 1, total: here.length };
}

/* ---------------- 统计 ---------------- */

/** 交上来的写成一段字：选择题是字母（AC），判断是对、错，别的是原文 */
function replyText(q: Question, a: Reply) {
  return isChoice(q.type) ? (a.choice ?? []).map(letter).join('') : a.text ?? '';
}

export interface Bar {
  label: string;
  /** 选项原文（选择题） */
  text?: string;
  count: number;
  right: boolean;
}
export interface QuestionStats {
  answered: number;
  /** 答对几个；不判对错的题是 null */
  correct: number | null;
  /** 选择题：每个选项几个人选；判断：对、错各几个；填空：写得最多的几种 */
  bars: Bar[] | null;
  /** 错得最多的：选择题是选的字母，判断是对或错，填空是写的答案 */
  wrong: { text: string; count: number; option?: string } | null;
}

function statsOf(q: Question, answers: AnswerRow[]): QuestionStats {
  const replies = answers.map((a) => ({ a, r: j<Reply>(a.answer, {}) }));
  const answered = answers.length;
  const correct = judged(q) ? answers.filter((a) => a.correct === 1).length : null;
  let bars: Bar[] | null = null;
  if (isChoice(q.type)) {
    const right = new Set(q.choice ?? []);
    bars = (q.options ?? []).map((o, i) => ({ label: letter(i), text: o, count: replies.filter((x) => x.r.choice?.includes(i)).length, right: right.has(i) }));
  } else if (q.type === 'judge') {
    bars = ['对', '错'].map((x) => ({ label: x, count: replies.filter((y) => y.r.text === x).length, right: q.answer === x }));
  } else if (q.type === 'blank') {
    const groups = new Map<string, Bar>();
    for (const { a, r } of replies) {
      const key = normBlank(r.text || '');
      const g = groups.get(key) || { label: (r.text || '').slice(0, 60), count: 0, right: a.correct === 1 };
      g.count++;
      groups.set(key, g);
    }
    bars = [...groups.values()].sort((x, y) => y.count - x.count).slice(0, 6);
  }
  let wrong: QuestionStats['wrong'] = null;
  if (correct !== null) {
    const tally = new Map<string, number>();
    for (const { a, r } of replies) if (a.correct === 0) tally.set(replyText(q, r), (tally.get(replyText(q, r)) || 0) + 1);
    const top = [...tally.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    if (top) {
      wrong = { text: top[0].slice(0, 60), count: top[1] };
      if (q.type === 'single') wrong.option = q.options?.[top[0].charCodeAt(0) - 65];
    }
  }
  return { answered, correct, bars, wrong };
}

const answersOf = (qids: number[]) =>
  qids.length ? db.all<AnswerRow>(`SELECT question_id, user_id, answer, correct, created_at FROM lecture_answers WHERE question_id IN (${qids.map(() => '?').join(',')}) ORDER BY id`, ...qids) : [];

/* ---------------- 给页面的样子 ---------------- */

const classSize = (classId: number) => db.value<number>('SELECT count(*) FROM class_students WHERE class_id=? AND user_id IS NOT NULL', classId) ?? 0;
const attendedCount = (lectureId: number) => db.value<number>('SELECT count(*) FROM lecture_attendance WHERE lecture_id=?', lectureId) ?? 0;

/** 一堂课的样子（列表一行、页面头上） */
export function lectureCard(l: LectureRow) {
  const k = db.get<{ name: string }>('SELECT name FROM classes WHERE id=?', l.class_id);
  const s = j<LectureSummary | null>(l.summary, null);
  const pushed = s ? s.questions.length : (db.value<number>('SELECT count(*) FROM lecture_questions WHERE lecture_id=?', l.id) ?? 0);
  return {
    id: l.id,
    classId: l.class_id,
    className: k?.name || '',
    lessonId: l.lesson_id,
    title: l.title,
    status: l.status,
    startedAt: l.started_at,
    endedAt: l.ended_at,
    attended: s ? s.attended : attendedCount(l.id),
    classSize: s ? s.classSize : classSize(l.class_id),
    pushed,
    rate: s ? s.rate : null,
  };
}

/** 老师上课时轮询的：到了谁、推了的题和作答、学生提的问题、最近一次点名 */
export function teacherState(l: LectureRow) {
  const names = namesIn(l.class_id);
  const nameOf = (u: number) => names.get(u) || db.value<string>('SELECT name FROM users WHERE id=?', u) || '';
  const here = db.all<{ user_id: number; joined_at: number }>('SELECT user_id, joined_at FROM lecture_attendance WHERE lecture_id=? ORDER BY joined_at', l.id);
  const came = new Set(here.map((a) => a.user_id));
  const rows = questionsOf(l.id);
  const answers = answersOf(rows.map((r) => r.id));
  const questions = rows.map((r, i) => {
    const q = j<Question>(r.data, null as any);
    const mine = answers.filter((a) => a.question_id === r.id);
    return {
      id: r.id,
      n: i + 1,
      source: r.source,
      status: r.status,
      pushedAt: r.pushed_at,
      revealedAt: r.revealed_at,
      q,
      ...statsOf(q, mine),
      answers: mine.map((a) => ({ name: nameOf(a.user_id), text: replyText(q, j<Reply>(a.answer, {})), correct: a.correct === null ? null : a.correct === 1, at: a.created_at })),
    };
  });
  const lastCall = db.get<{ id: number; user_id: number; round: number; created_at: number }>(
    'SELECT id, user_id, round, created_at FROM lecture_calls WHERE lecture_id=? ORDER BY id DESC LIMIT 1',
    l.id,
  );
  return {
    id: l.id,
    status: l.status,
    page: l.page,
    screen: l.screen,
    startedAt: l.started_at,
    endedAt: l.ended_at,
    attendance: {
      count: here.length,
      total: names.size,
      people: here.map((a) => ({ id: a.user_id, name: nameOf(a.user_id), at: a.joined_at })),
      absent: [...names.entries()].filter(([u]) => !came.has(u)).map(([, n]) => n),
    },
    questions,
    asks: db
      .all<{ id: number; user_id: number; text: string; created_at: number }>('SELECT id, user_id, text, created_at FROM lecture_asks WHERE lecture_id=? ORDER BY id', l.id)
      .map((a) => ({ id: a.id, name: nameOf(a.user_id), text: a.text, at: a.created_at })),
    call: lastCall ? { id: lastCall.id, name: nameOf(lastCall.user_id), round: lastCall.round, at: lastCall.created_at } : null,
  };
}

/**
 * 学生上课时轮询的：现在这页课件（不带讲稿和答案）、推来的题（公布之前不带答案、解析和别人的作答）、自己交的、自己问的。
 */
export function studentState(l: LectureRow, userId: number) {
  const k = db.get<{ name: string; teacher: string }>('SELECT c.name, t.name AS teacher FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.id=?', l.class_id);
  const { deck } = materialOf(l);
  const page = deck ? Math.min(Math.max(l.page, 0), deck.slides.length - 1) : 0;
  const rows = questionsOf(l.id);
  const answers = answersOf(rows.filter((r) => r.status === 'revealed').map((r) => r.id));
  const mine = new Map(
    db
      .all<AnswerRow>(
        'SELECT a.question_id, a.user_id, a.answer, a.correct, a.created_at FROM lecture_answers a JOIN lecture_questions q ON q.id=a.question_id WHERE q.lecture_id=? AND a.user_id=?',
        l.id,
        userId,
      )
      .map((a) => [a.question_id, a]),
  );
  const questions = rows.map((r, i) => {
    const q = j<Question>(r.data, null as any);
    const my = mine.get(r.id);
    const base = {
      id: r.id,
      n: i + 1,
      type: q.type,
      stem: q.stem,
      code: q.code,
      options: q.options,
      status: r.status,
      pushedAt: r.pushed_at,
      mine: my ? { ...j<Reply>(my.answer, {}), at: my.created_at } : null,
    };
    if (r.status !== 'revealed') return base;
    const s = statsOf(
      q,
      answers.filter((a) => a.question_id === r.id),
    );
    return {
      ...base,
      answer: q.answer,
      choice: q.choice,
      explain: q.explain,
      correct: my ? (my.correct === null ? null : my.correct === 1) : null,
      // 公布以后才看得到全班答得怎么样：几个人答、几个人对；选择、判断题每个选项几个人选（不带名字）
      stats: { answered: s.answered, correct: s.correct, bars: isChoice(q.type) || q.type === 'judge' ? s.bars : null },
    };
  });
  return {
    id: l.id,
    classId: l.class_id,
    title: l.title,
    teacher: k?.teacher || '',
    className: k?.name || '',
    status: l.status,
    startedAt: l.started_at,
    endedAt: l.ended_at,
    page,
    pages: deck?.slides.length ?? 0,
    theme: deck?.theme ?? null,
    slide: deck ? studentSlide(deck.slides[page]) : null,
    questions,
    asks: db
      .all<{ id: number; text: string; created_at: number }>('SELECT id, text, created_at FROM lecture_asks WHERE lecture_id=? AND user_id=? ORDER BY id', l.id, userId)
      .map((a) => ({ id: a.id, text: a.text, at: a.created_at })),
  };
}

/* ---------------- 下课小结 ---------------- */

export interface SummaryQuestion extends QuestionStats {
  id: number;
  n: number;
  type: QType;
  stem: string;
  /** 正确率；不判对错的题、没人答的是 null */
  rate: number | null;
}
export interface LectureSummary {
  minutes: number;
  attended: number;
  classSize: number;
  /** 班里没来的（名字） */
  absent: string[];
  /** 全部能判对错的作答里答对的比例；没有这样的作答是 null */
  rate: number | null;
  questions: SummaryQuestion[];
  asks: { name: string; text: string; at: number }[];
  calls: { name: string; at: number }[];
}

/** 下课小结：到课人数、每道题正确率和错得最多的选项、学生提的问题、点到的人。全是程序数的 */
export function summarize(l: LectureRow): LectureSummary {
  const s = teacherState(l);
  let right = 0,
    total = 0;
  const questions = s.questions.map((x): SummaryQuestion => {
    if (x.correct !== null) {
      right += x.correct;
      total += x.answered;
    }
    return {
      id: x.id,
      n: x.n,
      type: x.q.type,
      stem: x.q.stem.slice(0, 300),
      answered: x.answered,
      correct: x.correct,
      rate: x.correct !== null && x.answered ? x.correct / x.answered : null,
      bars: x.bars,
      wrong: x.wrong,
    };
  });
  const names = namesIn(l.class_id);
  const calls = db
    .all<{ user_id: number; created_at: number }>('SELECT user_id, created_at FROM lecture_calls WHERE lecture_id=? ORDER BY id', l.id)
    .map((c) => ({ name: names.get(c.user_id) || s.attendance.people.find((p) => p.id === c.user_id)?.name || '', at: c.created_at }));
  return {
    minutes: Math.max(1, Math.round(((l.ended_at ?? now()) - l.started_at) / 60_000)),
    attended: s.attendance.count,
    classSize: s.attendance.total,
    absent: s.attendance.absent,
    rate: total ? right / total : null,
    questions,
    asks: s.asks.map((a) => ({ name: a.name, text: a.text, at: a.at })),
    calls,
  };
}

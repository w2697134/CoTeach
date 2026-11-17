/**
 * 助教自己提议分出专门助手。
 *
 * 程序数老师常做的事，只用平台里已有的数据：
 * - 改分：同一份作业（发给几个班的算一份；交给了专门助手批的、最近 30 天老师没再改过的不算），老师改过助教给的分的有几份（items 里带「（老师改成 N 分）」）；
 * - 学生来问：最近 30 天老师回了几件（student_asks）；
 * - 老师交代：最近 30 天老师跟助教说了几句（kb_runs 里 agent='ta' kind='chat'；在卡片上点的、只发了文件的不算）。
 * 第一次数到 STEP 就让助教看一眼，以后每多 STEP 再看。这些数目只用来决定什么时候看，不写进给模型的话。
 *
 * 看一眼是单独一次模型调用：不进老师和助教的对话，也不记助教的一轮（不占老师每天的句数）。
 * 给它这几样事的摘要、它分出来的专门助手、老师说过不用的提议；值得分它就调 suggest_specialist，最多提一个。
 * 提了就在老师现在的会话里弹一张卡片（照学生来问的卡片：老师接着说别的也不收起来）；
 * 老师点「分出来」助教才分，点「先不用」同一件事不再提。同一时间只挂一张：现在这段会话里挂着一张就不看。
 *
 * 触发：老师改分、老师回了学生来问的、助教一轮办完以后叫 suggestSoon；连着改好几份时等一会儿没新动静再看，同一个老师同一时间只看一次。
 * 每看一次记一行 specialist_suggestions：数到几、给它看的摘要、提了什么、老师怎么答的。
 */
import { db, j, now } from '../db/index.js';
import { record } from '../kb/agent/events.js';
import { publishRun } from '../kb/keeper.js';
import type { Msg, ToolSpec } from '../llm/types.js';
import { gradeItems } from '../grading/common.js';
import { modelStep } from './model.js';
import { teacherTitle } from './pack.js';
import { findHomework } from './resolve.js';
import { changedItems, graderOf, specialistsOf } from './specialists.js';
import { nowLine, showTime } from './time.js';

const DAY = 86_400_000;
/** 学生来问、老师交代的事数最近这么多天的 */
const WINDOW = 30 * DAY;
/** 第一次数到几看，以后每多几件再看：同一份作业改了几份、学生来问几件、老师交代几句 */
const STEP = { grade: 3, asks: 4, chat: 15 };
/** 摘要里每样最多列几条 */
const LIST_MAX = 40;
/** 看一眼最多来回几步（提的不行时告诉它，让它改或者不提） */
const MAX_STEPS = 3;
/**
 * 看一眼是后台的活，没人在等：Gemini 忙的时候等它五分钟（跟批作业一样），不到一分钟就换 DeepSeek。
 * 2026-11-17 量过：Gemini 一分钟没回完就换 DeepSeek 的那些次，DeepSeek 把重置密码这类杂事也凑成一类来提，不该提的提了一半多（尺子 tools/suggest-measure）
 */
const WAIT_MS = 300_000;

export const YES = '分出来';
export const NO = '先不用';

export interface SuggestionRow {
  id: number;
  teacher_id: number;
  status: 'looking' | 'none' | 'waiting' | 'accepted' | 'declined' | 'answered' | 'expired' | 'error';
  subjects: string;
  due: string;
  digest: string | null;
  reply: string | null;
  name: string | null;
  duty: string | null;
  guide: string | null;
  question: string | null;
  homework_id: number | null;
  card_run_id: number | null;
  specialist_id: number | null;
  answer: string | null;
  error: string | null;
  created_at: number;
  answered_at: number | null;
}

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .trim()
    .slice(0, max);
const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/[\s「」『』《》"'“”‘’：:，,。]/g, '')
    .toLowerCase();
const oneLine = (s: unknown, max: number) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const score = (n: number) => String(Math.round(n * 10) / 10);
const day = (ms: number) => showTime(ms).replace(/ \d\d:\d\d$/, '');

/* ---------------- 数 ---------------- */

interface Group {
  /** grade:这份作业最早那一行的编号 */
  key: string;
  ids: number[];
  title: string;
  classes: string[];
  /** 助教批了几份 */
  graded: number;
  /** 老师改了几份 */
  changed: number;
  /** 老师最近一次改是什么时候 */
  last: number;
}

/** 同一份作业（标题一样、一起建的，发给几个班也算一份）：助教批了几份、老师改了几份。交给了专门助手批的不算 */
function homeworkGroups(teacherId: number): Group[] {
  const rows = db
    .all<{ id: number; title: string; created_at: number; cls: string; teacher_id: number; specialist_id: number | null; graded: number; changed: number; last: number | null }>(
      `SELECT a.id, a.title, a.created_at, c.name AS cls, a.teacher_id, a.specialist_id, count(s.id) AS graded,
         sum(CASE WHEN s.items LIKE '%（老师改成 %' THEN 1 ELSE 0 END) AS changed,
         max(CASE WHEN s.items LIKE '%（老师改成 %' THEN s.updated_at END) AS last
       FROM assignments a JOIN classes c ON c.id=a.class_id JOIN submissions s ON s.assignment_id=a.id AND s.ai_grade_id IS NOT NULL
       WHERE c.teacher_id=? AND a.deleted_at IS NULL AND c.deleted_at IS NULL
       GROUP BY a.id ORDER BY a.id`,
      teacherId,
    )
    .filter((r) => !graderOf(r));
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const k = `${r.title}\u0000${r.created_at}`;
    const g = groups.get(k) ?? { key: `grade:${r.id}`, ids: [], title: r.title, classes: [], graded: 0, changed: 0, last: 0 };
    g.ids.push(r.id);
    g.classes.push(r.cls);
    g.graded += r.graded;
    g.changed += r.changed || 0;
    g.last = Math.max(g.last, r.last || 0);
    groups.set(k, g);
  }
  return [...groups.values()];
}

const askCount = (teacherId: number, since: number) =>
  db.value<number>("SELECT count(*) FROM student_asks WHERE teacher_id=? AND status='replied' AND replied_at>=?", teacherId, since) || 0;

/** 老师跟助教说的话：在卡片上点的、只发了文件没写话的不算 */
const CHAT = `FROM kb_runs r WHERE r.teacher_id=? AND r.agent='ta' AND r.kind='chat' AND r.parent_id IS NULL AND r.request<>'' AND r.created_at>=?
  AND NOT EXISTS (SELECT 1 FROM kb_events e WHERE e.run_id=r.id AND e.type='answer')`;
const chatCount = (teacherId: number, since: number) => db.value<number>(`SELECT count(*) ${CHAT}`, teacherId, since) || 0;

interface Plan {
  /** 什么时候数的（记成这一行的时间，下回从这里往后数） */
  at: number;
  /** 哪几样数到了 */
  due: string[];
  /** 给它看的几样各数到几（记下来，下回从这里往后数） */
  subjects: Record<string, number>;
  groups: Group[];
}

/** 数一遍：哪几样够数了（够数的给它看），哪几样比上回看的时候又多了一截（这几样到了才看） */
function planOf(teacherId: number): Plan {
  const t = now();
  const looks = db
    .all<{ subjects: string; created_at: number }>(
      "SELECT subjects, created_at FROM specialist_suggestions WHERE teacher_id=? AND status NOT IN ('looking','error') ORDER BY id DESC LIMIT 200",
      teacherId,
    )
    .map((r) => ({ at: r.created_at, subjects: j<Record<string, number>>(r.subjects, {}) }));
  const last = (key: string) => looks.find((l) => key in l.subjects);
  const declined = new Set(
    db
      .all<{ homework_id: number }>("SELECT homework_id FROM specialist_suggestions WHERE teacher_id=? AND status='declined' AND homework_id IS NOT NULL", teacherId)
      .map((r) => r.homework_id),
  );
  const subjects: Record<string, number> = {};
  const due: string[] = [];
  // 老师说过先不用的作业不再数；最近没再改过的（早就批完的作业）不算
  const groups = homeworkGroups(teacherId).filter((g) => g.changed >= STEP.grade && g.last >= t - WINDOW && !g.ids.some((id) => declined.has(id)));
  for (const g of groups) {
    subjects[g.key] = g.changed;
    if (g.changed >= (last(g.key)?.subjects[g.key] ?? 0) + STEP.grade) due.push(g.key);
  }
  for (const [key, step, count] of [
    ['asks', STEP.asks, askCount],
    ['chat', STEP.chat, chatCount],
  ] as const) {
    const n = count(teacherId, t - WINDOW);
    if (n < step) continue;
    subjects[key] = n;
    const l = last(key);
    if (!l || count(teacherId, Math.max(l.at + 1, t - WINDOW)) >= step) due.push(key);
  }
  return { at: t, due, subjects, groups };
}

/* ---------------- 给它看的摘要 ---------------- */

/** 一份作业老师改的分：哪一项、助教给几分、老师改成几分，两边写的原因 */
function gradeLines(g: Group): string[] {
  const subs = db.all<{ items: string | null; ai_grade_id: number }>(
    `SELECT items, ai_grade_id FROM submissions WHERE assignment_id IN (${g.ids.map(() => '?').join(',')}) AND ai_grade_id IS NOT NULL AND items LIKE '%（老师改成 %' ORDER BY id`,
    ...g.ids,
  );
  const seen = new Map<string, number>();
  for (const s of subs) {
    const ai = gradeItems(db.value<string>('SELECT items FROM ai_grades WHERE id=?', s.ai_grade_id));
    const mine = gradeItems(s.items);
    for (const c of changedItems(ai, mine)) {
      const was = ai.find((x) => x.title === c.title);
      const line = `- ${c.title}：助教给 ${score(c.from)} 分，老师改成 ${score(c.to)} 分。${was?.why ? `助教写的：${oneLine(was.why, 120)}。` : ''}${c.why ? `老师写的：${oneLine(c.why, 120)}` : '老师没写原因'}`;
      seen.set(line, (seen.get(line) || 0) + 1);
    }
  }
  const lines = [...seen].map(([line, n]) => (n > 1 ? `${line}（${n} 份）` : line));
  return [`「${g.title}」（${g.classes.join('、')}）：助教批了 ${g.graded} 份，老师改了 ${g.changed} 份`, ...lines.slice(0, LIST_MAX)];
}

/** 学生来问、老师回了的：学生的原话，老师在卡片上怎么答的（老师在对话里回的是助教转告的话） */
function askLines(teacherId: number, since: number): string[] {
  return db
    .all<{ question: string; asked: string | null; reply: string | null; card_run_id: number | null; cls: string }>(
      `SELECT a.question, (SELECT request FROM kb_runs WHERE id=a.stu_run_id) AS asked, a.reply, a.card_run_id, c.name AS cls
       FROM student_asks a JOIN classes c ON c.id=a.class_id WHERE a.teacher_id=? AND a.status='replied' AND a.replied_at>=? ORDER BY a.id DESC LIMIT ?`,
      teacherId,
      since,
      LIST_MAX,
    )
    .reverse()
    .map((r) => {
      const card = r.card_run_id ? db.value<string>("SELECT data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", r.card_run_id) : null;
      const said = j<{ answered?: { a: string }[] | null }>(card, {}).answered?.[0]?.a || r.reply || '';
      return `- ${r.cls}的学生问：${oneLine(r.asked || r.question, 150)}；老师回：${oneLine(said, 150)}`;
    });
}

function chatLines(teacherId: number, since: number): string[] {
  return db
    .all<{ request: string; created_at: number }>(`SELECT r.request, r.created_at ${CHAT} ORDER BY r.id DESC LIMIT ?`, teacherId, since, LIST_MAX)
    .reverse()
    .map((r) => `- ${day(r.created_at)}：${oneLine(r.request, 150)}`);
}

/** 交给它批的作业，写成给助教看的样子：「标题」（哪几个班） */
function homeworkText(id: number | null): string {
  if (!id) return '';
  const h = db.get<{ title: string; created_at: number; teacher_id: number }>('SELECT title, created_at, teacher_id FROM assignments WHERE id=?', id);
  if (!h) return '';
  const classes = db
    .all<{ name: string }>(
      'SELECT c.name FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.teacher_id=? AND a.title=? AND a.created_at=? AND a.deleted_at IS NULL ORDER BY a.id',
      h.teacher_id,
      h.title,
      h.created_at,
    )
    .map((r) => r.name);
  return `「${h.title}」（${classes.join('、')}）`;
}

const proposalLine = (p: Pick<SuggestionRow, 'name' | 'duty' | 'homework_id'>) =>
  `「${p.name}」管：${p.duty}${p.homework_id ? `；批：${homeworkText(p.homework_id)}` : ''}`;

function digestOf(teacherId: number, p: Plan): string {
  const t = now();
  const parts = [`（现在是 ${nowLine(t)}）`];
  if (p.groups.length) parts.push(`老师改了助教批的分：\n${p.groups.flatMap(gradeLines).join('\n')}`);
  if (p.subjects.asks) parts.push(`学生来问、老师回了的：\n${askLines(teacherId, t - WINDOW).join('\n')}`);
  if (p.subjects.chat) parts.push(`老师跟你说的：\n${chatLines(teacherId, t - WINDOW).join('\n')}`);
  const list = specialistsOf(teacherId);
  if (list.length) {
    const hw = new Map<number, string[]>();
    for (const r of db.all<{ id: number; specialist_id: number }>(
      'SELECT id, specialist_id FROM assignments WHERE teacher_id=? AND specialist_id IS NOT NULL AND deleted_at IS NULL ORDER BY id',
      teacherId,
    ))
      hw.set(r.specialist_id, [...(hw.get(r.specialist_id) || []), homeworkText(r.id)]);
    parts.push(`你分出来的专门助手：\n${list.map((s) => `- 「${s.name}」管：${s.duty}${hw.get(s.id) ? `；批：${[...new Set(hw.get(s.id))].join('、')}` : ''}`).join('\n')}`);
  }
  const no = db.all<SuggestionRow>("SELECT * FROM specialist_suggestions WHERE teacher_id=? AND status='declined' ORDER BY id", teacherId);
  if (no.length) parts.push(`老师说过不用的：\n${no.map((r) => `- ${proposalLine(r)}`).join('\n')}`);
  return parts.join('\n\n');
}

/* ---------------- 看一眼 ---------------- */

const str = (description: string) => ({ type: 'string', description });

/** 改这里的话之前先用 tools/suggest-measure 的尺子量 */
export const suggestPrompt = (teacherName: string) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教。同一类活反复出现、每次要照同一套做法办时，可以分出一个专门助手。它只能翻老师的知识库，办完写出结果交回给你。
下面是老师最近办的事。有值得分出来的一类，用 suggest_specialist 问老师要不要分；没有就不用。`;

export const SUGGEST_TOOL: ToolSpec = {
  name: 'suggest_specialist',
  description: '问老师要不要分出这个专门助手：老师的对话里弹一张卡片，老师点「分出来」才分。',
  parameters: {
    type: 'object',
    properties: {
      question: str('问老师的话，一句话；老师点「分出来」或「先不用」答'),
      name: str('名字，照它管的活起'),
      duty: str('它管哪一类活，一句话'),
      guide: str('它怎么办：照老师的哪些做法、规矩，要注意什么'),
      homework: str('交给它批的作业标题：以后这份作业交上来的由它批；没有就不传'),
      class: str('作业在哪个班；同名作业在几个班时才填'),
    },
    required: ['question', 'name', 'duty', 'guide'],
  },
};

interface Proposal {
  name: string;
  duty: string;
  guide: string;
  question: string;
  homeworkId: number | null;
}

/** 它提的能不能用：缺东西、重名、作业对不上或者已经有专门助手批、老师说过不用的，返回原因 */
function proposalOf(teacherId: number, a: Record<string, unknown>): Proposal | string {
  const name = clean(a.name, 30),
    duty = clean(a.duty, 200),
    guide = clean(a.guide, 4000),
    question = clean(a.question, 300);
  if (!name || !duty || !question) return '名字、管什么、问老师的话都要写';
  if (specialistsOf(teacherId).some((s) => norm(s.name) === norm(name))) return `已经有叫「${name}」的专门助手了`;
  const declined = db.all<SuggestionRow>("SELECT * FROM specialist_suggestions WHERE teacher_id=? AND status='declined'", teacherId);
  if (declined.some((d) => norm(d.name) === norm(name))) return `老师说过不用分「${name}」`;
  let homeworkId: number | null = null;
  const title = clean(a.homework, 200);
  if (title) {
    let rows: { id: number; title: string }[];
    try {
      rows = findHomework(teacherId, title, clean(a.class, 80) || null).rows;
    } catch (err) {
      return (err as Error).message;
    }
    const bound = rows.filter((h) => graderOf({ teacher_id: teacherId, specialist_id: db.value<number>('SELECT specialist_id FROM assignments WHERE id=?', h.id) ?? null }));
    if (bound.length === rows.length) return `「${rows[0].title}」已经交给专门助手批了`;
    if (declined.some((d) => d.homework_id && rows.some((h) => h.id === d.homework_id))) return `老师说过「${rows[0].title}」不用分`;
    homeworkId = rows[0].id;
  }
  return { name, duty, guide, question, homeworkId };
}

/** 收起一张提议卡片：答了的记上答了什么；没答就过去了的（开了新会话又提了别的）标成没选 */
function closeCard(p: SuggestionRow, said: string | null) {
  if (!p.card_run_id) return;
  const run = db.get<{ status: string }>('SELECT status FROM kb_runs WHERE id=?', p.card_run_id);
  if (run?.status !== 'waiting') return;
  const ev = db.get<{ id: number; data: string }>("SELECT id, data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", p.card_run_id);
  if (ev) {
    const data = j<{ questions: { question: string }[] }>(ev.data, { questions: [] });
    db.update('kb_events', ev.id, { data: said ? { ...data, answered: [{ q: data.questions[0]?.question || '', a: said }] } : { ...data, skipped: true } });
  }
  db.update('kb_runs', p.card_run_id, { status: 'done', finished_at: now() });
  publishRun(null, p.card_run_id);
}

/** 老师现在那段会话（跟 runtime.ts 的 currentSession 一样，这里不引它，免得绕圈） */
const sessionNow = (teacherId: number) => db.value<number>('SELECT max(id) FROM ta_sessions WHERE owner_id=?', teacherId) ?? null;

/** 弹卡片：老师现在那段会话里，问题是它写的那句话，选项固定，带上提议的名字和管什么给页面显示 */
function postCard(teacherId: number, id: number, p: Proposal) {
  const runId = db.insert('kb_runs', {
    teacher_id: teacherId,
    agent: 'ta',
    kind: 'suggest',
    status: 'waiting',
    request: '',
    session_id: sessionNow(teacherId),
    created_by: teacherId,
    created_at: now(),
  });
  record({ teacherId, runId, kbId: null }, 'ask', {
    toolCallId: '',
    questions: [{ question: p.question, options: [YES, NO], multiple: false }],
    answered: null,
    suggest: { id, name: p.name, duty: p.duty },
  });
  db.update('specialist_suggestions', id, {
    status: 'waiting',
    name: p.name,
    duty: p.duty,
    guide: p.guide,
    question: p.question,
    homework_id: p.homeworkId,
    card_run_id: runId,
  });
  publishRun(null, runId);
}

const pendingRow = (teacherId: number) =>
  db.get<SuggestionRow>("SELECT * FROM specialist_suggestions WHERE teacher_id=? AND status='waiting' ORDER BY id DESC LIMIT 1", teacherId);

/** 看一眼：一次单独的模型调用，提了就弹卡片。返回提的那一条（没提是 null） */
async function look(teacherId: number, plan: Plan, older: SuggestionRow | undefined): Promise<SuggestionRow | null> {
  const teacher = db.get<{ name: string }>('SELECT name FROM users WHERE id=?', teacherId);
  if (!teacher) return null;
  const digest = digestOf(teacherId, plan);
  const id = db.insert('specialist_suggestions', {
    teacher_id: teacherId,
    status: 'looking',
    subjects: JSON.stringify(plan.subjects),
    due: plan.due.join(','),
    digest,
    created_at: plan.at,
  });
  const done = (patch: Record<string, unknown>) => db.update('specialist_suggestions', id, patch);
  try {
    const messages: Msg[] = [
      { role: 'system', content: suggestPrompt(teacher.name) },
      { role: 'user', content: digest },
    ];
    let said = '';
    for (let n = 0; n < MAX_STEPS; n++) {
      const r = await modelStep({
        agent: 'ta',
        purpose: 'ta:suggest',
        messages: [...messages],
        tools: [SUGGEST_TOOL],
        userId: teacherId,
        signal: new AbortController().signal,
        onText: () => {},
        waitMs: WAIT_MS,
      });
      said = r.text.trim() || said;
      const call = r.toolCalls.find((c) => c.name === SUGGEST_TOOL.name);
      if (!call) break;
      const p = proposalOf(teacherId, call.args || {});
      if (typeof p === 'string') {
        // 提的不行：告诉它为什么，它可以改了再提，也可以不提
        messages.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls, ...(r.reasoning ? { reasoning: r.reasoning } : {}) });
        for (const c of r.toolCalls) messages.push({ role: 'tool', toolCallId: c.id, content: c === call ? `没提成：${p}` : '一次只提一个' });
        continue;
      }
      // 以前那段会话里还挂着一张没答的：换成这一张（同一时间只挂一张）
      if (older) {
        closeCard(older, null);
        db.update('specialist_suggestions', older.id, { status: 'expired', answered_at: now() });
      }
      done({ reply: said || null });
      postCard(teacherId, id, p);
      return db.get<SuggestionRow>('SELECT * FROM specialist_suggestions WHERE id=?', id)!;
    }
    done({ status: 'none', reply: said || null });
    return null;
  } catch (err) {
    done({ status: 'error', error: (err as Error).message || '没看成' });
    throw err;
  }
}

/* ---------------- 什么时候看 ---------------- */

let auto = process.env.CT_SUGGEST_AUTO !== '0';
/** 连着改好几份时等这么久没新动静再看 */
let quietMs = 15_000;
/** 测试里关掉自动看（测试直接调 checkSuggestions），或者把等的时间改短 */
export function setSuggestAuto(on: boolean, quiet = 15_000) {
  auto = on;
  quietMs = quiet;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const looking = new Map<number, Promise<SuggestionRow | null>>();
const again = new Set<number>();

/** 老师改了分、回了学生、助教办完一轮：等一会儿没新动静再数 */
export function suggestSoon(teacherId: number) {
  if (!auto) return;
  clearTimeout(timers.get(teacherId));
  const t = setTimeout(() => {
    timers.delete(teacherId);
    checkSuggestions(teacherId).catch((err) => console.error('[suggest]', teacherId, err));
  }, quietMs);
  t.unref?.();
  timers.set(teacherId, t);
}

/**
 * 数一下，到了就看一眼。同一个老师同一时间只看一次：正在看就等它看完（看的时候又有新动静，看完再数一次）。
 * 现在这段会话里挂着一张提议卡片就不看。返回这回提的（没提是 null）。
 */
export function checkSuggestions(teacherId: number): Promise<SuggestionRow | null> {
  const running = looking.get(teacherId);
  if (running) {
    again.add(teacherId);
    return running;
  }
  const p = (async () => {
    const waiting = pendingRow(teacherId);
    if (waiting && db.value<number>('SELECT session_id FROM kb_runs WHERE id=?', waiting.card_run_id) === sessionNow(teacherId)) return null;
    const plan = planOf(teacherId);
    if (!plan.due.length) return null;
    return look(teacherId, plan, waiting);
  })().finally(() => {
    looking.delete(teacherId);
    if (again.delete(teacherId)) suggestSoon(teacherId);
  });
  looking.set(teacherId, p);
  return p;
}

/** 服务重启：看到一半的算没看成（下回有动静再数） */
export function recoverSuggestions() {
  db.run("UPDATE specialist_suggestions SET status='error', error='服务中断，没看完' WHERE status='looking'");
}

/* ---------------- 老师答了、助教分了 ---------------- */

/** 提议写成给助教看的话：分出谁、管什么、做法、交给它批的作业 */
export function proposalText(p: Pick<SuggestionRow, 'name' | 'duty' | 'guide' | 'homework_id'>) {
  const hw = homeworkText(p.homework_id);
  return `你提议分出专门助手「${p.name}」，管：${p.duty}${p.guide ? `；做法：${p.guide}` : ''}${hw ? `；交给它批：${hw}` : ''}`;
}

/** 还没答的提议：每轮带给助教，老师在对话里说「那个分了吧」它知道是哪个（没有就是 null） */
export function pendingSuggestionLine(teacherId: number): string | null {
  const p = pendingRow(teacherId);
  return p ? `（${proposalText(p)}，老师还没答）` : null;
}

/** 老师在卡片上答了：记下来，返回给助教的那句话（卡片上的提议对不上了就是 null） */
export function answerSuggestion(id: number, said: string): string | null {
  const p = db.get<SuggestionRow>('SELECT * FROM specialist_suggestions WHERE id=?', id);
  if (!p) return null;
  db.update('specialist_suggestions', id, {
    status: said === NO ? 'declined' : said === YES ? 'accepted' : 'answered',
    answer: said.slice(0, 500),
    answered_at: now(),
  });
  return `（${proposalText(p)}）\n老师在卡片上答：${said}`;
}

/**
 * 助教分出了一个专门助手：对得上挂着的提议（老师在对话里说分）、或者老师刚在卡片上点了分出来的那条，记上分的是哪个；
 * 挂着的卡片收起来。对得上：交给它批的作业一样，或者名字、管的事一样。
 */
export function suggestionTaken(teacherId: number, s: { id: number; name: string; duty: string }, homeworkIds: number[], said: string) {
  const rows = db.all<SuggestionRow>(
    "SELECT * FROM specialist_suggestions WHERE teacher_id=? AND specialist_id IS NULL AND status IN ('waiting','accepted','answered') ORDER BY id DESC LIMIT 5",
    teacherId,
  );
  const p = rows.find(
    (r) => (r.homework_id !== null && homeworkIds.includes(r.homework_id)) || norm(r.name) === norm(s.name) || (!!r.duty && norm(r.duty) === norm(s.duty)),
  );
  if (!p) return;
  if (p.status === 'waiting') closeCard(p, YES);
  db.update('specialist_suggestions', p.id, {
    status: 'accepted',
    specialist_id: s.id,
    ...(p.status === 'waiting' ? { answer: said.slice(0, 500), answered_at: now() } : {}),
  });
}

/**
 * 备课。
 * 一节课一份：学情、教案、课件、课堂练习、课后作业。助教几手分头做（make.ts），老师在页面上直接改、跟助教说着改、撤回、
 * 放映、导出，课后作业一点发到班里接上批改。每次改都留一版，撤回就退到上一版。
 */
import { db, j, now } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import { classRow, toNum, type RubricItem } from '../grading/common.js';
import { insightsOf, type InsightPoint } from '../grading/insights.js';
import { cleanSlideHtml } from './kit.js';

/* ---------------- 教案 ---------------- */

export interface PlanStep {
  name: string;
  minutes: number | null;
  content: string;
}
export interface Plan {
  title: string;
  goals: string[];
  focus: string;
  hard: string;
  review: string;
  steps: PlanStep[];
  board: string;
  sources: string[];
}

const text = (v: unknown, n: number) =>
  String(v ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, n);
const list = (v: unknown, n: number, each: number) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [])
    .map((x) => text(x, each))
    .filter(Boolean)
    .slice(0, n);

export function cleanPlan(raw: any): Plan {
  const title = text(raw?.title, 80);
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, 14).map((s: any) => {
    const m = Math.round(toNum(s?.minutes));
    return { name: text(s?.name, 40), minutes: Number.isFinite(m) && m > 0 && m <= 240 ? m : null, content: text(s?.content, 2500) };
  });
  if (!title || !steps.some((s: PlanStep) => s.content)) throw new Error('课题和教学过程都要写');
  return {
    title,
    goals: list(raw?.goals, 8, 300),
    focus: text(raw?.focus, 800),
    hard: text(raw?.hard, 800),
    review: text(raw?.review, 1500),
    steps: steps.filter((s: PlanStep) => s.content),
    board: text(raw?.board, 1500),
    sources: list(raw?.sources, 12, 200),
  };
}

/* ---------------- 课件 ---------------- */

export const LAYOUTS = ['cover', 'section', 'points', 'code', 'compare', 'steps', 'quiz', 'table', 'quote', 'summary'] as const;
export type SlideLayout = (typeof LAYOUTS)[number];
export interface Slide {
  id: string;
  layout: SlideLayout;
  title: string;
  subtitle?: string;
  points?: string[];
  code?: { lang: string; text: string; caption?: string };
  compare?: { left: { head: string; points: string[] }; right: { head: string; points: string[] } };
  steps?: { head: string; text?: string }[];
  quiz?: { question: string; options: string[]; answer: number[]; explain?: string };
  table?: { head: string[]; rows: string[][] };
  quote?: { text: string; by?: string };
  notes?: string;
  /** 做成幻灯片的这一页（模型照课件样式写的 HTML，画布 1280×720）；没有就按上面的内容和版式显示 */
  html?: string;
}
export interface Deck {
  theme: string;
  slides: Slide[];
}

const newId = () => Math.random().toString(36).slice(2, 10);
/** 选项前面它自己写的「A.」「(B)」「C、」去掉（页面上另外标字母） */
export const bareOption = (s: string) => s.replace(/^\s*[（(]?[A-Ha-h][)）.．、:：]\s*/, '');
const options = (v: unknown) => list(v, 6, 300).map(bareOption).filter(Boolean);

/** 选择题答案：模型写字母（B、AC），页面存序号（0 起） */
export function answerIndexes(v: unknown, count: number): number[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : String(v ?? '').toUpperCase().match(/[A-H]|\d+/g) || [];
  const out = raw
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x.toUpperCase().charCodeAt(0) - 65))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < count);
  return [...new Set(out)].sort((a, b) => a - b);
}

export function cleanSlide(raw: any): Slide {
  const layout: SlideLayout = LAYOUTS.includes(raw?.layout) ? raw.layout : 'points';
  const s: Slide = { id: text(raw?.id, 20) || newId(), layout, title: text(raw?.title, 80) };
  const sub = text(raw?.subtitle, 160);
  if (sub) s.subtitle = sub;
  const points = list(raw?.points, 8, 200);
  if (points.length) s.points = points;
  if (raw?.code && (raw.code.text || typeof raw.code === 'string')) {
    const c = typeof raw.code === 'string' ? { text: raw.code } : raw.code;
    s.code = { lang: text(c.lang, 20) || 'python', text: String(c.text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '').slice(0, 4000) };
    const cap = text(c.caption, 200);
    if (cap) s.code.caption = cap;
  }
  if (raw?.compare) {
    const side = (x: any) => ({ head: text(x?.head, 40), points: list(x?.points, 6, 160) });
    s.compare = { left: side(raw.compare.left), right: side(raw.compare.right) };
  }
  const steps = (Array.isArray(raw?.steps) ? raw.steps : [])
    .slice(0, 6)
    .map((x: any) => ({ head: text(x?.head ?? x, 40), ...(text(x?.text, 200) ? { text: text(x?.text, 200) } : {}) }))
    .filter((x: { head: string }) => x.head);
  if (steps.length) s.steps = steps;
  if (raw?.quiz?.question) {
    const opts = options(raw.quiz.options);
    s.quiz = { question: text(raw.quiz.question, 400), options: opts, answer: answerIndexes(raw.quiz.answer, opts.length) };
    const ex = text(raw.quiz.explain, 500);
    if (ex) s.quiz.explain = ex;
  }
  if (raw?.table && Array.isArray(raw.table.head)) {
    const head = list(raw.table.head, 6, 40);
    const rows = (Array.isArray(raw.table.rows) ? raw.table.rows : [])
      .slice(0, 8)
      .map((r: unknown) => (Array.isArray(r) ? r : []).slice(0, head.length).map((c) => text(c, 120)));
    if (head.length) s.table = { head, rows };
  }
  if (raw?.quote?.text) s.quote = { text: text(raw.quote.text, 300), ...(text(raw.quote.by, 60) ? { by: text(raw.quote.by, 60) } : {}) };
  const notes = text(raw?.notes, 2000);
  if (notes) s.notes = notes;
  const html = raw?.html ? cleanSlideHtml(raw.html) : '';
  if (html) s.html = html;
  if (!s.title && !s.points && !s.code && !s.quiz && !s.html) throw new Error('这一页是空的');
  return s;
}

export function cleanDeck(raw: any): Deck {
  const slides = (Array.isArray(raw?.slides) ? raw.slides : Array.isArray(raw) ? raw : []).slice(0, 40).map(cleanSlide);
  if (!slides.length) throw new Error('课件一页都没有');
  return { theme: text(raw?.theme, 20) || 'violet', slides };
}

/* ---------------- 题目 ---------------- */

export const QTYPES = ['single', 'multi', 'judge', 'blank', 'short', 'code'] as const;
export type QType = (typeof QTYPES)[number];
export interface Question {
  id: string;
  type: QType;
  stem: string;
  code?: string;
  options?: string[];
  /** 选择题：选项序号（0 起）；判断：「对」「错」；其他：参考答案 */
  answer: string;
  choice?: number[];
  explain?: string;
  points?: number;
  rubric?: string;
}

export function cleanQuestion(raw: any, withPoints: boolean): Question {
  const type: QType = QTYPES.includes(raw?.type) ? raw.type : Array.isArray(raw?.options) && raw.options.length ? 'single' : 'short';
  const q: Question = { id: text(raw?.id, 20) || newId(), type, stem: text(raw?.stem ?? raw?.question, 1500), answer: '' };
  if (!q.stem) throw new Error('题干是空的');
  const code = String(raw?.code ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
    .slice(0, 3000);
  if (code) q.code = code;
  if (type === 'single' || type === 'multi') {
    q.options = options(raw?.options);
    if (q.options.length < 2) throw new Error(`「${q.stem.slice(0, 20)}」选项不够`);
    q.choice = answerIndexes(raw?.choice ?? raw?.answer, q.options.length);
    q.answer = q.choice.map((n) => String.fromCharCode(65 + n)).join('');
  } else if (type === 'judge') {
    q.answer = /错|false|×|否|f\b/i.test(String(raw?.answer ?? '')) ? '错' : '对';
  } else q.answer = text(raw?.answer, 3000);
  const ex = text(raw?.explain, 1500);
  if (ex) q.explain = ex;
  if (withPoints) {
    const p = toNum(raw?.points);
    q.points = Number.isFinite(p) && p > 0 ? Math.round(p * 2) / 2 : 10;
    const rb = text(raw?.rubric, 1500);
    if (rb) q.rubric = rb;
  }
  return q;
}

export function cleanQuestions(raw: unknown, withPoints: boolean): Question[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 20).map((x) => cleanQuestion(x, withPoints));
}

/* ---------------- 学情 ---------------- */

export interface Brief {
  points: Pick<InsightPoint, 'title' | 'what' | 'teach' | 'lost' | 'asked' | 'homework'>[];
  basis: { graded: number; asks: number } | null;
  updatedAt: number | null;
}
export function briefOf(classId: number): Brief {
  const ins = insightsOf(classId);
  return {
    points: ins.points.slice(0, 6).map((p) => ({ title: p.title, what: p.what, teach: p.teach, lost: p.lost, asked: p.asked, homework: p.homework })),
    basis: ins.basis ? { graded: (ins.basis as any).graded ?? 0, asks: (ins.basis as any).asks ?? 0 } : null,
    updatedAt: ins.updatedAt,
  };
}

/* ---------------- 一节课 ---------------- */

export type Part = 'plan' | 'deck' | 'practice' | 'homework';
export const PARTS: Part[] = ['plan', 'deck', 'practice', 'homework'];
export type LaneKey = 'brief' | 'plan' | 'deck' | 'questions' | 'check';
export interface Lane {
  status: 'wait' | 'doing' | 'done' | 'error' | 'skip';
  note?: string;
  at?: number;
}
export const LANE_NAMES: Record<LaneKey, string> = { brief: '学情', plan: '教案', deck: '课件', questions: '练习和作业', check: '核对' };

export interface LessonRow {
  id: number;
  teacher_id: number;
  class_id: number;
  title: string | null;
  request: string | null;
  minutes: number | null;
  status: 'making' | 'ready' | 'error';
  brief: string | null;
  plan: string | null;
  deck: string | null;
  practice: string | null;
  homework: string | null;
  lanes: string | null;
  assignment_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export const lessonRow = (id: number) => db.get<LessonRow>('SELECT * FROM lessons WHERE id=? AND deleted_at IS NULL', id);

export function ownLesson(teacherId: number, id: number): LessonRow {
  const r = lessonRow(id);
  if (!r || r.teacher_id !== teacherId) throw notFound('这节课不在了');
  return r;
}

export const lanesOf = (r: Pick<LessonRow, 'lanes'>) => j<Partial<Record<LaneKey, Lane>>>(r.lanes, {});
export function setLane(id: number, key: LaneKey, lane: Lane) {
  const r = db.get<{ lanes: string | null }>('SELECT lanes FROM lessons WHERE id=?', id);
  if (!r) return;
  db.update('lessons', id, { lanes: JSON.stringify({ ...lanesOf(r), [key]: { ...lane, at: now() } }), updated_at: now() });
}

/** 存一份（老师在页面上改的、助教改的、助教做出来的），留一版给撤回 */
export function savePart(id: number, part: Part, data: unknown, by: 'teacher' | 'ta', note?: string) {
  const json = JSON.stringify(data);
  const patch: Record<string, unknown> = { [part]: json, updated_at: now() };
  if (part === 'plan') patch.title = (data as Plan).title;
  db.update('lessons', id, patch);
  db.insert('lesson_versions', { lesson_id: id, part, data: json, by, note: note ?? null, created_at: now() });
}

/** 并进最近那一版（同一次改动里后补的东西，撤回一次就一起回去） */
export function amendPart(id: number, part: Part, data: unknown) {
  const json = JSON.stringify(data);
  db.update('lessons', id, { [part]: json, updated_at: now() });
  const last = db.value<number>('SELECT max(id) FROM lesson_versions WHERE lesson_id=? AND part=?', id, part);
  if (last) db.update('lesson_versions', last, { data: json });
  else db.insert('lesson_versions', { lesson_id: id, part, data: json, by: 'ta', created_at: now() });
}

/** 撤回：退到这一份的上一版（没有上一版就不动） */
export function undoPart(id: number, part: Part) {
  const vs = db.all<{ id: number; data: string | null }>('SELECT id, data FROM lesson_versions WHERE lesson_id=? AND part=? ORDER BY id DESC LIMIT 2', id, part);
  if (vs.length < 2) throw bad('没有更早的版本了');
  db.run('DELETE FROM lesson_versions WHERE id=?', vs[0].id);
  const patch: Record<string, unknown> = { [part]: vs[1].data, updated_at: now() };
  if (part === 'plan') patch.title = j<Plan | null>(vs[1].data, null)?.title ?? null;
  db.update('lessons', id, patch);
}

const versionsOf = (id: number) =>
  Object.fromEntries(
    db
      .all<{ part: string; n: number; last: string; at: number }>(
        'SELECT part, count(*) AS n, (SELECT by FROM lesson_versions v2 WHERE v2.lesson_id=v.lesson_id AND v2.part=v.part ORDER BY id DESC LIMIT 1) AS last, max(created_at) AS at FROM lesson_versions v WHERE lesson_id=? GROUP BY part',
        id,
      )
      .map((v) => [v.part, { count: v.n, lastBy: v.last, at: v.at }]),
  );

/** 给页面的样子 */
export function lessonView(r: LessonRow, full: boolean) {
  const k = classRow(r.class_id);
  const deck = j<Deck | null>(r.deck, null);
  const practice = j<Question[] | null>(r.practice, null);
  const homework = j<Question[] | null>(r.homework, null);
  const plan = j<Plan | null>(r.plan, null);
  const base = {
    id: r.id,
    classId: r.class_id,
    className: k?.name || '',
    title: r.title || plan?.title || r.request || '',
    request: r.request,
    minutes: r.minutes,
    status: r.status,
    error: r.error,
    lanes: lanesOf(r),
    counts: { slides: deck?.slides.length ?? 0, practice: practice?.length ?? 0, homework: homework?.length ?? 0 },
    cover: deck ? { theme: deck.theme, slide: deck.slides[0] } : null,
    assignmentId: r.assignment_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (!full) return base;
  return {
    ...base,
    brief: j<Brief | null>(r.brief, null),
    plan,
    deck,
    practice,
    homework,
    versions: versionsOf(r.id),
  };
}

/* ---------------- 发到班里 ---------------- */

const letters = (n: number) => String.fromCharCode(65 + n);

/** 作业要求：题目一道一道写出来（学生看的，不带答案） */
export function homeworkBody(qs: Question[]) {
  return qs
    .map((q, i) => {
      const lines = [`**第 ${i + 1} 题**（${q.points ?? 10} 分）${q.stem}`];
      if (q.code) lines.push('```python\n' + q.code + '\n```');
      if (q.options?.length) lines.push(q.options.map((o, k) => `${letters(k)}. ${o}`).join('\n'));
      return lines.join('\n\n');
    })
    .join('\n\n');
}

/** 评分标准：一题一项，带参考答案（只给老师和批改的助教看） */
export function homeworkRubric(qs: Question[]): RubricItem[] {
  return qs.map((q, i) => ({
    title: `第${i + 1}题`,
    points: q.points ?? 10,
    criteria: q.rubric || (q.options?.length ? '选对给满分，选错不给分' : '照参考答案给分，思路对、结果有小错酌情给分'),
    answer: [q.answer, q.explain].filter(Boolean).join('\n'),
  }));
}

/* ---------------- 教案下载成 Word ---------------- */

export async function lessonDocx(r: LessonRow): Promise<{ name: string; bytes: Buffer }> {
  const p = j<Plan | null>(r.plan, null);
  if (!p) throw bad('教案还没写好');
  const practice = j<Question[]>(r.practice, []);
  const homework = j<Question[]>(r.homework, []);
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = await import('docx');
  // 它写的加粗、代码记号（** 和 `）Word 里不要
  const plain = (t: string) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  const para = (t: string, o: { bold?: boolean; color?: string; mono?: boolean } = {}) =>
    new Paragraph({
      spacing: { after: 120, line: 360 },
      children: [new TextRun({ text: o.mono ? t : plain(t), bold: o.bold, color: o.color, font: o.mono ? 'Consolas' : undefined })],
    });
  const h = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, bold: true })] });
  const cell = (t: string, bold = false) => new TableCell({ children: t.split('\n').map((x) => new Paragraph({ children: [new TextRun({ text: plain(x), bold })] })) });
  const k = classRow(r.class_id);
  const children: any[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 120 }, children: [new TextRun({ text: p.title, bold: true, size: 36 })] }),
    para([k?.name, r.minutes ? `${r.minutes} 分钟` : ''].filter(Boolean).join(' · '), { color: '666666' }),
  ];
  if (p.goals.length) {
    children.push(h('教学目标'));
    p.goals.forEach((g, i) => children.push(para(`${i + 1}. ${g}`)));
  }
  if (p.focus) children.push(h('教学重点'), para(p.focus));
  if (p.hard) children.push(h('教学难点'), para(p.hard));
  if (p.review) children.push(h('开头补讲'), ...p.review.split('\n').map((x) => para(x)));
  if (p.steps.length) {
    children.push(h('教学过程'));
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [cell('环节', true), cell('时间', true), cell('内容', true)] }),
          ...p.steps.map((s) => new TableRow({ children: [cell(s.name), cell(s.minutes ? `${s.minutes} 分钟` : ''), cell(s.content)] })),
        ],
      }),
    );
  }
  if (p.board) children.push(h('板书设计'), ...p.board.split('\n').map((x) => para(x)));
  const questions = (title: string, qs: Question[]) => {
    if (!qs.length) return;
    children.push(h(title));
    qs.forEach((q, i) => {
      children.push(para(`${i + 1}. ${q.stem}${q.points ? `（${q.points} 分）` : ''}`));
      if (q.code) q.code.split('\n').forEach((x) => children.push(para(x, { mono: true })));
      q.options?.forEach((o, n) => children.push(para(`${letters(n)}. ${o}`)));
    });
    children.push(para('参考答案', { bold: true }));
    qs.forEach((q, i) => children.push(para(`${i + 1}. ${q.answer}${q.explain ? `　${q.explain}` : ''}`, { color: '444444' })));
  };
  questions('课堂练习', practice);
  questions('课后作业', homework);
  if (p.sources.length) children.push(h('用到的资料'), para(p.sources.join('、'), { color: '666666' }));
  const doc = new Document({ styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } } }, sections: [{ properties: {}, children }] });
  return { name: `${p.title}-教案.docx`.replace(/[\\/:*?"<>|]/g, ''), bytes: await Packer.toBuffer(doc) };
}

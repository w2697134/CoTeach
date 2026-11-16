/**
 * 讲评（2026-11-16）：一份作业批完，助教给老师写讲评。数字（交了几个、平均分、分数段、各项得分率、谁没交、哪几份很像）程序算；
 * 错得多的几类问题、为什么会错、下节课怎么讲、做得好的，助教写。老师能下载 Word；点「发给学生」，学生看到不带名字的那一版，
 * 同时放进班级资料包，学伴就知道大家常错在哪。
 */
import { db, j, now } from '../db/index.js';
import { bad } from '../lib/http.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { dropPack, putPack, teacherTitle } from '../assistant/pack.js';
import {
  agentLoop,
  assignmentRow,
  classRow,
  finishRun,
  gradeItems,
  gradeMarks,
  numArg,
  obj,
  showNum,
  startRun,
  str,
  toNum,
  userName,
  type SubmissionRow,
} from './common.js';
import { latestGrades } from './grader.js';
import { rubricOf } from './rubric.js';
import { similarPairs, type SimilarPair } from './similar.js';

export interface ReviewStats {
  total: number;
  submitted: number;
  graded: number;
  avg: number | null;
  max: number | null;
  min: number | null;
  points: number;
  /** 分数段（按百分制）：不及格、60–69、70–79、80–89、90 以上 */
  buckets: { label: string; n: number }[];
  /** 每一项的平均得分 */
  items: { title: string; points: number; avg: number | null }[];
  /** 还没交的（过了截止是缺交） */
  missing: string[];
  similar: { names: [string, string]; ratio: number }[];
}
export interface ReviewError {
  title: string;
  item: number | null;
  students: string[];
  why: string;
  teach: string;
  example: string;
}
export interface ReviewWrite {
  summary: string;
  errors: ReviewError[];
  good: { student: string; why: string }[];
  next: string;
}
export interface Review {
  status: 'writing' | 'ready' | 'error';
  stats: ReviewStats | null;
  write: ReviewWrite | null;
  error: string | null;
  sharedAt: number | null;
  updatedAt: number;
  /** 写的时候批了几份：之后又批了新的，页面上提示可以重写 */
  gradedAtWrite: number;
}

const BUCKETS = [
  { label: '90 以上', lo: 90, hi: Infinity },
  { label: '80–89', lo: 80, hi: 90 },
  { label: '70–79', lo: 70, hi: 80 },
  { label: '60–69', lo: 60, hi: 70 },
  { label: '不及格', lo: -Infinity, hi: 60 },
];

/** 交上来的、批过的（发出去的分）：程序算的那些数 */
export async function reviewStats(assignmentId: number): Promise<ReviewStats> {
  const a = assignmentRow(assignmentId);
  if (!a) throw bad('这份作业不存在');
  const members = db.all<{ user_id: number | null; name: string }>('SELECT user_id, name FROM class_students WHERE class_id=? ORDER BY student_no, id', a.class_id);
  const subs = new Map(
    db.all<SubmissionRow>('SELECT * FROM submissions WHERE assignment_id=?', a.id).map((s) => [s.user_id, s] as const),
  );
  const joined = members.filter((m) => m.user_id !== null);
  const mine = joined.map((m) => subs.get(m.user_id!)).filter((s): s is SubmissionRow => !!s);
  const graded = mine.filter((s) => s.score !== null && !(s.returned_at && s.returned_at >= s.submitted_at));
  const scores = graded.map((s) => s.score!);
  const pct = (x: number) => (x / a.points) * 100;
  const r = rubricOf(a.id);
  const items = (r?.items || []).map((it, k) => {
    const got = graded.map((s) => gradeItems(s.items)[k]?.got).filter((x): x is number => typeof x === 'number');
    return { title: it.title, points: it.points, avg: got.length ? Math.round((got.reduce((n, x) => n + x, 0) / got.length) * 10) / 10 : null };
  });
  const pairs = await similarPairs(a.id).catch(() => [] as SimilarPair[]);
  return {
    total: members.length,
    submitted: mine.length,
    graded: graded.length,
    avg: scores.length ? Math.round((scores.reduce((n, x) => n + x, 0) / scores.length) * 10) / 10 : null,
    max: scores.length ? Math.max(...scores) : null,
    min: scores.length ? Math.min(...scores) : null,
    points: a.points,
    buckets: BUCKETS.map((b) => ({ label: b.label, n: scores.filter((x) => pct(x) >= b.lo && pct(x) < b.hi).length })),
    items,
    missing: members.filter((m) => m.user_id === null || !subs.has(m.user_id)).map((m) => m.name),
    similar: pairs.slice(0, 12).map((p) => ({ names: p.names, ratio: p.ratio })),
  };
}

export function reviewOf(assignmentId: number): Review | null {
  const r = db.get<{ status: Review['status']; data: string | null; error: string | null; shared_at: number | null; updated_at: number }>(
    'SELECT status, data, error, shared_at, updated_at FROM hw_reviews WHERE assignment_id=?',
    assignmentId,
  );
  if (!r) return null;
  const d = j<{ stats?: ReviewStats; write?: ReviewWrite; graded?: number }>(r.data, {});
  return { status: r.status, stats: d.stats ?? null, write: d.write ?? null, error: r.error, sharedAt: r.shared_at, updatedAt: r.updated_at, gradedAtWrite: d.graded ?? 0 };
}

function upsert(assignmentId: number, fields: Record<string, string | number | null>) {
  const t = now();
  if (db.get('SELECT assignment_id FROM hw_reviews WHERE assignment_id=?', assignmentId)) {
    const keys = Object.keys(fields);
    db.run(`UPDATE hw_reviews SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE assignment_id=?`, ...keys.map((k) => fields[k]), t, assignmentId);
  } else db.insert('hw_reviews', { assignment_id: assignmentId, status: 'writing', created_at: t, updated_at: t, ...fields });
}

export const reviewPrompt = (teacherName: string) => `你是${teacherTitle(teacherName)}的 CoT 助教。一份作业批完了，你给老师写讲评。`;

const SAVE_REVIEW: ToolSpec = {
  name: 'save_review',
  description: '存讲评，再存一次就换成新的。',
  parameters: obj(
    {
      summary: str('一两句话说这次作业整体怎么样'),
      errors: {
        type: 'array',
        description: '错得多的几类问题，多的在前',
        items: obj(
          {
            title: str('一句话说是什么错'),
            item: numArg('主要扣在评分标准第几项'),
            students: { type: 'array', items: { type: 'string' }, description: '错了这个的学生名字' },
            why: str('为什么会错'),
            teach: str('下节课怎么讲'),
            example: str('从学生原文里摘一段典型的'),
          },
          ['title', 'students', 'why', 'teach'],
        ),
      },
      good: { type: 'array', items: obj({ student: str('学生名字'), why: str('好在哪') }, ['student', 'why']), description: '做得好的' },
      next: str('下节课最该讲的'),
    },
    ['summary', 'errors', 'next'],
  ),
};

/** 给助教看的材料：每项扣分的原因、批注里划出的问题、学生问学伴的问题（谁说的都带名字，给老师的讲评要用） */
function material(assignmentId: number, stats: ReviewStats) {
  const a = assignmentRow(assignmentId)!;
  const k = classRow(a.class_id)!;
  const r = rubricOf(a.id);
  const subs = db.all<SubmissionRow & { name: string }>(
    `SELECT s.*, u.name FROM submissions s JOIN users u ON u.id=s.user_id JOIN class_students m ON m.class_id=? AND m.user_id=s.user_id
     WHERE s.assignment_id=? AND s.score IS NOT NULL ORDER BY s.score DESC`,
    a.class_id,
    a.id,
  );
  const lines: string[] = [
    `「${k.name}」的作业「${a.title}」，满分 ${showNum(a.points)} 分。`,
    `要求：${a.body.trim().slice(0, 3000) || '（没写要求）'}`,
    `班里 ${stats.total} 人，交了 ${stats.submitted} 人，批了 ${stats.graded} 份，平均 ${stats.avg ?? '—'} 分，最高 ${stats.max ?? '—'}，最低 ${stats.min ?? '—'}。`,
  ];
  if (r?.items.length) {
    lines.push('', '评分标准和各项平均得分：');
    r.items.forEach((it, i) => lines.push(`${i + 1}. ${it.title}（${showNum(it.points)} 分，平均得 ${stats.items[i]?.avg ?? '—'} 分）：${it.criteria}`));
  }
  lines.push('', '每个学生的得分和扣分原因：');
  for (const s of subs) {
    const items = gradeItems(s.items);
    const lost = items.map((x, i) => (x.got < x.max ? `第${i + 1}项 ${showNum(x.got)}/${showNum(x.max)}：${x.why}` : '')).filter(Boolean);
    lines.push(`- ${s.name} ${showNum(s.score!)} 分${lost.length ? `；${lost.join('；')}` : '；没有扣分'}`);
  }
  const marks: string[] = [];
  const graded = latestGrades(a.id);
  for (const s of subs) {
    const g = s.ai_grade_id ? db.get<{ marks: string | null }>('SELECT marks FROM ai_grades WHERE id=?', s.ai_grade_id) : graded.get(s.user_id);
    for (const m of gradeMarks(g?.marks).filter((m) => m.kind === 'wrong').slice(0, 3)) marks.push(`- ${s.name}：「${m.quote.slice(0, 120)}」→ ${m.note}`);
    if (marks.length >= 80) break;
  }
  if (marks.length) lines.push('', '批注里划出的问题：', ...marks);
  const asks = db.all<{ request: string; name: string }>(
    `SELECT r.request, u.name FROM kb_runs r JOIN users u ON u.id=r.teacher_id
     WHERE r.agent='stu' AND r.kind='chat' AND r.class_ids LIKE ? AND r.created_at>=? ORDER BY r.id DESC LIMIT 40`,
    `%${a.class_id}%`,
    a.publish_at,
  );
  const mine = asks.filter((x) => (x.request || '').trim());
  if (mine.length) lines.push('', '这份作业发布以后学生问学伴的（跟这份作业有关的才用）：', ...mine.map((x) => `- ${x.name}：${x.request.trim().slice(0, 200)}`));
  lines.push(
    '',
    '写讲评：错得多的几类问题（每类：是什么错、哪些学生、为什么会错、下节课怎么讲，摘一段典型的原文），做得好的学生和好在哪，下节课最该讲的。用 save_review 存。',
  );
  return lines.join('\n');
}

function cleanWrite(raw: any, names: Set<string>): ReviewWrite {
  const errors: ReviewError[] = (Array.isArray(raw?.errors) ? raw.errors : []).slice(0, 8).map((e: any) => {
    const item = Math.round(toNum(e?.item));
    return {
      title: String(e?.title ?? '').trim().slice(0, 120),
      item: Number.isFinite(item) && item > 0 ? item : null,
      students: [...new Set((Array.isArray(e?.students) ? e.students : []).map((x: unknown) => String(x ?? '').trim()).filter((x: string) => names.has(x)))] as string[],
      why: String(e?.why ?? '').trim().slice(0, 1500),
      teach: String(e?.teach ?? '').trim().slice(0, 1500),
      example: String(e?.example ?? '').trim().slice(0, 600),
    };
  });
  if (!errors.length && !String(raw?.summary ?? '').trim()) throw new Error('讲评是空的');
  return {
    summary: String(raw?.summary ?? '').trim().slice(0, 1000),
    errors: errors.filter((e) => e.title),
    good: (Array.isArray(raw?.good) ? raw.good : [])
      .slice(0, 8)
      .map((g: any) => ({ student: String(g?.student ?? '').trim(), why: String(g?.why ?? '').trim().slice(0, 600) }))
      .filter((g: { student: string; why: string }) => names.has(g.student) && g.why),
    next: String(raw?.next ?? '').trim().slice(0, 1500),
  };
}

const writing = new Map<number, Promise<void>>();
/** 写讲评（后台）：同一份作业同时只写一份 */
export function writeReview(assignmentId: number, signal?: AbortSignal): Promise<void> {
  const busy = writing.get(assignmentId);
  if (busy) return busy;
  const p = (async () => {
    const a = assignmentRow(assignmentId);
    const k = a && classRow(a.class_id);
    if (!a || !k) return;
    upsert(assignmentId, { status: 'writing', error: null });
    const stats = await reviewStats(assignmentId);
    if (!stats.graded) {
      upsert(assignmentId, { status: 'error', error: '还没有批好的作业' });
      return;
    }
    const names = new Set(
      db
        .all<{ name: string }>('SELECT u.name FROM submissions s JOIN users u ON u.id=s.user_id WHERE s.assignment_id=?', assignmentId)
        .map((x) => x.name),
    );
    const runId = startRun(a.teacher_id, 'review', `给「${k.name}」的「${a.title}」写讲评`, a.class_id);
    const ctrl = signal ?? new AbortController().signal;
    let saved: ReviewWrite | null = null;
    try {
      await agentLoop({
        teacherId: a.teacher_id,
        runId,
        system: reviewPrompt(userName(a.teacher_id)),
        first: material(assignmentId, stats),
        tools: [SAVE_REVIEW],
        purpose: 'grader:review',
        maxSteps: 3,
        signal: ctrl,
        nudge: '用 save_review 把讲评存下来。',
        done: () => !!saved,
        run: async (call: ToolCall) => {
          if (call.name !== 'save_review') return `没有「${call.name}」这个工具`;
          saved = cleanWrite(call.args || {}, names);
          return '存好了';
        },
      });
      const w = saved as ReviewWrite | null;
      if (!w) throw new Error('助教没写出讲评');
      upsert(assignmentId, { status: 'ready', data: JSON.stringify({ stats, write: w, graded: stats.graded }), error: null });
      finishRun(runId, 'done', w.summary);
      // 已经发给学生的：学生那一版跟着换
      if (reviewOf(assignmentId)?.sharedAt) packReview(assignmentId);
    } catch (err) {
      const msg = (err as Error).message || '没写成';
      upsert(assignmentId, { status: 'error', error: msg });
      finishRun(runId, 'error', '', msg);
    }
  })().finally(() => writing.delete(assignmentId));
  writing.set(assignmentId, p);
  return p;
}

/** 班里同学的名字（老师名单上的和账号上的），长的在前 */
function classNames(classId: number) {
  const names = db
    .all<{ a: string | null; b: string | null }>('SELECT m.name AS a, u.name AS b FROM class_students m LEFT JOIN users u ON u.id=m.user_id WHERE m.class_id=?', classId)
    .flatMap((x) => [x.a, x.b])
    .filter((x): x is string => !!x && x.trim().length >= 2);
  return [...new Set(names)].sort((x, y) => y.length - x.length);
}
/** 学生看的那一版里出现同学的名字一律换掉（助教写的「为什么会错」有时会点名，程序兜住） */
export const scrubNames = (text: string, names: string[]) => names.reduce((t, n) => t.split(n).join('有同学'), text);

/** 学生看的那一版：不带名字，不带「下节课怎么讲」 */
export function studentReview(assignmentId: number) {
  const r = reviewOf(assignmentId);
  if (!r || !r.sharedAt || !r.write) return null;
  const a = assignmentRow(assignmentId);
  const names = a ? classNames(a.class_id) : [];
  const clean = (t: string) => scrubNames(t, names);
  return {
    summary: clean(r.write.summary),
    errors: r.write.errors.map((e) => ({ title: clean(e.title), why: clean(e.why), n: e.students.length })),
    avg: r.stats?.avg ?? null,
    points: r.stats?.points ?? null,
    sharedAt: r.sharedAt,
  };
}

/** 发给学生的讲评也放进班级资料包：学伴就知道大家常错在哪 */
function packReview(assignmentId: number) {
  const a = assignmentRow(assignmentId);
  const s = studentReview(assignmentId);
  if (!a || !s) return;
  const body = [s.summary, ...s.errors.map((e, i) => `${i + 1}. ${e.title}（${e.n} 人）：${e.why}`)].filter(Boolean).join('\n');
  putPack(a.class_id, 'notice', `「${a.title}」讲评`, body);
}

export function shareReview(assignmentId: number, on: boolean) {
  const r = reviewOf(assignmentId);
  if (!r || r.status !== 'ready') throw bad('讲评还没写好');
  const a = assignmentRow(assignmentId)!;
  upsert(assignmentId, { shared_at: on ? now() : null });
  if (on) packReview(assignmentId);
  else dropPack(a.class_id, `「${a.title}」讲评`);
}

/** 讲评下载成 Word */
export async function reviewDocx(assignmentId: number): Promise<{ name: string; bytes: Buffer }> {
  const r = reviewOf(assignmentId);
  const a = assignmentRow(assignmentId);
  const k = a && classRow(a.class_id);
  if (!r || !r.write || !r.stats || !a || !k) throw bad('讲评还没写好');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = await import('docx');
  const s = r.stats,
    w = r.write;
  const p = (text: string, o: { bold?: boolean; color?: string; size?: number } = {}) =>
    new Paragraph({ spacing: { after: 120, line: 360 }, children: [new TextRun({ text, bold: o.bold, color: o.color, size: o.size })] });
  const h = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, bold: true })] });
  const cell = (text: string, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
  const children: any[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 120 }, children: [new TextRun({ text: `「${a.title}」讲评`, bold: true, size: 36 })] }),
    p(`${k.name} · 满分 ${showNum(a.points)} 分 · 交了 ${s.submitted}/${s.total} 人 · 平均 ${s.avg ?? '—'} 分 · 最高 ${s.max ?? '—'} · 最低 ${s.min ?? '—'}`, { color: '666666' }),
  ];
  if (w.summary) children.push(p(w.summary));
  children.push(h('分数分布'));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: s.buckets.map((b) => cell(b.label, true)) }), new TableRow({ children: s.buckets.map((b) => cell(`${b.n} 人`)) })],
    }),
  );
  if (s.items.length) {
    children.push(h('各项得分'));
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [cell('评分项', true), cell('满分', true), cell('平均得分', true)] }),
          ...s.items.map((it) => new TableRow({ children: [cell(it.title), cell(showNum(it.points)), cell(it.avg === null ? '—' : showNum(it.avg))] })),
        ],
      }),
    );
  }
  if (w.errors.length) {
    children.push(h('常见问题'));
    w.errors.forEach((e, i) => {
      children.push(p(`${i + 1}. ${e.title}（${e.students.length} 人）`, { bold: true }));
      if (e.students.length) children.push(p(`涉及：${e.students.join('、')}`, { color: '666666' }));
      if (e.example) children.push(p(`例：${e.example}`, { color: '555555' }));
      if (e.why) children.push(p(`为什么会错：${e.why}`));
      if (e.teach) children.push(p(`怎么讲：${e.teach}`));
    });
  }
  if (w.good.length) {
    children.push(h('做得好的'));
    for (const g of w.good) children.push(p(`${g.student}：${g.why}`));
  }
  if (w.next) {
    children.push(h('下节课'));
    children.push(p(w.next));
  }
  if (s.missing.length) {
    children.push(h('没交的'));
    children.push(p(s.missing.join('、')));
  }
  if (s.similar.length) {
    children.push(h('这几份很像'));
    for (const x of s.similar) children.push(p(`${x.names[0]}、${x.names[1]}：相似 ${x.ratio}%`));
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  const bytes = await Packer.toBuffer(doc);
  return { name: `${a.title}-讲评.docx`.replace(/[\\/:*?"<>|]/g, ''), bytes };
}

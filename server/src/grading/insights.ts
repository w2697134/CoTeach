/**
 * 学情：一个班的学生卡在哪。
 * 程序先把材料摆好：每份批过的作业、评分标准每一项有几个人丢分、扣分原因举例；学生问学伴的原话。每一条带个编号。
 * 助教把它们归成几个知识点：知识点、卡在哪、下节课怎么讲，再写上用到的编号。几个人丢分、几个人问过，程序按编号去数，不让模型数。
 * 只说卡在哪，不给学生贴标签；页面上不出现谁丢分、谁问过。
 */
import { db, j, now } from '../db/index.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { teacherTitle } from '../assistant/pack.js';
import { agentLoop, classRow, finishRun, gradeItems, obj, showNum, startRun, str, type AssignmentRow, type SubmissionRow } from './common.js';
import { rubricOf } from './rubric.js';
import { scrubNames } from './review.js';

export interface InsightPoint {
  title: string;
  what: string;
  teach: string;
  /** 在作业里丢过分的人数、问过学伴的人数（程序数的） */
  lost: number;
  asked: number;
  /** 出在哪几份作业 */
  homework: string[];
  /** 扣分原因、学生问的原话，各摘两条（名字换成「有同学」） */
  reasons: string[];
  questions: string[];
}
export interface Insights {
  /** none 是还没看过 */
  status: 'none' | 'writing' | 'ready' | 'error';
  points: InsightPoint[];
  /** 看的时候有多少：批好的作业份数、学伴提问条数 */
  basis: { homework: number; graded: number; asks: number } | null;
  error: string | null;
  updatedAt: number | null;
  /** 看过以后又有新批的作业或新问题 */
  stale: boolean;
}

interface Entry {
  id: string;
  kind: 'item' | 'ask';
  homework?: string;
  users: number[];
  /** 这一项一共丢了几分（各人满分减得分加起来） */
  loss: number;
  text: string;
  samples: string[];
}

/** 程序摆的材料：每一条带编号（作业的一项 a作业号-项号，学伴的一问 q轮次号） */
function collect(classId: number) {
  const homework = db.all<AssignmentRow>(
    'SELECT * FROM assignments WHERE class_id=? AND deleted_at IS NULL AND publish_at<=? ORDER BY publish_at, id',
    classId,
    now(),
  );
  const entries: Entry[] = [];
  let graded = 0;
  let used = 0;
  for (const a of homework) {
    const subs = db.all<SubmissionRow>(
      `SELECT s.* FROM submissions s JOIN class_students m ON m.class_id=? AND m.user_id=s.user_id
       WHERE s.assignment_id=? AND s.score IS NOT NULL AND (s.returned_at IS NULL OR s.returned_at < s.submitted_at)`,
      classId,
      a.id,
    );
    if (!subs.length) continue;
    used++;
    graded += subs.length;
    const r = rubricOf(a.id);
    const titles = r?.items.map((x) => x.title) || [];
    const n = Math.max(titles.length, ...subs.map((s) => gradeItems(s.items).length));
    for (let k = 0; k < n; k++) {
      const lost = subs.filter((s) => {
        const it = gradeItems(s.items)[k];
        return it && it.got < it.max;
      });
      if (!lost.length) continue;
      const first = gradeItems(lost[0].items)[k];
      const avg = subs.map((s) => gradeItems(s.items)[k]?.got).filter((x): x is number => typeof x === 'number');
      const samples = [...new Set(lost.map((s) => gradeItems(s.items)[k]?.why.trim()).filter(Boolean))].slice(0, 6) as string[];
      entries.push({
        id: `a${a.id}-${k + 1}`,
        kind: 'item',
        homework: a.title,
        users: lost.map((s) => s.user_id),
        loss: lost.reduce((n, s) => n + Math.max(0, (gradeItems(s.items)[k]?.max ?? 0) - (gradeItems(s.items)[k]?.got ?? 0)), 0),
        text: `「${a.title}」${titles[k] || first?.title || `第${k + 1}项`}（满分 ${showNum(first?.max ?? 0)}）：${lost.length}/${subs.length} 人丢分，平均得 ${showNum(avg.reduce((x, y) => x + y, 0) / Math.max(1, avg.length))} 分`,
        samples,
      });
    }
  }
  const asks = db.all<{ id: number; teacher_id: number; request: string }>(
    `SELECT r.id, r.teacher_id, r.request FROM kb_runs r JOIN class_students m ON m.class_id=? AND m.user_id=r.teacher_id
     WHERE r.agent='stu' AND r.kind='chat' AND r.class_ids LIKE ? ORDER BY r.id DESC LIMIT 200`,
    classId,
    `%${classId}%`,
  );
  for (const q of asks) {
    const text = (q.request || '').trim();
    if (text.length < 4) continue;
    entries.push({ id: `q${q.id}`, kind: 'ask', users: [q.teacher_id], loss: 0, text: text.slice(0, 200), samples: [] });
  }
  return { entries, basis: { homework: used, graded, asks: entries.filter((e) => e.kind === 'ask').length } };
}

export const insightsPrompt = (teacherName: string) => `你是${teacherTitle(teacherName)}的 CoT 助教，替老师看这个班的学生卡在哪。`;

const SAVE: ToolSpec = {
  name: 'save_insights',
  description: '存学情，再存一次就换成新的。',
  parameters: obj(
    {
      points: {
        type: 'array',
        description: '学生卡住的知识点，卡得多的在前',
        items: obj(
          {
            title: str('知识点'),
            what: str('卡在哪，一句话'),
            teach: str('下节课怎么讲'),
            refs: { type: 'array', items: { type: 'string' }, description: '用到的条目编号' },
          },
          ['title', 'what', 'teach', 'refs'],
        ),
      },
    },
    ['points'],
  ),
};

function material(className: string, entries: Entry[]) {
  const items = entries.filter((e) => e.kind === 'item');
  const asks = entries.filter((e) => e.kind === 'ask');
  const lines = [`「${className}」`];
  if (items.length) {
    lines.push('', '作业里丢分的地方（编号、哪一项、几个人丢分、扣分原因举例）：');
    for (const e of items) lines.push(`[${e.id}] ${e.text}`, ...e.samples.map((s) => `  - ${s.slice(0, 160)}`));
  }
  if (asks.length) lines.push('', '学生问学伴的（编号、原话）：', ...asks.map((e) => `[${e.id}] ${e.text}`));
  lines.push('', '把学生卡住的地方按知识点归成几类，用 save_insights 存。');
  return lines.join('\n');
}

function upsert(classId: number, fields: Record<string, string | number | null>) {
  const t = now();
  if (db.get('SELECT class_id FROM class_insights WHERE class_id=?', classId)) {
    const keys = Object.keys(fields);
    db.run(`UPDATE class_insights SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE class_id=?`, ...keys.map((k) => fields[k]), t, classId);
  } else db.insert('class_insights', { class_id: classId, status: 'writing', created_at: t, updated_at: t, ...fields });
}

/** 模型交上来的整理成存的样子：编号对不上的不算，人数按编号数，卡的人多的在前 */
export function cleanInsights(raw: any, entries: Entry[], names: string[]): InsightPoint[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const scrub = (s: string) => scrubNames(s, names);
  const points: (InsightPoint & { weight: number })[] = [];
  for (const p of Array.isArray(raw?.points) ? raw.points.slice(0, 12) : []) {
    const refs = [...new Set((Array.isArray(p?.refs) ? p.refs : []).map((x: unknown) => String(x ?? '').trim().replace(/^\[|\]$/g, '')))]
      .map((id) => byId.get(id as string))
      .filter((e): e is Entry => !!e);
    const title = String(p?.title ?? '').trim().slice(0, 60);
    if (!title || !refs.length) continue;
    const items = refs.filter((e) => e.kind === 'item');
    const asks = refs.filter((e) => e.kind === 'ask');
    points.push({
      title,
      what: scrub(String(p?.what ?? '').trim().slice(0, 300)),
      teach: scrub(String(p?.teach ?? '').trim().slice(0, 600)),
      lost: new Set(items.flatMap((e) => e.users)).size,
      asked: new Set(asks.flatMap((e) => e.users)).size,
      homework: [...new Set(items.map((e) => e.homework!))],
      reasons: items.flatMap((e) => e.samples).slice(0, 2).map((s) => scrub(s.slice(0, 160))),
      questions: asks.slice(0, 2).map((e) => scrub(e.text.slice(0, 120))),
      // 排在前面的是丢分多的：一共丢的分，一个问过学伴的学生算 3 分（2026-11-16：按人数排，人人扣 2 分的「注释」排到了扣 6 分的「range 边界」前面）
      weight: items.reduce((n, e) => n + e.loss, 0) + 3 * new Set(asks.flatMap((e) => e.users)).size,
    });
  }
  return points
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 8)
    .map(({ weight: _, ...p }) => p);
}

const writing = new Map<number, Promise<void>>();
/** 看一遍（后台）：同一个班同时只看一份 */
export function writeInsights(classId: number, signal?: AbortSignal): Promise<void> {
  const busy = writing.get(classId);
  if (busy) return busy;
  const p = (async () => {
    const k = classRow(classId);
    if (!k) return;
    const { entries, basis } = collect(classId);
    if (!entries.length) {
      upsert(classId, { status: 'error', error: '还没有批好的作业，也没有学生问过学伴' });
      return;
    }
    upsert(classId, { status: 'writing', error: null });
    const names = db
      .all<{ a: string | null; b: string | null }>('SELECT m.name AS a, u.name AS b FROM class_students m LEFT JOIN users u ON u.id=m.user_id WHERE m.class_id=?', classId)
      .flatMap((x) => [x.a, x.b])
      .filter((x): x is string => !!x && x.trim().length >= 2)
      .sort((x, y) => y.length - x.length);
    const runId = startRun(k.teacher_id, 'insights', `看「${k.name}」的学情`, classId);
    let saved: InsightPoint[] | null = null;
    try {
      await agentLoop({
        teacherId: k.teacher_id,
        runId,
        system: insightsPrompt(db.value<string>('SELECT name FROM users WHERE id=?', k.teacher_id) || ''),
        first: material(k.name, entries),
        tools: [SAVE],
        purpose: 'grader:insights',
        maxSteps: 3,
        signal: signal ?? new AbortController().signal,
        nudge: '用 save_insights 把学情存下来。',
        done: () => !!saved,
        run: async (call: ToolCall) => {
          if (call.name !== 'save_insights') return `没有「${call.name}」这个工具`;
          const points = cleanInsights(call.args || {}, entries, names);
          if (!points.length) return '没存上：每一类都要写上用到的条目编号（方括号里的那个）';
          saved = points;
          return '存好了';
        },
      });
      const points = saved as InsightPoint[] | null;
      if (!points) throw new Error('助教没存学情');
      upsert(classId, { status: 'ready', data: JSON.stringify({ points, basis }), error: null });
      finishRun(runId, 'done', points.map((x) => x.title).join('、'));
    } catch (err) {
      const msg = (err as Error).message || '没看成';
      upsert(classId, { status: 'error', error: msg });
      finishRun(runId, 'error', '', msg);
    }
  })().finally(() => writing.delete(classId));
  writing.set(classId, p);
  return p;
}

/** 给页面的：上次看的结果；看过以后又有新批的作业或新问题就是 stale */
export function insightsOf(classId: number): Insights {
  const r = db.get<{ status: Insights['status']; data: string | null; error: string | null; updated_at: number }>(
    'SELECT status, data, error, updated_at FROM class_insights WHERE class_id=?',
    classId,
  );
  const d = j<{ points?: InsightPoint[]; basis?: Insights['basis'] }>(r?.data, {});
  const now0 = r?.status === 'ready' ? collect(classId).basis : null;
  const stale = !!(now0 && d.basis && (now0.graded !== d.basis.graded || now0.asks !== d.basis.asks));
  // 表里写着在看、其实没在看的：上次看到一半服务重启了
  const cut = !writing.has(classId) && r?.status === 'writing';
  return {
    status: writing.has(classId) ? 'writing' : !r ? 'none' : cut ? 'error' : r.status,
    points: d.points ?? [],
    basis: d.basis ?? null,
    error: cut ? '上次没看完' : (r?.error ?? null),
    updatedAt: r?.updated_at ?? null,
    stale,
  };
}

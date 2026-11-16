/**
 * 评分标准（2026-11-16）：一份作业一份，分几项、每项几分、怎么给分、参考答案。
 * 布置作业时助教在后台拟（题目和答案先去老师的知识库里找），老师在作业页能看能改；改过的以老师的为准，助教不再自己重拟。
 * 学生看不到（里面有参考答案）。助教批每一份都照它，同样的问题给每个学生扣一样的分。
 */
import { db, j, now } from '../db/index.js';
import { bad } from '../lib/http.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { kbCatalog, readKb, READ_KB, searchKb, SEARCH_KB } from '../assistant/helper.js';
import { teacherTitle } from '../assistant/pack.js';
import { nowLine } from '../assistant/time.js';
import { documentText } from '../kb/intake/service.js';
import {
  agentLoop,
  assignmentRow,
  classRow,
  finishRun,
  homeworkFile,
  half,
  numArg,
  obj,
  showNum,
  startRun,
  str,
  toNum,
  userName,
  type AssignmentRow,
  type RubricItem,
} from './common.js';

export interface Rubric {
  items: RubricItem[];
  source: 'ai' | 'teacher';
  status: 'drafting' | 'ready' | 'error';
  error: string | null;
  updatedAt: number;
}

export function rubricOf(assignmentId: number): Rubric | null {
  const r = db.get<{ items: string; source: 'ai' | 'teacher'; status: Rubric['status']; error: string | null; updated_at: number }>(
    'SELECT items, source, status, error, updated_at FROM hw_rubrics WHERE assignment_id=?',
    assignmentId,
  );
  if (!r) return null;
  return { items: j<RubricItem[]>(r.items, []), source: r.source, status: r.status, error: r.error, updatedAt: r.updated_at };
}

function upsert(assignmentId: number, fields: Record<string, string | number | null>) {
  const t = now();
  if (db.get('SELECT assignment_id FROM hw_rubrics WHERE assignment_id=?', assignmentId)) {
    const keys = Object.keys(fields);
    db.run(`UPDATE hw_rubrics SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE assignment_id=?`, ...keys.map((k) => fields[k]), t, assignmentId);
  } else db.insert('hw_rubrics', { assignment_id: assignmentId, items: '[]', source: 'ai', status: 'drafting', created_at: t, updated_at: t, ...fields });
}

/** 整理一份评分标准：标题、分数、说明都要有；每项分数到 0.5；加起来要等于满分 */
export function cleanItems(raw: unknown, points: number): RubricItem[] {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw bad('评分标准至少要有一项');
  if (list.length > 20) throw bad('评分标准最多 20 项');
  const items = list.map((x: any, k: number) => {
    // 标题后面带的「（30 分）」去掉：分数单独一栏
    const title = String(x?.title ?? '')
      .trim()
      .replace(/\s*[（(]\s*\d+(\.\d+)?\s*分\s*[)）]\s*$/, '')
      .slice(0, 80);
    const p = toNum(x?.points);
    if (!title) throw bad(`第 ${k + 1} 项没写是什么`);
    if (!Number.isFinite(p) || p <= 0) throw bad(`「${title}」没有分：每一项都要有分；不单独计分的要求写进有关那一项的「怎么给分」里`);
    return { title, points: half(p), criteria: String(x?.criteria ?? '').trim().slice(0, 2000), answer: String(x?.answer ?? '').trim().slice(0, 6000) };
  });
  const sum = items.reduce((n, x) => n + x.points, 0);
  if (Math.abs(sum - points) > 0.01) throw bad(`各项加起来是 ${showNum(sum)} 分，满分是 ${showNum(points)} 分，要加起来正好是满分`);
  return items;
}

/** 老师改评分标准 */
export function setRubric(assignmentId: number, raw: unknown) {
  const a = assignmentRow(assignmentId);
  if (!a) throw bad('这份作业不存在');
  const items = cleanItems(raw, a.points);
  upsert(assignmentId, { items: JSON.stringify(items), source: 'teacher', status: 'ready', error: null });
  return items;
}

/** 作业满分改了：评分标准按比例跟着改（到 0.5，最后一项补齐） */
export function rescaleRubric(assignmentId: number, points: number) {
  const r = rubricOf(assignmentId);
  if (!r || !r.items.length) return;
  const sum = r.items.reduce((n, x) => n + x.points, 0);
  if (Math.abs(sum - points) < 0.01 || sum <= 0) return;
  const items = r.items.map((x) => ({ ...x, points: Math.max(0.5, half((x.points / sum) * points)) }));
  const rest = points - items.slice(0, -1).reduce((n, x) => n + x.points, 0);
  items[items.length - 1].points = Math.max(0.5, half(rest));
  upsert(assignmentId, { items: JSON.stringify(items) });
}

/** 作业的附件读成文字（题目常在附件里），老师那份的字认图算老师的 */
export async function assignmentFilesText(a: AssignmentRow, signal?: AbortSignal) {
  const files = db.all<{ name: string; path: string }>('SELECT name, path FROM homework_files WHERE assignment_id=? ORDER BY id', a.id);
  const parts: string[] = [];
  let budget = 16_000;
  for (const f of files) {
    if (budget <= 0) break;
    const r = await documentText(f.name, homeworkFile(f.path), a.teacher_id, signal);
    const body = 'text' in r ? r.text.slice(0, Math.min(8000, budget)) : `（${r.reason}）`;
    budget -= body.length;
    parts.push(`附件「${f.name}」：\n${body}`);
  }
  return parts.join('\n\n');
}

const SAVE_RUBRIC: ToolSpec = {
  name: 'save_rubric',
  description: '存评分标准，再存一次就换成新的。',
  parameters: obj(
    {
      items: {
        type: 'array',
        items: obj(
          {
            title: str('这一项是什么，比如「第1题」「代码能运行」'),
            points: numArg('这一项几分'),
            criteria: str('怎么给分：做到什么给满分，常见的错各扣几分'),
            answer: str('参考答案；没有唯一答案的写要点'),
          },
          ['title', 'points', 'criteria'],
        ),
      },
    },
    ['items'],
  ),
};

export const rubricPrompt = (teacherName: string) => `你是${teacherTitle(teacherName)}的 CoT 助教。老师布置了作业，你来拟评分标准，之后照它批每个学生的作业。`;

/** 同一份作业同时只拟一份 */
const drafting = new Map<number, Promise<void>>();

/**
 * 拟评分标准（后台）：老师改过的不动，除非 force（老师点了「重拟」）。拟不出来记下原因，批改时退回按要求整体给分。
 */
export function draftRubric(assignmentId: number, o: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const running = drafting.get(assignmentId);
  if (running) return running;
  const p = (async () => {
    const a = assignmentRow(assignmentId);
    if (!a || a.deleted_at) return;
    const have = rubricOf(assignmentId);
    if (have && !o.force && (have.source === 'teacher' || have.status === 'ready')) return;
    const k = classRow(a.class_id);
    if (!k) return;
    upsert(assignmentId, { status: 'drafting', error: null, ...(o.force ? { source: 'ai' } : {}) });
    const runId = startRun(a.teacher_id, 'rubric', `给「${k.name}」的作业「${a.title}」拟评分标准`, a.class_id);
    const signal = o.signal ?? new AbortController().signal;
    let saved: RubricItem[] | null = null;
    try {
      const files = await assignmentFilesText(a, signal);
      const first = [
        kbCatalog(a.teacher_id),
        '',
        `（现在是 ${nowLine()}）`,
        `「${k.name}」的作业「${a.title}」，满分 ${showNum(a.points)} 分。`,
        `要求：${a.body.trim() || '（没写要求）'}`,
        files || undefined,
        '',
        `给这份作业拟评分标准：分成几项，每项几分（加起来正好 ${showNum(a.points)} 分），每项怎么给分，参考答案。题目和答案先在老师的知识库里找，找不到再自己写。用 save_rubric 存。`,
      ]
        .filter((x) => x !== undefined)
        .join('\n');
      await agentLoop({
        teacherId: a.teacher_id,
        runId,
        system: rubricPrompt(userName(a.teacher_id)),
        first,
        tools: [SEARCH_KB, READ_KB, SAVE_RUBRIC],
        purpose: 'grader:rubric',
        maxSteps: 14,
        signal,
        nudge: '用 save_rubric 把评分标准存下来。',
        done: () => !!saved,
        run: async (call: ToolCall) => {
          const args = call.args || {};
          if (call.name === 'search_kb') return searchKb(a.teacher_id, String(args.query ?? ''));
          if (call.name === 'read_kb') return readKb(a.teacher_id, String(args.path ?? ''), Math.max(0, toNum(args.offset) || 0));
          if (call.name === 'save_rubric') {
            saved = cleanItems(args.items, a.points);
            return '存好了';
          }
          return `没有「${call.name}」这个工具`;
        },
      });
      const items = saved as RubricItem[] | null;
      if (!items) throw new Error('助教没拟出评分标准');
      // 拟的时候老师已经自己写好了：以老师的为准
      if (!o.force && rubricOf(assignmentId)?.source === 'teacher') {
        finishRun(runId, 'done', '老师已经写了评分标准');
        return;
      }
      upsert(assignmentId, { items: JSON.stringify(items), source: 'ai', status: 'ready', run_id: runId, error: null });
      finishRun(runId, 'done', items.map((x) => `${x.title} ${showNum(x.points)} 分`).join('；'));
    } catch (err) {
      const msg = (err as Error).message || '没拟出来';
      upsert(assignmentId, { status: 'error', error: msg, run_id: runId });
      finishRun(runId, signal.aborted ? 'canceled' : 'error', '', msg);
    }
  })().finally(() => drafting.delete(assignmentId));
  drafting.set(assignmentId, p);
  return p;
}

/**
 * 批改要用的评分标准：拟好了就用；正在拟就等它；没有就先拟。实在拟不出来，按作业要求整体给分（一项，满分就是作业满分）。
 */
export async function ensureRubric(a: AssignmentRow, signal?: AbortSignal): Promise<RubricItem[]> {
  let r = rubricOf(a.id);
  if (!r || r.status === 'drafting' || (r.status === 'error' && !r.items.length)) {
    await draftRubric(a.id, { signal });
    r = rubricOf(a.id);
  }
  if (r && r.items.length) return r.items;
  return [{ title: '整体', points: a.points, criteria: '照作业要求整体给分', answer: '' }];
}

/** 后台拟评分标准：测试里关掉（各自的测试直接调 draftRubric） */
let auto = process.env.CT_GRADE_AUTO !== '0';
export function setRubricAuto(on: boolean) {
  auto = on;
}
/** 布置作业、改了要求时：不用助教批的作业不拟 */
export function rubricOnHomework(assignmentId: number, o: { changed?: boolean } = {}) {
  if (!auto) return;
  const a = assignmentRow(assignmentId);
  if (!a || a.ai_mode === 'off') return;
  const have = rubricOf(assignmentId);
  // 要求改了：助教拟的那份重拟；老师自己写的不动
  if (have && (have.source === 'teacher' || (have.status === 'ready' && !o.changed))) return;
  void draftRubric(assignmentId, { force: !!have && have.source === 'ai' && !!o.changed }).catch((err) => console.error('[rubric]', assignmentId, err));
}

/** 服务重启：拟到一半的接着拟 */
export function recoverRubrics() {
  const rows = db.all<{ assignment_id: number }>("SELECT assignment_id FROM hw_rubrics WHERE status='drafting'");
  for (const r of rows) {
    db.run("UPDATE hw_rubrics SET status='error', error='服务中断，没拟完' WHERE assignment_id=?", r.assignment_id);
    if (auto) void draftRubric(r.assignment_id, { force: true }).catch((err) => console.error('[rubric]', r.assignment_id, err));
  }
}

/** 给模型看的评分标准（带参考答案） */
export function rubricText(items: RubricItem[]) {
  return items
    .map((x, k) =>
      [`${k + 1}. ${x.title}（${showNum(x.points)} 分）`, x.criteria && `   怎么给分：${x.criteria}`, x.answer && `   参考答案：${x.answer}`].filter(Boolean).join('\n'),
    )
    .join('\n');
}

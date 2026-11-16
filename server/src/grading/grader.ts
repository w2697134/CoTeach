/**
 * 助教批一份作业（2026-11-16）：照评分标准逐项给分、在学生原文上划出问题和写得好的地方、写评语。
 * 总分是程序加出来的（每项不超过这一项的满分）；批注要能在学生原文里找到，找不到的不划线，只留在批注里。
 * 看不清、对不上、判不了的，助教在 flag 里写原因，留给老师看，不直接发。
 */
import { db, now } from '../db/index.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { teacherTitle } from '../assistant/pack.js';
import { documentText } from '../kb/intake/service.js';
import {
  agentLoop,
  assignmentRow,
  classRow,
  finishRun,
  half,
  homeworkFile,
  locate,
  numArg,
  obj,
  showNum,
  startRun,
  str,
  submissionRow,
  toNum,
  userName,
  type AiGradeRow,
  type AssignmentRow,
  type GradeItem,
  type Mark,
  type RubricItem,
  type SubmissionRow,
} from './common.js';
import { assignmentFilesText, ensureRubric, rubricText } from './rubric.js';

/** 一份作业最多读这么多字给助教批（附件各自也有上限） */
const MAX_WORK = 30_000;
const MAX_FILE = 12_000;
const MAX_MARKS = 12;

/**
 * 学生交的东西读成一段文字：先是写在框里的，再是每个附件读出来的字（图片里的字请模型认）。
 * 这段就是批改稿：批注的位置都按它算，老师、学生看到的也是它。
 */
export async function workText(s: Pick<SubmissionRow, 'id' | 'text' | 'user_id'>, signal?: AbortSignal) {
  const parts: string[] = [];
  if (s.text.trim()) parts.push(s.text.trim());
  const files = db.all<{ name: string; path: string }>('SELECT name, path FROM homework_files WHERE submission_id=? ORDER BY id', s.id);
  for (const f of files) {
    const r = await documentText(f.name, homeworkFile(f.path), s.user_id, signal);
    parts.push(`【附件「${f.name}」】\n${'text' in r ? r.text.slice(0, MAX_FILE) : `（${r.reason}）`}`);
  }
  const text = parts.join('\n\n');
  return text.length > MAX_WORK ? text.slice(0, MAX_WORK) + '\n（后面太长，没有读）' : text;
}

export const gradePrompt = (teacherName: string) => `你是${teacherTitle(teacherName)}的 CoT 助教，替老师批作业。照评分标准一项一项给分，同样的问题给每个学生扣一样的分。
批注和评语学生都看得到：指出哪里不对、为什么不对，不要写出正确答案。`;

/**
 * 交批改结果的工具：评分标准有几项，items 里就是这几格，格子名就是项名（2026-11-16：原来是一个随便几条的列表，
 * 评分标准每道题底下又分了（1）（2）（3）小项，助教按小项一条条交，交成了十几条，程序拿前三条当三道题）。
 */
/** 交分格子的名字：就是项名；万一两项重名，后面加「（第几项）」分开 */
export function itemKeys(rubric: RubricItem[]) {
  const n = new Map<string, number>();
  for (const r of rubric) n.set(r.title, (n.get(r.title) || 0) + 1);
  return rubric.map((r, k) => (n.get(r.title)! > 1 ? `${r.title}（第${k + 1}项）` : r.title));
}

export function submitTool(rubric: RubricItem[]): ToolSpec {
  const each = obj({ got: numArg('得几分'), why: str('为什么给这个分；扣了分的说扣在哪') }, ['got', 'why']);
  return {
    name: 'submit_grade',
    description: '交批改结果。',
    parameters: obj(
      {
        items: { ...obj(Object.fromEntries(itemKeys(rubric).map((k) => [k, each])), itemKeys(rubric)), description: '评分标准每一项一格' },
        marks: {
          type: 'array',
          description: '批注',
          items: obj(
            {
              quote: str('从学生交的原文里一字不改摘一小段'),
              kind: { type: 'string', enum: ['wrong', 'good'], description: 'wrong 有问题，good 写得好' },
              note: str('批注'),
            },
            ['quote', 'kind', 'note'],
          ),
        },
        comment: str('给学生的评语，两三句：先说做得好的，再说最要紧的问题'),
        flag: str('看不清、跟这份作业对不上、照标准判不了时写原因，留给老师看；能批就不写'),
      },
      ['items', 'comment'],
    ),
  };
}

export interface GradeResult {
  score: number;
  items: GradeItem[];
  marks: Mark[];
  comment: string;
  flag: string | null;
}

/** 比对项名时不看空格和标点 */
const bare = (s: unknown) =>
  String(s ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();

/**
 * 交上来的一条是评分标准里的哪一项：按名字对（2026-11-16 线上演示班：原来按「第几项」交，评分标准每道题底下又有（1）（2）（3）小项，
 * 93 份里 13 份把第1题的三个小项当成了三道题交，第三章吴泽宇记成 27 分，评语却写「两题满分」）。
 * 名字一样的先算；不一样的，只有一项能对上开头才算。
 */
function itemOf(title: unknown, rubric: RubricItem[]): number {
  const t = bare(title);
  if (!t) return -1;
  const names = rubric.map((r) => bare(r.title));
  const same = names.indexOf(t);
  if (same >= 0) return same;
  const near = names.map((n, k) => (n.startsWith(t) || t.startsWith(n) ? k : -1)).filter((k) => k >= 0);
  return near.length === 1 ? near[0] : -1;
}

/** 模型交上来的整理成能存的样子：每项卡在 0 到满分，总分加出来，批注在原文里定位 */
export function cleanResult(raw: any, rubric: RubricItem[], text: string): GradeResult {
  const got = new Map<number, { got: number; why: string }>();
  // 一般是按项名的一格一格（submitTool）；也收一条条带项名的列表
  const list: { title: unknown; got: unknown; why: unknown }[] = Array.isArray(raw?.items)
    ? raw.items
    : raw?.items && typeof raw.items === 'object'
      ? Object.entries(raw.items).map(([title, v]: [string, any]) => ({ title, got: v?.got, why: v?.why }))
      : [];
  const keys = itemKeys(rubric);
  for (const x of list) {
    const k = keys.includes(String(x?.title)) ? keys.indexOf(String(x?.title)) : itemOf(x?.title, rubric);
    if (k < 0 || got.has(k + 1)) continue;
    const g = toNum(x?.got);
    got.set(k + 1, { got: Number.isFinite(g) ? g : 0, why: String(x?.why ?? '').trim().slice(0, 1000) });
  }
  if (got.size < rubric.length) {
    const missing = rubric.filter((_, k) => !got.has(k + 1)).map((r) => `「${r.title}」`);
    throw new Error(`${missing.join('、')}没给分，评分标准每一项都要给，名字照评分标准写`);
  }
  const items: GradeItem[] = rubric.map((r, k) => {
    const g = got.get(k + 1)!;
    return { title: r.title, max: r.points, got: Math.min(r.points, Math.max(0, half(g.got))), why: g.why };
  });
  const marks: Mark[] = [];
  let from = 0;
  for (const m of (Array.isArray(raw?.marks) ? raw.marks : []).slice(0, MAX_MARKS * 2)) {
    const quote = String(m?.quote ?? '').trim().slice(0, 300);
    const note = String(m?.note ?? '').trim().slice(0, 500);
    if (!quote || !note) continue;
    const at = locate(text, quote, 0) ?? locate(text, quote, from);
    if (at) from = at.end;
    marks.push({ quote, kind: m?.kind === 'good' ? 'good' : 'wrong', note, start: at?.start ?? -1, end: at?.end ?? -1 });
    if (marks.length >= MAX_MARKS) break;
  }
  // 位置先后排；找不到原文的放最后
  marks.sort((x, y) => (x.start < 0 ? 1e9 : x.start) - (y.start < 0 ? 1e9 : y.start));
  const flag = String(raw?.flag ?? '').trim().slice(0, 300) || null;
  return { score: half(items.reduce((n, x) => n + x.got, 0)), items, marks, comment: String(raw?.comment ?? '').trim().slice(0, 2000), flag };
}

/** 发给模型的那一段：作业和评分标准在前（同一份作业每个学生一样，缓存命中），学生交的在后 */
export function gradeInput(a: AssignmentRow, className: string, files: string, rubric: RubricItem[], text: string) {
  return [
    `「${className}」的作业「${a.title}」，满分 ${showNum(a.points)} 分。`,
    `要求：${a.body.trim() || '（没写要求）'}`,
    files || undefined,
    '',
    '评分标准：',
    rubricText(rubric),
    '',
    '学生交的：',
    text,
  ]
    .filter((x) => x !== undefined)
    .join('\n');
}

/**
 * 批一份（ai_grades 里排着的那一行）。批完：要直接发的、学生没重交、老师也没自己批过，就写到学生那份作业上。
 */
export async function runGrade(row: AiGradeRow, signal: AbortSignal) {
  const a = assignmentRow(row.assignment_id);
  const s = submissionRow(row.submission_id);
  const k = a && classRow(a.class_id);
  if (!a || a.deleted_at || !s || !k) return db.update('ai_grades', row.id, { status: 'stale', finished_at: now() });
  if (s.submitted_at !== row.submitted_at) return db.update('ai_grades', row.id, { status: 'stale', finished_at: now() });
  const rubric = await ensureRubric(a, signal);
  const text = await workText(s, signal);
  const files = await assignmentFilesText(a, signal);
  const runId = startRun(a.teacher_id, 'grade', `批「${a.title}」：${userName(s.user_id)}`, a.class_id);
  let result: GradeResult | null = null;
  try {
    await agentLoop({
      teacherId: a.teacher_id,
      runId,
      system: gradePrompt(userName(a.teacher_id)),
      first: gradeInput(a, k.name, files, rubric, text),
      tools: [submitTool(rubric)],
      purpose: 'grader:grade',
      maxSteps: 3,
      signal,
      nudge: '用 submit_grade 交批改结果。',
      done: () => !!result,
      run: async (call: ToolCall) => {
        if (call.name !== 'submit_grade') return `没有「${call.name}」这个工具`;
        result = cleanResult(call.args || {}, rubric, text);
        return '交好了';
      },
    });
    const r = result as GradeResult | null;
    if (!r) throw new Error('助教没交批改结果');
    db.update('ai_grades', row.id, {
      status: 'done',
      score: r.score,
      items: JSON.stringify(r.items),
      marks: JSON.stringify(r.marks),
      comment: r.comment,
      flag: r.flag,
      text,
      error: null,
      finished_at: now(),
    });
    finishRun(runId, 'done', `${showNum(r.score)}/${showNum(a.points)}${r.flag ? `（要老师看：${r.flag}）` : ''}`);
    releaseIfDue(row.id);
  } catch (err) {
    const msg = (err as Error).message || '没批成';
    db.update('ai_grades', row.id, { status: 'error', error: msg, text, finished_at: now() });
    finishRun(runId, signal.aborted ? 'canceled' : 'error', '', msg);
    throw err;
  }
}

/** 一份批好的能不能发给学生：学生没重交、没被退回、老师没自己批过 */
function releasable(g: AiGradeRow, s: SubmissionRow) {
  if (g.status !== 'done' || g.score === null) return false;
  if (s.submitted_at !== g.submitted_at) return false;
  if (s.returned_at && s.returned_at >= s.submitted_at) return false;
  if (s.score !== null && s.graded_by === 'teacher') return false;
  return true;
}

/** 写到学生那份作业上（发出去） */
export function publishGrade(g: AiGradeRow, s: SubmissionRow) {
  const t = now();
  db.update('submissions', s.id, {
    score: g.score,
    comment: g.comment || null,
    items: g.items,
    graded_by: 'ai',
    graded_at: t,
    ai_grade_id: g.id,
    returned_at: null,
    updated_at: t,
  });
  db.update('ai_grades', g.id, { released_at: t });
}

/** 批完直接发的那种：没有要老师看的就发 */
export function releaseIfDue(gradeId: number) {
  const g = db.get<AiGradeRow>('SELECT * FROM ai_grades WHERE id=?', gradeId);
  if (!g || !g.auto_release || g.flag) return false;
  const s = submissionRow(g.submission_id);
  if (!s || !releasable(g, s)) return false;
  publishGrade(g, s);
  return true;
}

/** 一份作业里每个学生最新的那次批改（对得上他现在交的那一版） */
export function latestGrades(assignmentId: number) {
  const rows = db.all<AiGradeRow>(
    `SELECT g.* FROM ai_grades g JOIN submissions s ON s.id=g.submission_id
     WHERE g.assignment_id=? AND g.submitted_at=s.submitted_at AND g.status<>'stale'
       AND g.id=(SELECT max(id) FROM ai_grades x WHERE x.submission_id=g.submission_id AND x.status<>'stale')`,
    assignmentId,
  );
  return new Map(rows.map((g) => [g.user_id, g]));
}

/** 老师点「发布」：批好了、还没发、老师也没自己批过的，一起发（要老师看的不发；重批的换掉助教上次发的） */
export function releaseDrafts(assignmentId: number) {
  let n = 0;
  for (const g of latestGrades(assignmentId).values()) {
    if (g.flag || g.released_at) continue;
    const s = submissionRow(g.submission_id);
    if (!s || !releasable(g, s) || (s.score !== null && s.ai_grade_id === g.id)) continue;
    publishGrade(g, s);
    n++;
  }
  return n;
}

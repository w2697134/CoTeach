/**
 * 备课（2026-11-16，老师左侧栏）：选一个班点「备下节课」（可以说这节讲什么），助教写一份下一节课的教案。
 * 照老师知识库里自己的教案、课件、授课计划来（它能翻知识库）；这个班已经布置过哪些作业、学情里卡在哪，程序摆给它，
 * 卡住的地方放进开头的补讲。存成一份一份的，能下载 Word。
 */
import { db, j, now } from '../db/index.js';
import { bad } from '../lib/http.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { teacherTitle } from '../assistant/pack.js';
import { READ_KB, SEARCH_KB, kbCatalog, readKb, searchKb } from '../assistant/helper.js';
import { nowLine } from '../assistant/time.js';
import { agentLoop, classRow, finishRun, numArg, obj, startRun, str, toNum } from './common.js';
import { insightsOf } from './insights.js';

export interface PlanStep {
  name: string;
  minutes: number | null;
  content: string;
}
export interface PlanWrite {
  title: string;
  goals: string[];
  focus: string;
  hard: string;
  review: string;
  steps: PlanStep[];
  practice: string;
  homework: string;
  sources: string[];
}
export interface Plan {
  id: number;
  classId: number;
  className: string;
  topic: string | null;
  status: 'writing' | 'ready' | 'error';
  write: PlanWrite | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export const planPrompt = (teacherName: string) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教，替老师备下一节课。照老师知识库里自己的教案、课件、授课计划来；这个班学生卡住的地方，放进开头的补讲。`;

const SAVE: ToolSpec = {
  name: 'save_plan',
  description: '存教案，再存一次就换成新的。',
  parameters: obj(
    {
      title: str('课题'),
      goals: { type: 'array', items: { type: 'string' }, description: '教学目标' },
      focus: str('重点'),
      hard: str('难点'),
      review: str('开头补讲：这个班学生卡住的地方怎么补'),
      steps: {
        type: 'array',
        description: '教学过程',
        items: obj({ name: str('环节'), minutes: numArg('几分钟'), content: str('做什么、讲什么') }, ['name', 'content']),
      },
      practice: str('课堂练习'),
      homework: str('课后作业'),
      sources: { type: 'array', items: { type: 'string' }, description: '用到的知识库文件' },
    },
    ['title', 'goals', 'steps'],
  ),
};

const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
const list = (v: unknown, n: number, each: number) =>
  (Array.isArray(v) ? v : [])
    .map((x) => text(x, each))
    .filter(Boolean)
    .slice(0, n);

export function cleanPlan(raw: any): PlanWrite {
  const title = text(raw?.title, 80);
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, 12).map((s: any) => {
    const m = Math.round(toNum(s?.minutes));
    return { name: text(s?.name, 40), minutes: Number.isFinite(m) && m > 0 && m <= 240 ? m : null, content: text(s?.content, 2000) };
  });
  if (!title || !steps.some((s: PlanStep) => s.content)) throw new Error('课题和教学过程都要写');
  return {
    title,
    goals: list(raw?.goals, 8, 300),
    focus: text(raw?.focus, 800),
    hard: text(raw?.hard, 800),
    review: text(raw?.review, 1500),
    steps: steps.filter((s: PlanStep) => s.content),
    practice: text(raw?.practice, 2000),
    homework: text(raw?.homework, 1500),
    sources: list(raw?.sources, 12, 200),
  };
}

/** 给助教的：今天几号、这个班布置过哪些作业（看出进度）、学情里卡在哪、以前备过哪几节、老师说这节讲什么、知识库里有什么 */
function material(classId: number, teacherId: number, topic: string | null) {
  const k = classRow(classId)!;
  const hw = db.all<{ title: string; publish_at: number; due_at: number | null }>(
    'SELECT title, publish_at, due_at FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY publish_at, id',
    classId,
  );
  const ins = insightsOf(classId);
  const before = db
    .all<{ data: string | null }>("SELECT data FROM lesson_plans WHERE class_id=? AND status='ready' ORDER BY id DESC LIMIT 6", classId)
    .map((r) => j<PlanWrite | null>(r.data, null)?.title)
    .filter(Boolean);
  const lines = [`（现在是 ${nowLine()}）`, `「${k.name}」`];
  if (hw.length) lines.push('', '这个班布置过的作业（按时间）：', ...hw.map((h) => `- ${h.title}`));
  if (ins.points.length)
    lines.push('', '学情（学生卡住的地方，丢分多的在前）：', ...ins.points.map((p) => `- ${p.title}：${p.what}（${p.lost} 人丢分${p.asked ? `，${p.asked} 人问过` : ''}）`));
  if (before.length) lines.push('', `以前备过的课：${before.join('、')}`);
  lines.push('', kbCatalog(teacherId), '', topic ? `老师说这节课讲：${topic}` : '老师没说这节讲什么：照授课计划和作业进度，备紧接着的下一节。', '写好用 save_plan 存。');
  return lines.join('\n');
}

function plan(id: number): Plan | null {
  const r = db.get<any>('SELECT p.*, c.name AS class_name FROM lesson_plans p JOIN classes c ON c.id=p.class_id WHERE p.id=?', id);
  if (!r) return null;
  return {
    id: r.id,
    classId: r.class_id,
    className: r.class_name,
    topic: r.topic,
    status: r.status === 'writing' && !writing.has(r.id) ? 'error' : r.status,
    write: j<PlanWrite | null>(r.data, null),
    error: r.status === 'writing' && !writing.has(r.id) ? '上次没写完' : r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const writing = new Set<number>();

/** 开始备一节（后台写）：返回这一份的编号；同一个班正在写的那份还没写完就不再开 */
export function startPlan(classId: number, teacherId: number, topic?: string | null): number {
  const k = classRow(classId);
  if (!k || k.teacher_id !== teacherId) throw bad('这个班不在了');
  const busy = db.value<number>("SELECT id FROM lesson_plans WHERE class_id=? AND status='writing' ORDER BY id DESC LIMIT 1", classId);
  if (busy && writing.has(busy)) return busy;
  const t = now();
  const id = db.insert('lesson_plans', { class_id: classId, teacher_id: teacherId, topic: topic?.trim() || null, status: 'writing', created_at: t, updated_at: t });
  writing.add(id);
  void writePlan(id).finally(() => writing.delete(id));
  return id;
}

async function writePlan(id: number) {
  const row = db.get<{ class_id: number; teacher_id: number; topic: string | null }>('SELECT class_id, teacher_id, topic FROM lesson_plans WHERE id=?', id)!;
  const k = classRow(row.class_id)!;
  const runId = startRun(row.teacher_id, 'prep', `给「${k.name}」备下节课${row.topic ? `：${row.topic}` : ''}`, row.class_id);
  let saved: PlanWrite | null = null;
  try {
    await agentLoop({
      teacherId: row.teacher_id,
      runId,
      system: planPrompt(db.value<string>('SELECT name FROM users WHERE id=?', row.teacher_id) || ''),
      first: material(row.class_id, row.teacher_id, row.topic),
      tools: [SEARCH_KB, READ_KB, SAVE],
      purpose: 'grader:prep',
      maxSteps: 14,
      signal: new AbortController().signal,
      nudge: '用 save_plan 把教案存下来。',
      done: () => !!saved,
      run: async (call: ToolCall) => {
        const a = call.args || {};
        try {
          if (call.name === 'search_kb') return searchKb(row.teacher_id, String(a.query ?? ''));
          if (call.name === 'read_kb') return readKb(row.teacher_id, String(a.path ?? ''), Math.max(0, Math.round(toNum(a.offset)) || 0));
          if (call.name === 'save_plan') {
            saved = cleanPlan(a);
            return '存好了';
          }
          return `没有「${call.name}」这个工具`;
        } catch (err) {
          return `没办成：${(err as Error).message}`;
        }
      },
    });
    const w = saved as PlanWrite | null;
    if (!w) throw new Error('助教没写出教案');
    db.update('lesson_plans', id, { status: 'ready', data: JSON.stringify(w), error: null, updated_at: now() });
    finishRun(runId, 'done', w.title);
  } catch (err) {
    const msg = (err as Error).message || '没写成';
    db.update('lesson_plans', id, { status: 'error', error: msg, updated_at: now() });
    finishRun(runId, 'error', '', msg);
  }
}

/** 老师自己的班备过的课，新的在前 */
export function plansOf(teacherId: number, classId?: number) {
  const rows = db.all<{ id: number }>(
    `SELECT p.id FROM lesson_plans p JOIN classes c ON c.id=p.class_id AND c.deleted_at IS NULL
     WHERE p.teacher_id=? ${classId ? 'AND p.class_id=?' : ''} ORDER BY p.id DESC LIMIT 60`,
    ...(classId ? [teacherId, classId] : [teacherId]),
  );
  return rows.map((r) => plan(r.id)!).filter(Boolean);
}

export function planFor(teacherId: number, id: number): Plan {
  const p = plan(id);
  const own = p && db.value<number>('SELECT teacher_id FROM lesson_plans WHERE id=?', id) === teacherId;
  if (!p || !own) throw bad('这份教案不在了');
  return p;
}

/** 教案下载成 Word */
export async function planDocx(p: Plan): Promise<{ name: string; bytes: Buffer }> {
  const w = p.write;
  if (!w) throw bad('教案还没写好');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = await import('docx');
  // 它写的加粗、代码记号（** 和 `）Word 里不要
  const plain = (t: string) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  const para = (t: string, o: { bold?: boolean; color?: string } = {}) =>
    new Paragraph({ spacing: { after: 120, line: 360 }, children: [new TextRun({ text: plain(t), bold: o.bold, color: o.color })] });
  const h = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, bold: true })] });
  const cell = (t: string, bold = false) => new TableCell({ children: t.split('\n').map((x) => new Paragraph({ children: [new TextRun({ text: plain(x), bold })] })) });
  const children: any[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 120 }, children: [new TextRun({ text: w.title, bold: true, size: 36 })] }),
    para(p.className, { color: '666666' }),
  ];
  if (w.goals.length) {
    children.push(h('教学目标'));
    w.goals.forEach((g, i) => children.push(para(`${i + 1}. ${g}`)));
  }
  if (w.focus) children.push(h('重点'), para(w.focus));
  if (w.hard) children.push(h('难点'), para(w.hard));
  if (w.review) children.push(h('开头补讲'), para(w.review));
  if (w.steps.length) {
    children.push(h('教学过程'));
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: [cell('环节', true), cell('时间', true), cell('内容', true)] }),
          ...w.steps.map((s) => new TableRow({ children: [cell(s.name), cell(s.minutes ? `${s.minutes} 分钟` : ''), cell(s.content)] })),
        ],
      }),
    );
  }
  if (w.practice) children.push(h('课堂练习'), ...w.practice.split('\n').map((x) => para(x)));
  if (w.homework) children.push(h('课后作业'), ...w.homework.split('\n').map((x) => para(x)));
  if (w.sources.length) children.push(h('用到的资料'), para(w.sources.join('、'), { color: '666666' }));
  const doc = new Document({ styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } } }, sections: [{ properties: {}, children }] });
  return { name: `${w.title}-教案.docx`.replace(/[\\/:*?"<>|]/g, ''), bytes: await Packer.toBuffer(doc) };
}

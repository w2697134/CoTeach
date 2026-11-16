/**
 * 助教批作业用到的东西（2026-11-16）：评分标准、批改结果的样子，作业和交上来的东西怎么取，跟模型来回的那一圈。
 * 老师看到的还是同一个 CoT 助教；这一手只能翻老师的知识库、存评分标准、交批改结果、写讲评，改不了班级和别的作业。
 */
import { resolve } from 'node:path';
import { config } from '../config.js';
import { db, j, now } from '../db/index.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { modelStep } from '../assistant/model.js';
import { append, requestMessages } from '../assistant/thread.js';

export type AiMode = 'release' | 'hold' | 'off';
export const isAiMode = (v: unknown): v is AiMode => v === 'release' || v === 'hold' || v === 'off';

/** 评分标准的一项：几分、怎么给分、参考答案（只给老师和批改的助教看） */
export interface RubricItem {
  title: string;
  points: number;
  criteria: string;
  answer: string;
}
/** 批出来的一项：满分几分、得了几分、为什么 */
export interface GradeItem {
  title: string;
  max: number;
  got: number;
  why: string;
}
/** 批注：在交上来的文字里划的一段（start、end 是在批改稿里的位置，找不到原文是 -1） */
export interface Mark {
  quote: string;
  kind: 'wrong' | 'good';
  note: string;
  start: number;
  end: number;
}

export interface AssignmentRow {
  id: number;
  class_id: number;
  teacher_id: number;
  title: string;
  body: string;
  points: number;
  due_at: number | null;
  allow_late: number;
  publish_at: number;
  ai_mode: AiMode;
  deleted_at: number | null;
}
export interface SubmissionRow {
  id: number;
  assignment_id: number;
  user_id: number;
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
export interface AiGradeRow {
  id: number;
  submission_id: number;
  assignment_id: number;
  user_id: number;
  submitted_at: number;
  status: 'queued' | 'running' | 'done' | 'error' | 'stale';
  score: number | null;
  items: string | null;
  marks: string | null;
  comment: string | null;
  flag: string | null;
  text: string | null;
  auto_release: number;
  released_at: number | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export const assignmentRow = (id: number) =>
  db.get<AssignmentRow>(
    'SELECT id, class_id, teacher_id, title, body, points, due_at, allow_late, publish_at, ai_mode, deleted_at FROM assignments WHERE id=?',
    id,
  );
export const submissionRow = (id: number) => db.get<SubmissionRow>('SELECT * FROM submissions WHERE id=?', id);
export const classRow = (id: number) => db.get<{ id: number; name: string; teacher_id: number }>('SELECT id, name, teacher_id FROM classes WHERE id=?', id);
export const userName = (id: number) => db.value<string>('SELECT name FROM users WHERE id=?', id) || '';

/** 交上来的作业附件存在哪 */
export const homeworkFile = (rel: string) => resolve(config.dataDir, 'homework', rel);

/** 分数到 0.5 */
export const half = (n: number) => Math.round(n * 2) / 2;
export const showNum = (n: number) => String(Math.round(n * 10) / 10);

export const gradeItems = (s: string | null | undefined) => j<GradeItem[]>(s, []);

/** 老师改了某一项的分：原因后面注明「（老师改成 N 分）」，跟助教原来写的扣分对得上 */
const CHANGED = /（老师改成 [\d.]+ 分）$/;
export function noteChange(item: GradeItem, aiGot: number | undefined): GradeItem {
  const why = item.why.replace(CHANGED, '').trimEnd();
  if (aiGot === undefined || Math.abs(aiGot - item.got) < 0.01) return { ...item, why };
  return { ...item, why: `${why}（老师改成 ${showNum(item.got)} 分）` };
}
export const gradeMarks = (s: string | null | undefined) => j<Mark[]>(s, []);

/** 在一段文字里找学生原文：先原样找，找不到就不管空格换行再找；返回在原文里的起止 */
export function locate(text: string, quote: string, from = 0): { start: number; end: number } | null {
  const q = quote.trim();
  if (!q) return null;
  const at = text.indexOf(q, from);
  if (at >= 0) return { start: at, end: at + q.length };
  const idx: number[] = [];
  let flat = '';
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    idx.push(i);
    flat += text[i];
  }
  const fq = q.replace(/\s+/g, '');
  if (!fq) return null;
  const k = flat.indexOf(fq);
  if (k < 0) return null;
  return { start: idx[k], end: idx[k + fq.length - 1] + 1 };
}

/** 一次跟模型来回：记一轮在 kb_runs（agent='grader'，老师的），说的话记在 grader:轮次 那一段里 */
export function startRun(teacherId: number, kind: 'rubric' | 'grade' | 'review' | 'insights', request: string, classId: number) {
  return db.insert('kb_runs', {
    teacher_id: teacherId,
    agent: 'grader',
    kind,
    status: 'running',
    request: request.slice(0, 2000),
    class_ids: JSON.stringify([classId]),
    created_by: teacherId,
    created_at: now(),
  });
}
export const finishRun = (runId: number, status: 'done' | 'error' | 'canceled', reply: string, error?: string) =>
  db.update('kb_runs', runId, { status, reply: reply ? reply.slice(0, 4000) : null, error: error ?? null, finished_at: now() });

/**
 * 跟模型来回，直到它用 save 那个工具存好（done() 为真）或者步数用完；模型只说话不用工具时提醒它一次。
 * 返回它最后说的话。
 */
export async function agentLoop(o: {
  teacherId: number;
  runId: number;
  system: string;
  first: string;
  tools: ToolSpec[];
  purpose: string;
  maxSteps: number;
  signal: AbortSignal;
  run: (call: ToolCall) => Promise<string>;
  done: () => boolean;
  /** 它只说话不用工具时提醒它的话 */
  nudge: string;
}): Promise<string> {
  const key = `grader:${o.runId}`;
  append(o.teacherId, key, o.runId, { role: 'user', content: o.first });
  let nudged = false;
  let last = '';
  for (let n = 0; n < o.maxSteps; n++) {
    o.signal.throwIfAborted();
    const r = await modelStep({
      agent: 'grader',
      purpose: o.purpose,
      messages: requestMessages(o.teacherId, key, o.system),
      tools: o.tools,
      userId: o.teacherId,
      signal: o.signal,
      onText: () => {},
    });
    append(o.teacherId, key, o.runId, {
      role: 'assistant',
      content: r.text,
      ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
      ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    });
    last = r.text.trim() || last;
    if (!r.toolCalls.length) {
      if (o.done() || nudged) return last;
      nudged = true;
      append(o.teacherId, key, o.runId, { role: 'user', content: o.nudge });
      continue;
    }
    for (const call of r.toolCalls) {
      let out: string;
      try {
        out = await o.run(call);
      } catch (err) {
        out = `没办成：${(err as Error).message || '没办成'}`;
      }
      append(o.teacherId, key, o.runId, { role: 'tool', toolCallId: call.id, content: out });
    }
    if (o.done()) return last;
  }
  return last;
}

export const str = (description: string) => ({ type: 'string', description });
export const numArg = (description: string) => ({ type: 'number', description });
export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
export const toNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);

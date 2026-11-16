/**
 * 专门助手。
 * CoT 助教自己分出来：一类活反复出现、每次要照同一套做法办时，起个名字，写好管什么、怎么办；以后这类活交给它，它接着自己的会话办。
 * 会话记在 agent_messages 里 spec:编号 那一段，只往后加，太长了压成概要。
 * 作业可以交给它批：一份一份来的活，每份从它的会话往下接着批，批的那一份不留在会话里（不然越批越长，前面批的带偏后面的）；
 * 老师改了它批的分，记进它的会话，下一份就照着老师的意思批。
 * 它手里只有翻老师知识库的工具；改作业、发通知这类事还是助教办。
 */
import { db, now } from '../db/index.js';
import { bad, conflict, notFound } from '../lib/http.js';
import type { ToolCall } from '../llm/types.js';
import type { GradeItem } from '../grading/common.js';
import { READ_KB, SEARCH_KB, readKb, searchKb } from './helper.js';
import { modelStep } from './model.js';
import { teacherTitle } from './pack.js';
import { nowLine } from './time.js';
import { append, compact, requestMessages, stored, threadRow, toMsg } from './thread.js';

export interface Specialist {
  id: number;
  teacher_id: number;
  name: string;
  duty: string;
  guide: string;
  uses: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  retired_at: number | null;
}

/** 一次最多来回几步 */
const MAX_STEPS = 8;
/** 批作业时带上的「以前的事」最多多长（字） */
const MEMORY_MAX = 6000;

export const specKey = (id: number) => `spec:${id}`;

/** 头像：用产品里现成的几张，按编号轮着给 */
const AVATARS = ['tutor', 'coach', 'grader', 'analyst', 'lesson', 'question', 'reviewer', 'steward'];
export const avatarOf = (id: number) => `/agents/${AVATARS[id % AVATARS.length]}.webp`;

const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/[\s「」『』《》"'“”‘’]/g, '')
    .toLowerCase();

export const specialistsOf = (teacherId: number, withRetired = false) =>
  db.all<Specialist>(`SELECT * FROM specialists WHERE teacher_id=? ${withRetired ? '' : 'AND retired_at IS NULL'} ORDER BY id`, teacherId);

export const specialistRow = (id: number) => db.get<Specialist>('SELECT * FROM specialists WHERE id=?', id);

/** 按名字找（还在用的）；对不上时把有哪些告诉助教 */
export function findSpecialist(teacherId: number, ref: unknown): Specialist {
  const all = specialistsOf(teacherId);
  const q = norm(ref);
  if (!q) throw bad('没说是哪个专门助手');
  const hit = all.filter((s) => norm(s.name) === q);
  const loose = hit.length ? hit : all.filter((s) => norm(s.name).includes(q) || q.includes(norm(s.name)));
  if (loose.length === 1) return loose[0];
  throw notFound(`${loose.length ? '对得上好几个' : `没有叫「${String(ref)}」的专门助手`}。现在有：${all.map((s) => `「${s.name}」`).join('、') || '还没有'}`);
}

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .trim()
    .slice(0, max);

export function createSpecialist(teacherId: number, d: { name: unknown; duty: unknown; guide: unknown }): Specialist {
  const name = clean(d.name, 30),
    duty = clean(d.duty, 200),
    guide = clean(d.guide, 4000);
  if (!name) throw bad('专门助手要有个名字');
  if (!duty) throw bad('要写它管哪一类活');
  if (specialistsOf(teacherId).some((s) => norm(s.name) === norm(name))) throw conflict(`已经有叫「${name}」的专门助手了`);
  const t = now();
  const id = db.insert('specialists', { teacher_id: teacherId, name, duty, guide, created_at: t, updated_at: t });
  return specialistRow(id)!;
}

/** 改名字、管的事、做法，或者停用；返回改之前和改之后（撤回用） */
export function updateSpecialist(teacherId: number, id: number, d: { name?: unknown; duty?: unknown; guide?: unknown; retire?: boolean }) {
  const s = specialistRow(id);
  if (!s || s.teacher_id !== teacherId) throw notFound('没有这个专门助手');
  const patch: Partial<Specialist> = {};
  if (d.name !== undefined && clean(d.name, 30)) {
    const name = clean(d.name, 30);
    if (specialistsOf(teacherId).some((x) => x.id !== id && norm(x.name) === norm(name))) throw conflict(`已经有叫「${name}」的专门助手了`);
    patch.name = name;
  }
  if (d.duty !== undefined && clean(d.duty, 200)) patch.duty = clean(d.duty, 200);
  if (d.guide !== undefined && clean(d.guide, 4000)) patch.guide = clean(d.guide, 4000);
  if (d.retire === true) patch.retired_at = now();
  const keys = Object.keys(patch) as (keyof Specialist)[];
  const before = Object.fromEntries(keys.map((k) => [k, s[k]]));
  if (keys.length) db.update('specialists', id, { ...patch, updated_at: now() });
  return { before, after: patch as Record<string, unknown>, row: specialistRow(id)! };
}

/** 给助教看的名单：每轮放在老师那句话前面（没有就不写，没分过专门助手的老师，助教看到的跟原来一样） */
export function rosterLine(teacherId: number): string | null {
  const list = specialistsOf(teacherId);
  if (!list.length) return null;
  const hw = new Map<number, string[]>();
  for (const r of db.all<{ specialist_id: number; title: string; cls: string }>(
    `SELECT a.specialist_id, a.title, c.name AS cls FROM assignments a JOIN classes c ON c.id=a.class_id
     WHERE c.teacher_id=? AND a.specialist_id IS NOT NULL AND a.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY a.id`,
    teacherId,
  ))
    hw.set(r.specialist_id, [...(hw.get(r.specialist_id) || []), `${r.cls}「${r.title}」`]);
  const one = (s: Specialist) => `「${s.name}」管：${s.duty}${hw.get(s.id) ? `；批：${hw.get(s.id)!.join('、')}` : ''}（办过 ${s.uses} 次）`;
  return `（你分出来的专门助手：${list.map(one).join('；')}）`;
}

const used = (id: number) => db.run('UPDATE specialists SET uses=uses+1, last_used_at=? WHERE id=?', now(), id);

export const specialistPrompt = (teacherName: string, s: Pick<Specialist, 'name' | 'duty' | 'guide'>) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教分出来的专门助手「${s.name}」，专管：${s.duty}。
${s.guide ? `做法：\n${s.guide}\n` : ''}老师的资料在知识库里，用 search_kb、read_kb 找。
活是助教交给你的，办完直接写出结果交回给助教。`;

/**
 * 交给专门助手一件活：接着它自己的会话办，办完返回它交回的话。
 * 记一轮在 kb_runs（agent='specialist'，老师的）。不挂在助教那一轮下面（挂上去会当成后台整理的活显示），助教那边记一行工作记录。
 */
export async function runSpecialist(o: { teacherId: number; specialist: Specialist; task: string; signal: AbortSignal }) {
  const s = o.specialist;
  const teacher = db.get<{ name: string }>('SELECT name FROM users WHERE id=?', o.teacherId);
  if (!teacher) throw notFound('没有这位老师');
  const task = clean(o.task, 6000);
  if (!task) throw bad('交代是空的');
  const key = specKey(s.id);
  const runId = db.insert('kb_runs', {
    teacher_id: o.teacherId,
    agent: 'specialist',
    kind: 'task',
    status: 'running',
    request: `「${s.name}」：${task}`.slice(0, 2000),
    created_by: o.teacherId,
    created_at: now(),
  });
  const finish = (status: string, reply: string, error?: string) =>
    db.update('kb_runs', runId, { status, reply: reply ? reply.slice(0, 4000) : null, error: error ?? null, finished_at: now() });
  try {
    await compact({
      ownerId: o.teacherId,
      key,
      signal: o.signal,
      who: { user: '助教', agent: s.name },
      instruction: `把助教交给「${s.name}」的活和它办的结果压成一段要点，给它接着干活用：老师定下的做法和规矩、办过的事里要记住的地方。`,
      agentKey: 'specialist',
      purpose: 'specialist:compact',
    }).catch((err) => console.error('[specialist] compact', err));
    append(o.teacherId, key, runId, { role: 'user', content: `（现在是 ${nowLine()}）\n${task}` });
    let last = '';
    for (let n = 0; n < MAX_STEPS; n++) {
      o.signal.throwIfAborted();
      const r = await modelStep({
        agent: 'specialist',
        purpose: 'specialist:task',
        messages: requestMessages(o.teacherId, key, specialistPrompt(teacher.name, s)),
        tools: [SEARCH_KB, READ_KB],
        userId: o.teacherId,
        signal: o.signal,
        onText: () => {},
      });
      append(o.teacherId, key, runId, {
        role: 'assistant',
        content: r.text,
        ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
        ...(r.reasoning ? { reasoning: r.reasoning } : {}),
      });
      last = r.text.trim() || last;
      if (!r.toolCalls.length) break;
      for (const call of r.toolCalls) append(o.teacherId, key, runId, { role: 'tool', toolCallId: call.id, content: kbTool(o.teacherId, call) });
    }
    used(s.id);
    finish('done', last);
    return { runId, text: last };
  } catch (err) {
    finish(o.signal.aborted ? 'canceled' : 'error', '', (err as Error).message || '没办完');
    throw err;
  }
}

function kbTool(teacherId: number, call: ToolCall): string {
  const a = call.args || {};
  try {
    if (call.name === 'search_kb') return searchKb(teacherId, String(a.query ?? ''));
    if (call.name === 'read_kb') return readKb(teacherId, String(a.path ?? ''), Number(a.offset) || 0);
    return `没有「${call.name}」这个工具`;
  } catch (err) {
    return `没办成：${(err as Error).message || '没办成'}`;
  }
}

/** 它以前的事（概要 + 后来的每一条），写成一段文字：批作业时放在说明里，同一份作业每份开头一样 */
function memoryText(teacherId: number, id: number) {
  const key = specKey(id);
  const t = threadRow(teacherId, key);
  const lines = stored(teacherId, key, t.summary_upto).map((r) => {
    const m = toMsg(r);
    const body = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).trim();
    if (r.role === 'tool') return '';
    if (r.role === 'assistant') return body ? `你：${body}` : '';
    return `助教：${body}`;
  });
  let text = lines.filter(Boolean).join('\n');
  if (text.length > MEMORY_MAX) text = '…' + text.slice(-MEMORY_MAX);
  return [t.summary ? `更早的概要：${t.summary}` : '', text].filter(Boolean).join('\n');
}

/** 批作业：这份作业交给了哪个专门助手（还在用的），没有就是 null */
export function graderOf(assignment: { teacher_id: number; specialist_id?: number | null }): Specialist | null {
  if (!assignment.specialist_id) return null;
  const s = specialistRow(assignment.specialist_id);
  return s && s.teacher_id === assignment.teacher_id && !s.retired_at ? s : null;
}

/** 批作业时的说明：批改的规矩不变，前面说明它是谁、照什么做法，再带上它以前的事 */
export function specialistGradeSystem(base: string, s: Specialist) {
  const memory = memoryText(s.teacher_id, s.id);
  return `${base}
你是专管这类作业的专门助手「${s.name}」（${s.duty}）。${s.guide ? `\n做法：\n${s.guide}` : ''}${memory ? `\n\n你以前办过的事和老师的交代：\n${memory}` : ''}`;
}

export function noteGraded(id: number) {
  used(id);
}

/**
 * 老师改了专门助手批的分：记进它的会话，下一份照着老师的意思批。
 * changes：哪一项、助教给的、老师改成的、老师写的原因（没写就不带）。
 */
export function noteTeacherChange(
  a: { id: number; title: string; teacher_id: number; specialist_id?: number | null },
  who: string,
  changes: { title: string; from: number; to: number; why?: string }[],
) {
  const s = graderOf(a);
  if (!s || !changes.length) return;
  const show = (n: number) => String(Math.round(n * 10) / 10);
  const text = changes.map((c) => `「${c.title}」${show(c.from)} → ${show(c.to)} 分${c.why ? `，老师写的原因：${c.why}` : ''}`).join('；');
  append(a.teacher_id, specKey(s.id), null, { role: 'user', content: `（老师改了你批的「${a.title}」${who}：${text}。以后同样的情况照老师的分给）` });
}

/** 老师那一份跟助教批的比，哪几项分数变了（原因去掉「（老师改成 N 分）」那一截） */
export function changedItems(ai: GradeItem[], mine: GradeItem[]) {
  return mine
    .map((x, i) => ({ x, ai: ai[i] }))
    .filter(({ x, ai }) => ai && Math.abs(ai.got - x.got) >= 0.01)
    .map(({ x, ai }) => ({
      title: x.title,
      from: ai!.got,
      to: x.got,
      why: x.why.replace(/（老师改成 [\d.]+ 分）$/, '').trim() !== ai!.why.trim() ? x.why.replace(/（老师改成 [\d.]+ 分）$/, '').trim() : undefined,
    }));
}

/** 服务重启：还在办的算没办完 */
export function recoverSpecialistRuns() {
  db.run("UPDATE kb_runs SET status='error', error='服务中断，没办完', finished_at=? WHERE agent='specialist' AND status='running'", now());
}

/** 老师那边看：管什么、怎么办、办过几次、批哪几份作业、最近办的几件 */
export function specialistList(teacherId: number) {
  return specialistsOf(teacherId).map((s) => ({
    id: s.id,
    name: s.name,
    duty: s.duty,
    guide: s.guide,
    avatar: avatarOf(s.id),
    uses: s.uses,
    lastUsedAt: s.last_used_at,
    createdAt: s.created_at,
    homework: db
      .all<{ id: number; title: string; class_id: number; cls: string }>(
        'SELECT a.id, a.title, a.class_id, c.name AS cls FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.specialist_id=? AND a.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY a.id',
        s.id,
      )
      .map((h) => ({ id: h.id, title: h.title, classId: h.class_id, className: h.cls })),
    recent: db
      .all<{ request: string; reply: string | null; status: string; created_at: number }>(
        "SELECT request, reply, status, created_at FROM kb_runs WHERE teacher_id=? AND agent IN ('specialist','grader') AND request LIKE ? ORDER BY id DESC LIMIT 5",
        teacherId,
        `「${s.name}」%`,
      )
      .map((r) => ({ what: r.request.replace(`「${s.name}」`, '').replace(/^：/, ''), result: r.reply, status: r.status, at: r.created_at })),
  }));
}

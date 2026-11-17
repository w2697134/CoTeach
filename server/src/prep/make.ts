/**
 * 助教备一节课（2026-11-17）：几手分头做，页面上看得到每一手做到哪。
 *   学情：这个班卡在哪（没看过或者旧了先看一遍）
 *   教案：照老师知识库里的教案、课件、授课计划写
 *   课件、练习和作业：照教案，两手一起做
 *   核对：对一遍答案、代码、跟教案对不对得上，错的改掉
 * 老师说着改（ask）：照老师的话改这节课，改了哪份就记一版，能撤回。
 * 发给模型的话改之前先用 tools/prep-measure 的尺子量。
 */
import { db, j, now } from '../db/index.js';
import { bad, conflict } from '../lib/http.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { teacherTitle } from '../assistant/pack.js';
import { READ_KB, SEARCH_KB, kbCatalog, readKb, searchKb } from '../assistant/helper.js';
import { modelStep } from '../assistant/model.js';
import { nowLine } from '../assistant/time.js';
import { append, compact, requestMessages, stored, threadRow, toMsg } from '../assistant/thread.js';
import { classRow, finishRun, numArg, obj, startRun, str, toNum, userName } from '../grading/common.js';
import { insightsOf, writeInsights } from '../grading/insights.js';
import { SLIDE_KIT_GUIDE, SLIDE_KIT_READY, cleanSlideHtml, tooFull } from './kit.js';
import {
  LAYOUTS,
  QTYPES,
  amendPart,
  briefOf,
  cleanDeck,
  cleanPlan,
  cleanQuestion,
  cleanQuestions,
  cleanSlide,
  lessonRow,
  savePart,
  setLane,
  type Brief,
  type Deck,
  type LaneKey,
  type LessonRow,
  type Part,
  type Plan,
  type Question,
} from './lessons.js';

/* ---------------- 工具 ---------------- */

const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

const SAVE_PLAN: ToolSpec = {
  name: 'save_plan',
  description: '存教案，再存一次就换成新的。',
  parameters: obj(
    {
      title: str('课题'),
      goals: strs('教学目标'),
      focus: str('重点'),
      hard: str('难点'),
      review: str('开头补讲：这个班学生卡住的地方怎么补'),
      steps: {
        type: 'array',
        description: '教学过程',
        items: obj({ name: str('环节'), minutes: numArg('几分钟'), content: str('做什么、讲什么') }, ['name', 'content']),
      },
      board: str('板书设计'),
      sources: strs('用到的知识库文件'),
    },
    ['title', 'goals', 'steps'],
  ),
};

const SLIDE = obj(
  {
    layout: {
      type: 'string',
      enum: [...LAYOUTS],
      description: '版式：cover 封面，section 小节标题，points 要点，code 代码，compare 左右对比，steps 步骤，quiz 课堂提问，table 表格，quote 引用，summary 小结',
    },
    title: str('标题'),
    subtitle: str('副标题'),
    points: strs('屏幕上的要点，一条一句短话；展开的讲解写进讲稿'),
    code: obj({ lang: str('语言'), text: str('代码'), caption: str('代码下面的一句说明') }),
    compare: obj({ left: obj({ head: str('左边的标题'), points: strs('左边的要点') }), right: obj({ head: str('右边的标题'), points: strs('右边的要点') }) }),
    steps: { type: 'array', items: obj({ head: str('这一步'), text: str('说明') }, ['head']), description: '步骤' },
    quiz: obj({ question: str('问题'), options: strs('选项'), answer: str('答案，写选项字母'), explain: str('讲解') }),
    table: obj({ head: strs('表头'), rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '每一行' } }),
    quote: obj({ text: str('引文'), by: str('出处') }),
    notes: str('讲稿：老师讲这一页时说的话'),
  },
  ['layout', 'title'],
);
const SAVE_DECK: ToolSpec = {
  name: 'save_deck',
  description: '存课件，再存一次就换成新的。',
  parameters: obj({ slides: { type: 'array', items: SLIDE, description: '一页一页' } }, ['slides']),
};

const QUESTION = (withPoints: boolean) =>
  obj(
    {
      type: { type: 'string', enum: [...QTYPES], description: '题型：single 单选，multi 多选，judge 判断，blank 填空，short 简答，code 编程' },
      stem: str('题干'),
      code: str('题目里给的代码，没有就不写'),
      options: strs('选项，选择题才有'),
      answer: str('答案：选择题写选项字母，判断写对或错，其他写参考答案'),
      explain: str('解析'),
      ...(withPoints ? { points: numArg('几分'), rubric: str('怎么给分') } : {}),
    },
    ['type', 'stem', 'answer'],
  );
const SAVE_QUESTIONS: ToolSpec = {
  name: 'save_questions',
  description: '存课堂练习和课后作业，再存一次就换成新的。',
  parameters: obj(
    {
      practice: { type: 'array', items: QUESTION(false), description: '课堂练习：上课当场做' },
      homework: { type: 'array', items: QUESTION(true), description: '课后作业：发到班里，助教照评分标准批' },
    },
    ['practice', 'homework'],
  ),
};

const SAVE_PAGES: ToolSpec = {
  name: 'save_pages',
  description: '存做好的几页，同一页再存就换成新的。',
  parameters: obj(
    { pages: { type: 'array', items: obj({ page: numArg('第几页'), html: str('这一页的 HTML'), notes: str('这一页完整的讲稿；不改讲稿就不写') }, ['page', 'html']) } },
    ['pages'],
  ),
};

const KIND = { type: 'string', enum: ['practice', 'homework'], description: 'practice 课堂练习，homework 课后作业' };
const EDIT_TOOLS: ToolSpec[] = [
  {
    name: 'update_plan',
    description: '改教案：只传要改的几栏，传了的整栏换掉。',
    parameters: obj({
      title: str('课题'),
      goals: strs('教学目标'),
      focus: str('重点'),
      hard: str('难点'),
      review: str('开头补讲'),
      steps: { type: 'array', items: obj({ name: str('环节'), minutes: numArg('几分钟'), content: str('做什么、讲什么') }, ['name', 'content']), description: '教学过程' },
      board: str('板书设计'),
    }),
  },
  { name: 'update_slide', description: '把课件的第几页整页换掉。', parameters: obj({ page: numArg('第几页'), slide: SLIDE }, ['page', 'slide']) },
  {
    name: 'insert_slides',
    description: '在第几页后面加几页；加在最前面 after 写 0。',
    parameters: obj({ after: numArg('加在第几页后面'), slides: { type: 'array', items: SLIDE } }, ['after', 'slides']),
  },
  { name: 'delete_slides', description: '删掉课件的几页。', parameters: obj({ pages: { type: 'array', items: { type: 'number' }, description: '第几页' } }, ['pages']) },
  {
    name: 'update_question',
    description: '把课堂练习或课后作业的第几题整题换掉。',
    parameters: obj({ kind: KIND, number: numArg('第几题'), question: QUESTION(true) }, ['kind', 'number', 'question']),
  },
  {
    name: 'add_questions',
    description: '在课堂练习或课后作业后面加几道题。',
    parameters: obj({ kind: KIND, questions: { type: 'array', items: QUESTION(true) } }, ['kind', 'questions']),
  },
  {
    name: 'delete_questions',
    description: '删掉课堂练习或课后作业的几道题。',
    parameters: obj({ kind: KIND, numbers: { type: 'array', items: { type: 'number' }, description: '第几题' } }, ['kind', 'numbers']),
  },
];
const CHECK_TOOLS = EDIT_TOOLS.filter((t) => t.name === 'update_slide' || t.name === 'update_question');

/* ---------------- 写给模型看的这节课 ---------------- */

export function planText(p: Plan, minutes: number | null) {
  const lines = [`课题：${p.title}${minutes ? `（${minutes} 分钟）` : ''}`];
  if (p.goals.length) lines.push('教学目标：', ...p.goals.map((g, i) => `${i + 1}. ${g}`));
  if (p.focus) lines.push(`重点：${p.focus}`);
  if (p.hard) lines.push(`难点：${p.hard}`);
  if (p.review) lines.push(`开头补讲：${p.review}`);
  if (p.steps.length) lines.push('教学过程：', ...p.steps.map((s) => `- ${s.name}${s.minutes ? `（${s.minutes} 分钟）` : ''}：${s.content}`));
  if (p.board) lines.push(`板书设计：${p.board}`);
  return lines.join('\n');
}

const letter = (n: number) => String.fromCharCode(65 + n);
/** 课件一页一行（JSON，跟存的时候一个写法，答案写成字母） */
function deckText(d: Deck) {
  return d.slides
    .map((s, i) => {
      const { id: _id, quiz, html: _html, ...rest } = s;
      const out: any = { ...rest };
      if (quiz) out.quiz = { ...quiz, answer: quiz.answer.map(letter).join('') };
      return `第${i + 1}页：${JSON.stringify(out)}`;
    })
    .join('\n');
}
function questionsText(qs: Question[]) {
  return qs
    .map((q, i) => {
      const { id: _id, choice: _c, ...rest } = q;
      return `第${i + 1}题：${JSON.stringify(rest)}`;
    })
    .join('\n');
}
function briefText(b: Brief | null) {
  if (!b?.points.length) return '';
  return ['这个班学生卡住的地方（丢分多的在前）：', ...b.points.map((p) => `- ${p.title}：${p.what}（${p.lost} 人丢分${p.asked ? `，${p.asked} 人问过` : ''}）`)].join('\n');
}

/* ---------------- 跟模型来回 ---------------- */

/** 来回到它用存的那个工具存好（done 为真）或者步数用完；只说话不用工具时提醒一次 */
async function loop(o: {
  teacherId: number;
  key: string;
  system: string;
  first: string;
  tools: ToolSpec[];
  purpose: string;
  maxSteps: number;
  signal: AbortSignal;
  run: (call: ToolCall) => Promise<string> | string;
  done?: () => boolean;
  nudge?: string;
}): Promise<string> {
  append(o.teacherId, o.key, null, { role: 'user', content: o.first });
  let nudged = false;
  let last = '';
  for (let n = 0; n < o.maxSteps; n++) {
    o.signal.throwIfAborted();
    const msgs = requestMessages(o.teacherId, o.key, o.system);
    const r = await modelStep({ agent: 'prep', purpose: o.purpose, messages: msgs, tools: o.tools, userId: o.teacherId, signal: o.signal, onText: () => {} });
    append(o.teacherId, o.key, null, {
      role: 'assistant',
      content: r.text,
      ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
      ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    });
    last = r.text.trim() || last;
    if (!r.toolCalls.length) {
      if (!o.done || o.done() || nudged || !o.nudge) return last;
      nudged = true;
      append(o.teacherId, o.key, null, { role: 'user', content: o.nudge });
      continue;
    }
    for (const call of r.toolCalls) {
      let out: string;
      try {
        out = await o.run(call);
      } catch (err) {
        out = `没办成：${(err as Error).message || '没办成'}`;
      }
      append(o.teacherId, o.key, null, { role: 'tool', toolCallId: call.id, content: out });
    }
    if (o.done?.()) return last;
  }
  return last;
}

function kbTool(teacherId: number, call: ToolCall): string | null {
  const a = call.args || {};
  if (call.name === 'search_kb') return searchKb(teacherId, String(a.query ?? ''));
  if (call.name === 'read_kb') return readKb(teacherId, String(a.path ?? ''), Math.max(0, Math.round(toNum(a.offset)) || 0));
  return null;
}

/* ---------------- 备一节课 ---------------- */

const making = new Map<number, AbortController>();
export const isMaking = (id: number) => making.has(id);

const ALL: LaneKey[] = ['brief', 'plan', 'deck', 'questions', 'check'];

/** 开始备一节（后台做），返回编号 */
export function startLesson(teacherId: number, classId: number, request: string | null, minutes: number | null): number {
  const k = classRow(classId);
  if (!k || k.teacher_id !== teacherId) throw bad('这个班不在了');
  const t = now();
  const id = db.insert('lessons', {
    teacher_id: teacherId,
    class_id: classId,
    request: request?.trim() || null,
    minutes,
    status: 'making',
    lanes: JSON.stringify(Object.fromEntries(ALL.map((key) => [key, { status: 'wait' }]))),
    created_at: t,
    updated_at: t,
  });
  run(id, ALL);
  return id;
}

/** 重做或者补做其中几手（以前只有教案的补课件和题目；某一手没做成重来） */
export function redoLesson(teacherId: number, id: number, lanes: LaneKey[]) {
  const r = lessonRow(id);
  if (!r || r.teacher_id !== teacherId) throw bad('这节课不在了');
  if (making.has(id)) throw conflict('这节课还在备');
  const want = ALL.filter((k) => lanes.includes(k));
  if (!want.length) throw bad('要重做哪一份没说');
  if (!want.includes('plan') && !r.plan) throw bad('先要有教案');
  const lanesNow = j<Record<string, unknown>>(r.lanes, {});
  for (const k of want) lanesNow[k] = { status: 'wait' };
  db.update('lessons', id, { status: 'making', error: null, lanes: JSON.stringify(lanesNow), updated_at: now() });
  run(id, want);
}

function run(id: number, lanes: LaneKey[]) {
  const ctrl = new AbortController();
  making.set(id, ctrl);
  void make(id, lanes, ctrl.signal).finally(() => making.delete(id));
}

/** 删掉一节课：还在备的停下 */
export function stopLesson(id: number) {
  making.get(id)?.abort(new Error('已删除'));
}

async function make(id: number, lanes: LaneKey[], signal: AbortSignal) {
  const r0 = lessonRow(id)!;
  const k = classRow(r0.class_id)!;
  const teacher = userName(r0.teacher_id);
  const runId = startRun(r0.teacher_id, 'prep', `给「${k.name}」备课${r0.request ? `：${r0.request}` : ''}`, r0.class_id);
  const want = (x: LaneKey) => lanes.includes(x);
  try {
    if (want('brief')) await laneBrief(id, r0.class_id, signal);
    if (want('plan')) await lanePlan(id, teacher, signal);
    const after = lessonRow(id)!;
    if (!after.plan) throw new Error('教案没写成');
    await Promise.all([want('deck') ? laneDeck(id, teacher, signal) : null, want('questions') ? laneQuestions(id, teacher, signal) : null]);
    if (want('check')) await laneCheck(id, teacher, signal);
    const done = lessonRow(id)!;
    db.update('lessons', id, { status: 'ready', error: null, updated_at: now() });
    finishRun(runId, 'done', done.title || '');
  } catch (err) {
    const msg = signal.aborted ? '停下了' : (err as Error).message || '没备成';
    db.update('lessons', id, { status: lessonRow(id)?.plan ? 'ready' : 'error', error: msg, updated_at: now() });
    finishRun(runId, signal.aborted ? 'canceled' : 'error', '', msg);
  }
}

/** 一手做不成：记在这一手上，接着做别的（教案那一手例外，没有教案后面的都做不了） */
async function lane(id: number, key: LaneKey, work: () => Promise<string>, required = false) {
  setLane(id, key, { status: 'doing' });
  try {
    const note = await work();
    setLane(id, key, { status: 'done', note: note.slice(0, 120) });
  } catch (err) {
    const msg = (err as Error).message || '没做成';
    setLane(id, key, { status: 'error', note: msg.slice(0, 120) });
    if (required) throw err;
  }
}

function laneBrief(id: number, classId: number, signal: AbortSignal) {
  return lane(id, 'brief', async () => {
    const ins = insightsOf(classId);
    if (ins.status === 'none' || ins.stale || ins.status === 'error') await writeInsights(classId, signal).catch(() => {});
    const b = briefOf(classId);
    db.update('lessons', id, { brief: JSON.stringify(b) });
    const top = b.points[0];
    return top ? `卡得最多：${top.title}（${top.lost} 人丢分）` : '这个班还没有批过的作业';
  });
}

export const planPrompt = (teacherName: string) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教，替老师备这一节课。照老师知识库里自己的教案、课件、授课计划来；这个班学生卡住的地方，放进开头的补讲。`;

/** 给写教案的：今天几号、这个班布置过哪些作业（看出进度）、学情、以前备过哪几节、老师说这节讲什么、知识库里有什么 */
function material(r: LessonRow) {
  const k = classRow(r.class_id)!;
  const hw = db.all<{ title: string }>('SELECT title FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY publish_at, id', r.class_id);
  const before = db
    .all<{ title: string | null }>("SELECT title FROM lessons WHERE class_id=? AND id<>? AND status='ready' AND deleted_at IS NULL ORDER BY id DESC LIMIT 6", r.class_id, r.id)
    .map((x) => x.title)
    .filter(Boolean);
  const lines = [`（现在是 ${nowLine()}）`, `「${k.name}」`];
  if (hw.length) lines.push('', '这个班布置过的作业（按时间）：', ...hw.map((h) => `- ${h.title}`));
  const brief = briefText(j<Brief | null>(r.brief, null));
  if (brief) lines.push('', brief);
  if (before.length) lines.push('', `以前备过的课：${before.join('、')}`);
  lines.push(
    '',
    kbCatalog(r.teacher_id),
    '',
    r.request ? `老师说这节课：${r.request}` : '老师没说这节讲什么：照授课计划和作业进度，备紧接着的下一节。',
    r.minutes ? `这节课 ${r.minutes} 分钟。` : '',
    '写好用 save_plan 存。',
  );
  return lines.filter((x) => x !== '').join('\n');
}

function lanePlan(id: number, teacher: string, signal: AbortSignal) {
  return lane(
    id,
    'plan',
    async () => {
      const r = lessonRow(id)!;
      let saved: Plan | null = null;
      const said = await loop({
        teacherId: r.teacher_id,
        key: `prep:${id}:plan:${now()}`,
        system: planPrompt(teacher),
        first: material(r),
        tools: [SEARCH_KB, READ_KB, SAVE_PLAN],
        purpose: 'prep:plan',
        maxSteps: 14,
        signal,
        nudge: '用 save_plan 把教案存下来。',
        done: () => !!saved,
        run: (call) => {
          const kb = kbTool(r.teacher_id, call);
          if (kb !== null) return kb;
          if (call.name === 'save_plan') {
            saved = cleanPlan(call.args);
            return '存好了';
          }
          return `没有「${call.name}」这个工具`;
        },
      });
      const p = saved as Plan | null;
      // 没写成多半是缺了东西（没资料、不知道讲哪节）：把它说的原因带给老师
      if (!p) throw new Error(said.replace(/\s+/g, ' ').trim().slice(0, 160) || '助教没写出教案');
      const minutes = r.minutes ?? (p.steps.reduce((n, s) => n + (s.minutes || 0), 0) || null);
      savePart(id, 'plan', p, 'ta');
      db.update('lessons', id, { minutes });
      return p.title;
    },
    true,
  );
}

const deckPrompt = (teacherName: string) => `你是${teacherTitle(teacherName)}的 CoT 助教，照教案给这一节课做课件，上课放给学生看。`;

function laneDeck(id: number, teacher: string, signal: AbortSignal) {
  return lane(id, 'deck', async () => {
    const r = lessonRow(id)!;
    const p = j<Plan>(r.plan, null as any);
    let saved: Deck | null = null;
    await loop({
      teacherId: r.teacher_id,
      key: `prep:${id}:deck:${now()}`,
      system: deckPrompt(teacher),
      first: [`「${classRow(r.class_id)?.name}」的这节课：`, planText(p, r.minutes), briefText(j<Brief | null>(r.brief, null)), kbCatalog(r.teacher_id), '做好用 save_deck 存。']
        .filter(Boolean)
        .join('\n\n'),
      tools: [SEARCH_KB, READ_KB, SAVE_DECK],
      purpose: 'prep:deck',
      maxSteps: 10,
      signal,
      nudge: '用 save_deck 把课件存下来。',
      done: () => !!saved,
      run: (call) => {
        const kb = kbTool(r.teacher_id, call);
        if (kb !== null) return kb;
        if (call.name === 'save_deck') {
          saved = cleanDeck(call.args);
          return `存好了，${saved.slides.length} 页`;
        }
        return `没有「${call.name}」这个工具`;
      },
    });
    const d = saved as Deck | null;
    if (!d) throw new Error('助教没做出课件');
    const old = j<Deck | null>(lessonRow(id)?.deck ?? null, null);
    if (old?.theme) d.theme = old.theme;
    savePart(id, 'deck', d, 'ta');
    const n = d.slides.length;
    if (!SLIDE_KIT_READY) return `${n} 页`;
    setLane(id, 'deck', { status: 'doing', note: `${n} 页，在做成幻灯片` });
    // 做成幻灯片并进刚存的那一版：撤回不会退到没样子的课件
    const made = await designPages(
      id,
      teacher,
      d.slides.map((_, i) => i),
      signal,
      (k) => setLane(id, 'deck', { status: 'doing', note: `${n} 页，做好 ${k} 页` }),
      true,
      (k) => setLane(id, 'deck', { status: 'doing', note: `${n} 页，精修 ${k} 页太满的` }),
    );
    return made < n ? `${n} 页（${n - made} 页没做成幻灯片）` : `${n} 页`;
  });
}

const designPrompt = (teacherName: string) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教，把这节课的课件做成上课放的幻灯片：每一页写成一段 HTML，照下面这套课件样式。

${SLIDE_KIT_GUIDE}`;

/** 一页给「做成幻灯片」看的内容（不带 id、讲稿、旧的 html） */
function pageContent(s: Deck['slides'][number]) {
  const { id: _id, html: _html, notes: _notes, quiz, ...rest } = s;
  return JSON.stringify(quiz ? { ...rest, quiz: { ...quiz, answer: quiz.answer.map(letter).join('') } } : rest);
}

/** 同一时间跑几件（Gemini 接口两个名额） */
async function pool<T>(items: T[], n: number, work: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await work(x);
  }));
}

/**
 * 把课件的几页做成幻灯片（一次五页，两次一起做）：内容已经定了，这一手只管样子。
 * 做成的那几页存进课件；没做成的还按内容和版式显示。返回做成了几页。
 */
export async function designPages(
  id: number,
  teacher: string,
  pages: number[],
  signal: AbortSignal,
  onDone?: (k: number) => void,
  /** true：并进刚才那一版（说着改、核对改了内容以后补做样子，撤回一次就都回去） */
  amend = false,
  /** 做完有几页太满、在精修 */
  onRefine?: (k: number) => void,
): Promise<number> {
  const r = lessonRow(id);
  if (!r) return 0;
  const d = j<Deck | null>(r.deck, null);
  if (!d || !pages.length) return 0;
  const plan = j<Plan | null>(r.plan, null);
  const titles = d.slides.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  const html = new Map<number, string>();
  const batches: number[][] = [];
  const sorted = [...new Set(pages)].filter((i) => i >= 0 && i < d.slides.length).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 5) batches.push(sorted.slice(i, i + 5));
  await pool(batches, 2, async (batch) => {
    try {
      await loop({
        teacherId: r.teacher_id,
        key: `prep:${id}:design:${batch[0]}:${now()}`,
        system: designPrompt(teacher),
        first: [
          `「${classRow(r.class_id)?.name}」${plan?.title ? `《${plan.title}》` : ''}的课件一共 ${d.slides.length} 页：`,
          titles,
          `这次做第 ${batch.map((i) => i + 1).join('、')} 页，每页的内容：`,
          ...batch.map((i) => `第${i + 1}页：${pageContent(d.slides[i])}`),
          '做好用 save_pages 存。',
        ].join('\n\n'),
        tools: [SAVE_PAGES],
        purpose: 'prep:design',
        maxSteps: 3,
        signal,
        nudge: '用 save_pages 把这几页存下来。',
        done: () => batch.every((i) => html.has(i)),
        run: (call) => {
          if (call.name !== 'save_pages') return `没有「${call.name}」这个工具`;
          const got: number[] = [];
          for (const x of Array.isArray(call.args?.pages) ? call.args.pages : []) {
            const i = Math.round(toNum((x as any)?.page)) - 1;
            const h = cleanSlideHtml((x as any)?.html);
            if (batch.includes(i) && h) {
              html.set(i, h);
              got.push(i + 1);
            }
          }
          const left = batch.filter((i) => !html.has(i)).map((i) => i + 1);
          return got.length ? `存好了第 ${got.join('、')} 页${left.length ? `；还差第 ${left.join('、')} 页` : ''}` : '一页都没存上：page 写第几页，html 写这一页的 HTML';
        },
      });
    } catch (err) {
      if (signal.aborted) throw err;
      console.error('[prep] design', id, batch, (err as Error).message);
    }
    onDone?.(html.size);
  });
  if (!html.size) return 0;
  const notes = await refinePages(id, teacher, html, signal, onRefine);
  // 存进最新的课件（这一手做的时候课件没别人改：备课时不让改，说着改的那一句做完才做这一步）
  const latest = j<Deck | null>(lessonRow(id)?.deck ?? null, null);
  if (!latest) return 0;
  latest.slides = latest.slides.map((s, i) => (html.has(i) ? { ...s, html: html.get(i), ...(notes.has(i) ? { notes: notes.get(i) } : {}) } : s));
  if (amend) amendPart(id, 'deck', latest);
  else savePart(id, 'deck', latest, 'ta', '做成幻灯片');
  return html.size;
}

/**
 * 精修：做出来太满的页（程序量），交回去删到只留要紧的，细节挪进讲稿，再做一遍这几页（只来一轮）。
 * 直接改 html 里的那几页；挪进讲稿以后的整份讲稿放在返回的 notes 里。
 */
export async function refinePages(id: number, teacher: string, html: Map<number, string>, signal: AbortSignal, onRefine?: (k: number) => void) {
  const notes = new Map<number, string>();
  const r = lessonRow(id);
  const d = j<Deck | null>(r?.deck ?? null, null);
  if (!r || !d) return notes;
  const plan = j<Plan | null>(r.plan, null);
  const full = [...html].map(([i, h]) => ({ i, why: tooFull(h) })).filter((x) => x.why.length);
  if (full.length) {
    onRefine?.(full.length);
    const fix: { i: number; why: string[] }[][] = [];
    for (let k = 0; k < full.length; k += 4) fix.push(full.slice(k, k + 4));
    await pool(fix, 2, async (batch) => {
      const fixed = new Set<number>();
      try {
        await loop({
          teacherId: r.teacher_id,
          key: `prep:${id}:refine:${batch[0].i}:${now()}`,
          system: designPrompt(teacher),
          first: [
            `「${classRow(r.class_id)?.name}」${plan?.title ? `《${plan.title}》` : ''}的课件，下面几页做出来太满了，教室后排看不清。`,
            '每页只留学生要看的几句，其余的挪进讲稿；重做这几页，notes 写这一页完整的讲稿（原来的加上挪过去的）。',
            ...batch.map((x) => `第${x.i + 1}页（${x.why.join('、')}）：\n${html.get(x.i)}\n原来的讲稿：${d.slides[x.i].notes || '（没有）'}`),
            '做好用 save_pages 存。',
          ].join('\n\n'),
          tools: [SAVE_PAGES],
          purpose: 'prep:refine',
          maxSteps: 3,
          signal,
          nudge: '用 save_pages 把这几页存下来。',
          done: () => batch.every((x) => fixed.has(x.i)),
          run: (call) => {
            if (call.name !== 'save_pages') return `没有「${call.name}」这个工具`;
            for (const p of Array.isArray(call.args?.pages) ? call.args.pages : []) {
              const i = Math.round(toNum((p as any)?.page)) - 1;
              const h = cleanSlideHtml((p as any)?.html);
              if (!batch.some((x) => x.i === i) || !h) continue;
              html.set(i, h);
              fixed.add(i);
              const n = String((p as any)?.notes ?? '').trim();
              if (n) notes.set(i, n.slice(0, 3000));
            }
            const left = batch.filter((x) => !fixed.has(x.i)).map((x) => x.i + 1);
            return left.length ? `还差第 ${left.join('、')} 页` : '都存好了';
          },
        });
      } catch (err) {
        if (signal.aborted) throw err;
        console.error('[prep] refine', id, batch.map((x) => x.i), (err as Error).message);
      }
    });
  }
  return notes;
}

/** 课件里已经做成幻灯片、又被改了内容的几页（改内容时样子就去掉了）：补做样子 */
async function redesignChanged(id: number, teacher: string, signal: AbortSignal) {
  const d = j<Deck | null>(lessonRow(id)?.deck ?? null, null);
  if (!d || !d.slides.some((s) => s.html)) return;
  const missing = d.slides.flatMap((s, i) => (s.html ? [] : [i]));
  if (missing.length) await designPages(id, teacher, missing, signal, undefined, true);
}

const questionsPrompt = (teacherName: string) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教，照教案出这一节课的课堂练习和课后作业。课堂练习上课当场做；课后作业发到班里，你照评分标准批。`;

function laneQuestions(id: number, teacher: string, signal: AbortSignal) {
  return lane(id, 'questions', async () => {
    const r = lessonRow(id)!;
    const p = j<Plan>(r.plan, null as any);
    let saved: { practice: Question[]; homework: Question[] } | null = null;
    await loop({
      teacherId: r.teacher_id,
      key: `prep:${id}:questions:${now()}`,
      system: questionsPrompt(teacher),
      first: [`「${classRow(r.class_id)?.name}」的这节课：`, planText(p, r.minutes), briefText(j<Brief | null>(r.brief, null)), '出好用 save_questions 存。'].filter(Boolean).join('\n\n'),
      tools: [SAVE_QUESTIONS],
      purpose: 'prep:questions',
      maxSteps: 4,
      signal,
      nudge: '用 save_questions 把题存下来。',
      done: () => !!saved,
      run: (call) => {
        if (call.name !== 'save_questions') return `没有「${call.name}」这个工具`;
        const a = call.args || {};
        saved = { practice: cleanQuestions(a.practice, false), homework: cleanQuestions(a.homework, true) };
        if (!saved.practice.length && !saved.homework.length) {
          saved = null;
          throw new Error('一道题都没有');
        }
        return `存好了：课堂练习 ${saved.practice.length} 道，课后作业 ${saved.homework.length} 道`;
      },
    });
    const s = saved as { practice: Question[]; homework: Question[] } | null;
    if (!s) throw new Error('助教没出题');
    savePart(id, 'practice', s.practice, 'ta');
    savePart(id, 'homework', s.homework, 'ta');
    return `练习 ${s.practice.length} 道，作业 ${s.homework.length} 道`;
  });
}

const checkPrompt = (teacherName: string) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教。这节课备好了，上课前核对一遍：答案对不对，代码跑出来是不是说的结果，课件和题目跟教案对不对得上。错的用工具改掉，没错的不动。最后用一句话说核对的结果。`;

function lessonText(r: LessonRow) {
  const p = j<Plan | null>(r.plan, null);
  const d = j<Deck | null>(r.deck, null);
  const pr = j<Question[]>(r.practice, []);
  const hw = j<Question[]>(r.homework, []);
  return [
    p ? `【教案】\n${planText(p, r.minutes)}` : '【教案】还没有',
    d ? `【课件】\n${deckText(d)}` : '【课件】还没有',
    pr.length ? `【课堂练习】\n${questionsText(pr)}` : '【课堂练习】还没有',
    hw.length ? `【课后作业】\n${questionsText(hw)}` : '【课后作业】还没有',
  ].join('\n\n');
}

function laneCheck(id: number, teacher: string, signal: AbortSignal) {
  return lane(id, 'check', async () => {
    const r = lessonRow(id)!;
    const fixed: string[] = [];
    const text = await loop({
      teacherId: r.teacher_id,
      key: `prep:${id}:check:${now()}`,
      system: checkPrompt(teacher),
      first: lessonText(r),
      tools: CHECK_TOOLS,
      purpose: 'prep:check',
      maxSteps: 6,
      signal,
      run: (call) => {
        const { what } = applyEdit(id, call, 'ta');
        fixed.push(what);
        return `改好了：${what}`;
      },
    });
    await redesignChanged(id, teacher, signal);
    return fixed.length ? `改了 ${fixed.length} 处：${fixed.join('；')}` : text.replace(/\s+/g, ' ').trim() || '没发现问题';
  });
}

/* ---------------- 改（老师说着改、核对时改） ---------------- */

const kindName = (k: string) => (k === 'homework' ? '课后作业' : '课堂练习');

/** 照一次工具调用改这节课，返回改了哪一份、改了什么（一句） */
function applyEdit(id: number, call: ToolCall, by: 'teacher' | 'ta'): { part: Part; what: string } {
  const r = lessonRow(id);
  if (!r) throw bad('这节课不在了');
  const a = call.args || {};
  const page = (v: unknown, n: number) => {
    const x = Math.round(toNum(v));
    if (!Number.isInteger(x) || x < 1 || x > n) throw bad(`没有第 ${String(v)} 页，课件一共 ${n} 页`);
    return x - 1;
  };
  switch (call.name) {
    case 'update_plan': {
      const p = j<Plan | null>(r.plan, null);
      if (!p) throw bad('还没有教案');
      const next = cleanPlan({ ...p, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null)) });
      savePart(id, 'plan', next, by);
      const names: Record<string, string> = { title: '课题', goals: '教学目标', focus: '重点', hard: '难点', review: '开头补讲', steps: '教学过程', board: '板书设计' };
      return { part: 'plan', what: `改了教案的${Object.keys(a).map((key) => names[key] || key).join('、')}` };
    }
    case 'update_slide': {
      const d = j<Deck | null>(r.deck, null);
      if (!d) throw bad('还没有课件');
      const i = page(a.page, d.slides.length);
      d.slides[i] = { ...cleanSlide(a.slide), id: d.slides[i].id };
      savePart(id, 'deck', d, by);
      return { part: 'deck', what: `改了课件第 ${i + 1} 页` };
    }
    case 'insert_slides': {
      const d = j<Deck | null>(r.deck, null) ?? { theme: 'violet', slides: [] };
      const after = Math.max(0, Math.min(d.slides.length, Math.round(toNum(a.after)) || 0));
      const add = (Array.isArray(a.slides) ? a.slides : [a.slides]).filter(Boolean).map(cleanSlide);
      if (!add.length) throw bad('要加的页是空的');
      d.slides.splice(after, 0, ...add);
      savePart(id, 'deck', d, by);
      return { part: 'deck', what: `在课件第 ${after} 页后面加了 ${add.length} 页` };
    }
    case 'delete_slides': {
      const d = j<Deck | null>(r.deck, null);
      if (!d) throw bad('还没有课件');
      const drop = new Set((Array.isArray(a.pages) ? a.pages : [a.pages]).map((x: unknown) => page(x, d.slides.length)));
      if (drop.size >= d.slides.length) throw bad('不能把课件删光');
      d.slides = d.slides.filter((_, i) => !drop.has(i));
      savePart(id, 'deck', d, by);
      return { part: 'deck', what: `删了课件 ${drop.size} 页` };
    }
    case 'update_question':
    case 'add_questions':
    case 'delete_questions': {
      const kind = a.kind === 'homework' ? 'homework' : 'practice';
      const qs = j<Question[]>(r[kind], []);
      const num = (v: unknown) => {
        const x = Math.round(toNum(v));
        if (!Number.isInteger(x) || x < 1 || x > qs.length) throw bad(`${kindName(kind)}没有第 ${String(v)} 题，一共 ${qs.length} 道`);
        return x - 1;
      };
      if (call.name === 'update_question') {
        const i = num(a.number);
        qs[i] = { ...cleanQuestion(a.question, kind === 'homework'), id: qs[i].id };
        savePart(id, kind, qs, by);
        return { part: kind, what: `改了${kindName(kind)}第 ${i + 1} 题` };
      }
      if (call.name === 'add_questions') {
        const add = cleanQuestions(Array.isArray(a.questions) ? a.questions : [a.questions], kind === 'homework');
        if (!add.length) throw bad('要加的题是空的');
        savePart(id, kind, [...qs, ...add], by);
        return { part: kind, what: `${kindName(kind)}加了 ${add.length} 道` };
      }
      const drop = new Set((Array.isArray(a.numbers) ? a.numbers : [a.numbers]).map(num));
      savePart(
        id,
        kind,
        qs.filter((_, i) => !drop.has(i)),
        by,
      );
      return { part: kind, what: `${kindName(kind)}删了 ${drop.size} 道` };
    }
    default:
      throw bad(`没有「${call.name}」这个工具`);
  }
}

const askPrompt = (teacherName: string) =>
  `你是${teacherTitle(teacherName)}的 CoT 助教。老师在看这节课，跟你说要怎么改：照老师说的用工具改，改完一两句话说改了什么。老师的话对不上、能有不止一种理解，就直接问，不要猜着改。`;

const asking = new Set<number>();

/** 老师说一句要怎么改：后台改，返回这一句的编号；同一节课一次改一句 */
export function startAsk(teacherId: number, lessonId: number, message: string, focus: { part?: string; page?: number; number?: number } | null) {
  const r = lessonRow(lessonId);
  if (!r || r.teacher_id !== teacherId) throw bad('这节课不在了');
  if (making.has(lessonId)) throw conflict('这节课还在备，备好了再改');
  if (asking.has(lessonId)) throw conflict('上一句还在改');
  const msg = message.trim().slice(0, 4000);
  if (!msg) throw bad('要怎么改没说');
  const askId = db.insert('lesson_asks', {
    lesson_id: lessonId,
    teacher_id: teacherId,
    message: msg,
    focus: focus ? JSON.stringify(focus) : null,
    status: 'running',
    created_at: now(),
  });
  asking.add(lessonId);
  void runAsk(askId).finally(() => asking.delete(lessonId));
  return askId;
}
export const isAsking = (lessonId: number) => asking.has(lessonId);

const PART_NAME: Record<string, string> = { plan: '教案', deck: '课件', practice: '课堂练习', homework: '课后作业', brief: '学情' };

async function runAsk(askId: number) {
  const ask = db.get<{ lesson_id: number; teacher_id: number; message: string; focus: string | null }>('SELECT * FROM lesson_asks WHERE id=?', askId)!;
  const id = ask.lesson_id;
  const key = `lesson:${id}`;
  const changed = new Set<Part>();
  const said: string[] = [];
  const signal = new AbortController().signal;
  try {
    const teacher = userName(ask.teacher_id);
    await compact({
      ownerId: ask.teacher_id,
      key,
      signal,
      who: { user: '老师', agent: '助教' },
      instruction: '把老师和助教改这节课说过的话压成一段要点：老师定下的要求、改过哪些地方。',
      agentKey: 'prep',
      purpose: 'prep:compact',
    }).catch((err) => console.error('[prep] compact', err));
    const f = j<{ part?: string; page?: number; number?: number } | null>(ask.focus, null);
    const where = f?.part ? `（老师正看着：${PART_NAME[f.part] || f.part}${f.page ? `第 ${f.page} 页` : ''}${f.number ? `第 ${f.number} 题` : ''}）\n` : '';
    append(ask.teacher_id, key, null, { role: 'user', content: `${where}${ask.message}` });
    let reply = '';
    for (let n = 0; n < 10; n++) {
      const r = lessonRow(id);
      if (!r) throw bad('这节课不在了');
      const t = threadRow(ask.teacher_id, key);
      const history = stored(ask.teacher_id, key, t.summary_upto).map(toMsg);
      const system = `${askPrompt(teacher)}\n（现在是 ${nowLine()}）${t.summary ? `\n\n以前说过的：${t.summary}` : ''}\n\n这节课现在的样子：\n${lessonText(r)}`;
      const step = await modelStep({
        agent: 'prep',
        purpose: 'prep:ask',
        messages: [{ role: 'system', content: system }, ...history],
        tools: [SEARCH_KB, READ_KB, ...EDIT_TOOLS],
        userId: ask.teacher_id,
        signal,
        onText: () => {},
      });
      append(ask.teacher_id, key, null, {
        role: 'assistant',
        content: step.text,
        ...(step.toolCalls.length ? { toolCalls: step.toolCalls } : {}),
        ...(step.reasoning ? { reasoning: step.reasoning } : {}),
      });
      reply = step.text.trim() || reply;
      if (!step.toolCalls.length) break;
      for (const call of step.toolCalls) {
        let out: string;
        try {
          const kb = kbTool(ask.teacher_id, call);
          if (kb !== null) out = kb;
          else {
            const e = applyEdit(id, call, 'ta');
            out = e.what;
            said.push(e.what);
            changed.add(e.part);
          }
        } catch (err) {
          out = `没办成：${(err as Error).message || '没办成'}`;
        }
        append(ask.teacher_id, key, null, { role: 'tool', toolCallId: call.id, content: out });
      }
    }
    if (changed.has('deck')) await redesignChanged(id, teacher, signal);
    db.update('lesson_asks', askId, {
      status: 'done',
      reply: reply || (said.length ? said.join('；') : '没改'),
      changed: JSON.stringify([...changed]),
      finished_at: now(),
    });
  } catch (err) {
    db.update('lesson_asks', askId, { status: 'error', error: (err as Error).message || '没改成', changed: JSON.stringify([...changed]), finished_at: now() });
  }
}

export function asksOf(lessonId: number) {
  return db
    .all<{ id: number; message: string; status: string; reply: string | null; changed: string | null; error: string | null; created_at: number }>(
      'SELECT id, message, status, reply, changed, error, created_at FROM lesson_asks WHERE lesson_id=? ORDER BY id DESC LIMIT 30',
      lessonId,
    )
    .reverse()
    .map((x) => ({
      id: x.id,
      message: x.message,
      status: x.status === 'running' && !asking.has(lessonId) ? 'error' : x.status,
      reply: x.reply,
      changed: j<string[]>(x.changed, []),
      error: x.status === 'running' && !asking.has(lessonId) ? '服务中断，没改完' : x.error,
      at: x.created_at,
    }));
}

/** 服务重启：还在备的、还在改的算没做完（做到一半、还没做的那几手标成没做成，页面上能重来） */
export function recoverLessons() {
  for (const r of db.all<{ id: number; lanes: string | null }>("SELECT id, lanes FROM lessons WHERE status='making'")) {
    const lanes = j<Record<string, { status: string; note?: string }>>(r.lanes, {});
    for (const k of Object.keys(lanes)) if (lanes[k].status === 'doing' || lanes[k].status === 'wait') lanes[k] = { status: 'error', note: '服务中断，没做完' };
    db.update('lessons', r.id, { lanes: JSON.stringify(lanes) });
  }
  db.run("UPDATE lessons SET status=CASE WHEN plan IS NULL THEN 'error' ELSE 'ready' END, error='服务中断，没做完' WHERE status='making'");
  db.run("UPDATE lesson_asks SET status='error', error='服务中断，没改完', finished_at=? WHERE status='running'", now());
}

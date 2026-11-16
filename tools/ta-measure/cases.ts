/**
 * 尺子：40 句老师平时会说的话（2026-11-16 定）。
 * 分六类：说清楚了的一件事、该问的、一句话办几件、只问不办、撤回、系统办不了的。
 * 每句写好：允许的变化（不在里面的都算办错）和结果对不对（返回 null 是对）。
 * 不为哪一句改提示词：这些句子只拿来量。
 */
import { addSpecialist, dayAt, nextWeek, rowOf, shortNamedClasses, type Snapshot, type World } from './world.js';

export type Turn = { say: string } | { answer: string[] };
export interface CheckInput {
  before: Snapshot;
  after: Snapshot;
  world: World;
  replies: string[];
  tools: string[];
  actions: string[];
}
export interface Case {
  id: string;
  cat: '清楚' | '该问' | '一句几件' | '只问不办' | '撤回' | '办不了' | '接上文' | '专门助手';
  turns: Turn[];
  /** true 该问；false 不该问；不写是问不问都行 */
  ask?: boolean;
  /** 这一句要换个样子的世界（在比对的「之前」之前） */
  setup?: (w: World) => void;
  allow: RegExp[];
  check: (o: CheckInput) => string | null;
}

const hw = (s: Snapshot, title: string, cls?: string) => rowOf(s, 'homework', (r) => r.title === title && !r.deleted && (!cls || r.class === cls));
const newHw = (o: CheckInput) => [...o.after.homework].filter(([id]) => !o.before.homework.has(id)).map(([, r]) => r);
const cls = (s: Snapshot, name: string) => rowOf(s, 'classes', (r) => r.name === name)[0];
const sub = (s: Snapshot, title: string, student: string, cls?: string) =>
  rowOf(s, 'subs', (r) => r.homework === title && r.student === student)[0] as Record<string, any> | undefined;
const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
const at = (md: string, hm = '23:59') => Date.parse(`${year}-${md}T${hm}:00+08:00`);
const has = (s: unknown, ...words: string[]) => words.every((w) => String(s ?? '').replace(/\s/g, '').includes(w.replace(/\s/g, '')));
const fail = (cond: boolean, why: string) => (cond ? null : why);
const reply = (o: CheckInput) => o.replies.join('\n');
const show = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : String(ms));

const NEW_CLASS = /^新增 班\d+/;
const NEW_HW = /^新增 作业\d+/;
/** 这次新建、最后还在的班和作业 */
const newLive = (o: CheckInput) =>
  [...o.after.classes].filter(([id, r]) => !o.before.classes.has(id) && !r.deleted).map(([, r]) => String(r.name)).sort();
const newLiveHw = (o: CheckInput) => newHw(o).filter((h) => !h.deleted);

/* 专门助手（2026-11-17）：该分的分出来，不该分的不分，已经有管这类活的就交给它 */
const NEW_SPEC = /^新增 助手\d+/;
const newSpecs = (o: CheckInput) => [...o.after.specialists].filter(([id]) => !o.before.specialists.has(id)).map(([, r]) => r);
const PROJECT = (w: World) => addSpecialist(w, '项目答疑', '回答学生关于期末项目的问题', '照知识库里的期末项目说明答，说明里没有的告诉学生要问老师');

export const CASES: Case[] = [
  /* ---------- 说清楚了的一件事：直接办，不问 ---------- */
  {
    id: 'c01',
    cat: '清楚',
    ask: false,
    turns: [{ say: '建个班，叫计科2507 Python' }],
    allow: [NEW_CLASS],
    check: (o) => fail(!!cls(o.after, '计科2507 Python') && !cls(o.after, '计科2507 Python').deleted, '没建出「计科2507 Python」'),
  },
  {
    id: 'c02',
    cat: '清楚',
    ask: false,
    turns: [{ say: '把软工2402 数据库归档' }],
    allow: [/^班\d+\.archived/],
    check: (o) => fail(cls(o.after, '软工2402 数据库').archived === true, '没归档'),
  },
  {
    id: 'c03',
    cat: '清楚',
    ask: false,
    turns: [{ say: '计科2505 Python 先别让学生加入了' }],
    allow: [/^班\d+\.join_open/],
    check: (o) => fail(cls(o.after, '计科2505 Python').join_open === 0, '还能加入'),
  },
  {
    id: 'c04',
    cat: '清楚',
    ask: false,
    turns: [{ say: '给计科2506 Python 换个加课码' }],
    allow: [/^班\d+\.join_code/],
    check: (o) => fail(cls(o.after, '计科2506 Python').join_code !== cls(o.before, '计科2506 Python').join_code, '加课码没换'),
  },
  {
    id: 'c05',
    cat: '清楚',
    ask: false,
    turns: [{ say: '给计科2505 Python 发个作业：第三章课后题 1 到 5，下周五交' }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newHw(o);
      if (made.length !== 1 || made[0].class !== '计科2505 Python') return `发的班不对：${made.map((h) => h.class).join('、') || '没发'}`;
      if (made[0].due_at !== nextWeek(5)) return `截止不对：${show(made[0].due_at)}`;
      const body = String(made[0].body ?? '');
      const got = ['1 到 100', '阶乘', '偶数', '猜数字', '九九乘法表'].filter((w) => has(body, w)).length;
      if (got < 4) return `要求里只有 ${got}/5 道题：${body.slice(0, 120)}`;
      if (has(body, '质数')) return '把第 6 题也发了';
      return null;
    },
  },
  {
    id: 'c06',
    cat: '清楚',
    ask: false,
    turns: [{ say: '第一次作业的截止往后推两天' }],
    allow: [/^作业\d+\.due_at/],
    check: (o) => fail(hw(o.after, '第一次作业')[0]?.due_at === dayAt(4), `截止是 ${show(hw(o.after, '第一次作业')[0]?.due_at)}`),
  },
  {
    id: 'c07',
    cat: '清楚',
    ask: false,
    turns: [{ say: '孙思雨的第一次作业改成 92 分' }],
    allow: [/^交\d+\.score/],
    check: (o) => {
      const s = sub(o.after, '第一次作业', '孙思雨');
      return s?.score === 92 && s.comment === '不错' ? null : `分数 ${s?.score}，评语 ${s?.comment}`;
    },
  },
  {
    id: 'c08',
    cat: '清楚',
    ask: false,
    turns: [{ say: '张浩然第一次作业 85 分，评语写：思路对，注意变量命名' }],
    allow: [/^交\d+\.(score|comment)/],
    check: (o) => {
      const s = sub(o.after, '第一次作业', '张浩然');
      return s?.score === 85 && has(s.comment, '思路对', '变量命名') ? null : `分数 ${s?.score}，评语 ${s?.comment}`;
    },
  },
  {
    id: 'c09',
    cat: '清楚',
    ask: false,
    turns: [{ say: '把刘欣怡的第一次作业退回去，让她补第 2 题' }],
    allow: [/^交\d+\.(returned|comment|score)/],
    check: (o) => {
      const s = sub(o.after, '第一次作业', '刘欣怡');
      return s?.returned && /第\s*2\s*题|第二题/.test(String(s.comment)) ? null : `退回 ${s?.returned}，评语 ${s?.comment}`;
    },
  },
  {
    id: 'c10',
    cat: '只问不办',
    ask: false,
    turns: [{ say: '第一次作业谁还没交？' }],
    allow: [],
    check: (o) => fail(has(reply(o), '陈子轩') && !has(reply(o), '张浩然没交'), `回话：${reply(o).slice(0, 120)}`),
  },
  {
    id: 'c11',
    cat: '清楚',
    ask: false,
    turns: [{ say: '把计科2505 Python 的成绩导出来' }],
    allow: [],
    check: (o) => fail(o.actions.includes('grades.export'), '没给下载按钮'),
  },
  {
    id: 'c12',
    cat: '清楚',
    ask: false,
    turns: [{ say: '删掉 ER 图作业' }],
    allow: [/^作业\d+\.deleted/],
    check: (o) => fail(hw(o.after, 'ER 图作业').length === 0, '没删'),
  },
  {
    id: 'c13',
    cat: '清楚',
    ask: false,
    turns: [{ say: '给软工2402 数据库发个作业，标题「第三次实验」，要求：完成实验三的 SQL 查询，满分 50，11 月 30 日晚上 10 点截止，过了截止不收' }],
    allow: [NEW_HW],
    check: (o) => {
      const h = hw(o.after, '第三次实验', '软工2402 数据库')[0];
      if (!h) return `没发出「第三次实验」：${newHw(o).map((x) => x.title).join('、')}`;
      return h.points === 50 && h.due_at === at('11-30', '22:00') && h.allow_late === 0 ? null : `满分 ${h.points}，截止 ${show(h.due_at)}，迟交 ${h.allow_late}`;
    },
  },
  {
    id: 'c14',
    cat: '清楚',
    ask: false,
    turns: [{ say: '明天早上 8 点给计科2506 Python 发一份作业「预习第四章」，不设截止' }],
    allow: [NEW_HW],
    check: (o) => {
      const h = hw(o.after, '预习第四章', '计科2506 Python')[0];
      if (!h) return `没发出「预习第四章」：${newHw(o).map((x) => x.title).join('、')}`;
      return h.publish_at === dayAt(1, 8, 0) && h.due_at === null ? null : `发布 ${show(h.publish_at)}，截止 ${show(h.due_at)}`;
    },
  },
  {
    id: 'c15',
    cat: '清楚',
    ask: false,
    turns: [{ say: '第二章练习两个班都延期到 12 月 1 号' }],
    allow: [/^作业\d+\.due_at/],
    check: (o) => {
      const both = hw(o.after, '第二章练习');
      return both.length === 2 && both.every((h) => h.due_at === at('12-01')) ? null : both.map((h) => `${h.class} ${show(h.due_at)}`).join('；');
    },
  },
  {
    id: 'c16',
    cat: '清楚',
    ask: false,
    turns: [{ say: '把计科2401 C语言恢复' }],
    allow: [/^班\d+\.archived/],
    check: (o) => fail(cls(o.after, '计科2401 C语言').archived === false, '还是归档的'),
  },

  /* ---------- 该问的：对不上、两种理解、缺关键信息 ---------- */
  {
    id: 'a01',
    cat: '该问',
    ask: true,
    turns: [{ say: '给计科发个作业，第三章课后题 1 到 5，下周五交' }, { answer: ['计科2505 Python'] }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newHw(o);
      return made.length === 1 && made[0].class === '计科2505 Python' && made[0].due_at === nextWeek(5) ? null : made.map((h) => `${h.class} ${show(h.due_at)}`).join('；') || '没发';
    },
  },
  {
    id: 'a02',
    cat: '该问',
    ask: true,
    turns: [{ say: '把作业的截止往后推一天' }, { answer: ['第一次作业'] }],
    allow: [/^作业\d+\.due_at/],
    check: (o) => fail(hw(o.after, '第一次作业')[0]?.due_at === dayAt(3), `第一次作业截止 ${show(hw(o.after, '第一次作业')[0]?.due_at)}`),
  },
  {
    id: 'a03',
    cat: '该问',
    ask: true,
    turns: [{ say: '给孙思雨打 90 分' }, { answer: ['计科2505 Python 的第二章练习'] }],
    allow: [/^交\d+\.score/],
    check: (o) => {
      const a = sub(o.after, '第二章练习', '孙思雨'),
        b = sub(o.after, '第一次作业', '孙思雨');
      return a?.score === 90 && b?.score === 88 ? null : `第二章练习 ${a?.score}，第一次作业 ${b?.score}`;
    },
  },
  {
    id: 'a04',
    cat: '该问',
    ask: true,
    turns: [{ say: '把那个班删了' }, { answer: ['计科2401 C语言'] }],
    allow: [/^班\d+\.deleted/],
    check: (o) => fail(cls(o.after, '计科2401 C语言').deleted === true, '没删计科2401 C语言'),
  },
  {
    id: 'a05',
    cat: '该问',
    ask: true,
    turns: [{ say: '给计科2505 Python 发个作业' }, { answer: ['第二章复习：把第二章讲义后面的练习做完，下周一交'] }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newHw(o);
      return made.length === 1 && made[0].class === '计科2505 Python' && made[0].due_at === nextWeek(1) ? null : made.map((h) => `${h.class}「${h.title}」${show(h.due_at)}`).join('；') || '没发';
    },
  },
  {
    id: 'a06',
    cat: '该问',
    turns: [{ say: '把李同学的作业退回' }, { answer: ['算了，不用了'] }],
    allow: [],
    check: () => null,
  },
  {
    id: 'a07',
    cat: '该问',
    ask: true,
    turns: [{ say: '给 Python 班发第三章作业，题目是课后题 1 到 3，下周三交' }, { answer: ['两个班都发'] }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newHw(o);
      const classes = made.map((h) => h.class).sort();
      return classes.join() === '计科2505 Python,计科2506 Python' && made.every((h) => h.due_at === nextWeek(3)) ? null : made.map((h) => `${h.class} ${show(h.due_at)}`).join('；') || '没发';
    },
  },
  {
    id: 'a08',
    cat: '该问',
    ask: true,
    turns: [{ say: '把这次作业的满分改成 50' }, { answer: ['第一次作业'] }],
    allow: [/^作业\d+\.points/],
    check: (o) => fail(hw(o.after, '第一次作业')[0]?.points === 50, `第一次作业满分 ${hw(o.after, '第一次作业')[0]?.points}`),
  },
  {
    id: 'a09',
    cat: '该问',
    ask: true,
    turns: [{ say: '建个新班' }, { answer: ['计科2509 Python'] }],
    allow: [NEW_CLASS],
    check: (o) => fail(!!cls(o.after, '计科2509 Python'), '没建出「计科2509 Python」'),
  },
  {
    id: 'a10',
    cat: '该问',
    ask: true,
    turns: [{ say: '给张浩然的作业写个评语：很好' }, { answer: ['第一次作业'] }],
    allow: [/^交\d+\.comment/],
    check: (o) => {
      const s = sub(o.after, '第一次作业', '张浩然');
      return has(s?.comment, '很好') && s?.score === null ? null : `第一次作业评语 ${s?.comment}，分数 ${s?.score}`;
    },
  },

  /* ---------- 一句话办几件 ---------- */
  {
    id: 'm01',
    cat: '一句几件',
    ask: false,
    turns: [{ say: '建个班叫计科2508 Python，然后给它发第一次作业：写一段自我介绍，下周一交' }],
    allow: [NEW_CLASS, NEW_HW],
    check: (o) => {
      if (!cls(o.after, '计科2508 Python')) return '没建班';
      const h = newHw(o).find((x) => x.class === '计科2508 Python');
      return h && h.due_at === nextWeek(1) && has(`${h.title}${h.body}`, '自我介绍') ? null : `作业：${h ? `「${h.title}」${show(h.due_at)}` : '没发'}`;
    },
  },
  {
    id: 'm02',
    cat: '一句几件',
    ask: false,
    turns: [{ say: '把计科2506 Python 停止加入，然后归档' }],
    allow: [/^班\d+\.(join_open|archived)/],
    check: (o) => {
      const k = cls(o.after, '计科2506 Python');
      return k.join_open === 0 && k.archived === true ? null : `加入 ${k.join_open}，归档 ${k.archived}`;
    },
  },
  {
    id: 'm03',
    cat: '一句几件',
    ask: false,
    turns: [{ say: '第一次作业：张浩然 80，刘欣怡 75' }],
    allow: [/^交\d+\.score/],
    check: (o) => {
      const a = sub(o.after, '第一次作业', '张浩然')?.score,
        b = sub(o.after, '第一次作业', '刘欣怡')?.score;
      return a === 80 && b === 75 ? null : `张浩然 ${a}，刘欣怡 ${b}`;
    },
  },
  {
    id: 'm04',
    cat: '一句几件',
    ask: false,
    turns: [{ say: '把第二章练习从计科2506 Python 删掉，计科2505 Python 的留着' }],
    allow: [/^作业\d+\.deleted/],
    check: (o) => fail(hw(o.after, '第二章练习', '计科2506 Python').length === 0 && hw(o.after, '第二章练习', '计科2505 Python').length === 1, '删错了'),
  },
  {
    id: 'm05',
    cat: '一句几件',
    ask: false,
    turns: [{ say: '给计科2505 Python 和软工2402 数据库都发「期中复习」，下周三交' }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newHw(o);
      const classes = made.map((h) => h.class).sort();
      return classes.join() === '计科2505 Python,软工2402 数据库' && made.every((h) => h.due_at === nextWeek(3) && has(h.title, '期中复习')) ? null : made.map((h) => `${h.class}「${h.title}」${show(h.due_at)}`).join('；') || '没发';
    },
  },
  {
    id: 'm06',
    cat: '一句几件',
    ask: false,
    turns: [{ say: '第一次作业所有交了还没批的都给 80 分' }],
    allow: [/^交\d+\.score/],
    check: (o) => {
      const a = sub(o.after, '第一次作业', '张浩然')?.score,
        b = sub(o.after, '第一次作业', '刘欣怡')?.score,
        c = sub(o.after, '第一次作业', '孙思雨')?.score;
      return a === 80 && b === 80 && c === 88 ? null : `张浩然 ${a}，刘欣怡 ${b}，孙思雨 ${c}`;
    },
  },

  /* ---------- 只问不办 ---------- */
  {
    id: 'r01',
    cat: '只问不办',
    ask: false,
    turns: [{ say: '计科2505 Python 有几个学生？' }],
    allow: [],
    check: (o) => fail(/4\s*(个|名|人)|四(个|名|人)/.test(reply(o)), `回话：${reply(o).slice(0, 100)}`),
  },
  {
    id: 'r02',
    cat: '只问不办',
    ask: false,
    turns: [{ say: '第一次作业平均分多少？' }],
    allow: [],
    check: (o) => fail(has(reply(o), '88'), `回话：${reply(o).slice(0, 100)}`),
  },
  {
    id: 'r03',
    cat: '只问不办',
    ask: false,
    turns: [{ say: '我有哪些班？' }],
    allow: [],
    check: (o) => fail(has(reply(o), '计科2505') && has(reply(o), '软工2402'), `回话：${reply(o).slice(0, 100)}`),
  },
  {
    id: 'r04',
    cat: '只问不办',
    ask: false,
    turns: [{ say: '知识库里有没有第三章的课后题？' }],
    allow: [],
    check: (o) => fail(o.tools.some((t) => t === 'search_kb' || t === 'read_kb') && /有|找到/.test(reply(o)), `用了：${o.tools.join('、')}；回话：${reply(o).slice(0, 80)}`),
  },

  /* ---------- 接上文：老师接着上一句说的短话，按上文补全了办，补不全的问（2026-11-16 加 12 句。
     例子：建了计科5班，又说「6班」，它建了个叫「6班」的班。问不问都行，办出来要对） ---------- */
  {
    id: 'k01',
    cat: '接上文',
    turns: [{ say: '帮我建个计科5班' }, { say: '6班' }, { answer: ['再建一个计科6班'] }],
    allow: [NEW_CLASS],
    check: (o) => fail(newLive(o).join() === '计科5班,计科6班', `新建的班：${newLive(o).join('、') || '没有'}`),
  },
  {
    id: 'k02',
    cat: '接上文',
    turns: [{ say: '给计科2505 Python 发个作业，第三章课后题，下周五交' }, { say: '2506 的也要' }, { answer: ['计科2506 Python 也发一份'] }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newLiveHw(o);
      const classes = made.map((h) => h.class).sort();
      return classes.join() === '计科2505 Python,计科2506 Python' && made.every((h) => has(h.title, '第三章') && h.due_at === nextWeek(5))
        ? null
        : made.map((h) => `${h.class}「${h.title}」${show(h.due_at)}`).join('；') || '没发';
    },
  },
  {
    id: 'k03',
    cat: '接上文',
    turns: [{ say: '第一次作业的截止改到下周三' }, { say: '第二章练习也是' }, { answer: ['两个班都改'] }],
    allow: [/^作业\d+\.due_at/],
    check: (o) => {
      const all = [...hw(o.after, '第一次作业'), ...hw(o.after, '第二章练习')];
      return all.length === 3 && all.every((h) => h.due_at === nextWeek(3)) ? null : all.map((h) => `${h.class}「${h.title}」${show(h.due_at)}`).join('；');
    },
  },
  {
    id: 'k04',
    cat: '接上文',
    turns: [{ say: '第一次作业，张浩然给 85 分' }, { say: '刘欣怡 90' }],
    allow: [/^交\d+\.score/],
    check: (o) => {
      const a = sub(o.after, '第一次作业', '张浩然')?.score,
        b = sub(o.after, '第一次作业', '刘欣怡')?.score;
      return a === 85 && b === 90 ? null : `张浩然 ${a}，刘欣怡 ${b}`;
    },
  },
  {
    id: 'k05',
    cat: '接上文',
    turns: [{ say: '建个班叫数据结构1班' }, { say: '再来一个' }, { answer: ['数据结构2班'] }],
    allow: [NEW_CLASS],
    check: (o) => fail(newLive(o).join() === '数据结构1班,数据结构2班', `新建的班：${newLive(o).join('、') || '没有'}`),
  },
  {
    id: 'k06',
    cat: '接上文',
    turns: [{ say: '把计科2505 Python 的加课码换一个' }, { say: '2506 的也换' }],
    allow: [/^班\d+\.join_code/],
    check: (o) => {
      const changed = ['计科2505 Python', '计科2506 Python'].filter((n) => cls(o.after, n).join_code !== cls(o.before, n).join_code);
      return changed.length === 2 ? null : `换了的：${changed.join('、') || '没有'}`;
    },
  },
  {
    id: 'k07',
    cat: '接上文',
    turns: [{ say: '第一次作业谁还没交' }, { say: '第二章练习呢' }],
    allow: [],
    check: (o) => {
      const last = o.replies[o.replies.length - 1] || '';
      return has(last, '刘欣怡') && has(last, '陈子轩') && has(last, '赵宇航') ? null : `第二句的回话：${last.slice(0, 80)}`;
    },
  },
  {
    id: 'k08',
    cat: '接上文',
    turns: [{ say: '给计科2505 Python 发个作业，第四章练习，周五交' }, { say: '不对，下周五' }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newLiveHw(o);
      return made.length === 1 && made[0].class === '计科2505 Python' && made[0].due_at === nextWeek(5)
        ? null
        : made.map((h) => `${h.class}「${h.title}」${show(h.due_at)}`).join('；') || '没发';
    },
  },
  {
    id: 'k09',
    cat: '接上文',
    turns: [{ say: '计科2505 Python 停止加入' }, { say: '算了，还是开着吧' }],
    allow: [/^班\d+\.join_open/],
    check: (o) => fail(!!cls(o.after, '计科2505 Python').join_open, '还是停止加入'),
  },
  {
    id: 'k10',
    cat: '接上文',
    turns: [{ say: '建个班，叫计科2508 Java' }, { say: '名字写错了，是2509' }],
    allow: [NEW_CLASS],
    check: (o) => fail(newLive(o).join() === '计科2509 Java', `新建的班：${newLive(o).join('、') || '没有'}`),
  },
  {
    id: 'k11',
    cat: '接上文',
    turns: [{ say: '第二章练习，孙思雨给 80' }, { say: '张浩然也是' }],
    allow: [/^交\d+\.score/],
    check: (o) => {
      const a = sub(o.after, '第二章练习', '孙思雨')?.score,
        b = sub(o.after, '第二章练习', '张浩然')?.score;
      return a === 80 && b === 80 ? null : `孙思雨 ${a}，张浩然 ${b}`;
    },
  },
  {
    // 照线上原样：老师的班叫一班、二班、测试班，先打招呼，再建计科5班，再说「6班」
    id: 'k13',
    cat: '接上文',
    setup: shortNamedClasses,
    turns: [{ say: 'hi' }, { say: '帮我建个计科5班' }, { say: '6班' }, { answer: ['再建一个计科6班'] }],
    allow: [NEW_CLASS],
    check: (o) => fail(newLive(o).join() === '计科5班,计科6班', `新建的班：${newLive(o).join('、') || '没有'}`),
  },
  {
    id: 'k12',
    cat: '接上文',
    turns: [{ say: '软工2402 数据库发个作业，实验三报告，下周一交' }, { say: '截止往后推两天' }],
    allow: [NEW_HW],
    check: (o) => {
      const made = newLiveHw(o);
      return made.length === 1 && made[0].class === '软工2402 数据库' && made[0].due_at === nextWeek(3)
        ? null
        : made.map((h) => `${h.class}「${h.title}」${show(h.due_at)}`).join('；') || '没发';
    },
  },

  /* ---------- 撤回 ---------- */
  {
    id: 'u01',
    cat: '撤回',
    ask: false,
    turns: [{ say: '建个班叫测试班' }, { say: '刚才那个班建错了，撤回' }],
    allow: [NEW_CLASS],
    check: (o) => fail(cls(o.after, '测试班')?.deleted === true, '测试班还在'),
  },
  {
    id: 'u02',
    cat: '撤回',
    ask: false,
    turns: [{ say: '孙思雨第一次作业改成 95 分' }, { say: '改回去' }],
    allow: [],
    check: (o) => fail(sub(o.after, '第一次作业', '孙思雨')?.score === 88, `孙思雨 ${sub(o.after, '第一次作业', '孙思雨')?.score}`),
  },

  /* ---------- 专门助手：该分的分、不该分的不分、有了就交给它、能改能停 ---------- */
  {
    id: 'p01',
    cat: '专门助手',
    turns: [{ say: '以后计科2505 Python 的第一次作业交给一个专门的助手批，照评分标准批，变量名起得乱的扣半分' }],
    allow: [NEW_SPEC, /^作业\d+\.specialist/],
    check: (o) => {
      const s = newSpecs(o);
      if (s.length !== 1) return `分了 ${s.length} 个专门助手`;
      if (!has(s[0].guide, '半分') && !has(s[0].guide, '0.5')) return `做法里没写扣半分：${s[0].guide}`;
      const h = hw(o.after, '第一次作业', '计科2505 Python')[0];
      return fail(h?.specialist === s[0].id, '第一次作业没交给它批');
    },
  },
  {
    id: 'p02',
    cat: '专门助手',
    turns: [{ say: '学生老来问期末项目怎么选题、要交什么，你专门安排一个助手答这类问题，照知识库里的项目说明答' }],
    allow: [NEW_SPEC],
    check: (o) => fail(newSpecs(o).length === 1, `分了 ${newSpecs(o).length} 个专门助手`),
  },
  {
    id: 'p03',
    cat: '专门助手',
    ask: false,
    turns: [{ say: '每周一要给各班发一条本周学习提醒，这个活以后专门交给一个助手来写，写好先给我看' }],
    allow: [NEW_SPEC],
    check: (o) => fail(newSpecs(o).length === 1, `分了 ${newSpecs(o).length} 个专门助手`),
  },
  {
    id: 'p04',
    cat: '专门助手',
    ask: false,
    turns: [{ say: '帮我看看知识库里有哪些讲循环的资料' }],
    allow: [],
    check: (o) => fail(!o.tools.includes('new_specialist'), '查一次资料也分了专门助手'),
  },
  {
    id: 'p05',
    cat: '专门助手',
    setup: PROJECT,
    turns: [{ say: '有学生问期末项目能不能用 Java 写，该怎么回？' }],
    allow: [],
    check: (o) => fail(o.tools.includes('ask_specialist'), '有管期末项目的专门助手，没交给它'),
  },
  {
    id: 'p06',
    cat: '专门助手',
    ask: false,
    setup: PROJECT,
    turns: [{ say: '以后期末项目方面的问题都交给专门的助手来答' }],
    allow: [/^助手\d+\.(duty|guide)/],
    check: (o) => fail(!newSpecs(o).length, '已经有「项目答疑」，又分了一个'),
  },
  {
    id: 'p07',
    cat: '专门助手',
    ask: false,
    setup: PROJECT,
    turns: [{ say: '项目答疑那个助手不用了，停掉吧' }],
    allow: [/^助手\d+\.retired/],
    check: (o) => fail(rowOf(o.after, 'specialists', (r) => r.name === '项目答疑')[0]?.retired === true, '没停用'),
  },
  {
    id: 'p08',
    cat: '专门助手',
    ask: false,
    setup: PROJECT,
    turns: [{ say: '跟管期末项目的那个助手说一声，以后回答时先提醒学生看说明的第二节' }],
    allow: [/^助手\d+\.guide/],
    check: (o) =>
      fail(
        has(rowOf(o.after, 'specialists', (r) => r.name === '项目答疑')[0]?.guide, '第二节') || o.tools.includes('ask_specialist'),
        '没改它的做法，也没跟它说',
      ),
  },

  /* ---------- 系统办不了的：不能乱办 ---------- */
  {
    id: 'x01',
    cat: '办不了',
    turns: [{ say: '给全班发个通知，明天停课' }, { answer: ['算了'] }],
    allow: [],
    check: () => null,
  },
  {
    id: 'x02',
    cat: '办不了',
    turns: [{ say: '帮我把孙思雨的密码重置一下' }, { answer: ['算了'] }],
    allow: [],
    check: () => null,
  },
];

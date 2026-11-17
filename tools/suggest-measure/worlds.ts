/**
 * 量「助教看一眼要不要分专门助手」的几个世界（2026-11-17）。
 * 该提的：同一份作业老师改了几份、原因一致；老师反复交代同一类事；学生老来问同一类事。
 * 不该提的：改分零散、各改各的；交代的都是杂事；已经有专门助手管同一类事；老师说过不用的同一件事。
 * 每个世界在一份干净的数据库里摆好（一位老师、三个班、学生、作业和批改、对话记录），跑完看它提没提、提的对不对。
 * 这些世界只拿来量，不为哪一个改给模型的话。
 */
import { createHash, randomUUID } from 'node:crypto';
import { db, now } from '../../server/src/db/index.js';
import type { SuggestionRow } from '../../server/src/assistant/suggest.js';

export const TEACHER = '王建国';
const DAY = 86_400_000;

export interface Ctx {
  teacher: number;
  cookie: string;
  classes: Record<string, number>;
  /** 班名 → 学生（班里名单那一行的编号、账号） */
  students: Record<string, { sid: number; uid: number; name: string }[]>;
  /** 老师改分走页面用的那个接口 */
  request: (path: string, body?: unknown) => Promise<{ status: number; json: any }>;
}

export interface World {
  id: string;
  /** 该不该提 */
  should: boolean;
  setup: (c: Ctx) => Promise<void> | void;
  /** 提了的话，名字、管的事、做法、绑的作业对不对（返回 null 是对） */
  check?: (p: SuggestionRow, c: Ctx) => string | null;
}

const has = (s: unknown, ...words: string[]) => words.some((w) => String(s ?? '').includes(w));
const hwId = (c: Ctx, cls: string, title: string) => db.value<number>('SELECT id FROM assignments WHERE class_id=? AND title=?', c.classes[cls], title) ?? null;

/* ---------------- 摆世界用的 ---------------- */

const NAMES = ['孙思雨', '张浩然', '刘欣怡', '陈子轩', '杨梓涵', '赵宇航', '黄诗琪', '周俊杰', '吴佳怡', '徐子墨', '马晓东', '朱雨桐'];

export async function base(app: { request: (url: string, init: RequestInit) => Response | Promise<Response> }): Promise<Ctx> {
  const t = now();
  const teacher = db.insert('users', { username: `suggest-ruler-${randomUUID().slice(0, 8)}`, name: TEACHER, role: 'teacher', password_hash: 'x', created_at: t });
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: teacher, created_at: t, expires_at: t + 3600_000 });
  const cookie = `ct_sid=${token}`;
  const classes: Ctx['classes'] = {};
  const students: Ctx['students'] = {};
  const sizes: [string, number][] = [
    ['计科2505 Python', 12],
    ['计科2506 Python', 8],
    ['软工2402 数据库', 8],
  ];
  let no = 1;
  for (const [name, n] of sizes) {
    const k = db.insert('classes', { teacher_id: teacher, name, join_code: randomUUID().slice(0, 6).toUpperCase(), join_open: 1, created_at: t - 40 * DAY, updated_at: t });
    classes[name] = k;
    students[name] = [];
    for (let i = 0; i < n; i++) {
      const sname = NAMES[i % NAMES.length];
      const sno = `2026${String(no).padStart(3, '0')}`;
      const uid = db.insert('users', { username: `suggest-ruler-${randomUUID().slice(0, 8)}`, name: sname, role: 'student', student_no: sno, password_hash: 'x', created_at: t });
      const sid = db.insert('class_students', { class_id: k, student_no: sno, name: sname, user_id: uid, in_roster: 0, joined_at: t - 30 * DAY, created_at: t - 30 * DAY });
      students[name].push({ sid, uid, name: sname });
      no++;
    }
  }
  const request = async (path: string, body?: unknown) => {
    const res = await app.request('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'x-tv2': '1', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, json: type.includes('json') ? await res.json() : null };
  };
  return { teacher, cookie, classes, students, request };
}

interface Item {
  title: string;
  points: number;
  criteria: string;
  answer: string;
}
/** 一份作业：每个学生交了、助教批了（got 是每项给的分，why 是助教写的原因） */
async function gradedHomework(c: Ctx, cls: string, title: string, body: string, items: Item[], marks: { text: string; got: number[]; why: string[] }[], daysAgo: number) {
  const { setRubric } = await import('../../server/src/grading/rubric.js');
  const t = now() - daysAgo * DAY;
  const points = items.reduce((n, x) => n + x.points, 0);
  const hw = db.insert('assignments', {
    class_id: c.classes[cls],
    teacher_id: c.teacher,
    title,
    body,
    points,
    due_at: t + 5 * DAY,
    allow_late: 1,
    publish_at: t,
    ai_mode: 'release',
    created_at: t,
    updated_at: t,
  });
  setRubric(hw, items);
  c.students[cls].forEach((s, i) => {
    const m = marks[i % marks.length];
    const graded = items.map((x, k) => ({ title: x.title, max: x.points, got: m.got[k], why: m.why[k] }));
    const score = graded.reduce((n, x) => n + x.got, 0);
    const at = t + 2 * DAY + i * 60_000;
    const sub = db.insert('submissions', { assignment_id: hw, user_id: s.uid, text: m.text, submitted_at: at, late: 0, updated_at: at });
    const ai = db.insert('ai_grades', {
      submission_id: sub,
      assignment_id: hw,
      user_id: s.uid,
      submitted_at: at,
      status: 'done',
      score,
      items: JSON.stringify(graded),
      marks: '[]',
      comment: '整体不错，注意细节',
      text: m.text,
      auto_release: 1,
      released_at: at + 60_000,
      created_at: at,
      started_at: at,
      finished_at: at + 30_000,
    });
    db.update('submissions', sub, { score, comment: '整体不错，注意细节', graded_at: at + 60_000, graded_by: 'ai', items: JSON.stringify(graded), ai_grade_id: ai });
  });
  return hw;
}

/** 老师在页面上改一个学生某一项的分（原因不写就是不改原因） */
async function teacherFix(c: Ctx, hw: number, cls: string, who: number, item: number, got: number, why?: string) {
  const s = c.students[cls][who];
  const w = (await c.request(`/homework/${hw}/students/${s.sid}`)).json;
  const items = w.submission.items.map((x: any, i: number) => (i === item ? { ...x, got, ...(why ? { why } : {}) } : x));
  const r = await c.request(`/homework/${hw}/students/${s.sid}/grade`, { score: null, comment: w.submission.comment, items, aiGradeId: w.ai.id });
  if (r.status !== 200) throw new Error(`改分没成：${JSON.stringify(r.json)}`);
}

/** 老师跟助教说过的一句（daysAgo 天前），助教回的一句 */
function said(c: Ctx, request: string, daysAgo: number, reply = '好的，办好了') {
  const at = now() - daysAgo * DAY;
  db.insert('kb_runs', { teacher_id: c.teacher, agent: 'ta', kind: 'chat', status: 'done', request, reply, created_by: c.teacher, created_at: at, finished_at: at + 20_000 });
}

/** 学生来问、助教转给老师、老师在卡片上答了 */
function asked(c: Ctx, cls: string, who: number, words: string, question: string, answer: string, daysAgo: number) {
  const s = c.students[cls][who];
  const at = now() - daysAgo * DAY;
  const stuRun = db.insert('kb_runs', { teacher_id: s.uid, agent: 'stu', kind: 'chat', status: 'done', request: words, created_by: s.uid, created_at: at });
  const card = db.insert('kb_runs', { teacher_id: c.teacher, agent: 'ta', kind: 'student_ask', status: 'done', request: '', created_by: s.uid, created_at: at, finished_at: at + 3600_000 });
  db.insert('kb_events', {
    run_id: card,
    type: 'ask',
    data: JSON.stringify({ toolCallId: '', questions: [{ question, options: ['可以', '不行'], multiple: false }], answered: [{ q: question, a: answer }] }),
    created_at: at,
  });
  db.insert('student_asks', {
    student_id: s.uid,
    class_id: c.classes[cls],
    teacher_id: c.teacher,
    stu_run_id: stuRun,
    question,
    status: 'replied',
    card_run_id: card,
    reply: answer,
    created_at: at,
    answered_at: at,
    replied_at: at + 3600_000,
  });
}

function existingSpecialist(c: Ctx, name: string, duty: string, guide: string) {
  const t = now() - 2 * DAY;
  return db.insert('specialists', { teacher_id: c.teacher, name, duty, guide, uses: 2, created_at: t, updated_at: t });
}

/* ---------------- 各个世界的材料 ---------------- */

const LOOP_ITEMS: Item[] = [
  { title: '第1题', points: 4, criteria: '用 for 循环求 1 到 100 的和，结果对给 4 分', answer: 'sum(range(1, 101)) 或 for 循环累加，结果 5050' },
  { title: '第2题', points: 6, criteria: '找列表最大值：思路对 3 分，代码对 3 分', answer: '先设 m = a[0]，再逐个比较' },
];
/** 第三次作业：一半学生第2题循环边界写错，助教代码分全扣 */
const LOOP_MARKS = [
  { text: 's = 0\nfor i in range(1, 101):\n    s += i\nprint(s)\n\nm = a[0]\nfor x in a:\n    if x > m: m = x', got: [4, 6], why: ['结果正确', '思路和代码都对'] },
  { text: 's = 0\nfor i in range(1, 101):\n    s += i\n\nm = a[0]\nfor i in range(1, len(a) - 1):\n    if a[i] > m: m = a[i]', got: [4, 3], why: ['结果正确', '思路对；range(1, len(a) - 1) 漏了最后一个元素，代码分全扣'] },
  { text: 's = 0\nfor i in range(100):\n    s += i\n\nm = 0\nfor x in a:\n    if x > m: m = x', got: [2, 3], why: ['range(100) 从 0 加到 99，结果少了 100', '思路对；m 初值写成 0，全是负数时出错，代码分全扣'] },
];

const CH4_ITEMS: Item[] = [
  { title: '第1题', points: 2, criteria: '函数定义和调用正确', answer: 'def area(r): return 3.14 * r * r' },
  { title: '第2题', points: 3, criteria: '默认参数用对', answer: 'def greet(name, word="你好")' },
  { title: '第3题', points: 3, criteria: '返回多个值', answer: 'return a + b, a - b' },
  { title: '第4题', points: 2, criteria: '写了文档字符串', answer: '"""计算面积"""' },
];
const CH4_MARKS = [
  { text: 'def area(r):\n    """面积"""\n    return 3.14*r*r', got: [2, 3, 3, 2], why: ['对', '对', '对', '有文档字符串'] },
  { text: 'def area(r): return 3.14*r*r', got: [2, 2, 1, 0], why: ['对', '默认参数位置写错', '只返回了一个值', '没写文档字符串'] },
];

const REMINDERS: [string, number][] = [
  ['给计科2505 Python 发本周学习提醒：先说这周要交的第二次作业、周五截止，再提醒复习第二章变量和类型，最后一句鼓励的话，别超过 100 字', 28],
  ['计科2506 也发一条，一样的格式', 28],
  ['给两个 Python 班发本周学习提醒，还是老格式：作业和截止、复习哪一章、一句鼓励。这周是第三次作业，复习第三章循环', 21],
  ['提醒写得太长了，控制在 100 字以内，别加表情', 21],
  ['本周学习提醒发一下，两个 Python 班，第四次作业周日截止，复习第四章函数', 14],
  ['软工2402 数据库也发一条本周提醒：实验三周四截止，复习 SELECT 和 GROUP BY', 14],
  ['照老样子给各班发本周学习提醒', 7],
  ['Python 班这周复习第五章列表，作业是第五次作业，周五截止', 7],
  ['提醒里把截止时间写具体到几点', 6],
  ['这周的学习提醒发一下，各班都要', 0],
];
const CHORES: [string, number][] = [
  ['把软工2402 数据库的加课码换一个', 26],
  ['张浩然忘了密码，帮他重置一下', 24],
  ['第三次作业截止推到下周一', 18],
  ['看看计科2506 第二次作业谁还没交', 15],
  ['导出计科2505 Python 的成绩', 10],
  ['建个新班，叫计科2507 Python', 3],
];
/** 都是杂事：建班、归档、重置密码、改截止、停止加入、查谁没交、导出成绩、停课通知 */
const ODD_JOBS: [string, number][] = [
  ['建个班，叫计科2507 Python', 29],
  ['把计科2401 C语言归档', 28],
  ['张浩然忘了密码，帮他重置一下', 26],
  ['第二次作业截止往后推两天', 25],
  ['计科2505 Python 先别让学生加入了', 22],
  ['看看计科2506 第二次作业谁还没交', 20],
  ['刘欣怡的密码也重置一下', 18],
  ['把软工2402 数据库的加课码换一个', 16],
  ['导出计科2505 Python 的成绩', 14],
  ['给计科2505 Python 发个通知，明天上午的课停一次', 12],
  ['再建一个班，叫软工2403 数据库', 10],
  ['实验三截止改到周日晚上十点', 8],
  ['第三次作业删掉，发错了', 6],
  ['陈子轩说登不上，给他重置密码', 4],
  ['看看计科2505 Python 第四次作业交了几份', 2],
  ['计科2505 Python 又可以加入了', 1],
];
const PROJECT_ASKS: [number, string, string, string, number][] = [
  [0, '老师期末项目能两个人一组吗', '期末项目能不能两人一组？', '可以，最多三人一组，组长周五前把名单发给我', 25],
  [1, '期末项目可以用 java 写吗？我 python 不太熟', '期末项目能不能用 Java 写？', '不行，只能用 Python', 21],
  [2, '期末项目截止能不能晚一周啊，那周考试多', '期末项目截止能不能延后一周？', '不能延期，按时交', 17],
  [3, '期末项目到底要交哪些东西', '期末项目要交哪些材料？', '代码、运行截图和一份 3000 字左右的报告', 12],
  [4, '期末项目的题目可以自己想吗', '期末项目选题能不能自己定？', '可以，先把题目发给我确认', 8],
  [5, '项目报告有没有模板', '期末项目报告有没有模板？', '有，在资料包里《期末项目说明》第二节', 4],
  [6, '老师我明天发烧想请个假', '学生明天发烧想请假，可以吗？', '可以，好好休息，记得补作业', 2],
];

/* ---------------- 世界 ---------------- */

export const WORLDS: World[] = [
  {
    id: 's1-改分一致',
    should: true,
    async setup(c) {
      const hw = await gradedHomework(c, '计科2505 Python', '第三次作业', '第1题：用 for 循环求 1 到 100 的和；第2题：找出列表 a 里的最大值', LOOP_ITEMS, LOOP_MARKS, 6);
      // 老师把循环边界写错的第2题从 3 分改成 5 分：思路对、只错边界的扣 1 分就够（四份，原因一个意思）
      await teacherFix(c, hw, '计科2505 Python', 1, 1, 5, '思路对，只是循环边界错了，扣 1 分就够');
      await teacherFix(c, hw, '计科2505 Python', 4, 1, 5, '边界错只扣 1 分，不要全扣');
      await teacherFix(c, hw, '计科2505 Python', 7, 1, 5, '思路对，边界问题扣 1 分');
      await teacherFix(c, hw, '计科2505 Python', 10, 1, 5);
    },
    check(p, c) {
      if (p.homework_id !== hwId(c, '计科2505 Python', '第三次作业')) return `绑的作业不对：${p.homework_id}`;
      if (!has(`${p.name}${p.duty}`, '批', '改', '阅')) return `名字、管的事不是批作业：${p.name}／${p.duty}`;
      if (!has(p.guide, '边界') || !has(p.guide, '1 分', '1分', '一分')) return `做法里没有老师的扣分规矩：${p.guide}`;
      return null;
    },
  },
  {
    id: 's2-反复交代',
    should: true,
    setup(c) {
      for (const [w, d] of [...REMINDERS, ...CHORES].sort((a, b) => b[1] - a[1])) said(c, w, d);
    },
    check(p) {
      if (p.homework_id) return `不该绑作业：${p.homework_id}`;
      if (!has(`${p.name}${p.duty}`, '提醒')) return `名字、管的事不是学习提醒：${p.name}／${p.duty}`;
      if (!has(p.guide, '截止') || !has(p.guide, '复习') || !has(p.guide, '鼓励')) return `做法里没有老师定的格式：${p.guide}`;
      return null;
    },
  },
  {
    id: 's3-学生常问',
    should: true,
    setup(c) {
      for (const [who, words, q, a, d] of PROJECT_ASKS) asked(c, '计科2505 Python', who, words, q, a, d);
    },
    check(p) {
      if (p.homework_id) return `不该绑作业：${p.homework_id}`;
      if (!has(`${p.name}${p.duty}`, '项目')) return `名字、管的事不是期末项目：${p.name}／${p.duty}`;
      return null;
    },
  },
  {
    id: 'n1-改分零散',
    should: false,
    async setup(c) {
      const hw = await gradedHomework(c, '计科2505 Python', '第四次作业', '第四章函数：四道小题', CH4_ITEMS, CH4_MARKS, 5);
      // 各改各的：有往上有往下，原因各不相同，有的没写
      await teacherFix(c, hw, '计科2505 Python', 0, 0, 1);
      await teacherFix(c, hw, '计科2505 Python', 1, 2, 3, '他在注释里写了第二个返回值，算对');
      await teacherFix(c, hw, '计科2505 Python', 2, 1, 2, '输出格式不对');
      await teacherFix(c, hw, '计科2505 Python', 3, 3, 2, '文档字符串写在附件里了');
    },
  },
  {
    id: 'n2-杂事',
    should: false,
    setup(c) {
      for (const [w, d] of ODD_JOBS) said(c, w, d);
    },
  },
  {
    id: 'n3-已有专门助手',
    should: false,
    setup(c) {
      for (const [w, d] of [...REMINDERS, ...CHORES].sort((a, b) => b[1] - a[1])) said(c, w, d);
      existingSpecialist(c, '学习提醒', '每周给各班写本周学习提醒', '先写这周要交的作业和截止时间，再写复习哪一章，最后一句鼓励，100 字以内，不加表情');
    },
  },
  {
    id: 'n4-说过不用',
    should: false,
    setup(c) {
      for (const [w, d] of [...REMINDERS, ...CHORES].sort((a, b) => b[1] - a[1])) said(c, w, d);
      const t = now() - 3 * DAY;
      db.insert('specialist_suggestions', {
        teacher_id: c.teacher,
        status: 'declined',
        subjects: '{}',
        due: 'asks',
        name: '每周学习提醒',
        duty: '每周一给各班写本周学习提醒',
        guide: '先写作业和截止，再写复习哪一章，最后一句鼓励，100 字以内',
        question: '要不要分一个专门助手每周给各班写学习提醒？',
        answer: '先不用',
        created_at: t,
        answered_at: t + 600_000,
      });
    },
  },
];

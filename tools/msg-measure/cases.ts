/**
 * 消息尺子：老师跟 CoT 助教说的通知、签到、选人、发消息（2026-11-18 定）。
 * 世界用助教尺子那一份（tools/ta-measure/world.ts：计科2505 Python 孙思雨、张浩然、刘欣怡、陈子轩；计科2506 Python 杨梓涵、赵宇航；
 * 软工2402 数据库 黄诗琪、周俊杰；计科2401 C语言 已归档）。打字的、语音口气的、识别错字的、接着上文的短话都有。
 * 每句写好该调哪个工具、办成什么样（返回 null 是对）。不为哪一句改提示词：这些句子只拿来量。
 */
import { db, now } from '../../server/src/db/index.js';
import type { World } from '../ta-measure/world.js';

export type Turn = { say: string } | { answer: string[] };
export interface Look {
  world: World;
  tools: { name: string; args: Record<string, any> }[];
  replies: string[];
  asked: boolean;
}
export interface Case {
  id: string;
  cat: '通知' | '签到' | '选人' | '发消息' | '接上文' | '错字';
  turns: Turn[];
  /** true 该问；false 不该问；不写是问不问都行 */
  ask?: boolean;
  setup?: (w: World) => void;
  check: (o: Look) => string | null;
}

/* ---------------- 查结果 ---------------- */

const has = (s: unknown, ...words: string[]) => words.every((w) => String(s ?? '').replace(/\s/g, '').includes(w.replace(/\s/g, '')));
const fail = (cond: boolean, why: string) => (cond ? null : why);
const first = (...checks: (string | null)[]) => checks.find((x) => x !== null) ?? null;
const cid = (w: World, name: string) => w.classes[name as keyof World['classes']];

/** 新发的通知（发给了哪几门课） */
// 只看尺子这位老师的（底下那份库是开发库的副本，里面有别的老师、别的通知）
const notices = (w: World) =>
  db.all<{ id: number; text: string; created_at: number }>('SELECT id, text, created_at FROM notices WHERE teacher_id=? ORDER BY id', w.teacher).map((n) => ({
    ...n,
    classes: db.all<{ class_id: number }>('SELECT class_id FROM notice_classes WHERE notice_id=?', n.id).map((x) => x.class_id).sort(),
  }));
const checkins = (w: World) =>
  db.all<{ id: number; class_id: number; started_at: number; ends_at: number }>('SELECT id, class_id, started_at, ends_at FROM checkins WHERE teacher_id=? ORDER BY id', w.teacher);
const marks = (checkinId: number) =>
  db.all<{ name: string; by: string }>(
    'SELECT s.name, m.by FROM checkin_marks m JOIN checkins k ON k.id=m.checkin_id JOIN class_students s ON s.user_id=m.user_id AND s.class_id=k.class_id WHERE m.checkin_id=? ORDER BY s.name',
    checkinId,
  );
const picks = (w: World) =>
  db.all<{ class_id: number; user_id: number }>('SELECT p.class_id, p.user_id FROM picks p JOIN classes c ON c.id=p.class_id WHERE c.teacher_id=? ORDER BY p.id', w.teacher);
/** 尺子里学生收件箱里没读的通知 */
const unreadNotices = (w: World) =>
  db
    .all<{ user_id: number }>("SELECT user_id FROM inbox WHERE kind='notice' AND read_at IS NULL")
    .map((x) => x.user_id)
    .filter((id) => Object.values(w.students).some((s) => s.user === id))
    .sort();
/** 老师发出去的文字消息：在哪（群是课程 id，私聊是学生名字）、说了什么 */
const said = (w: World) =>
  db
    .all<{ kind: string; class_id: number | null; student_id: number | null; text: string }>(
      "SELECT c.kind, c.class_id, c.student_id, m.text FROM chat_messages m JOIN chats c ON c.id=m.chat_id WHERE m.kind='text' AND m.user_id=? ORDER BY m.id",
      w.teacher,
    )
    .map((m) => ({ ...m, to: m.kind === 'dm' ? Object.entries(w.students).find(([, s]) => s.user === m.student_id)?.[0] : m.class_id }));
const called = (o: Look, name: string) => o.tools.filter((t) => t.name === name);
const nothingElse = (o: Look, keep: string[]) => {
  // 问没问另算（看 ask），看一眼班级、作业不算多用
  const extra = o.tools.map((t) => t.name).filter((n) => !keep.includes(n) && !['ask', 'list_classes', 'class_detail', 'homework_detail', 'view_submission'].includes(n));
  return fail(!extra.length, `多用了：${[...new Set(extra)].join('、')}`);
};

/* ---------------- 换个样子的世界 ---------------- */

/** 一条已经发出去的通知（发给 2505，几分钟前），读了的人 */
function oldNotice(w: World, text: string, readers: string[], minutesAgo = 30) {
  const t = now() - minutesAgo * 60_000;
  const id = db.insert('notices', { teacher_id: w.teacher, text, file_ids: null, created_at: t });
  const k = cid(w, '计科2505 Python');
  db.run('INSERT INTO notice_classes (notice_id, class_id) VALUES (?,?)', id, k);
  for (const name of ['孙思雨', '张浩然', '刘欣怡', '陈子轩'])
    db.insert('inbox', { user_id: w.students[name].user, kind: 'notice', ref_id: id, title: '计科2505 Python的通知', body: text, created_at: t, read_at: readers.includes(name) ? t : null, done_at: readers.includes(name) ? t : null });
  for (const name of readers) db.run('INSERT INTO notice_reads (notice_id, user_id, read_at) VALUES (?,?,?)', id, w.students[name].user, t + 60_000);
  return id;
}
/** 计科2505 正在签到（两分钟前开的、五分钟），签了的人 */
function openCheckin(w: World, signed: string[]) {
  const t = now() - 2 * 60_000;
  const id = db.insert('checkins', { class_id: cid(w, '计科2505 Python'), teacher_id: w.teacher, token: `t${t}`, started_at: t, ends_at: t + 5 * 60_000 });
  for (const name of signed) db.run("INSERT INTO checkin_marks (checkin_id, user_id, at, by) VALUES (?,?,?,'self')", id, w.students[name].user, t + 30_000);
  return id;
}

/* ---------------- 句子 ---------------- */

const noticeTo = (w: World, classes: string[], ...words: string[]) => (o: Look) => {
  const n = notices(w);
  return first(
    fail(n.length === 1, `发了 ${n.length} 条通知`),
    n[0] ? fail(JSON.stringify(n[0].classes) === JSON.stringify(classes.map((k) => cid(w, k)).sort()), `发给的课不对：${n[0].classes}`) : null,
    n[0] ? fail(has(n[0].text, ...words), `通知里没写到：${words.join('、')}（写的：${n[0].text}）`) : null,
    nothingElse(o, ['notify_students']),
  );
};
const checkinIn = (w: World, cls: string, minutes: number) => () => {
  const k = checkins(w);
  return first(
    fail(k.length >= 1, '没发起签到'),
    k.length ? fail(k[k.length - 1].class_id === cid(w, cls), '签到的课不对') : null,
    k.length ? fail(Math.round((k[k.length - 1].ends_at - k[k.length - 1].started_at) / 60_000) === minutes, `时长不对：${Math.round((k[k.length - 1].ends_at - k[k.length - 1].started_at) / 60_000)} 分钟`) : null,
  );
};
const pickedIn = (w: World, cls: string, n = 1) => (o: Look) => {
  const p = picks(w);
  return first(
    fail(p.length === n, `点了 ${p.length} 次`),
    fail(
      p.every((x) => x.class_id === cid(w, cls)),
      '点的不是这门课',
    ),
    fail(new Set(p.map((x) => x.user_id)).size === p.length, '一轮里点重了'),
    nothingElse(o, ['pick_student']),
  );
};
const sentTo = (w: World, to: string | number, ...words: string[]) => (o: Look) => {
  const m = said(w);
  return first(
    fail(m.length === 1, `发了 ${m.length} 条`),
    m[0] ? fail(m[0].to === to, `发错了地方：${m[0].to}`) : null,
    m[0] ? fail(has(m[0].text, ...words), `没写到：${words.join('、')}（写的：${m[0].text}）`) : null,
    nothingElse(o, ['send_message']),
  );
};

export const CASES: Case[] = [
  // 通知
  { id: 'n01', cat: '通知', turns: [{ say: '给计科2505发个通知，下周三停课' }], ask: false, check: (o) => noticeTo(o.world, ['计科2505 Python'], '停课')(o) },
  { id: 'n02', cat: '通知', turns: [{ say: '通知一下两个Python班，周五的实验课改到机房302' }], ask: false, check: (o) => noticeTo(o.world, ['计科2505 Python', '计科2506 Python'], '302')(o) },
  {
    id: 'n03',
    cat: '通知',
    turns: [{ say: '谁还没看通知' }],
    ask: false,
    setup: (w) => void oldNotice(w, '下周三停课一次，实验二照常交', ['孙思雨']),
    check: (o) => first(fail(called(o, 'notice_status').length === 1, '没看通知的情况'), fail(has(o.replies.join(), '张浩然') && has(o.replies.join(), '陈子轩'), '回话里没说谁没看'), fail(notices(o.world).length === 1, '又发了通知')),
  },
  {
    id: 'n04',
    cat: '通知',
    turns: [{ say: '提醒一下没看通知的同学' }],
    ask: false,
    setup: (w) => void oldNotice(w, '下周三停课一次，实验二照常交', ['孙思雨', '张浩然']),
    check: (o) => {
      const fresh = unreadNotices(o.world);
      const want = ['刘欣怡', '陈子轩'].map((n) => o.world.students[n].user).sort();
      return first(fail(called(o, 'remind_unread').length === 1, '没提醒'), fail(JSON.stringify(fresh) === JSON.stringify(want), '提醒的人不对'), fail(notices(o.world).length === 1, '又发了通知'));
    },
  },
  {
    id: 'n05',
    cat: '接上文',
    turns: [{ say: '给软工2402发个通知：明天的实验课带上笔记本电脑' }, { say: '刚才那个通知谁没看' }],
    // 半夜跑的时候「明天」真有两种理解（v1-ds 02:25 跑，它问了是哪天），问不问都行
    check: (o) => {
      const n = notices(o.world);
      const st = called(o, 'notice_status');
      return first(
        fail(n.length === 1 && n[0].classes[0] === cid(o.world, '软工2402 数据库'), '通知没发对'),
        fail(st.length >= 1, '没看通知的情况'),
        fail(has(o.replies[o.replies.length - 1], '黄诗琪') && has(o.replies[o.replies.length - 1], '周俊杰'), '没说谁没看'),
      );
    },
  },
  {
    id: 'n06',
    cat: '通知',
    turns: [{ say: '停课那个通知还有谁没看' }],
    ask: false,
    setup: (w) => {
      oldNotice(w, '下周三停课一次', ['孙思雨', '张浩然', '刘欣怡'], 120);
      oldNotice(w, '周五实验课改到机房302', ['孙思雨'], 10);
    },
    check: (o) => first(fail(called(o, 'notice_status').length === 1, '没看通知的情况'), fail(has(o.replies.join(), '陈子轩') && !has(o.replies.join(), '刘欣怡'), `说的不是停课那条：${o.replies.join()}`)),
  },
  // 签到
  {
    id: 'c01',
    cat: '签到',
    turns: [{ say: '发起签到，5分钟' }, { answer: ['计科2505 Python'] }],
    ask: true,
    check: (o) => checkinIn(o.world, '计科2505 Python', 5)(),
  },
  { id: 'c02', cat: '签到', turns: [{ say: '计科2505签到，给三分钟' }], ask: false, check: (o) => first(checkinIn(o.world, '计科2505 Python', 3)(), nothingElse(o, ['start_checkin'])) },
  {
    id: 'c03',
    cat: '签到',
    turns: [{ say: '谁还没签到' }],
    ask: false,
    setup: (w) => void openCheckin(w, ['孙思雨', '张浩然']),
    check: (o) => first(fail(called(o, 'checkin_status').length === 1, '没看签到'), fail(has(o.replies.join(), '刘欣怡') && has(o.replies.join(), '陈子轩'), '没说谁没签'), fail(checkins(o.world).length === 1, '又发起了签到')),
  },
  {
    id: 'c04',
    cat: '签到',
    turns: [{ say: '给陈子轩补签一下' }],
    ask: false,
    setup: (w) => void openCheckin(w, ['孙思雨']),
    check: (o) => {
      const k = checkins(o.world);
      const m = k.length ? marks(k[0].id) : [];
      return first(fail(k.length === 1, '又发起了签到'), fail(m.some((x) => x.name === '陈子轩' && x.by === 'teacher') && m.length === 2, `补签的不对：${JSON.stringify(m)}`));
    },
  },
  {
    id: 'c05',
    cat: '错字',
    turns: [{ say: '签到给刘新宜补一下' }],
    setup: (w) => void openCheckin(w, ['孙思雨']),
    check: (o) => {
      const k = checkins(o.world);
      const m = k.length ? marks(k[0].id) : [];
      const wrong = m.filter((x) => x.by === 'teacher' && x.name !== '刘欣怡');
      return first(fail(!wrong.length, `补签错了人：${wrong.map((x) => x.name)}`), fail(o.asked || m.some((x) => x.name === '刘欣怡'), '没补签也没问'));
    },
  },
  { id: 'c06', cat: '签到', turns: [{ say: '2505 python那个班签个到吧，十分钟' }], ask: false, check: (o) => first(checkinIn(o.world, '计科2505 Python', 10)(), nothingElse(o, ['start_checkin'])) },
  // 选人
  { id: 'p01', cat: '选人', turns: [{ say: '计科2506随机点个人回答问题' }], ask: false, check: (o) => pickedIn(o.world, '计科2506 Python')(o) },
  { id: 'p02', cat: '接上文', turns: [{ say: '在计科2505里点一个人' }, { say: '再点一个' }], ask: false, check: (o) => pickedIn(o.world, '计科2505 Python', 2)(o) },
  { id: 'p03', cat: '错字', turns: [{ say: '帮我在二五零五班抽一个同学' }], ask: false, check: (o) => pickedIn(o.world, '计科2505 Python')(o) },
  {
    id: 'p04',
    cat: '选人',
    turns: [{ say: '随便点一个人' }],
    setup: (w) => void openCheckin(w, ['孙思雨']),
    // 正在给计科2505签到：点 2505 的人对，问一句是哪门课也行；点别的课的不对
    check: (o) => (o.asked && !picks(o.world).length ? null : pickedIn(o.world, '计科2505 Python')(o)),
  },
  // 发消息
  { id: 'm01', cat: '发消息', turns: [{ say: '私聊张浩然，让他今晚把实验二交了' }], ask: false, check: (o) => sentTo(o.world, '张浩然', '实验二')(o) },
  { id: 'm02', cat: '发消息', turns: [{ say: '在计科2505群里说一声明天交作业' }], ask: false, check: (o) => sentTo(o.world, cid(o.world, '计科2505 Python'), '明天', '作业')(o) },
  { id: 'm03', cat: '发消息', turns: [{ say: '跟孙思雨说一声她这次作业写得很好' }], ask: false, check: (o) => sentTo(o.world, '孙思雨', '好')(o) },
  { id: 'm04', cat: '错字', turns: [{ say: '在软工二四零二群里说一下下午实验课取消' }], ask: false, check: (o) => sentTo(o.world, cid(o.world, '软工2402 数据库'), '取消')(o) },
  {
    id: 'm05',
    cat: '发消息',
    turns: [{ say: '在群里说一声明天交作业' }, { answer: ['计科2505 Python'] }],
    ask: true,
    check: (o) => sentTo(o.world, cid(o.world, '计科2505 Python'), '作业')(o),
  },
  // 接上文
  {
    id: 'f01',
    cat: '接上文',
    turns: [{ say: '计科2505签到，五分钟' }, { say: '谁没签' }],
    ask: false,
    check: (o) => first(checkinIn(o.world, '计科2505 Python', 5)(), fail(called(o, 'checkin_status').length === 1, '没看签到'), fail(has(o.replies[o.replies.length - 1], '陈子轩'), '没说谁没签')),
  },
  {
    id: 'f02',
    cat: '接上文',
    turns: [{ say: '给计科2506发通知：周四的课提前到8点' }, { say: '提醒一下没看的' }],
    ask: false,
    check: (o) => {
      const n = notices(o.world);
      const fresh = unreadNotices(o.world).length;
      return first(fail(n.length === 1 && n[0].classes[0] === cid(o.world, '计科2506 Python'), '通知没发对'), fail(called(o, 'remind_unread').length === 1, '没提醒'), fail(fresh === 2, `收件箱没读的通知 ${fresh} 条`));
    },
  },
  {
    id: 'f03',
    cat: '接上文',
    turns: [{ say: '给计科2505签到，3分钟' }, { say: '张浩然手机没电了，给他补上' }],
    ask: false,
    check: (o) => {
      const k = checkins(o.world);
      const m = k.length ? marks(k[k.length - 1].id) : [];
      return first(checkinIn(o.world, '计科2505 Python', 3)(), fail(m.length === 1 && m[0].name === '张浩然' && m[0].by === 'teacher', `补签不对：${JSON.stringify(m)}`));
    },
  },
];

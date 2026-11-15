/**
 * 尺子用的一套固定的「世界」：一位老师、四个班、九个学生、几份作业和交的情况、两个知识库。
 * 每句话都在一份干净的世界里跑（case.ts），跑完比对这几张表变了什么。
 */
import { db, now } from '../../server/src/db/index.js';
import * as repo from '../../server/src/kb/repo.js';
import * as changes from '../../server/src/kb/changes.js';

export const TEACHER = '王建国';

/** 北京时间某天 23:59（相对今天往后几天） */
export function dayAt(daysFromToday: number, hh = 23, mm = 59, base = Date.now()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(base + daysFromToday * 86_400_000))
      .map((x) => [x.type, x.value]),
  );
  return Date.parse(`${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
}
/** 今天是周几（北京时间，周一=1…周日=7） */
export function weekday(base = Date.now()) {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(base));
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[w as 'Mon']!;
}
/** 下周几：下一个自然周的那一天（周一到周日算一周） */
export function nextWeek(day: number, base = Date.now()) {
  return dayAt(7 - weekday(base) + day, 23, 59, base);
}
/** 这周几（本周内，可能已经过了） */
export function thisWeek(day: number, base = Date.now()) {
  return dayAt(day - weekday(base), 23, 59, base);
}

export interface World {
  teacher: number;
  classes: Record<string, number>;
  students: Record<string, { user: number; member: number; no: string }>;
  homework: Record<string, number[]>;
}

const NOTE_EXERCISES = `# 第三章 课后习题

1. 用 for 循环求 1 到 100 的和。
2. 用 while 循环求 n 的阶乘，n 由用户输入。
3. 输出 100 以内所有的偶数。
4. 写一个猜数字游戏：随机生成 1 到 100 的数，让用户猜，提示大了还是小了。
5. 打印九九乘法表。
6. 判断一个数是不是质数。
`;
const NOTE_LECTURE = `# 第三章 循环

for 循环用来遍历序列，range(n) 生成 0 到 n-1。while 循环在条件为真时一直执行，要注意写退出条件，避免死循环。
break 跳出整个循环，continue 跳过这一次。
`;
const NOTE_CH2 = `# 第二章 变量和类型

变量就是给一个值起的名字。Python 的基本类型有 int、float、str、bool。
`;
const NOTE_LAB3 = `# 实验三 SQL 查询

用 SELECT 完成以下查询：
1. 查出所有选了《数据库原理》的学生。
2. 统计每门课的平均分。
3. 找出平均分高于 80 的学生。
`;

export async function seed(): Promise<World> {
  const t = now();
  const teacher = db.insert('users', { username: 'ruler-teacher', name: TEACHER, role: 'teacher', password_hash: 'x', created_at: t });
  const cls = (name: string, archived = false) =>
    db.insert('classes', { teacher_id: teacher, name, join_code: Math.random().toString(36).slice(2, 8).toUpperCase(), join_open: 1, archived_at: archived ? t : null, created_at: t, updated_at: t });
  const classes = {
    '计科2505 Python': cls('计科2505 Python'),
    '计科2506 Python': cls('计科2506 Python'),
    '软工2402 数据库': cls('软工2402 数据库'),
    '计科2401 C语言': cls('计科2401 C语言', true),
  };
  const roster: [string, string, string][] = [
    ['孙思雨', '2026001', '计科2505 Python'],
    ['张浩然', '2026002', '计科2505 Python'],
    ['刘欣怡', '2026003', '计科2505 Python'],
    ['陈子轩', '2026004', '计科2505 Python'],
    ['杨梓涵', '2026005', '计科2506 Python'],
    ['赵宇航', '2026006', '计科2506 Python'],
    ['黄诗琪', '2026007', '软工2402 数据库'],
    ['周俊杰', '2026008', '软工2402 数据库'],
    ['吴佳怡', '2026009', '计科2401 C语言'],
  ];
  const students: World['students'] = {};
  for (const [name, no, k] of roster) {
    const u = db.insert('users', { username: `ruler-${no}`, name, role: 'student', student_no: no, password_hash: 'x', created_at: t });
    const m = db.insert('class_students', { class_id: classes[k as keyof typeof classes], student_no: no, name, user_id: u, in_roster: 0, joined_at: t, created_at: t });
    students[name] = { user: u, member: m, no };
  }
  const hw = (k: keyof typeof classes, title: string, due: number, body = '', created = t) =>
    db.insert('assignments', { class_id: classes[k], teacher_id: teacher, title, body, points: 100, due_at: due, allow_late: 1, publish_at: t - 3 * 86_400_000, created_at: created, updated_at: created });
  const first = hw('计科2505 Python', '第一次作业', dayAt(2), '读第一章，做课后第 1、2 题。');
  const together = t - 3600_000;
  const ch2a = hw('计科2505 Python', '第二章练习', dayAt(5), '第二章课后练习全部。', together);
  const ch2b = hw('计科2506 Python', '第二章练习', dayAt(5), '第二章课后练习全部。', together);
  const er = hw('软工2402 数据库', 'ER 图作业', dayAt(3), '画出选课系统的 ER 图。');
  const sub = (h: number, who: string, extra: Record<string, unknown> = {}) =>
    db.insert('submissions', { assignment_id: h, user_id: students[who].user, text: `${who}的答案`, submitted_at: t - 3600_000, late: 0, updated_at: t, ...extra });
  sub(first, '孙思雨', { score: 88, comment: '不错', graded_at: t });
  sub(first, '张浩然');
  sub(first, '刘欣怡');
  sub(ch2a, '孙思雨');
  sub(ch2a, '张浩然');
  sub(ch2b, '杨梓涵');
  sub(er, '黄诗琪');

  // 两个知识库，各放几篇笔记
  const owner = { id: teacher, name: TEACHER };
  const put = async (kbId: number, path: string, content: string) =>
    changes.createChange({
      kbId,
      title: '测试资料',
      author: 'teacher',
      authorName: TEACHER,
      kind: 'teacher',
      ops: [{ path, content, base: null }],
      apply: { by: teacher, as: changes.teacherAuthor(owner) },
    });
  const py = await repo.createKnowledgeBase({ teacherId: teacher, name: 'Python 程序设计' });
  await put(py, '第三章 循环/课后习题.md', NOTE_EXERCISES);
  await put(py, '第三章 循环/讲义.md', NOTE_LECTURE);
  await put(py, '第二章 变量/讲义.md', NOTE_CH2);
  const dbk = await repo.createKnowledgeBase({ teacherId: teacher, name: '数据库原理' });
  await put(dbk, '实验/实验三.md', NOTE_LAB3);

  return { teacher, classes, students, homework: { 第一次作业: [first], 第二章练习: [ch2a, ch2b], 'ER 图作业': [er] } };
}

/* ---------------- 比对：这几张表变了什么 ---------------- */

type Rows = Map<string, Record<string, unknown>>;
export interface Snapshot {
  classes: Rows;
  homework: Rows;
  subs: Rows;
}
export function snapshot(w: World): Snapshot {
  const cn = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM classes WHERE teacher_id=?', w.teacher).map((k) => [k.id, k.name]));
  const classes: Rows = new Map(
    db
      .all<any>('SELECT id, name, join_code, join_open, archived_at, deleted_at FROM classes WHERE teacher_id=?', w.teacher)
      .map((k) => [`班${k.id}`, { name: k.name, join_code: k.join_code, join_open: k.join_open, archived: !!k.archived_at, deleted: !!k.deleted_at }]),
  );
  const homework: Rows = new Map(
    db
      .all<any>('SELECT a.* FROM assignments a JOIN classes c ON c.id=a.class_id WHERE c.teacher_id=?', w.teacher)
      .map((h) => [
        `作业${h.id}`,
        { class: cn.get(h.class_id), title: h.title, body: h.body, points: h.points, due_at: h.due_at, allow_late: h.allow_late, publish_at: h.publish_at, deleted: !!h.deleted_at },
      ]),
  );
  const subs: Rows = new Map(
    db
      .all<any>(
        'SELECT s.*, a.title, u.name FROM submissions s JOIN assignments a ON a.id=s.assignment_id JOIN classes c ON c.id=a.class_id JOIN users u ON u.id=s.user_id WHERE c.teacher_id=?',
        w.teacher,
      )
      .map((s) => [`交${s.id}`, { homework: s.title, student: s.name, score: s.score, comment: s.comment, returned: !!s.returned_at && s.returned_at >= s.submitted_at }]),
  );
  return { classes, homework, subs };
}

/** 两次快照之间的变化，一条一行：「新增 作业31 {…}」「作业12.due_at: A → B」 */
export function diff(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  for (const key of ['classes', 'homework', 'subs'] as const) {
    for (const [id, row] of b[key]) {
      const old = a[key].get(id);
      if (!old) {
        out.push(`新增 ${id} ${JSON.stringify(row)}`);
        continue;
      }
      for (const f of Object.keys(row)) if (JSON.stringify(old[f]) !== JSON.stringify(row[f])) out.push(`${id}.${f}: ${JSON.stringify(old[f])} → ${JSON.stringify(row[f])}`);
    }
  }
  return out;
}

export const rowOf = (s: Snapshot, kind: keyof Snapshot, f: (r: Record<string, unknown>) => boolean) => [...s[kind].values()].filter(f);

/**
 * 演示班：给一位老师建一个满的班——36 个虚构学生（加上测试号 s2）、
 * 四份作业（两份已截止、一份正在交、一份定时发布）和交上来的答卷。交上来的由助教真的批（排队批），批完写讲评；
 * 再让几个学生真的问一下学伴。答卷是事先按每个学生的水平请模型写好的（answers.json，tools/demo-class/gen.ts 写的）。
 * 虚构学生的账号密码是随机的，没人能登录；学生端用 s2 演示。
 *
 * 触发：数据目录里放一个 seed-demo.json（{"teacher":"t0"}），服务启动时、之后每半分钟看一次；看到就建，
 * 建完改名成 seed-demo.done.json（里面写着结果）。同一位老师已经有这个班就不再建。
 * 写成 {"teacher":"t0","refresh":true} 是让已经建好的班重来一遍（批改、讲评、等老师回的卡片，见 refreshDemo）。
 *
 * 给评委的体验账号：同一个文件里写 accounts（没有就建，标成演示账号：不能改密码、老师不能重置、
 * 不能设成别人的正式账号）、students（虚构学生学号的前缀，跟 t0 的演示班分开）、extra（放进班里的已有学生账号，用谁的答卷）。
 * notes 是放进这位老师知识库的几份资料（路径和内容）；only 写成 "accounts" 是只建账号、放资料，不建班。
 * 带了 accounts 的请求文件里有密码，做完删掉，不留 .old。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { db, getSetting, now, setSetting } from '../db/index.js';
import { hashPassword } from '../lib/crypto.js';
import { callApi } from '../assistant/api.js';
import { startStuTurn } from '../assistant/buddy.js';
import { rewriteCard } from '../assistant/bridge.js';
import { writeInsights } from '../grading/insights.js';
import { startPlan } from '../grading/prep.js';
import { packOnHomework } from '../assistant/pack-jobs.js';
import { manifest, startingKb } from '../kb/repo.js';
import { createChange, teacherAuthor } from '../kb/changes.js';
import { enqueueGrade, gradeAssignment, gradingCount } from '../grading/jobs.js';
import { draftRubric, rubricOf, rubricOnHomework } from '../grading/rubric.js';
import { shareReview, writeReview } from '../grading/review.js';
import answers from './answers.json' with { type: 'json' };
import { ASKS, CLASS_NAME, EXTRA, HOMEWORK, STUDENTS, studentNo } from './spec.js';

const DAY = 86_400_000;
type Log = (s: string) => void;

/** 体验账号：没有就建（标成演示账号）；老师的建一个空知识库，跟注册时一样 */
export type DemoAccount = { username: string; name: string; role: 'teacher' | 'student'; password: string };
export async function ensureAccounts(list: DemoAccount[], log: Log = (s) => console.log('[demo]', s)) {
  for (const a of list) {
    if (db.get('SELECT id FROM users WHERE username=?', a.username)) continue;
    const id = db.insert('users', {
      username: a.username,
      name: a.name,
      role: a.role,
      ...(a.role === 'student' ? { student_no: a.username } : {}),
      password_hash: hashPassword(a.password),
      is_demo: 1,
      created_at: now(),
    });
    if (a.role === 'teacher') await startingKb(id);
    log(`建了体验账号 ${a.username}（${a.name}）`);
  }
}

/** 体验账号的知识库：放几份老师常有的资料（以老师的名义放进第一个知识库，跟老师自己放的一样）；已经有的路径不再放 */
export type DemoNote = { path: string; content: string };
export async function putNotes(teacherUsername: string, notes: DemoNote[], log: Log = (s) => console.log('[demo]', s)) {
  const t = db.get<{ id: number; name: string }>("SELECT id, name FROM users WHERE username=? AND role='teacher'", teacherUsername);
  if (!t || !notes.length) return;
  const kbId = db.value<number>('SELECT id FROM knowledge_bases WHERE teacher_id=? AND deleted_at IS NULL ORDER BY id LIMIT 1', t.id) ?? (await startingKb(t.id));
  if (!kbId) return;
  const have = new Set(manifest(kbId).map((e) => e.path));
  const ops = notes.filter((n) => !have.has(n.path)).map((n) => ({ path: n.path, content: n.content, base: null }));
  if (!ops.length) return;
  await createChange({ kbId, title: '老师的资料', author: 'teacher', authorName: t.name, kind: 'teacher', ops, apply: { by: t.id, as: teacherAuthor(t) } });
  log(`放进知识库 ${ops.length} 份资料`);
}

/** 北京时间某天几点（相对今天往后几天） */
function dayAt(days: number, hh: number, mm: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(Date.now() + days * DAY))
      .map((x) => [x.type, x.value]),
  );
  return Date.parse(`${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
}
/** 固定的「随机」：同一个人同一份作业每次一样 */
const pick = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** 班里另放进来的已有学生账号，交的答卷用 answers.json 里哪一个人的（as） */
export type Extra = { username: string; as: string };
export type DemoOptions = {
  refresh?: boolean | Step[];
  /** 虚构学生学号的前缀（默认 20250101）；给别的老师建时换一个，两个班的虚构学生各是各的 */
  students?: string;
  extra?: Extra[];
};

export async function seedDemo(teacherUsername: string, log: Log = (s) => console.log('[demo]', s), o: DemoOptions = {}) {
  const teacher = db.get<{ id: number; name: string }>("SELECT id, name FROM users WHERE username=? AND role IN ('teacher','admin')", teacherUsername);
  if (!teacher) throw new Error(`没有老师账号 ${teacherUsername}`);
  const have = db.get<{ id: number }>('SELECT id FROM classes WHERE teacher_id=? AND name=? AND deleted_at IS NULL', teacher.id, CLASS_NAME);
  if (have) {
    if (o.refresh) {
      await refreshDemo(have.id, log, o.refresh === true ? STEPS : o.refresh);
      return { classId: have.id, created: false, refreshed: true };
    }
    log(`已经有「${CLASS_NAME}」了（${have.id}），不再建，没做完的接着做`);
    finishLater(have.id, log);
    return { classId: have.id, created: false };
  }
  // 建班走页面那套（加课码、资料包的课程说明都会有）
  const { id: classId } = await callApi<{ id: number }>(teacher.id, 'POST', '/classes', { name: CLASS_NAME });
  const t = now();
  const joinedAt = t - 25 * DAY;
  // 学生：虚构的建账号（密码随机，没人能登录），测试号直接放进来
  const members: { uid: number; no: string; key: string }[] = [];
  STUDENTS.forEach((s, i) => {
    const no = studentNo(i, o.students);
    let uid = db.value<number>('SELECT id FROM users WHERE username=?', no);
    if (!uid)
      uid = db.insert('users', {
        username: no,
        name: s.name,
        role: 'student',
        student_no: no,
        password_hash: hashPassword(randomBytes(18).toString('hex')),
        created_at: joinedAt,
      });
    members.push({ uid, no, key: String(i) });
  });
  for (const x of o.extra ?? EXTRA.map((e) => ({ username: e.username, as: e.username }))) {
    const u = db.get<{ id: number; student_no: string | null }>("SELECT id, student_no FROM users WHERE username=? AND role='student'", x.username);
    if (u) members.push({ uid: u.id, no: u.student_no || x.username, key: x.as });
  }
  db.tx(() => {
    for (const m of members) {
      const name = db.value<string>('SELECT name FROM users WHERE id=?', m.uid)!;
      db.insert('class_students', { class_id: classId, student_no: m.no, name, user_id: m.uid, in_roster: 1, joined_at: joinedAt, created_at: joinedAt });
    }
  });
  log(`建了「${CLASS_NAME}」（${classId}），${members.length} 个学生`);

  // 作业：按天数排好发布、截止；交上来的按时间散开，排上让助教批
  const made: { id: number; review?: 'write' | 'share' }[] = [];
  for (const h of HOMEWORK) {
    const publishAt = h.publishDays >= 0 ? t - h.publishDays * DAY - 3 * 3600_000 : dayAt(-h.publishDays, 8, 0);
    const dueAt = dayAt(h.dueDays, 23, 59);
    const hid = db.insert('assignments', {
      class_id: classId,
      teacher_id: teacher.id,
      title: h.title,
      body: h.body,
      points: h.points,
      due_at: dueAt,
      allow_late: 1,
      publish_at: publishAt,
      ai_mode: 'release',
      created_at: publishAt,
      updated_at: publishAt,
    });
    packOnHomework(hid);
    rubricOnHomework(hid);
    made.push({ id: hid, review: h.review });
    const pool = (answers as Record<string, Record<string, string>>)[h.key];
    if (!pool) continue;
    const end = Math.min(dueAt, t - 3600_000);
    let n = 0;
    for (const m of members) {
      const text = pool[m.key];
      if (!text) continue;
      const r = pick(hid * 1000 + m.uid);
      // 大多在截止前一两天交；已截止的作业里两三个迟交
      const late = dueAt < t && r > 0.93;
      const at = late ? dueAt + (r - 0.9) * 10 * DAY : Math.max(publishAt + 3600_000, end - r * Math.min(5 * DAY, end - publishAt));
      const sid = db.insert('submissions', { assignment_id: hid, user_id: m.uid, text, submitted_at: Math.round(at), late: late ? 1 : 0, updated_at: Math.round(at) });
      enqueueGrade(sid, { release: true });
      n++;
    }
    log(`「${h.title}」交了 ${n} 份，排上批`);
  }

  finishLater(classId, log);
  return { classId, created: true };
}

/**
 * 后面那几步：等批完写讲评（一份发给学生），再让几个学生问学伴。每一步做过就跳过；服务中途重启了，启动时接着做（设置 demo_pending）。
 */
function finishLater(classId: number, log: Log) {
  setSetting('demo_pending', classId);
  void finishDemo(classId, log)
    .then(() => setSetting('demo_pending', null))
    .catch((err) => log(`后面那几步没做完：${(err as Error).message}`));
}
async function finishDemo(classId: number, log: Log) {
  const list = db.all<{ id: number; title: string }>('SELECT id, title FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY id', classId);
  // 评分标准没拟成（批的时候只能按要求整体给分）的：等这份批完，重拟，再把没按新标准批的重批一遍
  for (const a of list) {
    if (!db.get('SELECT id FROM submissions WHERE assignment_id=?', a.id)) continue;
    for (let i = 0; i < 720 && gradingCount(a.id) > 0; i++) await wait(5000);
    let r = rubricOf(a.id);
    if (!r || r.status !== 'ready' || (r.items.length === 1 && r.items[0].title === '整体')) {
      await draftRubric(a.id, { force: true });
      r = rubricOf(a.id);
    }
    if (r?.status !== 'ready' || !r.items.length) continue;
    const off = db
      .all<{ items: string | null }>('SELECT items FROM submissions WHERE assignment_id=? AND score IS NOT NULL', a.id)
      .some((s) => (JSON.parse(s.items || '[]') as unknown[]).length !== r!.items.length);
    if (!off) continue;
    const n = gradeAssignment(a.id, { redo: true });
    log(`「${a.title}」评分标准重拟好了，重批 ${n} 份`);
    for (let i = 0; i < 720 && gradingCount(a.id) > 0; i++) await wait(5000);
  }
  for (const h of HOMEWORK.filter((x) => x.review)) {
    const a = list.find((x) => x.title === h.title);
    if (!a) continue;
    const r = db.get<{ status: string; shared_at: number | null }>('SELECT status, shared_at FROM hw_reviews WHERE assignment_id=?', a.id);
    if (r?.status !== 'ready') {
      for (let i = 0; i < 720 && gradingCount(a.id) > 0; i++) await wait(5000);
      await writeReview(a.id);
      log(`「${a.title}」讲评写好了`);
    }
    if (h.review === 'share' && !db.value('SELECT shared_at FROM hw_reviews WHERE assignment_id=?', a.id)) {
      try {
        shareReview(a.id, true);
      } catch (err) {
        log(`讲评没发出去：${(err as Error).message}`);
      }
    }
  }
  const members = db.all<{ user_id: number; name: string }>('SELECT user_id, name FROM class_students WHERE class_id=? AND user_id IS NOT NULL ORDER BY id', classId);
  for (const q of ASKS) {
    const m = members[q.student];
    if (!m) continue;
    // 问过了就不再问
    if (db.get("SELECT id FROM kb_runs WHERE teacher_id=? AND agent='stu' AND request=?", m.user_id, q.text)) continue;
    try {
      const runId = startStuTurn({ id: m.user_id, name: m.name }, { message: q.text });
      for (let i = 0; i < 120; i++) {
        await wait(2000);
        if (db.value<string>('SELECT status FROM kb_runs WHERE id=?', runId) !== 'running') break;
      }
    } catch (err) {
      log(`${m.name} 问学伴没成：${(err as Error).message}`);
    }
  }
  log('演示班建好了');
}

/**
 * 演示班重来一遍（2026-11-16 批改 v2 上线：原来 93 份里 13 份把第1题的小项当成了三道题交分）：
 * 批好的按现在的办法全部重批，写过的讲评重写（发给学生的那一版跟着换），老师那边还在等的学生来问卡片按现在的说法重写。
 */
type Step = 'grades' | 'reviews' | 'cards' | 'insights' | 'prep';
const STEPS: Step[] = ['grades', 'reviews', 'cards', 'insights', 'prep'];
/** refresh 也能只写其中几步：{"teacher":"t0","refresh":["insights","prep"]} 只看学情、备一节课 */
async function refreshDemo(classId: number, log: Log, steps: Step[] = STEPS) {
  const list = db.all<{ id: number; title: string }>('SELECT id, title FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY id', classId);
  if (steps.includes('grades')) await regrade(list, log);
  if (steps.includes('reviews'))
    for (const a of list) {
      if (!db.get("SELECT 1 FROM hw_reviews WHERE assignment_id=? AND status='ready'", a.id)) continue;
      await writeReview(a.id);
      log(`「${a.title}」讲评重写好了`);
    }
  if (steps.includes('cards'))
    for (const ask of db.all<{ id: number }>("SELECT id FROM student_asks WHERE class_id=? AND status='teacher' AND card_run_id IS NOT NULL ORDER BY id", classId)) {
      try {
        log(`卡片 ${ask.id}${(await rewriteCard(ask.id)) ? ' 重写好了' : ' 没动（助教这回没转老师）'}`);
      } catch (err) {
        log(`卡片 ${ask.id} 没重写成：${(err as Error).message}`);
      }
    }
  if (steps.includes('insights')) {
    await writeInsights(classId);
    log('学情看好了');
  }
  if (steps.includes('prep')) {
    const teacher = db.value<number>('SELECT teacher_id FROM classes WHERE id=?', classId)!;
    const id = startPlan(classId, teacher, null);
    for (let i = 0; i < 240 && db.value<string>('SELECT status FROM lesson_plans WHERE id=?', id) === 'writing'; i++) await wait(5000);
    log(`备课：${db.value<string>('SELECT status FROM lesson_plans WHERE id=?', id)}`);
  }
  log('演示班重来好了');
}

async function regrade(list: { id: number; title: string }[], log: Log) {
  for (const a of list) {
    const n = gradeAssignment(a.id, { redo: true });
    if (n) log(`「${a.title}」重批 ${n} 份`);
  }
  for (const a of list) for (let i = 0; i < 720 && gradingCount(a.id) > 0; i++) await wait(5000);
}

/** 服务重启：演示班后面那几步没做完的接着做 */
export function resumeDemo() {
  const id = getSetting<number | null>('demo_pending', null);
  if (id) finishLater(id, (s) => console.log('[demo]', s));
}

/** 数据目录里有 seed-demo.json 就建（启动时、之后每半分钟看一次） */
export function watchDemoRequest() {
  resumeDemo();
  const file = join(config.dataDir, 'seed-demo.json');
  const check = () => {
    if (!existsSync(file)) return;
    let teacher = 't0',
      refresh: boolean | Step[] = false,
      students: string | undefined,
      extra: Extra[] | undefined,
      accounts: DemoAccount[] = [],
      notes: DemoNote[] = [],
      onlyAccounts = false;
    try {
      const want = JSON.parse(readFileSync(file, 'utf8'));
      teacher = String(want.teacher || 't0');
      refresh = want.refresh === true ? true : Array.isArray(want.refresh) ? want.refresh.filter((s: unknown): s is Step => STEPS.includes(s as Step)) : false;
      if (typeof want.students === 'string' && /^\d{6,10}$/.test(want.students)) students = want.students;
      if (Array.isArray(want.extra))
        extra = want.extra
          .filter((x: any) => x && typeof x.username === 'string' && typeof x.as === 'string')
          .map((x: any) => ({ username: x.username, as: x.as }));
      if (Array.isArray(want.accounts))
        accounts = want.accounts.filter(
          (a: any) => a && typeof a.username === 'string' && typeof a.name === 'string' && (a.role === 'teacher' || a.role === 'student') && typeof a.password === 'string' && a.password.length >= 6,
        );
      if (Array.isArray(want.notes))
        notes = want.notes.filter((n: any) => n && typeof n.path === 'string' && typeof n.content === 'string' && n.path.length < 200).slice(0, 30);
      onlyAccounts = want.only === 'accounts';
    } catch {}
    const running = join(config.dataDir, 'seed-demo.running.json');
    try {
      renameSync(file, running);
    } catch {
      return;
    }
    void ensureAccounts(accounts)
      .then(() => putNotes(teacher, notes))
      .then((): Promise<Record<string, unknown>> => (onlyAccounts ? Promise.resolve({ accountsOnly: true }) : seedDemo(teacher, undefined, { refresh, students, extra })))
      .then((r) => writeFileSync(join(config.dataDir, 'seed-demo.done.json'), JSON.stringify({ teacher, ...r, at: now() })))
      .catch((err) => writeFileSync(join(config.dataDir, 'seed-demo.done.json'), JSON.stringify({ teacher, error: (err as Error).message, at: now() })))
      .finally(() => {
        try {
          if (accounts.length) unlinkSync(running);
          else renameSync(running, join(config.dataDir, 'seed-demo.request.old'));
        } catch {}
      });
  };
  check();
  setInterval(check, 30_000).unref();
}

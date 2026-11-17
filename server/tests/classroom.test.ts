import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Question } from '../src/prep/lessons.js';

process.env.CT_DATA_DIR = mkdtempSync(join(tmpdir(), 'ct-classroom-'));
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
// 建班、布置作业时助教在后台写资料包、批改，这里都不让它跑（不调模型）
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const L = await import('../src/classroom/lecture.js');
const app = createApp();

const user = (name: string, role: string) =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const ids = {
  teacher: user('王建国', 'teacher'),
  other: user('李老师', 'teacher'),
  zhang: user('张三', 'student'),
  li: user('李四', 'student'),
  wang: user('王五', 'student'),
};
type Who = keyof typeof ids;
const who = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, cookie(v)])) as Record<Who, string>;
async function req(path: string, as: Who = 'teacher', body?: unknown, method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: who[as], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: (type.includes('json') ? await res.json() : null) as any };
}

test('课堂：程序判对错——选择照选项、判断照对错、填空去空格不分大小写，简答编程不判', () => {
  const single: Question = { id: 'a', type: 'single', stem: '选一个', options: ['x', 'y', 'z'], choice: [1], answer: 'B' };
  assert.equal(L.judge(single, { choice: [1] }), true);
  assert.equal(L.judge(single, { choice: [0] }), false);
  const multi: Question = { id: 'b', type: 'multi', stem: '选几个', options: ['x', 'y', 'z'], choice: [0, 2], answer: 'AC' };
  assert.equal(L.judge(multi, { choice: [2, 0] }), true);
  assert.equal(L.judge(multi, { choice: [0] }), false);
  assert.equal(L.judge(multi, { choice: [0, 1, 2] }), false);
  assert.equal(L.judge({ id: 'c', type: 'judge', stem: '对不对', answer: '错' }, { text: '错' }), true);
  assert.equal(L.judge({ id: 'c', type: 'judge', stem: '对不对', answer: '错' }, { text: '对' }), false);
  const blank: Question = { id: 'd', type: 'blank', stem: '填空', answer: 'Hello World' };
  assert.equal(L.judge(blank, { text: '  hello   world ' }), true);
  assert.equal(L.judge(blank, { text: 'ＨＥＬＬＯ world' }), true);
  assert.equal(L.judge(blank, { text: 'hello' }), false);
  assert.equal(L.judge({ id: 'e', type: 'blank', stem: '两个空', answer: 'def, return' }, { text: 'def、return' }), true);
  // 题上没写答案的不判，免得全班都算错
  assert.equal(L.judge({ id: 'f', type: 'blank', stem: '没答案', answer: '' }, { text: 'x' }), null);
  assert.equal(L.judge({ id: 'g', type: 'short', stem: '说说', answer: '缺键不报错' }, { text: '随便' }), null);
  assert.equal(L.judge({ id: 'h', type: 'code', stem: '写个函数', answer: 'def f(): pass' }, { text: 'def f(): pass' }), null);
});

/* ---------------- 一堂课走一遍 ---------------- */

const deck = {
  theme: 'violet',
  slides: [
    { id: 's1', layout: 'cover', title: '字典的常用操作', notes: '先问一句：查字典怎么查' },
    { id: 's2', layout: 'points', title: 'get 取值', points: ["d.get('a', 0)"], notes: '当场演示' },
    { id: 's3', layout: 'quiz', title: '想一想', quiz: { question: '缺的键 get 返回什么', options: ['报错', 'None'], answer: [1], explain: '不给默认值就是 None' } },
  ],
};
const practice = [
  { id: 'p1', type: 'single', stem: 'get 不写默认值，缺键时返回', options: ['None', '0', '报错'], choice: [0], answer: 'A', explain: '默认值是 None' },
  { id: 'p2', type: 'judge', stem: "d['x'] 在缺键时会报 KeyError", answer: '对', explain: '方括号取不到就报错' },
  { id: 'p3', type: 'short', stem: '说说 get 和 [] 的区别', answer: '缺键时 get 不报错' },
];

async function joinClass(classId: number, as: Who, no: string, name: string) {
  const code = (await req(`/classes/${classId}`)).json.code;
  const r = await req('/classes/join', as, { code, studentNo: no, name });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

test('课堂：开课、进课堂、翻页、推题、作答、公布、点名、提问、下课小结；别的班、别的老师碰不到', async (t) => {
  const a = (await req('/classes', 'teacher', { name: '计科5班' })).json.id as number;
  const b = (await req('/classes', 'teacher', { name: '计科6班' })).json.id as number;
  await joinClass(a, 'zhang', '2025000001', '张三');
  await joinClass(a, 'li', '2025000002', '李四');
  await joinClass(b, 'wang', '2025000003', '王五');
  const lesson = db.insert('lessons', {
    teacher_id: ids.teacher,
    class_id: a,
    title: '字典的常用操作',
    status: 'ready',
    deck: JSON.stringify(deck),
    practice: JSON.stringify(practice),
    lanes: '{}',
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  let id = 0;

  await t.test('开课：带一节备好的课；同一个班只能一堂在上；别的老师开不了我的班、用不了我的课', async () => {
    assert.equal((await req('/classroom', 'other', { classId: a })).status, 404);
    const theirs = (await req('/classes', 'other', { name: '别人的班' })).json.id as number;
    assert.equal((await req('/classroom', 'other', { classId: theirs, lessonId: lesson })).status, 404);
    const r = await req('/classroom', 'teacher', { classId: a, lessonId: lesson });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    id = r.json.id;
    const again = await req('/classroom', 'teacher', { classId: a });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /正在上/);
    // 表上的唯一索引也兜着
    assert.throws(() => db.insert('lectures', { class_id: a, teacher_id: ids.teacher, title: 'x', status: 'live', started_at: 1, updated_at: 1 }), /UNIQUE/);
    const got = (await req(`/classroom/${id}`)).json;
    assert.equal(got.lecture.title, '字典的常用操作');
    assert.equal(got.lecture.className, '计科5班');
    assert.equal(got.lecture.status, 'live');
    assert.equal(got.deck.slides.length, 3);
    assert.equal(got.deck.slides[0].notes, '先问一句：查字典怎么查');
    assert.equal(got.practice.length, 3);
    assert.equal((await req(`/classroom/${id}`, 'other')).status, 404);
    assert.equal((await req(`/classroom/${id}/state`, 'other')).status, 404);
    assert.equal((await req('/classroom/live')).json.live.length, 1);
    assert.equal((await req('/classroom/live', 'other')).json.live.length, 0);
  });

  await t.test('学生：自己班在上课才看得到；打开就算到课；课件不带讲稿，课件上的小测不带答案', async () => {
    const zl = (await req('/classroom/live', 'zhang')).json.live;
    assert.deepEqual(
      zl.map((x: any) => [x.id, x.title, x.teacher, x.className]),
      [[id, '字典的常用操作', '王建国', '计科5班']],
    );
    assert.equal((await req('/classroom/live', 'wang')).json.live.length, 0);
    assert.equal((await req(`/classroom/${id}/student`, 'wang')).status, 404);
    // 老师那头还没人到
    assert.equal((await req(`/classroom/${id}/state`)).json.attendance.count, 0);
    const s = (await req(`/classroom/${id}/student`, 'zhang')).json;
    assert.equal(s.status, 'live');
    assert.equal(s.pages, 3);
    assert.equal(s.page, 0);
    assert.equal(s.slide.title, '字典的常用操作');
    assert.equal(s.slide.notes, undefined);
    const st = (await req(`/classroom/${id}/state`)).json;
    assert.equal(st.attendance.count, 1);
    assert.equal(st.attendance.total, 2);
    assert.deepEqual(st.attendance.people.map((p: any) => p.name), ['张三']);
    assert.deepEqual(st.attendance.absent, ['李四']);
    // 翻到小测那页：学生看得到题，看不到答案和解析
    assert.equal((await req(`/classroom/${id}/page`, 'teacher', { page: 9 })).json.page, 2);
    const q = (await req(`/classroom/${id}/student`, 'zhang')).json;
    assert.equal(q.page, 2);
    assert.equal(q.slide.quiz.question, '缺的键 get 返回什么');
    assert.deepEqual(q.slide.quiz.answer, []);
    assert.equal(q.slide.quiz.explain, undefined);
    assert.equal((await req(`/classroom/${id}/page`, 'zhang', { page: 1 })).status, 403);
    assert.equal((await req(`/classroom/${id}/page`, 'other', { page: 1 })).status, 404);
    await req(`/classroom/${id}/student`, 'li');
  });

  let single = 0,
    judgeQ = 0,
    shortQ = 0,
    blankQ = 0,
    slideQ = 0;
  await t.test('推题：课堂练习的、课件上小测的、当堂出的；同一道不推两次；学生公布前看不到答案', async () => {
    single = (await req(`/classroom/${id}/questions`, 'teacher', { source: 'p1' })).json.id;
    assert.ok(single);
    assert.equal((await req(`/classroom/${id}/questions`, 'teacher', { source: 'p1' })).status, 409);
    assert.equal((await req(`/classroom/${id}/questions`, 'teacher', { source: 'nope' })).status, 404);
    assert.equal((await req(`/classroom/${id}/questions`, 'other', { source: 'p2' })).status, 404);
    assert.equal((await req(`/classroom/${id}/questions`, 'zhang', { source: 'p2' })).status, 403);
    judgeQ = (await req(`/classroom/${id}/questions`, 'teacher', { source: 'p2' })).json.id;
    shortQ = (await req(`/classroom/${id}/questions`, 'teacher', { source: 'p3' })).json.id;
    slideQ = (await req(`/classroom/${id}/questions`, 'teacher', { source: 'slide:s3' })).json.id;
    const made = await req(`/classroom/${id}/questions`, 'teacher', { question: { type: 'blank', stem: '打印出 Hello World 的语句是 print(___)', answer: "'Hello World'" } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    blankQ = made.json.id;
    assert.equal((await req(`/classroom/${id}/questions`, 'teacher', { question: { type: 'single', stem: '只有一个选项', options: ['a'] } })).status, 400);
    const s = (await req(`/classroom/${id}/student`, 'zhang')).json;
    assert.equal(s.questions.length, 5);
    for (const x of s.questions) {
      assert.equal(x.status, 'open');
      assert.equal(x.answer, undefined);
      assert.equal(x.choice, undefined);
      assert.equal(x.explain, undefined);
      assert.equal(x.stats, undefined);
    }
    assert.deepEqual(s.questions[0].options, ['None', '0', '报错']);
    const sq = s.questions.find((x: any) => x.id === slideQ);
    assert.equal(sq.type, 'single');
    assert.equal(sq.stem, '缺的键 get 返回什么');
    // 题目存的是一份拷贝：课后改了练习，这堂课的题不变
    db.update('lessons', lesson, { practice: JSON.stringify([{ ...practice[0], stem: '改过的题干' }]), updated_at: Date.now() + 1 });
    assert.equal((await req(`/classroom/${id}/student`, 'zhang')).json.questions[0].stem, 'get 不写默认值，缺键时返回');
    db.update('lessons', lesson, { practice: JSON.stringify(practice), updated_at: Date.now() + 2 });
  });

  await t.test('作答：别的班的学生交不了；交了不能改；对不对程序判；老师实时看到每个选项几个人', async () => {
    assert.equal((await req(`/classroom/${id}/questions/${single}/answer`, 'wang', { choice: [0] })).status, 404);
    assert.equal((await req(`/classroom/${id}/questions/${single}/answer`, 'zhang', { choice: [0, 1] })).status, 400);
    assert.equal((await req(`/classroom/${id}/questions/${single}/answer`, 'zhang', { choice: [7] })).status, 400);
    assert.deepEqual((await req(`/classroom/${id}/questions/${single}/answer`, 'zhang', { choice: [0] })).json, { correct: true });
    assert.equal((await req(`/classroom/${id}/questions/${single}/answer`, 'zhang', { choice: [2] })).status, 409);
    assert.deepEqual((await req(`/classroom/${id}/questions/${single}/answer`, 'li', { choice: [2] })).json, { correct: false });
    assert.equal((await req(`/classroom/${id}/questions/${judgeQ}/answer`, 'zhang', { text: '是' })).status, 400);
    assert.deepEqual((await req(`/classroom/${id}/questions/${judgeQ}/answer`, 'zhang', { text: '对' })).json, { correct: true });
    assert.deepEqual((await req(`/classroom/${id}/questions/${blankQ}/answer`, 'li', { text: "  'hello world' " })).json, { correct: true });
    assert.deepEqual((await req(`/classroom/${id}/questions/${blankQ}/answer`, 'zhang', { text: 'hello' })).json, { correct: false });
    assert.equal((await req(`/classroom/${id}/questions/${shortQ}/answer`, 'li', { text: '  ' })).status, 400);
    assert.deepEqual((await req(`/classroom/${id}/questions/${shortQ}/answer`, 'li', { text: 'get 缺键给 None，[] 报错' })).json, { correct: null });
    const st = (await req(`/classroom/${id}/state`)).json;
    const q1 = st.questions.find((x: any) => x.id === single);
    assert.equal(q1.answered, 2);
    assert.equal(q1.correct, 1);
    assert.deepEqual(
      q1.bars.map((b: any) => [b.label, b.count, b.right]),
      [
        ['A', 1, true],
        ['B', 0, false],
        ['C', 1, false],
      ],
    );
    assert.deepEqual(q1.wrong, { text: 'C', count: 1, option: '报错' });
    assert.deepEqual(
      q1.answers.map((x: any) => [x.name, x.text, x.correct]),
      [
        ['张三', 'A', true],
        ['李四', 'C', false],
      ],
    );
    const q5 = st.questions.find((x: any) => x.id === shortQ);
    assert.equal(q5.correct, null);
    assert.equal(q5.answers[0].text, 'get 缺键给 None，[] 报错');
    // 学生在公布前看到自己交的，看不到对错
    const mine = (await req(`/classroom/${id}/student`, 'li')).json.questions.find((x: any) => x.id === single);
    assert.deepEqual(mine.mine.choice, [2]);
    assert.equal(mine.correct, undefined);
  });

  await t.test('公布答案：学生看到对错、答案、解析和全班选得怎么样；公布以后不再收', async () => {
    assert.equal((await req(`/classroom/${id}/questions/${single}/reveal`, 'other', {})).status, 404);
    assert.equal((await req(`/classroom/${id}/questions/${single}/reveal`, 'zhang', {})).status, 403);
    assert.equal((await req(`/classroom/${id}/questions/${single}/reveal`, 'teacher', {})).status, 200);
    const li = (await req(`/classroom/${id}/student`, 'li')).json.questions.find((x: any) => x.id === single);
    assert.equal(li.status, 'revealed');
    assert.equal(li.correct, false);
    assert.deepEqual(li.choice, [0]);
    assert.equal(li.explain, '默认值是 None');
    assert.equal(li.stats.answered, 2);
    assert.equal(li.stats.correct, 1);
    assert.deepEqual(
      li.stats.bars.map((b: any) => b.count),
      [1, 0, 1],
    );
    assert.equal(JSON.stringify(li).includes('张三'), false);
    // 没公布的那几道还是看不到
    assert.equal((await req(`/classroom/${id}/student`, 'li')).json.questions.find((x: any) => x.id === judgeQ).answer, undefined);
    const late = await req(`/classroom/${id}/questions/${single}/answer`, 'li', { choice: [0] });
    assert.equal(late.status, 409);
    assert.match(late.json.error, /公布/);
    // 大屏放这道题的作答，放回课件
    assert.equal((await req(`/classroom/${id}/screen`, 'teacher', { question: single })).status, 200);
    assert.equal((await req(`/classroom/${id}/state`)).json.screen, single);
    assert.equal((await req(`/classroom/${id}/screen`, 'teacher', { question: 999999 })).status, 404);
    await req(`/classroom/${id}/screen`, 'teacher', { question: null });
  });

  await t.test('随机点名：只从进了课堂的学生里挑，一轮里不重复，点完开新一轮', async () => {
    const first = (await req(`/classroom/${id}/call`, 'teacher', {})).json;
    const second = (await req(`/classroom/${id}/call`, 'teacher', {})).json;
    assert.deepEqual([first.name, second.name].sort(), ['张三', '李四']);
    assert.deepEqual([first.round, second.round, first.left, second.left, first.total], [1, 1, 1, 0, 2]);
    const third = (await req(`/classroom/${id}/call`, 'teacher', {})).json;
    assert.equal(third.round, 2);
    assert.equal(third.left, 1);
    assert.equal((await req(`/classroom/${id}/state`)).json.call.name, third.name);
    assert.equal((await req(`/classroom/${id}/call`, 'other', {})).status, 404);
    assert.equal((await req(`/classroom/${id}/call`, 'zhang', {})).status, 403);
  });

  await t.test('提问：学生发一句给老师；别的班的发不了；老师看到是谁问的', async () => {
    assert.equal((await req(`/classroom/${id}/asks`, 'zhang', { text: '  ' })).status, 400);
    assert.equal((await req(`/classroom/${id}/asks`, 'wang', { text: '我也想问' })).status, 404);
    assert.equal((await req(`/classroom/${id}/asks`, 'zhang', { text: 'setdefault 和 get 有什么不一样？' })).status, 200);
    assert.deepEqual(
      (await req(`/classroom/${id}/state`)).json.asks.map((x: any) => [x.name, x.text]),
      [['张三', 'setdefault 和 get 有什么不一样？']],
    );
    assert.deepEqual(
      (await req(`/classroom/${id}/student`, 'zhang')).json.asks.map((x: any) => x.text),
      ['setdefault 和 get 有什么不一样？'],
    );
    assert.equal((await req(`/classroom/${id}/student`, 'li')).json.asks.length, 0);
  });

  await t.test('下课：小结有到课人数、每道题正确率、错得最多的选项、学生的提问；下课后不再收，能再开下一堂', async () => {
    assert.equal((await req(`/classroom/${id}/end`, 'other', {})).status, 404);
    assert.equal((await req(`/classroom/${id}/end`, 'zhang', {})).status, 403);
    const end = await req(`/classroom/${id}/end`, 'teacher', {});
    assert.equal(end.status, 200);
    const s = end.json.summary;
    assert.equal(s.attended, 2);
    assert.equal(s.classSize, 2);
    assert.deepEqual(s.absent, []);
    assert.deepEqual(
      s.questions.map((q: any) => [q.n, q.type, q.answered, q.correct, q.rate]),
      [
        [1, 'single', 2, 1, 0.5],
        [2, 'judge', 1, 1, 1],
        [3, 'short', 1, null, null],
        [4, 'single', 0, 0, null],
        [5, 'blank', 2, 1, 0.5],
      ],
    );
    assert.deepEqual(s.questions[0].wrong, { text: 'C', count: 1, option: '报错' });
    assert.deepEqual(s.questions[4].wrong, { text: 'hello', count: 1 });
    // 能判对错的 5 份作答里对了 3 份
    assert.equal(s.rate, 3 / 5);
    assert.deepEqual(
      s.asks.map((x: any) => [x.name, x.text]),
      [['张三', 'setdefault 和 get 有什么不一样？']],
    );
    assert.equal(s.calls.length, 3);
    assert.equal(end.json.lecture.status, 'ended');
    assert.equal((await req(`/classroom/${id}/questions/${judgeQ}/answer`, 'li', { text: '对' })).status, 409);
    assert.equal((await req(`/classroom/${id}/asks`, 'li', { text: '还在吗' })).status, 409);
    assert.equal((await req(`/classroom/${id}/questions`, 'teacher', { source: 'p2' })).status, 409);
    assert.equal((await req(`/classroom/${id}/call`, 'teacher', {})).status, 409);
    assert.equal((await req('/classroom/live', 'zhang')).json.live.length, 0);
    // 学生下课后打开不再算到课，也还看得到自己交的
    const after = (await req(`/classroom/${id}/student`, 'zhang')).json;
    assert.equal(after.status, 'ended');
    assert.equal(after.questions.find((x: any) => x.id === single).correct, true);
    // 「课堂」页：上过的课一行一个
    const list = (await req('/classroom')).json;
    assert.equal(list.live.length, 0);
    assert.deepEqual(
      list.past.map((x: any) => [x.title, x.className, x.attended, x.classSize, x.pushed, x.rate]),
      [['字典的常用操作', '计科5班', 2, 2, 5, 0.6]],
    );
    assert.equal((await req('/classroom', 'other')).json.past.length, 0);
    assert.equal((await req('/classroom', 'zhang')).status, 403);
    // 打开上过的课看得到小结
    assert.equal((await req(`/classroom/${id}`)).json.summary.attended, 2);
    // 再开一堂：这回不带课，只推题和点名
    const next = await req('/classroom', 'teacher', { classId: a, title: '' });
    assert.equal(next.status, 200);
    const n = (await req(`/classroom/${next.json.id}`)).json;
    assert.equal(n.lecture.title, '随堂互动');
    assert.equal(n.deck, null);
    assert.deepEqual(n.practice, []);
    assert.equal((await req(`/classroom/${next.json.id}/questions`, 'teacher', { source: 'p1' })).status, 404);
    const call = await req(`/classroom/${next.json.id}/call`, 'teacher', {});
    assert.equal(call.status, 409);
    assert.match(call.json.error, /还没有学生/);
    // 在上的删不了；下了课的删掉就没了
    assert.equal((await req(`/classroom/${next.json.id}`, 'teacher', undefined, 'DELETE')).status, 409);
    await req(`/classroom/${next.json.id}/end`, 'teacher', {});
    assert.equal((await req(`/classroom/${next.json.id}`, 'teacher', undefined, 'DELETE')).status, 200);
    assert.equal((await req(`/classroom/${next.json.id}`)).status, 404);
    assert.equal((await req(`/classroom/${next.json.id}/student`, 'zhang')).status, 404);
  });

  await t.test('退出了班的学生看不到这个班的课；归档的班开不了课；很久没动的课自己下课', async () => {
    const live = (await req('/classroom', 'teacher', { classId: b })).json.id;
    assert.equal((await req(`/classroom/${live}/student`, 'wang')).status, 200);
    await req(`/classes/${b}/leave`, 'wang', {});
    assert.equal((await req(`/classroom/${live}/student`, 'wang')).status, 404);
    assert.equal((await req('/classroom/live', 'wang')).json.live.length, 0);
    await req(`/classes/${a}`, 'teacher', { archived: true }, 'PATCH');
    const archived = await req('/classroom', 'teacher', { classId: a });
    assert.equal(archived.status, 409);
    assert.match(archived.json.error, /归档/);
    db.update('lectures', live, { updated_at: Date.now() - 5 * 3600_000 });
    L.endStale(true);
    const row = db.get<any>('SELECT status, ended_at, summary FROM lectures WHERE id=?', live);
    assert.equal(row.status, 'ended');
    assert.ok(row.ended_at < Date.now() - 4 * 3600_000);
    assert.equal(JSON.parse(row.summary).attended, 1);
  });
});

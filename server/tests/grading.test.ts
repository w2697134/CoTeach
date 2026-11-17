import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-grading-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_PACK_AUTO = '0';
process.env.CT_GRADE_AUTO = '0';
// 助教看一眼要不要分专门助手也不在后台自己跑（会用掉排好的模型回答）
process.env.CT_SUGGEST_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const model = await import('../src/assistant/model.js');
const pack = await import('../src/assistant/pack.js');
const { createKb } = await import('../src/kb/bases.js');
const { saveSource } = await import('../src/kb/repo.js');
const rubric = await import('../src/grading/rubric.js');
const jobs = await import('../src/grading/jobs.js');
const review = await import('../src/grading/review.js');
const { locate } = await import('../src/grading/common.js');
const { cleanResult } = await import('../src/grading/grader.js');
const app = createApp();

const user = (name: string, role = 'teacher') =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
const teacher = user('王建国'),
  other = user('李老师'),
  zhang = user('张浩然', 'student'),
  liu = user('刘欣怡', 'student'),
  chen = user('陈子轩', 'student');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies: Record<string, string> = { teacher: cookie(teacher), other: cookie(other), zhang: cookie(zhang), liu: cookie(liu), chen: cookie(chen) };
async function req(path: string, body?: unknown, who = 'teacher', method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? ((await res.json()) as any) : null, res };
}

type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };
const queue: Reply[] = [];
const seen: { messages: any[]; tools: string[]; purpose?: string }[] = [];
model.setModelStep(async (o) => {
  assert.equal(o.agent, 'grader');
  seen.push({ messages: o.messages, tools: o.tools.map((t) => t.name), purpose: o.purpose });
  const s = queue.shift();
  if (!s) throw new Error('批改助教的模型回答写少了');
  return { text: s.text || '', toolCalls: (s.calls || []).map((c, i) => ({ id: `call_${randomUUID().slice(0, 8)}_${i}`, name: c.name, args: c.args, raw: JSON.stringify(c.args) })) };
});
const script = (...steps: Reply[]) => queue.push(...steps);
const lastToolOut = (messages: any[]) => String([...messages].reverse().find((m) => m.role === 'tool')?.content || '');

const k5 = (await req('/classes', { name: '计科5班' })).json.id as number;
const enroll = (classId: number, uid: number, no: string, name: string) =>
  db.insert('class_students', { class_id: classId, student_no: no, name, user_id: uid, in_roster: 0, joined_at: Date.now(), created_at: Date.now() });
const zs = enroll(k5, zhang, '2023001', '张浩然');
const ls = enroll(k5, liu, '2023002', '刘欣怡');
const cs = enroll(k5, chen, '2023003', '陈子轩');
const kb = await createKb(teacher, '程序设计');
saveSource(kb, '作业1 答案.md', Buffer.from('作业1 答案'), '第1题 答案：sum(range(1,101)) = 5050\n第2题 答案：用 for 循环逐个比较，ANSWER-MARK-7731');

const day = 86400_000;
async function assign(title: string, aiMode = 'release', points = 10) {
  const r = await req('/homework', { classIds: [k5], title, body: '第1题：求1到100的和；第2题：找列表最大值', points, dueAt: Date.now() + 3 * day, allowLate: true, publishAt: null, fileIds: [], aiMode });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.ids[0] as number;
}
const submit = async (hw: number, who: string, text: string) => {
  const r = await req(`/homework/${hw}/submit`, { text, fileIds: [] }, who);
  assert.equal(r.status, 200, JSON.stringify(r.json));
};
const RUBRIC = [
  { title: '第1题', points: 4, criteria: '结果对给 4 分', answer: 'sum(range(1,101)) = 5050' },
  { title: '第2题', points: 6, criteria: '思路对 3 分，代码对 3 分', answer: '用 for 循环逐个比较，ANSWER-MARK-7731' },
];

let hw1 = 0;
test('布置作业带批改方式；评分标准助教去知识库找、加起来不等于满分时退回去改', async () => {
  hw1 = await assign('作业1');
  assert.equal(db.value('SELECT ai_mode FROM assignments WHERE id=?', hw1), 'release');
  script(
    { calls: [{ name: 'search_kb', args: { query: '作业1 答案' } }] },
    { calls: [{ name: 'save_rubric', args: { items: [{ ...RUBRIC[0] }, { ...RUBRIC[1], points: 5 }] } }] },
    { calls: [{ name: 'save_rubric', args: { items: RUBRIC } }] },
  );
  await rubric.draftRubric(hw1);
  const first = seen[seen.length - 3];
  assert.equal(first.purpose, 'grader:rubric');
  assert.deepEqual(first.tools, ['search_kb', 'read_kb', 'save_rubric']);
  assert.match(String(first.messages[1].content), /「计科5班」的作业「作业1」，满分 10 分/);
  assert.match(String(first.messages[1].content), /知识库/);
  assert.match(lastToolOut(seen[seen.length - 1].messages), /加起来是 9 分，满分是 10 分/);
  const r = await req(`/homework/${hw1}/rubric`);
  assert.equal(r.json.rubric.status, 'ready');
  assert.equal(r.json.rubric.source, 'ai');
  assert.deepEqual(
    r.json.rubric.items.map((x: any) => [x.title, x.points]),
    [
      ['第1题', 4],
      ['第2题', 6],
    ],
  );
  // 学生看不到评分标准（里面有答案）
  assert.equal((await req(`/homework/${hw1}/rubric`, undefined, 'zhang')).status, 403);
  // 老师改评分标准：加起来要等于满分
  const bad = await req(`/homework/${hw1}/rubric`, { items: [{ title: '整体', points: 8, criteria: '', answer: '' }] }, 'teacher', 'PUT');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /加起来是 8 分，满分是 10 分/);
});

test('学生一交就排上批；批完直接发：每项分、总分程序加、批注定位在原文里、学生看不到参考答案', async () => {
  await submit(hw1, 'zhang', 'print(sum(range(1,100)))\n\nm = 0\nfor x in a:\n    if x > m:\n        m = x');
  const row = db.get<any>('SELECT * FROM ai_grades WHERE assignment_id=? AND user_id=?', hw1, zhang);
  assert.equal(row.status, 'queued');
  assert.equal(row.auto_release, 1);
  // 学生那边：助教在批
  assert.equal((await req(`/homework/${hw1}`, undefined, 'zhang')).json.mine.grading, true);
  script({
    calls: [
      {
        name: 'submit_grade',
        args: {
          items: [
            { title: '第1题', got: 2.3, why: 'range 少算了 100' },
            { title: '第2题', got: 9, why: '思路对，代码对' },
          ],
          marks: [
            { quote: 'range(1,100)', kind: 'wrong', note: '右边界不包括 100' },
            { quote: 'if x > m:    m = x', kind: 'good', note: '比较写得清楚' },
            { quote: '不存在的一句话', kind: 'wrong', note: '找不到原文' },
          ],
          comment: '第2题写得好；第1题注意 range 的右边界。',
        },
      },
    ],
  });
  await jobs.drainGrades();
  const g = db.get<any>('SELECT * FROM ai_grades WHERE id=?', row.id);
  assert.equal(g.status, 'done');
  // 每项卡在满分以内、到 0.5：2.5 + 6 = 8.5
  assert.equal(g.score, 8.5);
  const sent = seen[seen.length - 1];
  assert.equal(sent.purpose, 'grader:grade');
  const input = String(sent.messages[1].content);
  assert.match(input, /评分标准：\n1\. 第1题（4 分）/);
  assert.match(input, /参考答案：sum\(range\(1,101\)\)/);
  assert.match(input, /学生交的：\nprint\(sum\(range\(1,100\)\)\)/);
  const s = await req(`/homework/${hw1}`, undefined, 'zhang');
  assert.equal(s.json.status, 'graded');
  const mine = s.json.mine;
  assert.equal(mine.score, 8.5);
  assert.equal(mine.gradedBy, 'ai');
  assert.deepEqual(
    mine.items.map((x: any) => [x.got, x.max]),
    [
      [2.5, 4],
      [6, 6],
    ],
  );
  assert.equal(mine.marks.length, 3);
  const [m1, m2, m3] = mine.marks;
  assert.equal(mine.workText.slice(m1.start, m1.end), 'range(1,100)');
  // 空格换行不一样也找得到
  assert.match(mine.workText.slice(m2.start, m2.end), /^if x > m:\s+m = x$/);
  assert.equal(m3.start, -1);
  assert.doesNotMatch(JSON.stringify(s.json), /ANSWER-MARK-7731|5050/);
  // 批了就锁了，跟老师批的一样
  assert.match(s.json.lock, /已经批改了/);
  // 老师那边：助教批的
  const t = await req(`/homework/${hw1}`);
  const row2 = t.json.students.find((x: any) => x.name === '张浩然');
  assert.equal(row2.gradedBy, 'ai');
  assert.equal(row2.ai.status, 'done');
  assert.equal(row2.ai.released, true);
});

test('助教判不了的留给老师看，不直接发；模型漏了项要它补', async () => {
  await submit(hw1, 'liu', '老师我不会');
  script(
    { calls: [{ name: 'submit_grade', args: { items: [{ title: '第1题', got: 0, why: '没做' }], comment: '没有作答' } }] },
    { calls: [{ name: 'submit_grade', args: { items: [{ title: '第1题', got: 0, why: '没做' }, { title: '第2题', got: 0, why: '没做' }], comment: '没有作答', flag: '交的内容跟题目无关' } }] },
  );
  await jobs.drainGrades();
  assert.match(lastToolOut(seen[seen.length - 1].messages), /「第2题」没给分/);
  const s = await req(`/homework/${hw1}`, undefined, 'liu');
  assert.equal(s.json.status, 'submitted');
  assert.equal(s.json.mine.score, null);
  const t = await req(`/homework/${hw1}/students/${ls}`);
  assert.equal(t.json.ai.flag, '交的内容跟题目无关');
  assert.equal(t.json.ai.released, false);
});

test('批完先给老师看：老师点发布才发；学生重交了旧的作废', async () => {
  const hw2 = await assign('作业2', 'hold');
  rubric.setRubric(hw2, RUBRIC);
  await submit(hw2, 'zhang', '第一版');
  await submit(hw2, 'zhang', '第二版：print(sum(range(1,101)))');
  const rows = db.all<any>('SELECT status, auto_release FROM ai_grades WHERE assignment_id=? ORDER BY id', hw2);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['stale', 'queued'],
  );
  assert.equal(rows[1].auto_release, 0);
  script({ calls: [{ name: 'submit_grade', args: { items: [{ title: '第1题', got: 4, why: '对' }, { title: '第2题', got: 0, why: '没做' }], comment: '第2题没做' } }] });
  await jobs.drainGrades();
  assert.equal(seen[seen.length - 1].messages[1].content.includes('第二版'), true);
  assert.equal((await req(`/homework/${hw2}`, undefined, 'zhang')).json.mine.score, null);
  const r = await req(`/homework/${hw2}/ai-release`, {});
  assert.equal(r.json.released, 1);
  const s = await req(`/homework/${hw2}`, undefined, 'zhang');
  assert.equal(s.json.mine.score, 4);
  assert.equal(s.json.mine.gradedBy, 'ai');
});

test('老师改一项：算老师批的；同一项助教给了一样分的其他学生，挑着一起改', async () => {
  await submit(hw1, 'chen', 'print(sum(range(1,100)))\n# 第2题没写');
  script({ calls: [{ name: 'submit_grade', args: { items: [{ title: '第1题', got: 2.5, why: 'range 少算了 100' }, { title: '第2题', got: 0, why: '没做' }], comment: '第2题没做' } }] });
  await jobs.drainGrades();
  // 老师觉得第1题这个错只扣 1 分：给张浩然改成 3 分
  const w = (await req(`/homework/${hw1}/students/${zs}`)).json;
  const items = w.submission.items.map((x: any, i: number) => (i === 0 ? { ...x, got: 3 } : x));
  const g = await req(`/homework/${hw1}/students/${zs}/grade`, { score: null, comment: w.submission.comment, items, aiGradeId: w.ai.id });
  assert.equal(g.json.score, 9);
  const after = (await req(`/homework/${hw1}/students/${zs}`)).json.submission;
  assert.equal(after.gradedBy, 'teacher');
  assert.equal(after.score, 9);
  // 改了的那一项注明老师改成了几分（助教原来写的扣分原因还在）
  assert.equal(after.items[0].why, 'range 少算了 100（老师改成 3 分）');
  assert.equal(after.items[1].why, '思路对，代码对');
  // 同一项助教也给了 2.5 的：陈子轩
  const same = await req(`/homework/${hw1}/same?sid=${zs}&item=0&from=2.5`);
  assert.deepEqual(
    same.json.students.map((x: any) => x.name),
    ['陈子轩'],
  );
  assert.match(same.json.students[0].why, /range 少算了 100/);
  const fix = await req(`/homework/${hw1}/same`, { item: 0, got: 3, sids: [cs] });
  assert.equal(fix.json.changed, 1);
  const c = (await req(`/homework/${hw1}/students/${cs}`)).json.submission;
  assert.equal(c.score, 3);
  assert.equal(c.items[0].got, 3);
  assert.equal(c.items[0].why, 'range 少算了 100（老师改成 3 分）');
  assert.equal(c.gradedBy, 'teacher');
  // 学生那边：老师批的，批注还在
  const mine = (await req(`/homework/${hw1}`, undefined, 'zhang')).json.mine;
  assert.equal(mine.gradedBy, 'teacher');
  assert.equal(mine.marks.length, 3);
});

test('哪几份很像：程序比，题目里的字不算', async () => {
  const hw3 = await assign('作业3', 'off');
  const body = '我的做法：先用一个变量 best 记住目前最大的数，然后挨个看列表里的每一个数，比 best 大就换掉，最后输出 best，顺便统计一共比较了多少次并打印出来';
  await submit(hw3, 'zhang', body);
  await submit(hw3, 'liu', body.replace('best', 'big'));
  await submit(hw3, 'chen', '求和用 sum 函数，最大值用 max 函数，两行就写完了，非常简单，没有什么难的地方，下次希望多一点题目');
  // 不用助教批：交了不排
  assert.equal(db.value('SELECT count(*) FROM ai_grades WHERE assignment_id=?', hw3), 0);
  const r = await req(`/homework/${hw3}/students/${zs}/similar`);
  assert.equal(r.json.similar.length, 1);
  assert.equal(r.json.similar[0].name, '刘欣怡');
  assert.ok(r.json.similar[0].ratio >= 70);
  assert.equal((await req(`/homework/${hw3}/students/${cs}/similar`)).json.similar.length, 0);
});

test('讲评：数字程序算，助教写常见问题；发给学生的不带名字、进资料包；能下载 Word', async () => {
  script({
    calls: [
      {
        name: 'save_review',
        args: {
          summary: '大部分同学第2题思路清楚，第1题 range 边界错得多。',
          errors: [
            { title: 'range 右边界', item: 1, students: ['张浩然', '陈子轩', '不在班里的人'], why: 'range 不包括右边界', teach: '画数轴讲 range', example: 'range(1,100)' },
            { title: '第2题没做', item: 2, students: ['陈子轩'], why: '陈子轩的第2题空着', teach: '提醒', example: '' },
          ],
          good: [{ student: '张浩然', why: '第2题写得清楚' }],
          next: '下节课先讲 range',
        },
      },
    ],
  });
  await review.writeReview(hw1);
  const input = String(seen[seen.length - 1].messages[1].content);
  assert.match(input, /张浩然 9 分；第1项 3\/4/);
  assert.match(input, /批注里划出的问题：\n- 张浩然：「range\(1,100\)」→ 右边界不包括 100/);
  const r = (await req(`/homework/${hw1}/review`)).json.review;
  assert.equal(r.status, 'ready');
  assert.equal(r.stats.submitted, 3);
  assert.equal(r.stats.graded, 2);
  assert.equal(r.stats.avg, 6);
  assert.deepEqual(r.write.errors[0].students, ['张浩然', '陈子轩']);
  assert.deepEqual(r.stats.missing, []);
  // 学生还看不到
  assert.equal((await req(`/homework/${hw1}`, undefined, 'zhang')).json.studentReview, null);
  await req(`/homework/${hw1}/review/share`, { on: true });
  const s = (await req(`/homework/${hw1}`, undefined, 'liu')).json.studentReview;
  assert.equal(s.errors[0].title, 'range 右边界');
  assert.equal(s.errors[0].n, 2);
  assert.doesNotMatch(JSON.stringify(s), /张浩然|陈子轩|画数轴/);
  // 助教写的原因里点了名：学生那一版换成「有同学」
  assert.equal(s.errors[1].why, '有同学的第2题空着');
  assert.match(pack.renderPack(k5), /「作业1」讲评[\s\S]*range 右边界（2 人）/);
  const doc = await req(`/homework/${hw1}/review/docx`);
  assert.equal(doc.status, 200);
  const bytes = Buffer.from(await doc.res.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  // 别的老师看不了
  assert.equal((await req(`/homework/${hw1}/review`, undefined, 'other')).status, 404);
});

test('原文定位：原样找、不管空白找', () => {
  assert.deepEqual(locate('ab  cd\nef', 'cd ef'), { start: 4, end: 9 });
  assert.equal(locate('abc', 'xyz'), null);
});

test('满分改了评分标准跟着按比例改', async () => {
  await req(`/homework/${hw1}`, { points: 20 }, 'teacher', 'PATCH');
  const items = rubric.rubricOf(hw1)!.items;
  assert.deepEqual(
    items.map((x) => x.points),
    [8, 12],
  );
});

test('跟助教说：让助教批、看讲评（写完再回老师）', async () => {
  const { runTaTool } = await import('../src/assistant/tools.js');
  const runId = db.insert('kb_runs', { teacher_id: teacher, agent: 'ta', kind: 'chat', status: 'running', request: '把作业4批了', created_by: teacher, created_at: Date.now() });
  const ctx = { user: { id: teacher, name: '王建国' }, ref: { teacherId: teacher, runId, kbId: null }, startJob: () => 0 };
  const call = (name: string, args: Record<string, unknown>) => runTaTool(ctx, { id: `c-${randomUUID().slice(0, 6)}`, name, args, raw: JSON.stringify(args) });
  const hw4 = await assign('作业4', 'off');
  rubric.setRubric(hw4, RUBRIC);
  await submit(hw4, 'zhang', 'print(5050)');
  await submit(hw4, 'liu', 'print(4950)');
  // 不用助教批的：交了不排；老师说了才批
  assert.equal(db.value('SELECT count(*) FROM ai_grades WHERE assignment_id=?', hw4), 0);
  const r = await call('grade_homework', { homework: '作业4' });
  assert.equal(r.ok, true);
  assert.match(r.content, /开始批「作业4」：「计科5班」2 份/);
  script(
    { calls: [{ name: 'submit_grade', args: { items: [{ title: '第1题', got: 4, why: '对' }, { title: '第2题', got: 0, why: '没做' }], comment: '第2题没做' } }] },
    { calls: [{ name: 'submit_grade', args: { items: [{ title: '第1题', got: 2, why: '少了100' }, { title: '第2题', got: 0, why: '没做' }], comment: '第1题再看看' } }] },
  );
  await jobs.drainGrades();
  // 不用助教批的作业：老师让批的，批完先给老师看
  const d = await call('homework_detail', { homework: '作业4' });
  assert.match(d.content, /老师自己批/);
  assert.match(d.content, /待批 2：张浩然，助教拟了 4 分等发布、刘欣怡，助教拟了 2 分等发布/);
  await req(`/homework/${hw4}/ai-release`, {});
  script({ calls: [{ name: 'save_review', args: { summary: '第2题大家都没做', errors: [{ title: '第2题没做', item: 2, students: ['张浩然', '刘欣怡'], why: '没看到第2题', teach: '提醒看全题目' }], next: '讲第2题' } }] });
  const v = await call('homework_review', { homework: '作业4', share: true });
  assert.equal(v.ok, true, v.content);
  assert.match(v.content, /班里 3 人，交了 2 人，批了 2 份，平均 3 分（满分 10）/);
  assert.match(v.content, /1\. 第2题没做（2 人：张浩然、刘欣怡）；怎么讲：提醒看全题目/);
  assert.match(v.content, /学生那边已经能看到/);
  assert.equal((await req(`/homework/${hw4}`, undefined, 'liu')).json.studentReview.errors[0].n, 2);
  // 卡片：看讲评、下载 Word
  const card = db.get<any>("SELECT data FROM ta_actions WHERE kind='homework.review' ORDER BY id DESC LIMIT 1");
  assert.match(card.data, /review\/docx/);
});

test('交上来的每一条按名字对上评分标准的那一项：小项当成大题交的不算，要照评分标准的名字交', () => {
  // 2026-11-16 线上演示班：第1题底下有（1）（2）（3）小项，助教按「第几项」交，把三个小项交成了三道题
  const items = [
    { title: '第1题 用for循环求1到100的和', points: 30, criteria: '（1）for 结构 10 分（2）累加 10 分（3）range 边界 7 分（4）输出 3 分', answer: '' },
    { title: '第2题 输出100以内所有的偶数', points: 30, criteria: '', answer: '' },
    { title: '第3题 用双重循环打印九九乘法表', points: 40, criteria: '', answer: '' },
  ];
  assert.throws(
    () =>
      cleanResult(
        { items: [{ title: '第1题（1）for 结构', got: 10, why: '对' }, { title: '第1题（2）累加', got: 10, why: '对' }, { title: '第1题（3）range 边界', got: 7, why: '对' }], comment: '' },
        items,
        '',
      ),
    /「第1题 用for循环求1到100的和」、「第2题 输出100以内所有的偶数」、「第3题 用双重循环打印九九乘法表」没给分/,
  );
  // 名字照抄（标点、空格不同也算）、只写了开头的「第3题」也对得上；顺序乱了照名字放回原位
  const r = cleanResult(
    {
      items: [
        { title: '第3题', got: 20, why: '内层循环写成了矩形' },
        { title: '第1题：用 for 循环求 1 到 100 的和', got: 30, why: '都对' },
        { title: '第2题 输出100以内所有的偶数', got: 30, why: '都对' },
      ],
      comment: '',
    },
    items,
    '',
  );
  assert.deepEqual(
    r.items.map((x) => [x.title, x.got]),
    [
      ['第1题 用for循环求1到100的和', 30],
      ['第2题 输出100以内所有的偶数', 30],
      ['第3题 用双重循环打印九九乘法表', 20],
    ],
  );
  assert.equal(r.score, 80);
});

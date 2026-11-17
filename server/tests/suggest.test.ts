import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-suggest-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
// 批改、写资料包、看一眼都不在后台自己跑：模型回答是排好的，看一眼由测试直接调 checkSuggestions
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
process.env.CT_SUGGEST_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const model = await import('../src/assistant/model.js');
const suggest = await import('../src/assistant/suggest.js');
const spec = await import('../src/assistant/specialists.js');
const rubric = await import('../src/grading/rubric.js');
const jobs = await import('../src/grading/jobs.js');
const app = createApp();

const user = (name: string, role = 'teacher') =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
const cookies = new Map<number, string>();
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  cookies.set(uid, `ct_sid=${token}`);
}
async function req(uid: number, path: string, body?: unknown) {
  const res = await app.request('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: cookies.get(uid)!, 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? ((await res.json()) as any) : null };
}

/** 写好的模型回答，一步一个；记下每一步是谁在调、为了什么、发了什么、给了哪些工具 */
type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };
const queue: Reply[] = [];
const seen: { agent: string; purpose?: string; userId: number; messages: any[]; tools: string[]; waitMs?: number }[] = [];
model.setModelStep(async (o) => {
  seen.push({ agent: o.agent, purpose: o.purpose, userId: o.userId, messages: o.messages, tools: o.tools.map((t) => t.name), waitMs: o.waitMs });
  const s = queue.shift();
  if (!s) throw new Error('模型回答写少了');
  return { text: s.text || '', toolCalls: (s.calls || []).map((c, i) => ({ id: `call_${randomUUID().slice(0, 8)}_${i}`, name: c.name, args: c.args, raw: JSON.stringify(c.args) })) };
});
const script = (...steps: Reply[]) => queue.push(...steps);
const text = (m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
const looks = (uid: number) => seen.filter((x) => x.purpose === 'ta:suggest' && x.userId === uid);

async function settled(runId: number) {
  for (let i = 0; i < 250; i++) {
    const r = db.get<any>('SELECT status FROM kb_runs WHERE id=?', runId);
    if (r && r.status !== 'running' && r.status !== 'queued') return r.status as string;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('这一轮一直没结束');
}

const day = 86400_000;
const RUBRIC = [
  { title: '第1题', points: 4, criteria: '结果对给 4 分', answer: 'sum(range(1,101)) = 5050' },
  { title: '第2题', points: 6, criteria: '思路对 3 分，代码对 3 分', answer: '用 for 循环逐个比较' },
];

/** 一位老师、一个班、八个学生（都能登录交作业） */
async function teacherWorld(name: string) {
  const teacher = user(name);
  cookie(teacher);
  const k = (await req(teacher, '/classes', { name: '计科5班' })).json.id as number;
  const students: { uid: number; sid: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const uid = user(`学生${i + 1}`, 'student');
    cookie(uid);
    const sid = db.insert('class_students', { class_id: k, student_no: `20230${i + 1}`, name: `学生${i + 1}`, user_id: uid, in_roster: 0, joined_at: Date.now(), created_at: Date.now() });
    students.push({ uid, sid });
  }
  /** 布置一份作业，前 n 个学生交了，助教都批了（第1题 4 分，第2题 3 分） */
  async function graded(title: string, n: number) {
    const r = await req(teacher, '/homework', {
      classIds: [k],
      title,
      body: '第1题：求1到100的和；第2题：找列表最大值',
      points: 10,
      dueAt: Date.now() + 3 * day,
      allowLate: true,
      publishAt: null,
      fileIds: [],
      aiMode: 'release',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const hw = r.json.ids[0] as number;
    rubric.setRubric(hw, RUBRIC);
    for (const s of students.slice(0, n)) assert.equal((await req(s.uid, `/homework/${hw}/submit`, { text: 'for i in range(1,100): ...', fileIds: [] })).status, 200);
    for (let i = 0; i < n; i++) script({ calls: [{ name: 'submit_grade', args: { items: { 第1题: { got: 4, why: '对' }, 第2题: { got: 3, why: '循环边界写错，代码分全扣' } }, comment: '注意边界' } }] });
    await jobs.drainGrades();
    return hw;
  }
  /** 老师改一个学生某一项的分（照页面上抽屉里改分的那个接口） */
  async function fix(hw: number, who: number, item: number, got: number, why?: string) {
    const w = (await req(teacher, `/homework/${hw}/students/${students[who].sid}`)).json;
    const items = w.submission.items.map((x: any, i: number) => (i === item ? { ...x, got, ...(why ? { why } : {}) } : x));
    const r = await req(teacher, `/homework/${hw}/students/${students[who].sid}/grade`, { score: null, comment: w.submission.comment, items, aiGradeId: w.ai.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const say = async (message: string) => {
    const r = await req(teacher, '/keeper/messages', { message });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { runId: r.json.runId as number, status: await settled(r.json.runId) };
  };
  return { teacher, k, students, graded, fix, say };
}

/** 卡片上那一条 ask 记录 */
const cardOf = (runId: number) => JSON.parse(db.value<string>("SELECT data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", runId)!);
/** 助教那边一共几轮（老师每天的句数数的就是这个，卡片不算） */
const turns = (uid: number) => db.value<number>("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND agent='ta' AND kind<>'suggest'", uid);
const SUGGEST_1 = {
  question: '练习一第2题您改了好几份，要不要分一个专门助手照您的扣分批？',
  name: '练习一批改',
  duty: '批计科5班的练习一',
  guide: '第2题思路对、只错边界的扣 1 分',
  homework: '练习一',
};

test('改分到数了才看一眼：看一眼单独调一次模型，弹出提议卡片；老师接着说别的卡片还在，助教每轮看得到这条提议；挂着一张时不再弹第二张', async () => {
  const w = await teacherWorld('王建国');
  const hw = await w.graded('练习一', 5);
  await w.fix(hw, 0, 1, 5, '思路对，边界错扣 1 分就够');
  await w.fix(hw, 1, 1, 5, '思路对，边界错扣 1 分就够');
  // 两份还不够数：不看
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 0);

  await w.fix(hw, 2, 1, 5, '边界错只扣 1 分');
  const before = turns(w.teacher);
  script({ calls: [{ name: 'suggest_specialist', args: SUGGEST_1 }] });
  const p = (await suggest.checkSuggestions(w.teacher))!;
  assert.ok(p, '到数了应该提');
  const [look] = looks(w.teacher);
  assert.equal(look.agent, 'ta');
  assert.deepEqual(look.tools, ['suggest_specialist']);
  // 后台的活：主模型忙的时候多等一会儿再换备用的
  assert.equal(look.waitMs, 300_000);
  // 给它的说明里没有数目（数目只用来决定什么时候看）
  assert.doesNotMatch(text(look.messages[0]), /\d/);
  const digest = text(look.messages[1]);
  assert.match(digest, /「练习一」（计科5班）：助教批了 5 份，老师改了 3 份/);
  assert.match(digest, /- 第2题：助教给 3 分，老师改成 5 分。助教写的：循环边界写错，代码分全扣。老师写的：思路对，边界错扣 1 分就够（2 份）/);
  assert.match(digest, /老师写的：边界错只扣 1 分/);
  assert.doesNotMatch(digest, /学生来问|老师跟你说的|专门助手/);

  // 卡片：老师现在那段会话里的一轮（kind=suggest，在等老师），问题是它写的那句话，选项固定，带上提议的名字和管什么
  const card = db.get<any>('SELECT * FROM kb_runs WHERE id=?', p.card_run_id);
  assert.equal(card.agent, 'ta');
  assert.equal(card.kind, 'suggest');
  assert.equal(card.status, 'waiting');
  assert.equal(card.session_id, db.value('SELECT max(id) FROM ta_sessions WHERE owner_id=?', w.teacher) ?? null);
  const ask = cardOf(card.id);
  assert.deepEqual(ask.questions, [{ question: SUGGEST_1.question, options: ['分出来', '先不用'], multiple: false }]);
  assert.deepEqual(ask.suggest, { id: p.id, name: '练习一批改', duty: '批计科5班的练习一' });
  // 看一眼不占老师每天的句数：助教那边没有多出一轮
  assert.equal(turns(w.teacher), before);
  // 记账：数到几、为什么看、提了什么
  const row = db.get<any>('SELECT * FROM specialist_suggestions WHERE id=?', p.id);
  assert.deepEqual(JSON.parse(row.subjects), { [`grade:${hw}`]: 3 });
  assert.equal(row.due, `grade:${hw}`);
  assert.equal(row.status, 'waiting');
  assert.equal(row.homework_id, hw);
  assert.equal(row.guide, SUGGEST_1.guide);
  // 页面上看得到
  const runs = (await req(w.teacher, '/keeper/runs')).json.runs;
  assert.ok(runs.some((r: any) => r.id === card.id && r.kind === 'suggest' && r.status === 'waiting'));

  // 老师接着说别的：卡片不收起来；助教这一轮看得到还没答的提议
  script({ text: '计科5班有 8 个学生' });
  await w.say('计科5班有几个人');
  assert.equal(db.value('SELECT status FROM kb_runs WHERE id=?', card.id), 'waiting');
  const ta = seen.filter((x) => x.agent === 'ta' && x.purpose !== 'ta:suggest').pop()!;
  assert.match(
    text(ta.messages.at(-1)),
    /（你提议分出专门助手「练习一批改」，管：批计科5班的练习一；做法：第2题思路对、只错边界的扣 1 分；交给它批：「练习一」（计科5班），老师还没答）\n计科5班有几个人/,
  );

  // 挂着这一张：另一份作业也改到数了，不看、不弹第二张
  const hw2 = await w.graded('练习二', 3);
  for (const who of [0, 1, 2]) await w.fix(hw2, who, 0, 3);
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 1);
  assert.equal(db.value("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND kind='suggest' AND status='waiting'", w.teacher), 1);
});

test('点「分出来」：助教接着办，调 new_specialist，作业交给它批；卡片收起来，账上记分出来的是哪个。交给专门助手批的作业再改分也不看', async () => {
  const w = await teacherWorld('李老师');
  const hw = await w.graded('练习一', 6);
  for (const who of [0, 1, 2]) await w.fix(hw, who, 1, 5, '边界错扣 1 分就够');
  script({ calls: [{ name: 'suggest_specialist', args: SUGGEST_1 }] });
  const p = (await suggest.checkSuggestions(w.teacher))!;

  script({ calls: [{ name: 'new_specialist', args: { name: '练习一批改', duty: '批计科5班的练习一', guide: '第2题思路对、只错边界的扣 1 分', homework: '练习一' } }] }, { text: '分好了' });
  const r = await req(w.teacher, `/keeper/runs/${p.card_run_id}/answer`, { answers: [{ picks: ['分出来'] }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await settled(r.json.runId), 'done');
  // 给助教的话里带着它提的是什么、老师怎么答的
  const first = seen.filter((x) => x.agent === 'ta' && x.purpose !== 'ta:suggest').at(-2)!;
  assert.match(
    text(first.messages.at(-1)),
    /（你提议分出专门助手「练习一批改」，管：批计科5班的练习一；做法：第2题思路对、只错边界的扣 1 分；交给它批：「练习一」（计科5班））\n老师在卡片上答：分出来$/,
  );
  const s = db.get<any>("SELECT * FROM specialists WHERE teacher_id=? AND name='练习一批改'", w.teacher);
  assert.ok(s);
  assert.equal(db.value('SELECT specialist_id FROM assignments WHERE id=?', hw), s.id);
  const row = db.get<any>('SELECT * FROM specialist_suggestions WHERE id=?', p.id);
  assert.equal(row.status, 'accepted');
  assert.equal(row.answer, '分出来');
  assert.equal(row.specialist_id, s.id);
  assert.equal(db.value('SELECT status FROM kb_runs WHERE id=?', p.card_run_id), 'done');
  assert.deepEqual(cardOf(p.card_run_id!).answered, [{ q: SUGGEST_1.question, a: '分出来' }]);
  // 页面上在卡片上答的那一轮不摆老师的气泡（跟别的卡片一样记了 answer）
  assert.ok(db.get("SELECT id FROM kb_events WHERE run_id=? AND type='answer'", r.json.runId));

  // 这份作业交给专门助手批了：老师再改三份，程序不再数它
  for (const who of [3, 4, 5]) await w.fix(hw, who, 0, 3);
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 1);
});

test('点「先不用」：同一份作业再改分也不再问；别的事数到了再看，它提回这份作业程序也拦下', async () => {
  const w = await teacherWorld('赵老师');
  const hw = await w.graded('练习一', 6);
  for (const who of [0, 1, 2]) await w.fix(hw, who, 1, 5, '边界错扣 1 分就够');
  script({ calls: [{ name: 'suggest_specialist', args: SUGGEST_1 }] });
  const p = (await suggest.checkSuggestions(w.teacher))!;

  script({ text: '好的，先不分' });
  const r = await req(w.teacher, `/keeper/runs/${p.card_run_id}/answer`, { answers: [{ picks: ['先不用'] }] });
  assert.equal(await settled(r.json.runId), 'done');
  assert.match(text(seen.filter((x) => x.agent === 'ta' && x.purpose !== 'ta:suggest').pop()!.messages.at(-1)), /老师在卡片上答：先不用$/);
  assert.equal(db.value('SELECT status FROM specialist_suggestions WHERE id=?', p.id), 'declined');
  assert.equal(db.value('SELECT count(*) FROM specialists WHERE teacher_id=?', w.teacher), 0);

  // 同一份作业又改了三份：不看
  for (const who of [3, 4, 5]) await w.fix(hw, who, 1, 5, '边界错扣 1 分就够');
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 1);

  // 老师跟助教说的话数到了：看一眼，摘要里没有这份作业的改分，有老师说过不用的提议；它还是提这份作业，程序告诉它不行
  const t = Date.now();
  for (let i = 0; i < 15; i++)
    db.insert('kb_runs', { teacher_id: w.teacher, agent: 'ta', kind: 'chat', status: 'done', request: `第 ${i + 1} 句交代`, created_by: w.teacher, created_at: t - (15 - i) * 60_000 });
  script({ calls: [{ name: 'suggest_specialist', args: { ...SUGGEST_1, name: '练习一阅卷' } }] }, { text: '那就不提了' });
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  const [, look, retry] = looks(w.teacher);
  const digest = text(look.messages[1]);
  assert.doesNotMatch(digest, /老师改了助教批的分/);
  // 在卡片上点的「先不用」那一轮不算老师交代的
  assert.match(digest, /老师跟你说的：\n- .+：第 1 句交代\n(- .+\n){13}- .+：第 15 句交代\n\n/);
  assert.match(digest, /老师说过不用的：\n- 「练习一批改」管：批计科5班的练习一；批：「练习一」（计科5班）/);
  assert.match(text(retry.messages.at(-1)), /^没提成：老师说过「练习一」不用分$/);
  const row = db.get<any>("SELECT * FROM specialist_suggestions WHERE teacher_id=? ORDER BY id DESC LIMIT 1", w.teacher);
  assert.equal(row.status, 'none');
  assert.equal(row.reply, '那就不提了');
  assert.equal(db.value("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND kind='suggest' AND status='waiting'", w.teacher), 0);
});

test('已经交给专门助手批的作业：改分不数，不看', async () => {
  const w = await teacherWorld('钱老师');
  const s = spec.createSpecialist(w.teacher, { name: '作业批改', duty: '批计科5班的作业', guide: '照评分标准' });
  const hw = await w.graded('练习一', 0);
  db.run('UPDATE assignments SET specialist_id=? WHERE id=?', s.id, hw);
  for (const who of [0, 1, 2]) assert.equal((await req(w.students[who].uid, `/homework/${hw}/submit`, { text: 'print(1)', fileIds: [] })).status, 200);
  for (let i = 0; i < 3; i++) script({ calls: [{ name: 'submit_grade', args: { items: { 第1题: { got: 4, why: '对' }, 第2题: { got: 3, why: '边界错' } }, comment: '注意边界' } }] });
  await jobs.drainGrades();
  assert.equal(seen.filter((x) => x.purpose === 'specialist:grade').length, 3);
  for (const who of [0, 1, 2]) await w.fix(hw, who, 1, 5, '边界错扣 1 分就够');
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 0);
});

test('早就改完的作业（最近 30 天老师没再改过）不数', async () => {
  const w = await teacherWorld('郑老师');
  const hw = await w.graded('练习一', 3);
  for (const who of [0, 1, 2]) await w.fix(hw, who, 1, 5, '边界错扣 1 分就够');
  db.run('UPDATE submissions SET updated_at=? WHERE assignment_id=?', Date.now() - 40 * day, hw);
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 0);
});

test('卡片还挂着，老师在对话里说分：助教调 new_specialist 分出来了，卡片收起来；分的是别的就不动卡片', async () => {
  const w = await teacherWorld('孙老师');
  const hw = await w.graded('练习一', 3);
  for (const who of [0, 1, 2]) await w.fix(hw, who, 1, 5, '边界错扣 1 分就够');
  script({ calls: [{ name: 'suggest_specialist', args: SUGGEST_1 }] });
  const p = (await suggest.checkSuggestions(w.teacher))!;

  // 分了一个不相干的：卡片还挂着
  script({ calls: [{ name: 'new_specialist', args: { name: '项目答疑', duty: '回答期末项目的问题', guide: '照项目说明答' } }] }, { text: '分好了' });
  await w.say('分一个专门回答期末项目问题的助手');
  assert.equal(db.value('SELECT status FROM kb_runs WHERE id=?', p.card_run_id), 'waiting');

  script({ calls: [{ name: 'new_specialist', args: { name: '练习一批改', duty: '批计科5班的练习一', guide: '第2题思路对、只错边界的扣 1 分', homework: '练习一' } }] }, { text: '分好了' });
  await w.say('那个分了吧');
  assert.equal(db.value('SELECT status FROM kb_runs WHERE id=?', p.card_run_id), 'done');
  assert.deepEqual(cardOf(p.card_run_id!).answered, [{ q: SUGGEST_1.question, a: '分出来' }]);
  const row = db.get<any>('SELECT * FROM specialist_suggestions WHERE id=?', p.id);
  assert.equal(row.status, 'accepted');
  assert.equal(row.answer, '那个分了吧');
  assert.equal(row.specialist_id, db.value("SELECT id FROM specialists WHERE teacher_id=? AND name='练习一批改'", w.teacher));
  // 收起来以后助教那边不再带这条提议
  script({ text: '好' });
  await w.say('好');
  assert.doesNotMatch(text(seen.filter((x) => x.agent === 'ta' && x.purpose !== 'ta:suggest').pop()!.messages.at(-1)), /你提议分出/);
});

test('学生来问、老师交代的事：最近 30 天数到了才看，以后每多一截再看；在卡片上点的不算交代；一次只提一个', async () => {
  const w = await teacherWorld('周老师');
  const t = Date.now();
  const chat = (request: string, at: number) =>
    db.insert('kb_runs', { teacher_id: w.teacher, agent: 'ta', kind: 'chat', status: 'done', request, created_by: w.teacher, created_at: at });
  // 一个多月以前的不算
  for (let i = 0; i < 20; i++) chat(`很早以前的第 ${i + 1} 句`, t - 40 * day);
  for (let i = 0; i < 14; i++) chat(`给计科5班写本周学习提醒（第 ${i + 1} 次）`, t - (20 - i) * day);
  // 在卡片上点的不算
  const answered = chat('分出来', t - 3600_000);
  db.insert('kb_events', { run_id: answered, type: 'answer', data: { askRunId: 1 }, created_at: t });
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 0);

  chat('给计科5班写本周学习提醒（第 15 次）', t - 60_000);
  script({ text: '这些交代各不相同，不用分' });
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  let [look] = looks(w.teacher);
  const digest = text(look.messages[1]);
  assert.match(digest, /老师跟你说的：\n- .+：给计科5班写本周学习提醒（第 1 次）/);
  assert.doesNotMatch(digest, /很早以前|分出来|学生来问/);
  assert.equal(db.value("SELECT status FROM specialist_suggestions WHERE teacher_id=? ORDER BY id DESC LIMIT 1", w.teacher), 'none');

  // 看过以后又说了 14 句：不看；第 15 句：看
  const later = Date.now() + 1000;
  for (let i = 0; i < 14; i++) chat(`又一句交代 ${i + 1}`, later + i);
  assert.equal(await suggest.checkSuggestions(w.teacher), null);
  assert.equal(looks(w.teacher).length, 1);
  chat('又一句交代 15', later + 14);

  // 学生来问、老师回了的：4 件
  const k = w.k;
  for (let i = 0; i < 4; i++)
    db.insert('student_asks', {
      student_id: w.students[i].uid,
      class_id: k,
      teacher_id: w.teacher,
      question: `期末项目第 ${i + 1} 个问题`,
      status: 'replied',
      reply: `老师的回复：第 ${i + 1} 个回答`,
      created_at: Date.now(),
      answered_at: Date.now(),
      replied_at: Date.now(),
    });
  // 它一次调了两回：只弹一张卡片
  script({
    calls: [
      { name: 'suggest_specialist', args: { question: '要不要分一个专门助手回答期末项目的问题？', name: '项目答疑', duty: '回答学生关于期末项目的问题', guide: '照老师回过的答' } },
      { name: 'suggest_specialist', args: { question: '要不要分一个写学习提醒的助手？', name: '学习提醒', duty: '写每周学习提醒', guide: '照老师的格式写' } },
    ],
  });
  const p = (await suggest.checkSuggestions(w.teacher))!;
  look = looks(w.teacher)[1];
  const d2 = text(look.messages[1]);
  assert.match(d2, /学生来问、老师回了的：\n- 计科5班的学生问：期末项目第 1 个问题；老师回：老师的回复：第 1 个回答/);
  assert.match(d2, /老师跟你说的：/);
  assert.equal(p.name, '项目答疑');
  assert.equal(p.homework_id, null);
  assert.deepEqual(JSON.parse(p.subjects), { asks: 4, chat: 30 });
  assert.equal(p.due, 'asks,chat');
  assert.equal(db.value("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND kind='suggest'", w.teacher), 1);
});

test('连着改好几份只看一次：等一会儿没新动静再看；同一个老师同一时间只看一次；挂着的卡片在以前的会话里，提了新的就换掉它', async () => {
  const w = await teacherWorld('吴老师');
  const hw = await w.graded('练习一', 6);
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  // 同一时间叫两次：是同一次
  const a = suggest.checkSuggestions(w.teacher),
    b = suggest.checkSuggestions(w.teacher);
  assert.equal(a, b);
  await a;

  // 连着改了六份（改分的接口每份都叫一下）：中间数到三份时不看，等没新动静了才看，只看一次，看的时候是六份
  suggest.setSuggestAuto(true, 1000);
  try {
    script({ calls: [{ name: 'suggest_specialist', args: SUGGEST_1 }] });
    for (const who of [0, 1, 2, 3, 4, 5]) await w.fix(hw, who, 1, 5, '边界错扣 1 分就够');
    assert.equal(looks(w.teacher).length, 0);
    for (let i = 0; i < 200 && !looks(w.teacher).length; i++) await sleep(20);
    await sleep(300);
    assert.equal(looks(w.teacher).length, 1);
  } finally {
    suggest.setSuggestAuto(false);
  }
  const old = db.get<any>("SELECT * FROM specialist_suggestions WHERE teacher_id=? AND status='waiting'", w.teacher);
  assert.ok(old);
  assert.deepEqual(JSON.parse(old.subjects), { [`grade:${hw}`]: 6 });

  // 老师开了新会话，卡片在以前那段里没答；又数到了：看一眼，提了新的就把以前那张换掉
  const fresh = (await req(w.teacher, '/keeper/sessions', {})).json.id as number;
  assert.ok(fresh);
  const t = Date.now();
  for (let i = 0; i < 15; i++)
    db.insert('kb_runs', { teacher_id: w.teacher, agent: 'ta', kind: 'chat', status: 'done', request: `交代 ${i + 1}`, created_by: w.teacher, created_at: t - i * 1000 });
  script({ calls: [{ name: 'suggest_specialist', args: { ...SUGGEST_1, question: '还是想问您：要不要分一个专门助手批练习一？' } }] });
  const p = (await suggest.checkSuggestions(w.teacher))!;
  assert.equal(db.value('SELECT session_id FROM kb_runs WHERE id=?', p.card_run_id), fresh);
  assert.equal(db.value('SELECT status FROM specialist_suggestions WHERE id=?', old.id), 'expired');
  assert.equal(db.value('SELECT status FROM kb_runs WHERE id=?', old.card_run_id), 'done');
  assert.equal(cardOf(old.card_run_id).skipped, true);
  assert.equal(db.value("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND kind='suggest' AND status='waiting'", w.teacher), 1);
});

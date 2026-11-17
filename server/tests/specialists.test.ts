import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-specialists-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
// 批改、写资料包不在后台自己跑（这里的模型回答是排好的）
process.env.CT_GRADE_AUTO = '0';
// 助教看一眼要不要分专门助手也不在后台自己跑（会用掉排好的模型回答）
process.env.CT_SUGGEST_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const model = await import('../src/assistant/model.js');
const spec = await import('../src/assistant/specialists.js');
const { runHelper } = await import('../src/assistant/helper.js');
const rubric = await import('../src/grading/rubric.js');
const jobs = await import('../src/grading/jobs.js');
const app = createApp();

const user = (name: string, role = 'teacher') =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
const teacher = user('王建国'),
  other = user('李老师'),
  zhang = user('张浩然', 'student'),
  liu = user('刘欣怡', 'student');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies: Record<string, string> = { teacher: cookie(teacher), other: cookie(other), zhang: cookie(zhang), liu: cookie(liu) };
async function req(path: string, body?: unknown, who = 'teacher', method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? ((await res.json()) as any) : null };
}

/** 写好的模型回答，一步一个；记下每一步是谁在调、发了什么、给了哪些工具 */
type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };
const queue: Reply[] = [];
const seen: { agent: string; messages: any[]; tools: string[]; purpose?: string }[] = [];
model.setModelStep(async (o) => {
  seen.push({ agent: o.agent, messages: o.messages, tools: o.tools.map((t) => t.name), purpose: o.purpose });
  const s = queue.shift();
  if (!s) throw new Error('模型回答写少了');
  return { text: s.text || '', toolCalls: (s.calls || []).map((c, i) => ({ id: `call_${randomUUID().slice(0, 8)}_${i}`, name: c.name, args: c.args, raw: JSON.stringify(c.args) })) };
});
const script = (...steps: Reply[]) => queue.push(...steps);
const text = (m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

async function settled(runId: number) {
  for (let i = 0; i < 250; i++) {
    const r = db.get<any>('SELECT status FROM kb_runs WHERE id=?', runId);
    if (r && r.status !== 'running' && r.status !== 'queued') return r.status as string;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('这一轮一直没结束');
}
const say = async (message: string) => {
  const r = await req('/keeper/messages', { message });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { runId: r.json.runId as number, status: await settled(r.json.runId) };
};

const k5 = (await req('/classes', { name: '计科5班' })).json.id as number;
const enroll = (uid: number, no: string, name: string) =>
  db.insert('class_students', { class_id: k5, student_no: no, name, user_id: uid, in_roster: 0, joined_at: Date.now(), created_at: Date.now() });
const zs = enroll(zhang, '2023001', '张浩然');
enroll(liu, '2023002', '刘欣怡');
const day = 86400_000;
async function assign(title: string) {
  const r = await req('/homework', { classIds: [k5], title, body: '第1题：求1到100的和；第2题：找列表最大值', points: 10, dueAt: Date.now() + 3 * day, allowLate: true, publishAt: null, fileIds: [], aiMode: 'release' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.ids[0] as number;
}
const RUBRIC = [
  { title: '第1题', points: 4, criteria: '结果对给 4 分', answer: 'sum(range(1,101)) = 5050' },
  { title: '第2题', points: 6, criteria: '思路对 3 分，代码对 3 分', answer: '用 for 循环逐个比较' },
];

test('助教分出专门助手：管什么、怎么办存好，交给它批的作业记上；老师那边看得到；撤回就停用、作业改回助教批', async () => {
  const hw = await assign('练习一');
  script(
    {
      calls: [
        { name: 'new_specialist', args: { name: '练习批改', duty: '批计科5班的练习', guide: '照评分标准逐题给分，格式不对扣 1 分', homework: '练习一' } },
      ],
    },
    { text: '分好了' },
  );
  const r = await say('以后练习交给一个专门的助手批');
  assert.equal(r.status, 'done');
  const s = db.get<any>('SELECT * FROM specialists WHERE teacher_id=?', teacher);
  assert.equal(s.name, '练习批改');
  assert.equal(s.guide, '照评分标准逐题给分，格式不对扣 1 分');
  assert.equal(db.value('SELECT specialist_id FROM assignments WHERE id=?', hw), s.id);
  // 下一轮助教看得到自己分出来的专门助手
  script({ text: '有一个' });
  await say('你手下有哪些专门助手');
  const last = seen[seen.length - 1];
  assert.equal(last.agent, 'ta');
  assert.match(text(last.messages[last.messages.length - 1]), /你分出来的专门助手：「练习批改」管：批计科5班的练习；批：计科5班「练习一」/);
  assert.ok(last.tools.includes('ask_specialist') && last.tools.includes('new_specialist') && last.tools.includes('edit_specialist'));
  // 老师那边的列表；别的老师看不到
  const list = (await req('/keeper/specialists')).json.specialists;
  assert.deepEqual(
    list.map((x: any) => [x.name, x.duty, x.homework.map((h: any) => h.title)]),
    [['练习批改', '批计科5班的练习', ['练习一']]],
  );
  assert.match(list[0].avatar, /^\/agents\/\w+\.webp$/);
  assert.equal((await req('/keeper/specialists', undefined, 'other')).json.specialists.length, 0);
  // 撤回分出来的那一件：停用，作业改回助教自己批
  const action = db.get<any>("SELECT id FROM ta_actions WHERE teacher_id=? AND kind='specialist.create'", teacher);
  assert.equal((await req(`/keeper/actions/${action.id}/undo`, {})).status, 200);
  assert.ok(db.value('SELECT retired_at FROM specialists WHERE id=?', s.id));
  assert.equal(db.value('SELECT specialist_id FROM assignments WHERE id=?', hw), null);
  assert.equal((await req('/keeper/specialists')).json.specialists.length, 0);
});

test('交给专门助手的活：接着它自己的会话办，第二次看得到第一次的来往；它只有翻知识库的工具', async () => {
  const s = spec.createSpecialist(teacher, { name: '项目答疑', duty: '回答期末项目的问题', guide: '照《期末项目说明》答' });
  script(
    { calls: [{ name: 'ask_specialist', args: { specialist: '项目答疑', task: '学生问：能不能两个人一组' } }] },
    { text: '说明里写了可以两人一组，最多三人' },
    { text: '能，最多三人' },
  );
  const r1 = await say('期末项目能两个人一组吗');
  assert.equal(r1.status, 'done');
  const first = seen.find((x) => x.agent === 'specialist')!;
  assert.deepEqual(first.tools, ['search_kb', 'read_kb']);
  assert.equal(first.purpose, 'specialist:task');
  assert.match(text(first.messages[0]), /专门助手「项目答疑」，专管：回答期末项目的问题。\n做法：\n照《期末项目说明》答/);
  // 助教拿到它交回的结果；工作记录里有一行「交给「项目答疑」」
  const taAfter = seen.filter((x) => x.agent === 'ta').pop()!;
  assert.match(text(taAfter.messages[taAfter.messages.length - 1]), /「项目答疑」交回：说明里写了可以两人一组，最多三人/);
  const ev = db.all<any>("SELECT data FROM kb_events WHERE run_id=? AND type='tool'", r1.runId).map((e) => JSON.parse(e.data));
  assert.ok(ev.some((e) => e.name === 'ta_specialist' && e.label === '交给「项目答疑」'));

  script(
    { calls: [{ name: 'ask_specialist', args: { specialist: '项目答疑', task: '学生问：截止能不能延后' } }] },
    { text: '说明里没写延后，要问老师' },
    { text: '这个要您定' },
  );
  await say('项目截止能延后吗');
  const second = seen.filter((x) => x.agent === 'specialist').pop()!;
  const said = second.messages.map(text).join('\n');
  assert.match(said, /能不能两个人一组/);
  assert.match(said, /说明里写了可以两人一组，最多三人/);
  assert.match(said, /截止能不能延后/);
  assert.equal(db.value('SELECT uses FROM specialists WHERE id=?', s.id), 2);
  spec.updateSpecialist(teacher, s.id, { retire: true });
});

test('作业交给了专门助手：批的时候说明里带上它是谁、做法；老师改了它批的分，记进它的会话，下一份照着批', async () => {
  const hw = await assign('练习二');
  rubric.setRubric(hw, RUBRIC);
  const s = spec.createSpecialist(teacher, { name: '练习二批改', duty: '批练习二', guide: '变量名不规范扣 0.5 分' });
  db.run('UPDATE assignments SET specialist_id=? WHERE id=?', s.id, hw);
  const submit = async (who: string, body: string) => assert.equal((await req(`/homework/${hw}/submit`, { text: body, fileIds: [] }, who)).status, 200);
  await submit('zhang', 'print(sum(range(1,100)))');
  script({ calls: [{ name: 'submit_grade', args: { items: { 第1题: { got: 2, why: 'range 少算 100' }, 第2题: { got: 6, why: '对' } }, comment: '第1题边界错了' } }] });
  await jobs.drainGrades();
  const g1 = seen[seen.length - 1];
  assert.equal(g1.agent, 'grader');
  assert.equal(g1.purpose, 'specialist:grade');
  assert.match(text(g1.messages[0]), /你是专管这类作业的专门助手「练习二批改」（批练习二）。\n做法：\n变量名不规范扣 0.5 分/);
  assert.equal(db.value('SELECT uses FROM specialists WHERE id=?', s.id), 1);
  assert.match(db.value<string>("SELECT request FROM kb_runs WHERE agent='grader' ORDER BY id DESC LIMIT 1")!, /^「练习二批改」批「练习二」/);

  // 老师把第1题改成 3 分
  const w = (await req(`/homework/${hw}/students/${zs}`)).json;
  const items = w.submission.items.map((x: any, i: number) => (i === 0 ? { ...x, got: 3 } : x));
  assert.equal((await req(`/homework/${hw}/students/${zs}/grade`, { score: null, comment: w.submission.comment, items, aiGradeId: w.ai.id })).status, 200);
  const note = db.all<any>('SELECT content FROM agent_messages WHERE owner_id=? AND thread=? ORDER BY id', teacher, spec.specKey(s.id)).map((m) => JSON.parse(m.content));
  assert.deepEqual(note, ['（老师改了你批的「练习二」张浩然：「第1题」2 → 3 分。以后同样的情况照老师的分给）']);

  // 下一份：说明里带着老师改过的分
  await submit('liu', 'print(sum(range(1,100)))');
  script({ calls: [{ name: 'submit_grade', args: { items: { 第1题: { got: 3, why: 'range 少算 100' }, 第2题: { got: 6, why: '对' } }, comment: '第1题边界错了' } }] });
  await jobs.drainGrades();
  assert.match(text(seen[seen.length - 1].messages[0]), /你以前办过的事和老师的交代：\n助教：（老师改了你批的「练习二」张浩然：「第1题」2 → 3 分。以后同样的情况照老师的分给）/);

  // 老师在页面上停用：这份作业改回助教自己批（说明里不再有它）
  assert.equal((await req(`/keeper/specialists/${s.id}/retire`, {})).status, 200);
  assert.equal(spec.graderOf({ teacher_id: teacher, specialist_id: s.id }), null);
  assert.equal((await req(`/keeper/specialists/${s.id}/retire`, {}, 'other')).status, 404);
});

test('回学伴的那一手：老师有专门助手时才多一个 ask_specialist，名单写在开头', async () => {
  for (const s of spec.specialistsOf(teacher)) spec.updateSpecialist(teacher, s.id, { retire: true });
  script({ text: '照资料包答' });
  await runHelper({ teacherId: teacher, classId: k5, mode: 'answer', request: '学生问', task: '张浩然问：第三章讲什么' });
  assert.ok(!seen[seen.length - 1].tools.includes('ask_specialist'));
  assert.doesNotMatch(text(seen[seen.length - 1].messages[1]), /专门助手/);

  spec.createSpecialist(teacher, { name: '章节答疑', duty: '回答各章内容的问题', guide: '照课件答' });
  script({ calls: [{ name: 'ask_specialist', args: { specialist: '章节答疑', task: '张浩然问第三章讲什么' } }] }, { text: '第三章讲循环' }, { text: '第三章讲循环' });
  const r = await runHelper({ teacherId: teacher, classId: k5, mode: 'answer', request: '学生问', task: '张浩然问：第三章讲什么' });
  assert.equal(r.text, '第三章讲循环');
  const helperSteps = seen.filter((x) => x.agent === 'helper');
  assert.ok(helperSteps[helperSteps.length - 1].tools.includes('ask_specialist'));
  assert.match(text(helperSteps[helperSteps.length - 1].messages[1]), /你分出来的专门助手：「章节答疑」管：回答各章内容的问题/);
  assert.match(text(helperSteps[helperSteps.length - 1].messages.at(-1)), /专门助手交回：第三章讲循环/);
});

test('分专门助手：重名的不让分；名字对不上时告诉助教有哪几个', () => {
  assert.throws(() => spec.createSpecialist(teacher, { name: '章节答疑', duty: 'x', guide: '' }), /已经有叫「章节答疑」的专门助手了/);
  assert.throws(() => spec.findSpecialist(teacher, '没这个'), /没有叫「没这个」的专门助手。现在有：「章节答疑」/);
  assert.throws(() => spec.createSpecialist(teacher, { name: '', duty: 'x', guide: '' }), /要有个名字/);
});

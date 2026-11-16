import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-assistant-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
// 助教批改、拟评分标准不在后台自己跑（这里的模型回答是排好的）
process.env.CT_GRADE_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const runtime = await import('../src/assistant/runtime.js');
const time = await import('../src/assistant/time.js');
const app = createApp();

const user = (name: string, role = 'teacher', extra: Record<string, unknown> = {}) =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now(), ...extra });
const teacher = user('王建国'),
  other = user('另一位老师');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies: Record<string, string> = { teacher: cookie(teacher), other: cookie(other) };
async function req(path: string, body?: unknown, who = 'teacher', method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** 写好的模型回答：一步一个；每一步能看到发给模型的整段（检查有没有补上回音、带没带后台消息） */
type Reply = { text?: string; reasoning?: string; calls?: { name: string; args: Record<string, unknown> }[] };
const seen: any[][] = [];
function script(...steps: Reply[]) {
  let n = 0;
  runtime.setModelStep(async ({ messages }) => {
    seen.push(messages);
    const s = steps[n++];
    if (!s) throw new Error('模型回答写少了');
    return {
      text: s.text || '',
      toolCalls: (s.calls || []).map((c, i) => ({ id: `call_${randomUUID().slice(0, 8)}_${i}`, name: c.name, args: c.args, raw: JSON.stringify(c.args) })),
      ...(s.reasoning ? { reasoning: s.reasoning } : {}),
    };
  });
}
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
const events = (runId: number, type: string) => db.all<any>('SELECT * FROM kb_events WHERE run_id=? AND type=? ORDER BY id', runId, type).map((e) => JSON.parse(e.data));

test('时间按北京时间算', () => {
  assert.equal(time.parseTime('2026-11-27 23:59'), Date.parse('2026-11-27T23:59:00+08:00'));
  assert.equal(time.parseTime('2026-11-27'), Date.parse('2026-11-27T23:59:00+08:00'));
  assert.equal(time.parseTime('2026年11月27日 8:05'), Date.parse('2026-11-27T08:05:00+08:00'));
  assert.equal(time.parseTime('下周五'), null);
  assert.match(time.nowLine(Date.parse('2026-11-16T02:40:00+08:00')), /^2026-11-16 周一 02:40$/);
});

test('老师怎么说就怎么收，日期由程序算（今天是 2026-11-16 周一）', () => {
  const base = Date.parse('2026-11-16T03:00:00+08:00');
  const due = (s: string, from?: number) => time.parseWhen(s, { hour: 23, minute: 59, base, from });
  const pub = (s: string) => time.parseWhen(s, { hour: 8, minute: 0, base });
  const at = (s: string) => Date.parse(`${s}+08:00`);
  assert.equal(due('下周五'), at('2026-11-27T23:59:00'));
  assert.equal(due('下周五交'), at('2026-11-27T23:59:00'));
  assert.equal(due('这周五'), at('2026-11-20T23:59:00'));
  assert.equal(due('周五'), at('2026-11-20T23:59:00'));
  assert.equal(due('星期一'), at('2026-11-23T23:59:00'));
  assert.equal(due('下周三晚上10点'), at('2026-11-25T22:00:00'));
  assert.equal(due('下下周一'), at('2026-11-30T23:59:00'));
  assert.equal(pub('明天早上8点'), at('2026-11-17T08:00:00'));
  assert.equal(pub('明天'), at('2026-11-17T08:00:00'));
  assert.equal(due('后天'), at('2026-11-18T23:59:00'));
  assert.equal(due('11月30日晚上10点'), at('2026-11-30T22:00:00'));
  assert.equal(due('11 月 30 日晚上 10 点'), at('2026-11-30T22:00:00'));
  assert.equal(due('12月1号'), at('2026-12-01T23:59:00'));
  assert.equal(due('十二月一日'), at('2026-12-01T23:59:00'));
  assert.equal(due('2026-11-27 23:59'), at('2026-11-27T23:59:00'));
  assert.equal(due('3天后'), at('2026-11-19T23:59:00'));
  assert.equal(due('三天后'), at('2026-11-19T23:59:00'));
  const old = at('2026-11-18T23:59:00');
  assert.equal(due('往后推两天', old), at('2026-11-20T23:59:00'));
  assert.equal(due('推迟一周', old), at('2026-11-25T23:59:00'));
  assert.equal(due('提前一天', old), at('2026-11-17T23:59:00'));
  assert.equal(due('推两天', old), at('2026-11-20T23:59:00'));
  // 日期里的「19日」不是「推 19 天」；又写日期又写「往后推一天」的，从原截止算
  assert.equal(due('11月19日 周四 23:59（原截止往后推一天）', old), at('2026-11-19T23:59:00'));
  assert.equal(due('11月25日（原截止往后推一天）', old), at('2026-11-19T23:59:00'));
  assert.equal(due('推迟到12月1日', old), at('2026-12-01T23:59:00'));
  assert.equal(due('延期到 12 月 1 号', old), at('2026-12-01T23:59:00'));
  assert.equal(due('两周后'), at('2026-11-30T23:59:00'));
  assert.equal(due('8点半'), at('2026-11-16T08:30:00'));
  assert.equal(due('看情况'), null);
});

test('一句话建班，卡片上能撤回', async () => {
  script({ calls: [{ name: 'create_class', args: { name: '计科2505 Python' } }] }, { text: '建好了「计科2505 Python」。' });
  const { runId, status } = await say('建个班，叫计科2505 Python');
  assert.equal(status, 'done');
  const k = db.get<any>("SELECT * FROM classes WHERE teacher_id=? AND name='计科2505 Python'", teacher);
  assert.ok(k && !k.deleted_at);
  const [card] = events(runId, 'action');
  assert.equal(card.kind, 'class.create');
  assert.equal(card.code, k.join_code);
  const runs = (await req('/keeper/runs')).json.runs;
  const run = runs.find((r: any) => r.id === runId);
  assert.equal(run.agent, 'ta');
  assert.equal(run.reply, '建好了「计科2505 Python」。');
  assert.deepEqual(run.actions.map((a: any) => [a.kind, a.status, a.undoable]), [['class.create', 'done', true]]);
  // 撤回：班删掉了，记录标成已撤回；再撤一次不出错
  const u = await req(`/keeper/actions/${card.actionId}/undo`, {});
  assert.equal(u.status, 200);
  assert.ok(db.get<any>('SELECT deleted_at FROM classes WHERE id=?', k.id).deleted_at);
  assert.match((await req(`/keeper/actions/${card.actionId}/undo`, {})).json.message, /已经撤回过了/);
  // 别的老师撤不了
  assert.equal((await req(`/keeper/actions/${card.actionId}/undo`, {}, 'other')).status, 404);
});

test('班名对上两个：程序拦下，助教问老师；老师在卡片上选了再办', async () => {
  await req('/classes', { name: '计科2505 Python' });
  await req('/classes', { name: '计科2506 Python' });
  script(
    { calls: [{ name: 'assign_homework', args: { classes: ['计科'], title: '第三章课后题' } }] },
    { calls: [{ name: 'ask', args: { questions: [{ question: '发给哪个班？', options: ['计科2505 Python', '计科2506 Python', '两个都发'] }] } }] },
  );
  const first = await say('给计科发第三章课后题，11月27号交');
  assert.equal(first.status, 'waiting');
  // 第一步办不成的原因交回给了助教，里面列着对得上的几个班
  const tool = seen.at(-1)!.at(-1);
  assert.equal(tool.role, 'tool');
  assert.match(String(tool.content), /对得上好几个班.*计科2505 Python.*计科2506 Python/);
  const [ask] = events(first.runId, 'ask');
  assert.equal(ask.questions[0].question, '发给哪个班？');
  assert.equal(db.value<number>("SELECT count(*) FROM assignments WHERE title='第三章课后题'"), 0);

  script({ calls: [{ name: 'assign_homework', args: { classes: ['计科2505 Python'], title: '第三章课后题', due: '2026-11-27' } }] }, { text: '发好了。' });
  const r = await req(`/keeper/runs/${first.runId}/answer`, { answers: [{ picks: ['计科2505 Python'] }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await settled(r.json.runId), 'done');
  // 回答成了那一问的回音，接在老师下一句前面
  const sent = seen.at(-2)!;
  const answer = sent.findIndex((m: any) => m.role === 'tool' && /老师答/.test(String(m.content)));
  assert.ok(answer > 0 && sent[answer + 1].role === 'user');
  const hw = db.all<any>("SELECT a.*, c.name FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.title='第三章课后题'");
  assert.deepEqual(
    hw.map((h) => [h.name, h.due_at, h.points, h.allow_late]),
    [['计科2505 Python', Date.parse('2026-11-27T23:59:00+08:00'), 100, 1]],
  );
  assert.equal(db.get<any>('SELECT status FROM kb_runs WHERE id=?', first.runId).status, 'done');
  assert.deepEqual(events(first.runId, 'ask')[0].answered, [{ q: '发给哪个班？', a: '计科2505 Python' }]);
  // 答过的不能再答
  assert.equal((await req(`/keeper/runs/${first.runId}/answer`, { answers: [{ picks: ['计科2506 Python'] }] })).status, 409);
});

test('问了老师，老师没在卡片上选、直接说了别的：那一问补上回音，接着说', async () => {
  script({ calls: [{ name: 'ask', args: { questions: [{ question: '哪份作业？', options: ['第三章课后题'] }] } }] });
  const a = await say('截止往后推一天');
  assert.equal(a.status, 'waiting');
  script({ text: '好的，不推了。' });
  const b = await say('算了不用推了');
  assert.equal(b.status, 'done');
  const sent = seen.at(-1)!;
  const skipped = sent.findIndex((m: any) => m.role === 'tool' && /没有在卡片上选/.test(String(m.content)));
  assert.ok(skipped > 0 && sent[skipped + 1].role === 'user' && /算了不用推了/.test(String(sent[skipped + 1].content)));
  assert.equal(db.get<any>('SELECT status FROM kb_runs WHERE id=?', a.runId).status, 'done');
});

test('批改：打分写评语；撤回改回原来的；老师后来自己改过就撤不回', async () => {
  const k = db.get<any>("SELECT id FROM classes WHERE name='计科2505 Python' AND deleted_at IS NULL AND teacher_id=?", teacher);
  const s1 = user('孙思雨', 'student', { student_no: '2026001' });
  db.insert('class_students', { class_id: k.id, student_no: '2026001', name: '孙思雨', user_id: s1, in_roster: 0, joined_at: Date.now(), created_at: Date.now() });
  const hid = db.value<number>("SELECT id FROM assignments WHERE title='第三章课后题' AND class_id=?", k.id)!;
  const sid = db.insert('submissions', { assignment_id: hid, user_id: s1, text: '答案', submitted_at: Date.now(), late: 0, updated_at: Date.now() });

  script({ calls: [{ name: 'grade', args: { homework: '第三章课后题', student: '孙思雨', score: 88, comment: '思路对' } }] }, { text: '打好了。' });
  const g = await say('孙思雨第三章课后题 88 分，评语写思路对');
  assert.equal(g.status, 'done');
  assert.deepEqual({ ...db.get<any>('SELECT score, comment FROM submissions WHERE id=?', sid) }, { score: 88, comment: '思路对' });
  const [card] = events(g.runId, 'action');
  assert.equal(card.kind, 'submission.grade');
  assert.equal((await req(`/keeper/actions/${card.actionId}/undo`, {})).status, 200);
  assert.deepEqual({ ...db.get<any>('SELECT score, comment FROM submissions WHERE id=?', sid) }, { score: null, comment: null });

  script({ calls: [{ name: 'grade', args: { homework: '第三章课后题', student: '2026001', score: 90 } }] }, { text: '好了。' });
  const g2 = await say('2026001 那份 90 分');
  const [card2] = events(g2.runId, 'action');
  // 老师在页面上又改成 95：撤回会冲掉老师改的，不撤
  const csid = db.value<number>('SELECT id FROM class_students WHERE user_id=?', s1);
  await req(`/homework/${hid}/students/${csid}/grade`, { score: 95, comment: '' });
  assert.equal((await req(`/keeper/actions/${card2.actionId}/undo`, {})).status, 409);
  assert.equal(db.get<any>('SELECT score FROM submissions WHERE id=?', sid).score, 95);
});

test('改作业、删作业、看谁交了；别的老师的班它够不着', async () => {
  script(
    { calls: [{ name: 'update_homework', args: { homework: '第三章课后题', due: '2026-11-29 22:00', allow_late: false } }] },
    { calls: [{ name: 'homework_detail', args: { homework: '第三章课后题' } }] },
    { text: '改好了。' },
  );
  const r = await say('第三章课后题截止推到 29 号晚上 10 点，过了不收，再看看谁交了');
  assert.equal(r.status, 'done');
  const h = db.get<any>("SELECT * FROM assignments WHERE title='第三章课后题' AND deleted_at IS NULL");
  assert.equal(h.due_at, Date.parse('2026-11-29T22:00:00+08:00'));
  assert.equal(h.allow_late, 0);
  const detail = seen.at(-1)!.at(-1);
  assert.match(String(detail.content), /已批 1：孙思雨 95/);

  // 别的老师说同一个班名：在他自己的班里找，找不到
  const ot = db.insert('classes', { teacher_id: other, name: '他的班', join_code: 'ZZZZZZ', created_at: Date.now(), updated_at: Date.now() });
  script({ calls: [{ name: 'delete_class', args: { class: '他的班' } }] }, { text: '没有这个班。' });
  const d = await say('删掉他的班');
  assert.equal(d.status, 'done');
  assert.match(String(seen.at(-1)!.at(-1).content), /没有叫「他的班」的班/);
  assert.equal(db.get<any>('SELECT deleted_at FROM classes WHERE id=?', ot).deleted_at, null);
});

test('整理资料交给后台：不挡着助教，做完（这里没做成）的消息下一轮带给助教', async () => {
  script({ calls: [{ name: 'hand_to_keeper', args: { brief: '老师说：把第三章的笔记整理一下' } }] }, { text: '交给整理助手了。' });
  const r = await say('把第三章的笔记整理一下');
  assert.equal(r.status, 'done');
  const [job] = events(r.runId, 'job');
  assert.ok(job.jobRunId);
  const jobRow = db.get<any>('SELECT * FROM kb_runs WHERE id=?', job.jobRunId);
  assert.deepEqual([jobRow.agent, jobRow.kind, jobRow.parent_id], ['keeper', 'job', r.runId]);
  // 测试库里没接模型：后台这件活做不成，结果记给助教
  await settled(job.jobRunId);
  for (let i = 0; i < 100 && !db.value<string>("SELECT notes FROM agent_threads WHERE owner_id=? AND notes<>'[]'", teacher); i++) await new Promise((ok) => setTimeout(ok, 20));
  script({ text: '整理那件没做成。' });
  await say('整理得怎么样了');
  const lastUser = [...seen.at(-1)!].reverse().find((m: any) => m.role === 'user');
  assert.match(String(lastUser.content), /后台的消息：整理助手没做完任务/);
  // 对话里后台的活挂在派它的那一轮下面，不单独占一条
  const runs = (await req('/keeper/runs')).json.runs;
  assert.ok(!runs.some((x: any) => x.id === job.jobRunId));
  assert.equal(runs.find((x: any) => x.id === r.runId).jobs[0].id, job.jobRunId);
});

test('开新会话：屏幕从头开始，助教也从头记；以前那段还能翻出来接着说', async () => {
  const sayIn = async (message: string, session?: number | null) => {
    const r = await req('/keeper/messages', { message, ...(session !== undefined ? { session } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { runId: r.json.runId as number, status: await settled(r.json.runId) };
  };
  script({ text: '好的。' });
  await sayIn('以前那段说的话：记住我喜欢简短');
  const s1 = (await req('/keeper/sessions', {})).json.id;
  assert.ok(s1);
  // 新会话：对话是空的
  const empty = (await req('/keeper/runs')).json;
  assert.equal(empty.session, s1);
  assert.equal(empty.runs.length, 0);
  // 还没说话就再点一次：不多开一段空的
  assert.equal((await req('/keeper/sessions', {})).json.id, s1);
  script({ text: '新会话里回。' });
  await sayIn('新会话第一句');
  const sent = seen.at(-1)!.map((m: any) => String(m.content)).join('\n');
  assert.match(sent, /新会话第一句/);
  assert.doesNotMatch(sent, /记住我喜欢简短/);
  assert.equal((await req('/keeper/runs')).json.runs.length, 1);
  // 会话列表：新的在前，第一句话当标题；以前那一段的编号是空的
  const list = (await req('/keeper/sessions')).json;
  assert.equal(list.current, s1);
  assert.equal(list.sessions[0].id, s1);
  assert.equal(list.sessions[0].title, '新会话第一句');
  assert.ok(list.sessions.some((x: any) => x.id === null));
  // 翻回以前那段接着说：模型那边接着以前那段（带着以前说的）
  const old = (await req('/keeper/runs?session=old')).json;
  assert.equal(old.session, null);
  assert.ok(old.runs.length > 1);
  script({ text: '接着说。' });
  await sayIn('接着以前的说', null);
  const back = seen.at(-1)!.map((m: any) => String(m.content)).join('\n');
  assert.match(back, /记住我喜欢简短/);
  assert.doesNotMatch(back, /新会话第一句/);
  // 别的老师的会话用不了
  assert.equal((await req('/keeper/messages', { message: '看看', session: s1 }, 'other')).status, 404);
});

test('助教正在回上一句：再说要等它说完', async () => {
  let release!: () => void;
  const hold = new Promise<void>((ok) => (release = ok));
  runtime.setModelStep(async () => {
    await hold;
    return { text: '好', toolCalls: [] };
  });
  const a = await req('/keeper/messages', { message: '在吗' });
  const b = await req('/keeper/messages', { message: '在吗？' });
  assert.equal(b.status, 409);
  release();
  assert.equal(await settled(a.json.runId), 'done');
  runtime.setModelStep(null);
});

test('开着思考：每一步的思考记下来，往后原样传回去（DeepSeek 带工具时要它）；没开思考时的旧记录照常', async () => {
  script(
    { reasoning: '老师要建一个班，班名是思考测试班。', calls: [{ name: 'create_class', args: { name: '思考测试班' } }] },
    { reasoning: '建好了，告诉老师加课码。', text: '建好了。' },
    { text: '不客气。' },
  );
  await say('建个班叫思考测试班');
  await say('谢谢');
  const asked = seen[seen.length - 1].filter((m: any) => m.role === 'assistant');
  assert.deepEqual(
    asked.slice(-2).map((m: any) => m.reasoning),
    ['老师要建一个班，班名是思考测试班。', '建好了，告诉老师加课码。'],
  );
  // 以前没开思考时说的那些没有思考，也不硬塞一个空的
  assert.ok(asked.slice(0, -2).every((m: any) => m.reasoning === undefined));

  // 只有会思考的 DeepSeek 才传开关；指定了就按指定的，没指定按模型设置
  const { thinkingFor } = await import('../src/llm/index.js');
  const flash = { model: 'deepseek-flash', caps: { reasoning: false } };
  assert.equal(thinkingFor(flash), false);
  assert.equal(thinkingFor(flash, 'high'), true);
  assert.equal(thinkingFor(flash, 'off'), false);
  assert.equal(thinkingFor({ model: 'gpt-5', caps: { reasoning: true } }, 'high'), undefined);
});

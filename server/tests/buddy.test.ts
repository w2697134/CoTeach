import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-buddy-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
// 助教批改、拟评分标准不在后台自己跑（这里的模型回答是排好的）
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const model = await import('../src/assistant/model.js');
const pack = await import('../src/assistant/pack.js');
const { createKb } = await import('../src/kb/bases.js');
const { saveSource } = await import('../src/kb/repo.js');
const app = createApp();

const user = (name: string, role = 'teacher') =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
const teacher = user('王建国'),
  other = user('李老师'),
  zhang = user('张浩然', 'student'),
  liu = user('刘欣怡', 'student'),
  outsider = user('陈子轩', 'student');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies: Record<string, string> = { teacher: cookie(teacher), other: cookie(other), zhang: cookie(zhang), liu: cookie(liu), outsider: cookie(outsider) };
async function req(path: string, body?: unknown, who = 'teacher') {
  const res = await app.request('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? ((await res.json()) as any) : null, res };
}

/** 写好的模型回答：按谁在调（老师的助教、学伴、替老师回学伴的助教）各排一队 */
type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };
const queues: Record<string, Reply[]> = { ta: [], stu: [], helper: [] };
const seen: { agent: string; messages: any[]; tools: string[] }[] = [];
model.setModelStep(async (o) => {
  seen.push({ agent: o.agent, messages: o.messages, tools: o.tools.map((t) => t.name) });
  const s = queues[o.agent].shift();
  if (!s) throw new Error(`${o.agent} 的模型回答写少了`);
  return { text: s.text || '', toolCalls: (s.calls || []).map((c, i) => ({ id: `call_${randomUUID().slice(0, 8)}_${i}`, name: c.name, args: c.args, raw: JSON.stringify(c.args) })) };
});
const script = (agent: 'ta' | 'stu' | 'helper', ...steps: Reply[]) => queues[agent].push(...steps);

async function settled(runId: number) {
  for (let i = 0; i < 250; i++) {
    const r = db.get<any>('SELECT status FROM kb_runs WHERE id=?', runId);
    if (r && r.status !== 'running' && r.status !== 'queued') return r.status as string;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('这一轮一直没结束');
}
const ask = async (who: string, message: string) => {
  const r = await req('/cot/messages', { message }, who);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { runId: r.json.runId as number, status: await settled(r.json.runId) };
};
const teacherSays = async (message: string) => {
  const r = await req('/keeper/messages', { message });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { runId: r.json.runId as number, status: await settled(r.json.runId) };
};
const lastUser = (messages: any[]) => String([...messages].reverse().find((m) => m.role === 'user')?.content || '');

// 两个班：计科5班（王老师，张浩然和刘欣怡）、数据结构1班（李老师，张浩然）
const k5 = (await req('/classes', { name: '计科5班' })).json.id as number;
const ds = (await req('/classes', { name: '数据结构1班' }, 'other')).json.id as number;
const enroll = (classId: number, uid: number, no: string, name: string) =>
  db.insert('class_students', { class_id: classId, student_no: no, name, user_id: uid, in_roster: 0, joined_at: Date.now(), created_at: Date.now() });
enroll(k5, zhang, '2023001', '张浩然');
enroll(k5, liu, '2023002', '刘欣怡');
enroll(ds, zhang, '2023001', '张浩然');
const day = 86400_000;
const hw = (classId: number, title: string, o: Record<string, unknown> = {}) =>
  db.insert('assignments', {
    class_id: classId,
    teacher_id: classId === k5 ? teacher : other,
    title,
    body: `${title}的要求`,
    points: 100,
    due_at: Date.now() + 3 * day,
    allow_late: 1,
    publish_at: Date.now() - day,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...o,
  });
const ch3 = hw(k5, '第三章课后题');
const hidden = hw(k5, '期中复习', { publish_at: Date.now() + 2 * day, due_at: Date.now() + 5 * day });
const gone = hw(k5, '删掉的作业', { deleted_at: Date.now() });
hw(ds, '链表练习');

test('资料包：作业的截止、满分、要求现取；没发布的、删掉的学生那边看不到', () => {
  pack.putPack(k5, 'homework', '第三章课后题', '考递归，对应讲义第三章第二节', ch3);
  pack.putPack(k5, 'rule', '晚交', '截止后两天内交不扣分');
  const shown = pack.renderPack(k5);
  assert.match(shown, /「计科5班」（王建国老师）/);
  assert.match(shown, /「第三章课后题」截止 .*满分 100/);
  assert.match(shown, /要求：第三章课后题的要求/);
  assert.match(shown, /助教的说明：考递归/);
  assert.match(shown, /「晚交」截止后两天内交不扣分/);
  assert.doesNotMatch(shown, /期中复习|删掉的作业/);
  // 助教看的时候还没发布的也在
  assert.match(pack.renderPack(k5, { teacherView: true }), /期中复习.*还没发布/);
  // 改了截止不用重写说明：资料包里跟着变
  db.update('assignments', ch3, { due_at: Date.parse('2026-12-01T23:59:00+08:00') });
  assert.match(pack.renderPack(k5), /截止 12月1日 周二 23:59/);
  void hidden;
  void gone;
});

test('学伴：说明里带着学生各个班的资料包，每轮带着现在几点、学生在哪几个班、还没交的作业；按资料包能答的直接答', async () => {
  script('stu', { text: '「第三章课后题」截止 12-01 周二 23:59，截止后两天内交不扣分。' });
  const r = await ask('zhang', '第三章课后题什么时候截止，晚交扣分吗');
  assert.equal(r.status, 'done');
  const call = seen.filter((s) => s.agent === 'stu').pop()!;
  const system = String(call.messages[0].content);
  assert.match(system, /CoT 学伴/);
  assert.match(system, /「计科5班」（王建国老师）[\s\S]*「晚交」截止后两天内交不扣分/);
  assert.match(system, /「数据结构1班」（李老师）[\s\S]*链表练习/);
  assert.deepEqual(call.tools, ['my_homework', 'send_file', 'ask_ta']);
  const said = lastUser(call.messages);
  assert.match(said, /学生是张浩然/);
  assert.match(said, /在「计科5班」（王建国老师）、「数据结构1班」（李老师）/);
  assert.match(said, /还没交的作业：.*「第三章课后题」（计科5班/);
  assert.match(said, /第三章课后题什么时候截止/);
  const run = (await req('/cot/runs', undefined, 'zhang')).json.runs.pop();
  assert.equal(run.reply, '「第三章课后题」截止 12-01 周二 23:59，截止后两天内交不扣分。');
  // 老师那边的对话里没有学生说的
  assert.equal((await req('/keeper/runs')).json.runs.length, 0);
});

test('学伴查自己的作业：只看得到自己的分数和评语', async () => {
  db.insert('submissions', { assignment_id: ch3, user_id: zhang, text: '我的答案', submitted_at: Date.now(), late: 0, score: 88, comment: '递归边界没写', graded_at: Date.now(), updated_at: Date.now() });
  db.insert('submissions', { assignment_id: ch3, user_id: liu, text: '刘的答案', submitted_at: Date.now(), late: 0, score: 95, comment: '很好', graded_at: Date.now(), updated_at: Date.now() });
  script('stu', { calls: [{ name: 'my_homework', args: { homework: '第三章课后题' } }] }, { text: '88 分，评语是递归边界没写。' });
  await ask('zhang', '我第三章作业几分');
  const tool = seen.filter((s) => s.agent === 'stu').pop()!.messages.filter((m) => m.role === 'tool').pop();
  assert.match(String(tool.content), /88 分（满分 100），评语：递归边界没写/);
  assert.doesNotMatch(String(tool.content), /95|刘/);
});

test('问助教：助教翻资料答，答的跟个人无关就写进资料包；它手里没有改班级作业成绩的工具', async () => {
  script('stu', { calls: [{ name: 'ask_ta', args: { question: '递归和循环有什么区别', class: '计科5班' } }] }, { text: '助教说：递归是函数调用自己……' });
  script(
    'helper',
    { calls: [{ name: 'update_pack', args: { kind: 'qa', title: '递归和循环的区别', body: '递归是函数调用自己，循环是重复执行一段代码' } }] },
    { text: '递归是函数调用自己，循环是重复执行一段代码（讲义第三章）' },
  );
  const r = await ask('zhang', '递归和循环有什么区别');
  assert.equal(r.status, 'done');
  const h = seen.filter((s) => s.agent === 'helper').pop()!;
  assert.deepEqual(h.tools, ['search_kb', 'read_kb', 'update_pack', 'give_files', 'ask_teacher']);
  assert.match(String(h.messages[0].content), /王建国老师的 CoT 助教/);
  assert.match(lastUser(h.messages), /^这个班的资料包：\n「计科5班」[\s\S]*张浩然的学伴来问：\n递归和循环有什么区别/);
  const toolOut = seen.filter((s) => s.agent === 'stu').pop()!.messages.filter((m) => m.role === 'tool').pop();
  assert.match(String(toolOut.content), /递归是函数调用自己/);
  assert.match(pack.renderPack(k5), /答过的问题：\n- 「递归和循环的区别」递归是函数调用自己/);
  const row = db.get<any>('SELECT * FROM student_asks ORDER BY id DESC LIMIT 1');
  assert.equal(row.status, 'answered');
  // 这一轮记着说的是计科5班（老师只看得到说自己班的）
  assert.deepEqual(JSON.parse(db.get<any>('SELECT class_ids FROM kb_runs WHERE id=?', r.runId).class_ids), [k5]);
});

test('要老师拍板：老师那边弹卡片（说别的也不收），老师在卡片上答，助教转告学生、记成规矩', async () => {
  script('stu', { calls: [{ name: 'ask_ta', args: { question: '张浩然生病了，第三章课后题想晚交三天' } }] }, { text: '已经帮你问了老师，老师回了会告诉你。' });
  script('helper', {
    calls: [{ name: 'ask_teacher', args: { question: '张浩然生病了，想晚交「第三章课后题」三天', options: ['可以，不扣分', '可以，按迟交算', '不行'], draft: '老师同意你晚交三天' } }],
  });
  // 张浩然在两个班：没说哪个班，学伴就得说清楚——这里写好的回答没带班，程序要拦下来让它说
  await ask('zhang', '我生病了，第三章作业能晚交三天吗');
  let out = String(seen.filter((s) => s.agent === 'stu').pop()!.messages.filter((m) => m.role === 'tool').pop().content);
  assert.match(out, /学生在好几个班/);
  queues.helper.length = 0;
  queues.stu.length = 0;
  script('stu', { calls: [{ name: 'ask_ta', args: { question: '张浩然生病了，第三章课后题想晚交三天', class: '计科5班' } }] }, { text: '已经帮你问了老师，老师回了会告诉你。' });
  script('helper', {
    calls: [{ name: 'ask_teacher', args: { question: '张浩然生病了，想晚交「第三章课后题」三天', options: ['可以，不扣分', '可以，按迟交算', '不行'], draft: '老师同意你晚交三天' } }],
  });
  await ask('zhang', '计科5班的，第三章作业能晚交三天吗');
  out = String(seen.filter((s) => s.agent === 'stu').pop()!.messages.filter((m) => m.role === 'tool').pop().content);
  assert.match(out, /助教已经帮学生问了老师/);
  assert.doesNotMatch(out, /老师同意/);
  const card = db.get<any>("SELECT * FROM kb_runs WHERE teacher_id=? AND kind='student_ask' ORDER BY id DESC LIMIT 1", teacher);
  assert.equal(card.status, 'waiting');
  const runs = (await req('/keeper/runs')).json.runs;
  const ev = runs.find((x: any) => x.id === card.id).events.find((e: any) => e.type === 'ask');
  assert.equal(ev.data.from.student, '张浩然');
  assert.equal(ev.data.from.className, '计科5班');
  assert.deepEqual(ev.data.questions[0].options, ['可以，不扣分', '可以，按迟交算', '不行']);

  // 老师先说了别的：学生来问的卡片还挂着；助教每轮知道有学生在等
  script('ta', { text: '好的' });
  await teacherSays('今天天气不错');
  assert.equal(db.get<any>('SELECT status FROM kb_runs WHERE id=?', card.id).status, 'waiting');
  assert.match(lastUser(seen.filter((s) => s.agent === 'ta').pop()!.messages), /学生在等老师回：计科5班的张浩然问「张浩然生病了/);

  // 老师在卡片上点「可以，不扣分」：助教转告学生，记成规矩
  script(
    'ta',
    {
      calls: [
        { name: 'reply_student', args: { student: '张浩然', reply: '老师同意你晚交三天，不扣分，好好养病。' } },
        { name: 'update_pack', args: { classes: ['计科5班'], kind: 'rule', title: '生病晚交', body: '生病可以晚交三天，不扣分' } },
      ],
    },
    { text: '已经告诉张浩然了，也记进了计科5班的资料包。' },
  );
  const answered = await req(`/keeper/runs/${card.id}/answer`, { answers: [{ picks: ['可以，不扣分'] }] });
  assert.equal(answered.status, 200);
  await settled(answered.json.runId);
  const said = lastUser(seen.filter((s) => s.agent === 'ta').pop()!.messages);
  assert.match(said, /计科5班的张浩然来问：张浩然生病了.*你拟的回复：老师同意你晚交三天）\n老师在卡片上答：可以，不扣分/);
  const asked = db.get<any>('SELECT * FROM student_asks WHERE card_run_id=?', card.id);
  assert.equal(asked.status, 'replied');
  assert.match(pack.renderPack(k5), /「生病晚交」生病可以晚交三天，不扣分/);
  // 学生那边多了一条老师那边来的消息
  const mine = (await req('/cot/runs', undefined, 'zhang')).json.runs;
  const notice = mine.pop();
  assert.equal(notice.kind, 'notice');
  assert.equal(notice.reply, '老师同意你晚交三天，不扣分，好好养病。');
  assert.equal(notice.events[0].data.kind, 'reply');
  // 学伴下一轮知道老师回了
  script('stu', { text: '好的' });
  await ask('zhang', '老师回了吗');
  assert.match(lastUser(seen.filter((s) => s.agent === 'stu').pop()!.messages), /这期间收到的：计科5班的王建国老师回复了你之前问的「计科5班的，第三章作业能晚交三天吗」：老师同意你晚交三天/);
});

test('老师在卡片上答了，助教没转告：照老师的原话转给学生', async () => {
  script('stu', { calls: [{ name: 'ask_ta', args: { question: '能不能把我的分数改成 90', class: '计科5班' } }] }, { text: '帮你问了老师。' });
  script('helper', { calls: [{ name: 'ask_teacher', args: { question: '张浩然想把第三章分数改成 90', options: ['不改', '改'] } }] });
  await ask('zhang', '能不能把我的分数改成90');
  const card = db.get<any>("SELECT * FROM kb_runs WHERE teacher_id=? AND kind='student_ask' AND status='waiting' ORDER BY id DESC LIMIT 1", teacher);
  script('ta', { text: '好' });
  const r = await req(`/keeper/runs/${card.id}/answer`, { answers: [{ text: '分数不改，递归边界确实没写' }] });
  await settled(r.json.runId);
  await new Promise((ok) => setTimeout(ok, 50));
  const last = (await req('/cot/runs', undefined, 'zhang')).json.runs.pop();
  assert.equal(last.kind, 'notice');
  assert.equal(last.reply, '老师的回复：分数不改，递归边界确实没写');
});

test('老师让助教通知：全班的写进资料包；只发某份作业没交的', async () => {
  script('ta', { calls: [{ name: 'notify_students', args: { classes: ['计科5班'], message: '明天停课一次' } }] }, { text: '通知了' });
  await teacherSays('告诉计科5班明天停课');
  assert.match(pack.renderPack(k5), /通知：\n- .*「明天停课一次」明天停课一次/);
  const z = (await req('/cot/runs', undefined, 'zhang')).json.runs.pop();
  const l = (await req('/cot/runs', undefined, 'liu')).json.runs.pop();
  assert.equal(z.reply, '明天停课一次');
  assert.equal(l.reply, '明天停课一次');
  // 刘欣怡、张浩然都交了第三章：再布置一份，只有刘欣怡交了
  const ch4 = hw(k5, '第四章练习');
  db.insert('submissions', { assignment_id: ch4, user_id: liu, text: '交了', submitted_at: Date.now(), late: 0, updated_at: Date.now() });
  script('ta', { calls: [{ name: 'notify_students', args: { classes: ['计科5班'], message: '第四章练习记得交', homework: '第四章练习' } }] }, { text: '提醒了' });
  await teacherSays('提醒没交第四章练习的');
  const tool = seen.filter((s) => s.agent === 'ta').pop()!.messages.filter((m) => m.role === 'tool').pop();
  assert.match(String(tool.content), /「计科5班」「第四章练习」没交的 1 人：张浩然/);
  assert.equal((await req('/cot/runs', undefined, 'liu')).json.runs.pop().reply, '明天停课一次');
  assert.equal((await req('/cot/runs', undefined, 'zhang')).json.runs.pop().reply, '第四章练习记得交');
});

test('资料包里的文件：学伴发给学生，只有这个班的学生（和老师）下载得到；学生交的作业不能放进去', async () => {
  const kb = await createKb(teacher, '程序设计');
  const sid = saveSource(kb, '第三章课件.pdf', Buffer.from('%PDF-1.4 课件'), '第三章 递归');
  const fid = pack.grantFile(k5, kb, sid, '第三章课件.pdf', '第三章的课件');
  assert.match(pack.renderPack(k5), /能发给学生的文件：\n- 「第三章课件.pdf」：第三章的课件/);
  script('stu', { calls: [{ name: 'send_file', args: { name: '第三章课件', class: '计科5班' } }] }, { text: '发给你了' });
  const r = await ask('zhang', '把第三章课件发我');
  const ev = db.all<any>("SELECT data FROM kb_events WHERE run_id=? AND type='file'", r.runId).map((e) => JSON.parse(e.data));
  assert.equal(ev[0].fileId, fid);
  const ok = await req(`/cot/files/${fid}`, undefined, 'zhang');
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(await ok.res.arrayBuffer()).toString(), '%PDF-1.4 课件');
  assert.equal((await req(`/cot/files/${fid}`, undefined, 'outsider')).status, 404);
  assert.equal((await req(`/cot/files/${fid}`, undefined, 'other')).status, 404);
  assert.equal((await req(`/cot/files/${fid}`)).status, 200);
  // 不再给了：下载不到
  assert.equal(pack.revokeFile(k5, '第三章课件.pdf'), true);
  assert.equal((await req(`/cot/files/${fid}`, undefined, 'zhang')).status, 404);
});

test('老师看学生跟学伴说的：只看说到自己班的那几轮；学生还有别的老师的班', async () => {
  script('stu', { calls: [{ name: 'my_homework', args: { class: '数据结构1班' } }] }, { text: '链表练习还没交' });
  const r = await ask('zhang', '数据结构有什么作业');
  const csid = db.value<number>('SELECT id FROM class_students WHERE class_id=? AND user_id=?', k5, zhang)!;
  const mine = (await req(`/cot/students/${csid}?class=${k5}`)).json.runs.map((x: any) => x.id);
  assert.ok(!mine.includes(r.runId), '数据结构的那一轮王老师看不到');
  assert.ok(mine.length > 3);
  const dsid = db.value<number>('SELECT id FROM class_students WHERE class_id=? AND user_id=?', ds, zhang)!;
  const theirs = (await req(`/cot/students/${dsid}?class=${ds}`, undefined, 'other')).json.runs.map((x: any) => x.id);
  assert.ok(theirs.includes(r.runId));
  assert.ok(!theirs.some((id: number) => mine.includes(id)), '说计科5班的那几轮李老师看不到');
  // 只有王老师的班的学生：都看得到
  const lsid = db.value<number>('SELECT id FROM class_students WHERE class_id=? AND user_id=?', k5, liu)!;
  assert.equal((await req(`/cot/students/${lsid}?class=${k5}`)).json.runs.length, (await req('/cot/runs', undefined, 'liu')).json.runs.length);
  assert.equal((await req(`/cot/students/${lsid}?class=${k5}`, undefined, 'other')).status, 404);
});

test('学情：助教看得到这个班学生最近问了什么', async () => {
  script('ta', { calls: [{ name: 'student_questions', args: { class: '计科5班' } }] }, { text: '这周主要在问递归' });
  await teacherSays('这周学生都问了啥');
  const tool = String(seen.filter((s) => s.agent === 'ta').pop()!.messages.filter((m) => m.role === 'tool').pop().content);
  assert.match(tool, /张浩然：递归和循环有什么区别/);
  assert.doesNotMatch(tool, /数据结构有什么作业/);
  assert.match(tool, /转来问老师的：\n张浩然：张浩然生病了.*已回/);
});

test('每个学生每天最多说几句；学生、外人碰不到老师的接口', async () => {
  db.run("INSERT INTO settings (key, value) VALUES ('stu_daily_turns', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const r = await req('/cot/messages', { message: '在吗' }, 'liu');
  assert.equal(r.status, 200);
  await settled(r.json.runId).catch(() => {});
  assert.equal((await req('/cot/messages', { message: '在吗' }, 'liu')).status, 429);
  db.run("DELETE FROM settings WHERE key='stu_daily_turns'");
  assert.equal((await req('/keeper/runs', undefined, 'zhang')).status, 403);
  assert.equal((await req('/cot/runs')).status, 403);
});

test('作业的附件学伴也能发（作业页上本来就能下载）', async () => {
  const f = db.insert('homework_files', { owner_id: teacher, assignment_id: ch3, name: '第三章课后题.pdf', size: 3, path: 'x/none', created_at: Date.now() });
  script('stu', { calls: [{ name: 'send_file', args: { name: '第三章课后题.pdf', class: '计科5班' } }] }, { text: '发给你了' });
  const r = await ask('zhang', '第三章作业的附件发我');
  const ev = db.all<any>("SELECT data FROM kb_events WHERE run_id=? AND type='file'", r.runId).map((e) => JSON.parse(e.data));
  assert.equal(ev[0].hwFileId, f);
  assert.equal(ev[0].note, '「第三章课后题」的附件');
});

test('同一句话里学伴在同一位老师的两个班各问一次：老师那边只弹一张卡片，回一次两问都算回了', async () => {
  // 张浩然也在王老师的另一个班
  const k6 = (await req('/classes', { name: '计科6班' })).json.id as number;
  enroll(k6, zhang, '2023001', '张浩然');
  const before = db.value<number>("SELECT count(*) FROM kb_runs WHERE teacher_id=? AND kind='student_ask'", teacher) || 0;
  script(
    'stu',
    {
      calls: [
        { name: 'ask_ta', args: { question: '下周三请假', class: '计科5班' } },
        { name: 'ask_ta', args: { question: '下周三请假', class: '计科6班' } },
      ],
    },
    { text: '帮你跟老师说了' },
  );
  script('helper', { calls: [{ name: 'ask_teacher', args: { question: '张浩然下周三请假', options: ['好的'] } }] });
  script('helper', { calls: [{ name: 'ask_teacher', args: { question: '张浩然下周三请假（计科6班的课）', options: ['好的'] } }] });
  await ask('zhang', '下周三我请假，跟老师说一声');
  const cards = db.all<any>("SELECT * FROM kb_runs WHERE teacher_id=? AND kind='student_ask' ORDER BY id", teacher).slice(before);
  assert.equal(cards.length, 1);
  const ev = JSON.parse(db.get<any>("SELECT data FROM kb_events WHERE run_id=? AND type='ask'", cards[0].id).data);
  assert.match(ev.questions[0].question, /张浩然下周三请假\n另外（计科6班）：张浩然下周三请假（计科6班的课）/);
  script('ta', { calls: [{ name: 'reply_student', args: { student: '张浩然', reply: '收到，准假' } }] }, { text: '回了' });
  const r = await req(`/keeper/runs/${cards[0].id}/answer`, { answers: [{ picks: ['好的'] }] });
  await settled(r.json.runId);
  const rows = db.all<any>('SELECT status FROM student_asks WHERE card_run_id=?', cards[0].id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === 'replied'));
});

test('助教回学伴时带着老师知识库的文件目录（原件标出来，学生交的不列）', async () => {
  script('stu', { calls: [{ name: 'ask_ta', args: { question: '有第三章课件吗', class: '计科5班' } }] }, { text: '有' });
  script('helper', { text: '有，在资料包里' });
  await ask('zhang', '有第三章课件吗');
  const h = seen.filter((s) => s.agent === 'helper').pop()!;
  assert.match(lastUser(h.messages), /老师的知识库里有：\n「程序设计」：第三章课件\.pdf（原件）|老师的知识库里/);
});

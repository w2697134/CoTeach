import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

process.env.CT_DATA_DIR = mkdtempSync(join(tmpdir(), 'ct-messages-'));
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
// 建班、布置作业时助教在后台写资料包、批改，这里都不让它跑（不调模型）
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { runTaTool } = await import('../src/assistant/tools.js');
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
  zhao: user('赵六', 'student'),
};
type Who = keyof typeof ids;
const who = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, cookie(v)])) as Record<Who, string>;
async function req(path: string, as: Who = 'teacher', body?: unknown, method?: string) {
  const raw = body instanceof Uint8Array;
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: who[as], 'x-tv2': '1', 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
    ...(body === undefined ? {} : { body: raw ? (body as Uint8Array) : JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: (type.includes('json') ? await res.json() : null) as any, res };
}
async function joinClass(classId: number, as: Who, no: string, name: string) {
  const code = (await req(`/classes/${classId}`)).json.code;
  assert.equal((await req('/classes/join', as, { code, studentNo: no, name })).status, 200);
}
const groupOf = async (classId: number, as: Who = 'teacher') => (await req('/messages', as)).json.chats.find((c: any) => c.classId === classId);
const inboxOf = async (as: Who) => (await req('/messages/inbox', as)).json.items;

// 两门课：计科5班（张三、李四、王五），计科6班（赵六、张三）；李老师另有一门
const k5 = (await req('/classes', 'teacher', { name: '计科5班' })).json.id as number;
const k6 = (await req('/classes', 'teacher', { name: '计科6班' })).json.id as number;
const theirs = (await req('/classes', 'other', { name: '别人的课' })).json.id as number;
await joinClass(k5, 'zhang', '2025000001', '张三');
await joinClass(k5, 'li', '2025000002', '李四');
await joinClass(k5, 'wang', '2025000003', '王五');
await joinClass(k6, 'zhao', '2025000004', '赵六');
await joinClass(k6, 'zhang', '2025000001', '张三');

test('课程群：每门课自动有一个群，老师和这门课的学生在里面；别的课的学生、别的老师看不到也发不了', async () => {
  const g5 = await groupOf(k5);
  assert.ok(g5, '老师的列表里有计科5班的群');
  assert.equal(g5.title, '计科5班');
  assert.equal((await groupOf(k5, 'zhang')).id, g5.id);
  assert.equal(await groupOf(k5, 'zhao'), undefined);
  assert.equal((await req(`/messages/chats/${g5.id}`, 'zhao')).status, 404);
  assert.equal((await req(`/messages/chats/${g5.id}`, 'other')).status, 404);
  assert.equal((await req(`/messages/chats/${g5.id}`, 'zhao', { text: '我也说一句' })).status, 404);
  const opened = (await req(`/messages/chats/${g5.id}`, 'zhang')).json;
  assert.deepEqual(
    opened.members.map((m: any) => [m.name, m.teacher]),
    [
      ['王建国', true],
      ['张三', false],
      ['李四', false],
      ['王五', false],
    ],
  );
  // 发一句：别人那边算一条没读，打开就读了
  assert.equal((await req(`/messages/chats/${g5.id}`, 'zhang', { text: '  ' })).status, 400);
  assert.equal((await req(`/messages/chats/${g5.id}`, 'zhang', { text: '老师，明天几点上课？' })).status, 200);
  assert.equal((await groupOf(k5, 'li')).unread, 1);
  assert.equal((await groupOf(k5, 'zhang')).unread, 0);
  const before = (await req('/messages/unread', 'teacher')).json.count;
  const seen = (await req(`/messages/chats/${g5.id}`, 'teacher')).json.messages;
  assert.deepEqual(
    seen.map((m: any) => [m.kind, m.text, m.from.name, m.mine]),
    [['text', '老师，明天几点上课？', '张三', false]],
  );
  assert.equal((await req('/messages/unread', 'teacher')).json.count, before - 1);
  // 只取某一条以后的（打开着的会话几秒刷一次）
  const last = seen[0].id;
  await req(`/messages/chats/${g5.id}`, 'teacher', { text: '八点，别迟到' });
  assert.deepEqual(
    (await req(`/messages/chats/${g5.id}?after=${last}`, 'li')).json.messages.map((m: any) => [m.text, m.from.teacher]),
    [['八点，别迟到', true]],
  );
});

test('私聊：同一门课里的老师和学生之间谁都能先开口；学生之间、不在一门课的不行；别人看不到', async () => {
  const dm = (await req('/messages/dm', 'wang', { userId: ids.teacher })).json.id;
  assert.ok(dm);
  assert.equal((await req('/messages/dm', 'teacher', { userId: ids.wang })).json.id, dm, '两个人只有一个私聊');
  assert.equal((await req('/messages/dm', 'wang', { userId: ids.zhang })).status, 404);
  assert.equal((await req('/messages/dm', 'wang', { userId: ids.other })).status, 404);
  assert.equal((await req('/messages/dm', 'other', { userId: ids.wang })).status, 404);
  await req(`/messages/chats/${dm}`, 'wang', { text: '老师，实验二我晚一天交可以吗' });
  assert.equal((await req(`/messages/chats/${dm}`, 'li')).status, 404);
  assert.equal((await req(`/messages/chats/${dm}`, 'other')).status, 404);
  const mine = (await req('/messages', 'teacher')).json.chats.find((c: any) => c.id === dm);
  assert.equal(mine.title, '王五');
  assert.equal(mine.unread, 1);
  assert.equal((await req('/messages', 'wang')).json.chats.find((c: any) => c.id === dm).title, '王建国');
});

test('群里发文件：这门课的人下载得到，别的人下载不到；文件只能用一次', async () => {
  const up = await req('/homework/files?name=%E8%AF%BE%E4%BB%B6.pdf', 'teacher', new TextEncoder().encode('%PDF-1.4 课件'));
  assert.equal(up.status, 200);
  const g5 = await groupOf(k5);
  assert.equal((await req(`/messages/chats/${g5.id}`, 'teacher', { fileId: up.json.id })).status, 200);
  assert.equal((await req(`/messages/chats/${g5.id}`, 'teacher', { fileId: up.json.id })).status, 400);
  const msg = (await req(`/messages/chats/${g5.id}`, 'li')).json.messages.pop();
  assert.equal(msg.kind, 'file');
  assert.equal(msg.file.name, '课件.pdf');
  assert.equal((await req(`/homework/files/${up.json.id}`, 'li')).status, 200);
  assert.equal((await req(`/homework/files/${up.json.id}`, 'zhao')).status, 404);
  assert.equal((await req(`/homework/files/${up.json.id}`, 'other')).status, 404);
  // 别人传的文件不能拿来发
  const theirFile = (await req('/homework/files?name=a.txt', 'zhang', new TextEncoder().encode('x'))).json.id;
  assert.equal((await req(`/messages/chats/${g5.id}`, 'teacher', { fileId: theirFile })).status, 400);
});

test('通知：发给两门课，群里各一张卡、每个学生收件箱一条；学生点开算读了；老师看到读了几个、谁没读，能提醒没读的', async () => {
  // 学生发不了，别的老师发不到我的课
  assert.equal((await req('/messages/notices', 'zhang', { classIds: [k5], text: '明天停课' })).status, 403);
  assert.equal((await req('/messages/notices', 'other', { classIds: [k5], text: '明天停课' })).status, 404);
  const r = await req('/messages/notices', 'teacher', { classIds: [k5, k6], text: '下周三停课一次，作业照常交' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.id;
  for (const k of [k5, k6]) {
    const g = await groupOf(k);
    const card = (await req(`/messages/chats/${g.id}`)).json.messages.pop();
    assert.deepEqual([card.kind, card.ref, card.text], ['notice', id, '下周三停课一次，作业照常交']);
  }
  // 张三在两门课里，只算一个人、收件箱一条
  let v = (await req(`/messages/notices/${id}`)).json;
  assert.deepEqual([v.read, v.total], [0, 4]);
  assert.deepEqual(v.unread.sort(), ['张三', '李四', '王五', '赵六'].sort());
  const zi = (await inboxOf('zhang')).filter((x: any) => x.kind === 'notice');
  assert.equal(zi.length, 1);
  assert.equal(zi[0].read, false);
  assert.equal((await req(`/messages/notices/${id}`, 'other')).status, 404);
  // 学生点开：算读了，收件箱那条划掉
  const seen = (await req(`/messages/notices/${id}`, 'zhang')).json;
  assert.equal(seen.text, '下周三停课一次，作业照常交');
  assert.equal(seen.unread, undefined, '学生看不到谁没读');
  const after = (await inboxOf('zhang')).find((x: any) => x.kind === 'notice' && x.ref === id);
  assert.deepEqual([after.read, after.done], [true, true]);
  await req(`/messages/notices/${id}`, 'zhao');
  v = (await req(`/messages/notices/${id}`)).json;
  assert.deepEqual([v.read, v.total], [2, 4]);
  // 只算计科6班的（群里的卡片）：赵六、张三都读了
  const only6 = (await req(`/messages/notices/${id}?class=${k6}`)).json;
  assert.deepEqual([only6.read, only6.total, only6.unread], [2, 2, []]);
  // 提醒没读的：李四、王五收件箱那条顶上来、重新算没读
  await req(`/messages/inbox/read`, 'li', {});
  assert.equal((await inboxOf('li')).find((x: any) => x.ref === id).read, true);
  assert.equal((await req(`/messages/notices/${id}/remind`, 'zhang', {})).status, 403);
  const reminded = (await req(`/messages/notices/${id}/remind`, 'teacher', {})).json;
  assert.deepEqual([reminded.reminded, reminded.names.sort()], [2, ['李四', '王五'].sort()]);
  const li = (await inboxOf('li')).find((x: any) => x.ref === id);
  assert.deepEqual([li.read, li.title], [false, '老师提醒你看通知']);
  assert.equal((await inboxOf('zhang')).find((x: any) => x.ref === id).done, true, '读过的不提醒');
});

test('签到：群里一张卡、学生收件箱一条；点卡片、开链接都能签；时间过了签不上；老师能补签；学生和别的老师发起不了', async () => {
  assert.equal((await req('/messages/checkins', 'zhang', { classId: k5 })).status, 403);
  assert.equal((await req('/messages/checkins', 'other', { classId: k5 })).status, 404);
  const id = (await req('/messages/checkins', 'teacher', { classId: k5 })).json.id;
  const g5 = await groupOf(k5);
  assert.deepEqual(
    [(await req(`/messages/chats/${g5.id}`)).json.messages.pop().kind, (await inboxOf('li')).find((x: any) => x.kind === 'checkin' && x.ref === id).done],
    ['checkin', false],
  );
  let v = (await req(`/messages/checkins/${id}`)).json;
  assert.equal(v.open, true);
  assert.equal(Math.round((v.endsAt - v.startedAt) / 60000), 5, '默认 5 分钟');
  assert.deepEqual([v.signed, v.total], [0, 3]);
  assert.ok(v.token);
  // 学生点卡片签；开链接签；别的课的学生签不了；学生看不到签到链接
  assert.equal((await req(`/messages/checkins/${id}/sign`, 'zhang', {})).status, 200);
  assert.equal((await req(`/messages/checkin-links/${v.token}`, 'li', {})).json.className, '计科5班');
  assert.equal((await req(`/messages/checkin-links/${v.token}`, 'zhao', {})).status, 404);
  assert.equal((await req(`/messages/checkins/${id}/sign`, 'zhao', {})).status, 404);
  assert.equal((await req(`/messages/checkin-links/nope`, 'li', {})).status, 404);
  const mine = (await req(`/messages/checkins/${id}`, 'li')).json;
  assert.ok(mine.mine);
  assert.equal(mine.token, undefined);
  assert.equal((await inboxOf('li')).find((x: any) => x.kind === 'checkin' && x.ref === id).done, true);
  v = (await req(`/messages/checkins/${id}`)).json;
  assert.deepEqual([v.signed, v.people.filter((p: any) => !p.at).map((p: any) => p.name)], [2, ['王五']]);
  // 时间过了：链接、卡片都签不上；老师还能补签
  db.run('UPDATE checkins SET ends_at=? WHERE id=?', Date.now() - 1000, id);
  const late = await req(`/messages/checkin-links/${v.token}`, 'wang', {});
  assert.equal(late.status, 409);
  assert.match(late.json.error, /结束/);
  assert.equal((await req(`/messages/checkins/${id}/sign`, 'wang', {})).status, 409);
  assert.equal((await req(`/messages/checkins/${id}/mark`, 'zhang', { userId: ids.wang })).status, 403);
  assert.equal((await req(`/messages/checkins/${id}/mark`, 'teacher', { userId: ids.zhao })).status, 404, '不是这门课的学生');
  assert.equal((await req(`/messages/checkins/${id}/mark`, 'teacher', { userId: ids.wang })).json.name, '王五');
  v = (await req(`/messages/checkins/${id}`)).json;
  assert.deepEqual([v.open, v.signed, v.people.find((p: any) => p.name === '王五').by], [false, 3, 'teacher']);
  // 同一门课再发起：上一次还开着就先结束
  const a = (await req('/messages/checkins', 'teacher', { classId: k6, minutes: 10 })).json.id;
  const b = (await req('/messages/checkins', 'teacher', { classId: k6, minutes: 3 })).json.id;
  assert.equal((await req(`/messages/checkins/${a}`)).json.open, false);
  assert.equal((await req(`/messages/checkins/${b}`)).json.open, true);
});

test('选人：只点这门课的学生，一轮里不重复，点完一轮开新一轮；群里出一张卡；学生、别的老师点不了', async () => {
  assert.equal((await req('/messages/picks', 'zhang', { classId: k5 })).status, 403);
  assert.equal((await req('/messages/picks', 'other', { classId: k5 })).status, 404);
  const got = [];
  for (let i = 0; i < 3; i++) got.push((await req('/messages/picks', 'teacher', { classId: k5 })).json);
  assert.deepEqual(got.map((x) => x.name).sort(), ['张三', '李四', '王五'].sort());
  assert.deepEqual(
    got.map((x) => [x.round, x.left, x.total]),
    [
      [1, 2, 3],
      [1, 1, 3],
      [1, 0, 3],
    ],
  );
  const next = (await req('/messages/picks', 'teacher', { classId: k5 })).json;
  assert.deepEqual([next.round, next.left], [2, 2]);
  const g5 = await groupOf(k5);
  const card = (await req(`/messages/chats/${g5.id}`, 'li')).json.messages.pop();
  assert.deepEqual([card.kind, card.ref, card.text], ['pick', next.id, next.name]);
  assert.equal((await req(`/messages/picks/${next.id}`, 'li')).json.name, next.name);
  assert.equal((await req(`/messages/picks/${next.id}`, 'zhao')).status, 404);
});

test('收件箱：快截止了还有人没交来一条（一份只来一次）；点开算读、办完划掉；全部已读', async () => {
  const t = Date.now();
  const hw = db.insert('assignments', { class_id: k5, teacher_id: ids.teacher, title: '实验二', body: '', points: 100, due_at: t + 5 * 3600_000, allow_late: 1, publish_at: t - 1000, created_at: t, updated_at: t });
  db.insert('submissions', { assignment_id: hw, user_id: ids.zhang, text: '交了', submitted_at: t, late: 0, updated_at: t });
  let due = (await inboxOf('teacher')).filter((x: any) => x.kind === 'due');
  assert.equal(due.length, 1);
  assert.match(due[0].title, /「实验二」.*截止，还有 2 人没交/);
  assert.equal(due[0].body, '计科5班：李四、王五');
  assert.equal(due[0].link, `/classes/${k5}/homework/${hw}`);
  await inboxOf('teacher');
  assert.equal((await inboxOf('teacher')).filter((x: any) => x.kind === 'due').length, 1, '一份作业只来一次');
  const unread = (await req('/messages', 'teacher')).json.inbox.unread;
  assert.ok(unread >= 1);
  assert.equal((await req(`/messages/inbox/${due[0].id}`, 'li', {})).status, 404, '别人的收件箱动不了');
  await req(`/messages/inbox/${due[0].id}`, 'teacher', {});
  due = (await inboxOf('teacher')).filter((x: any) => x.kind === 'due');
  assert.deepEqual([due[0].read, due[0].done], [true, false]);
  await req(`/messages/inbox/${due[0].id}`, 'teacher', { done: true });
  assert.equal((await inboxOf('teacher')).find((x: any) => x.kind === 'due').done, true);
  assert.equal((await req('/messages', 'teacher')).json.inbox.unread, unread - 1);
  await req('/messages/inbox/read', 'teacher', {});
  assert.equal((await req('/messages', 'teacher')).json.inbox.unread, 0);
});

test('CoT 助教办这些调的是页面上那套接口：效果一样，别的老师的课办不了', async () => {
  const ctx = (uid: number, name: string) => {
    const runId = db.insert('kb_runs', { teacher_id: uid, agent: 'ta', kind: 'chat', status: 'running', request: '', created_by: uid, created_at: Date.now() });
    return { user: { id: uid, name }, ref: { teacherId: uid, runId, kbId: null }, startJob: () => 0 };
  };
  const me = ctx(ids.teacher, '王建国');
  const call = (c: typeof me, name: string, args: Record<string, unknown>) => runTaTool(c, { id: randomUUID(), name, args } as any);
  const cards = () => db.all<any>("SELECT data FROM kb_events WHERE run_id=? AND type='action' ORDER BY id", me.ref.runId).map((e) => JSON.parse(e.data));

  // 通知：走发通知的接口（审计里有一笔），群里有卡、学生收件箱有一条；卡片带着这条通知
  let out = await call(me, 'notify_students', { classes: ['计科6班'], message: '周五交实验报告' });
  assert.equal(out.ok, true, out.content);
  const nid = db.value<number>('SELECT max(id) FROM notices')!;
  assert.ok(db.get("SELECT id FROM audit_logs WHERE action='notice.send' AND target=?", `notice:${nid}`), '走的是 /messages/notices');
  assert.equal((await inboxOf('zhao')).filter((x: any) => x.kind === 'notice' && x.ref === nid).length, 1);
  assert.deepEqual(cards().pop().live, { type: 'notice', id: nid });
  await req(`/messages/notices/${nid}`, 'zhao');
  out = await call(me, 'notice_status', {});
  assert.match(out.content, /读了 1\/2，没读：张三/);
  out = await call(me, 'remind_unread', { notice: '实验报告' });
  assert.match(out.content, /提醒了没读的 1 人：张三/);

  // 签到、看谁没签、补签
  out = await call(me, 'start_checkin', { class: '计科5班', minutes: 3 });
  assert.match(out.content, /「计科5班」签到开始了/);
  const cid = db.value<number>('SELECT max(id) FROM checkins')!;
  assert.ok(db.get("SELECT id FROM audit_logs WHERE action='checkin.start' AND target=?", `checkin:${cid}`));
  assert.equal(Math.round((db.value<number>('SELECT ends_at - started_at FROM checkins WHERE id=?', cid)! / 60000)), 3);
  await req(`/messages/checkins/${cid}/sign`, 'li', {});
  out = await call(me, 'checkin_status', {});
  assert.match(out.content, /还在签，签了 1\/3，没签：张三、王五/);
  out = await call(me, 'mark_checkin', { student: '王五' });
  assert.match(out.content, /给「计科5班」的王五补签了/);
  // 张三在两门课里：没说哪门课要问
  assert.equal((await call(me, 'mark_checkin', { student: '张三' })).ok, true, '张三是同一个人，在哪门课都对得上');

  // 选人、再点一个
  out = await call(me, 'pick_student', { class: '计科6班' });
  const first = out.content.match(/点到了(.+?)（/)![1];
  out = await call(me, 'pick_student', { class: '计科6班' });
  assert.notEqual(out.content.match(/点到了(.+?)（/)![1], first, '一轮里不重复');
  assert.equal(cards().pop().live.type, 'pick');

  // 私聊、群里说
  out = await call(me, 'send_message', { student: '李四', text: '今晚把实验二交了' });
  assert.equal(out.ok, true, out.content);
  const dm = (await req('/messages', 'li')).json.chats.find((c: any) => c.kind === 'dm');
  assert.deepEqual(
    (await req(`/messages/chats/${dm.id}`, 'li')).json.messages.map((m: any) => [m.text, m.from.name]),
    [['今晚把实验二交了', '王建国']],
  );
  out = await call(me, 'send_message', { class: '计科5班', text: '明天交作业' });
  assert.equal((await req(`/messages/chats/${(await groupOf(k5, 'wang')).id}`, 'wang')).json.messages.pop().text, '明天交作业');

  // 别的老师：对不上我的课，接口那一关也过不去
  const them = ctx(ids.other, '李老师');
  assert.match((await call(them, 'pick_student', { class: '计科5班' })).content, /没办成：没有叫「计科5班」的班/);
  assert.match((await call(them, 'notice_status', {})).content, /没办成/);
  db.insert('class_students', { class_id: theirs, student_no: '2025000009', name: '李四', user_id: ids.li, created_at: Date.now() });
  assert.equal((await call(them, 'send_message', { student: '李四', text: '你好' })).ok, true, '李四也在李老师的课里，能私聊');
  const bad = await req('/messages/checkins', 'other', { classId: k5 });
  assert.equal(bad.status, 404, '助教走的这个接口，别的老师直接调也不行');
});

test('撤回通知：发的老师能撤，学生、别的老师撤不了；撤了群里留一行灰字、学生收件箱里没了、读没读不再算；再撤说一句已经撤回了', async () => {
  const { messageFacts } = await import('../src/messages/core.js');
  const up = await req('/homework/files?name=%E8%B0%83%E8%AF%BE.txt', 'teacher', new TextEncoder().encode('调课安排'));
  const before = { li: (await req('/messages/unread', 'li')).json.count, g5: (await groupOf(k5, 'li')).unread };
  const id = (await req('/messages/notices', 'teacher', { classIds: [k5, k6], text: '周四的实验课改到周五', fileIds: [up.json.id] })).json.id;
  // 发出去：李四收件箱一条、群里一条没读；张三点开算读了；附件李四下载得到；助教每轮带的那行里有它
  assert.equal((await req('/messages/unread', 'li')).json.count, before.li + 2);
  assert.equal((await groupOf(k5, 'li')).unread, before.g5 + 1);
  await req(`/messages/notices/${id}`, 'zhang');
  assert.deepEqual([(await req(`/messages/notices/${id}`)).json.read, (await req(`/messages/notices/${id}`)).json.total], [1, 4]);
  assert.equal((await req(`/homework/files/${up.json.id}`, 'li')).status, 200);
  assert.match(messageFacts(ids.teacher) || '', /周四的实验课改到周五/);

  // 学生撤不了；别的老师撤不了（当没有这条）
  assert.equal((await req(`/messages/notices/${id}/recall`, 'li', {})).status, 403);
  assert.equal((await req(`/messages/notices/${id}/recall`, 'other', {})).status, 404);
  assert.equal(db.value('SELECT recalled_at FROM notices WHERE id=?', id), null);

  // 发的老师撤回
  const r = await req(`/messages/notices/${id}/recall`, 'teacher', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(db.get("SELECT id FROM audit_logs WHERE action='notice.recall' AND target=?", `notice:${id}`));

  // 学生收件箱里没了（读过的、没读的都没了），左边栏的数回到发之前，群里这一条不算没读
  for (const s of ['zhang', 'li', 'wang', 'zhao'] as const) assert.equal((await inboxOf(s)).filter((x: any) => x.kind === 'notice' && x.ref === id).length, 0, s);
  assert.equal((await req('/messages/unread', 'li')).json.count, before.li);
  assert.equal((await groupOf(k5, 'li')).unread, before.g5);
  // 群里那张卡换成一行灰字：学生那边「老师撤回了一条通知」，老师那边「你撤回了一条通知」；话不再给出去
  assert.equal((await groupOf(k5, 'li')).last.text, '老师撤回了一条通知');
  assert.deepEqual([(await groupOf(k6)).last.text, (await groupOf(k6)).last.recalled], ['你撤回了一条通知', true]);
  const g5 = await groupOf(k5);
  const card = (await req(`/messages/chats/${g5.id}`, 'li')).json.messages.find((m: any) => m.kind === 'notice' && m.ref === id);
  assert.deepEqual([card.recalled, card.text], [true, '']);
  assert.equal((await req(`/messages/chats/${g5.id}`, 'teacher')).json.messages.find((m: any) => m.ref === id && m.kind === 'notice').recalled, true);

  // 读没读不再算：老师那边不再给读了几个；学生点开不算读、看不到话和附件；助教每轮带的那行里没有它；提醒没读的办不了
  const mine = (await req(`/messages/notices/${id}`)).json;
  assert.deepEqual([mine.recalled, mine.text, mine.read, mine.total, mine.unread], [true, '周四的实验课改到周五', undefined, undefined, undefined]);
  const reads = db.value<number>('SELECT count(*) FROM notice_reads WHERE notice_id=?', id);
  const theirs = (await req(`/messages/notices/${id}`, 'wang')).json;
  assert.deepEqual([theirs.recalled, theirs.text, theirs.files], [true, '', []]);
  assert.equal(db.value<number>('SELECT count(*) FROM notice_reads WHERE notice_id=?', id), reads);
  assert.equal((await inboxOf('wang')).filter((x: any) => x.kind === 'notice' && x.ref === id).length, 0, '点开撤回了的也不再进收件箱');
  assert.doesNotMatch(messageFacts(ids.teacher) || '', /周四的实验课改到周五/);
  const remind = await req(`/messages/notices/${id}/remind`, 'teacher', {});
  assert.equal(remind.status, 409);
  assert.match(remind.json.error, /已经撤回了/);
  // 附件：学生下载不到了，老师自己传的照样能下
  assert.equal((await req(`/homework/files/${up.json.id}`, 'li')).status, 404);
  assert.equal((await req(`/homework/files/${up.json.id}`, 'teacher')).status, 200);

  // 再撤一次：一句大白话
  const again = await req(`/messages/notices/${id}/recall`, 'teacher', {});
  assert.equal(again.status, 409);
  assert.equal(again.json.error, '这条通知已经撤回了');
});

test('第 25 次迁移：原来挂在主对话里的学生来问、提议分专门助手的卡片搬进老师的收件箱，还在等的算没读', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrations } = await import('../src/db/schema.js');
  const raw = new DatabaseSync(':memory:');
  migrations.slice(0, 24).forEach((sql) => raw.exec(sql));
  raw.prepare("INSERT INTO users (id, username, name, role, password_hash, created_at) VALUES (1, 't', '王建国', 'teacher', 'x', 1)").run();
  const run = (id: number, kind: string, status: string) =>
    raw.prepare("INSERT INTO kb_runs (id, teacher_id, agent, kind, status, request, created_by, created_at) VALUES (?, 1, 'ta', ?, ?, '', 1, ?)").run(id, kind, status, id * 1000);
  const ask = (runId: number, data: object) => raw.prepare("INSERT INTO kb_events (run_id, type, data, created_at) VALUES (?, 'ask', ?, 1)").run(runId, JSON.stringify(data));
  run(1, 'student_ask', 'waiting');
  ask(1, { questions: [{ question: '能晚交两天吗', options: ['可以', '不行'] }], from: { student: '张浩然' } });
  run(2, 'suggest', 'done');
  ask(2, { questions: [{ question: '要不要分出一个批改助手', options: ['分出来', '先不用'] }], suggest: { name: '实验二批改助手' } });
  run(3, 'chat', 'done');
  raw.exec(migrations[24]);
  const rows = raw.prepare('SELECT ref_id, kind, title, body, read_at IS NULL AS unread, done_at IS NULL AS open FROM inbox WHERE user_id=1 ORDER BY ref_id').all() as any[];
  assert.deepEqual(
    rows.map((r) => [r.ref_id, r.kind, r.title, r.body, r.unread, r.open]),
    [
      [1, 'ask', '张浩然来问', '能晚交两天吗', 1, 1],
      [2, 'ask', '要不要分出「实验二批改助手」', '要不要分出一个批改助手', 0, 0],
    ],
  );
  assert.deepEqual(
    raw.prepare('SELECT id, place FROM kb_runs ORDER BY id').all().map((r: any) => [r.id, r.place]),
    [
      [1, 'inbox'],
      [2, 'inbox'],
      [3, null],
    ],
  );
  raw.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';

const dir = mkdtempSync(join(tmpdir(), 'coteach-homework-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const app = createApp();

const user = (name: string, role: string) =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const who = {
  teacher: cookie(user('王建国', 'teacher')),
  other: cookie(user('另一位老师', 'teacher')),
  zhang: cookie(user('张三', 'student')),
  li: cookie(user('李四', 'student')),
  wang: cookie(user('王五', 'student')),
};
type Who = keyof typeof who;
async function req(path: string, as: Who = 'teacher', body?: unknown, method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: who[as], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: (type.includes('json') ? await res.json() : null) as any, res };
}
async function upload(as: Who, name: string, text: string) {
  const res = await app.request('/api/homework/files?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { cookie: who[as], 'x-tv2': '1', 'Content-Type': 'application/octet-stream' },
    body: new TextEncoder().encode(text),
  });
  return (await res.json()) as any;
}
const download = (as: Who, id: number) => app.request(`/api/homework/files/${id}`, { headers: { cookie: who[as] } });
const hour = 3600_000;

test('作业：布置、交、批、退回、成绩表', async (t) => {
  // 两个班；张三、李四在甲班，王五在乙班
  const a = (await req('/classes', 'teacher', { name: '甲班' })).json.id;
  const b = (await req('/classes', 'teacher', { name: '乙班' })).json.id;
  const codeA = (await req(`/classes/${a}`)).json.code,
    codeB = (await req(`/classes/${b}`)).json.code;
  await req('/classes/join', 'zhang', { code: codeA, studentNo: '2025000001', name: '张三' });
  await req('/classes/join', 'li', { code: codeA, studentNo: '2025000002', name: '李四' });
  await req('/classes/join', 'wang', { code: codeB, studentNo: '2025000003', name: '王五' });
  // 甲班名单上还有一个没加入的
  await req(`/classes/${a}/students`, 'teacher', { roster: '2025000009 赵九' });
  let hw = 0,
    hwB = 0;

  await t.test('一次发给两个班，每个班一份，附件各挂一份；学生只看到自己班的', async () => {
    const f = await upload('teacher', '实验一要求.txt', '写一个冒泡排序');
    assert.equal(f.size, 21);
    const made = await req('/homework', 'teacher', {
      classIds: [a, b],
      title: '实验一',
      body: '照附件做',
      points: 10,
      dueAt: Date.now() + 2 * hour,
      allowLate: true,
      publishAt: null,
      fileIds: [f.id],
    });
    assert.equal(made.status, 200);
    [hw, hwB] = made.json.ids;
    const mine = (await req(`/homework/${hw}`, 'zhang')).json;
    assert.equal(mine.title, '实验一');
    assert.equal(mine.files.length, 1);
    assert.equal(mine.status, 'todo');
    assert.equal(await (await download('zhang', mine.files[0].id)).text(), '写一个冒泡排序');
    const theirs = (await req(`/homework/${hwB}`, 'wang')).json;
    assert.equal(theirs.files[0].name, '实验一要求.txt');
    // 王五不在甲班
    assert.equal((await req(`/homework/${hw}`, 'wang')).status, 404);
    assert.equal((await download('wang', mine.files[0].id)).status, 404);
    // 学生卡片上：甲班 1 份待交
    assert.equal((await req('/classes', 'zhang')).json.classes.find((k: any) => k.id === a).todo, 1);
  });
  await t.test('定时发布：没到时间学生看不到，也不算待交；老师看得到', async () => {
    const later = (await req('/homework', 'teacher', { classIds: [a], title: '下周的', body: '', points: 100, dueAt: null, allowLate: true, publishAt: Date.now() + 24 * hour, fileIds: [] })).json.ids[0];
    assert.equal((await req(`/homework/class/${a}`, 'zhang')).json.homework.some((h: any) => h.id === later), false);
    assert.equal((await req(`/homework/${later}`, 'zhang')).status, 404);
    assert.equal((await req(`/homework/class/${a}`)).json.homework.some((h: any) => h.id === later), true);
    assert.equal((await req('/classes', 'zhang')).json.classes.find((k: any) => k.id === a).todo, 1);
    // 截止在发布之前不行
    assert.equal((await req('/homework', 'teacher', { classIds: [a], title: '错的', body: '', points: 10, dueAt: Date.now() - hour, allowLate: true, publishAt: null, fileIds: [] })).status, 400);
  });
  await t.test('学生交文字和文件，截止前能改；老师看到谁交了、点开看内容', async () => {
    const f = await upload('zhang', 'bubble.py', 'print(1)');
    assert.equal((await req(`/homework/${hw}/submit`, 'zhang', { text: '第一版', fileIds: [f.id] })).status, 200);
    assert.equal((await req(`/homework/${hw}/submit`, 'zhang', { text: '改过的', fileIds: [f.id] })).status, 200);
    assert.equal((await req(`/homework/${hw}/submit`, 'zhang', { text: '  ', fileIds: [] })).status, 400);
    // 别人的文件挂不上
    assert.equal((await req(`/homework/${hw}/submit`, 'li', { text: '抄的', fileIds: [f.id] })).status, 400);
    const view = (await req(`/homework/${hw}`)).json;
    const zhang = view.students.find((s: any) => s.name === '张三');
    assert.equal(zhang.status, 'submitted');
    assert.equal(view.students.find((s: any) => s.name === '李四').status, 'todo');
    assert.equal(view.students.find((s: any) => s.name === '赵九').joined, false);
    const one = (await req(`/homework/${hw}/students/${zhang.id}`)).json;
    assert.equal(one.submission.text, '改过的');
    assert.equal(await (await download('teacher', one.submission.files[0].id)).text(), 'print(1)');
    // 同学看不到别人交的文件；别的老师也看不到
    assert.equal((await download('li', one.submission.files[0].id)).status, 404);
    assert.equal((await download('other', one.submission.files[0].id)).status, 404);
    assert.equal((await req(`/homework/${hw}/students/${zhang.id}`, 'other')).status, 404);
    // 老师卡片上：甲班 1 份待批；学生卡片上张三不再待交
    assert.equal((await req('/classes')).json.classes.find((k: any) => k.id === a).pending, 1);
    assert.equal((await req('/classes', 'zhang')).json.classes.find((k: any) => k.id === a).todo, 0);
  });
  await t.test('打分不能超过满分；批了以后学生看到分数评语，不能再改', async () => {
    const zhang = (await req(`/homework/${hw}`)).json.students.find((s: any) => s.name === '张三');
    assert.equal((await req(`/homework/${hw}/students/${zhang.id}/grade`, 'teacher', { score: 11, comment: '' })).status, 400);
    assert.equal((await req(`/homework/${hw}/students/${zhang.id}/grade`, 'teacher', { score: 8.5, comment: '边界没处理' })).status, 200);
    const mine = (await req(`/homework/${hw}`, 'zhang')).json;
    assert.deepEqual({ status: mine.status, score: mine.mine.score, comment: mine.mine.comment }, { status: 'graded', score: 8.5, comment: '边界没处理' });
    assert.equal(mine.lock, '已经批改了，要改找老师退回');
    assert.equal((await req(`/homework/${hw}/submit`, 'zhang', { text: '再改', fileIds: [] })).status, 409);
    // 没交的批不了
    const li = (await req(`/homework/${hw}`)).json.students.find((s: any) => s.name === '李四');
    assert.equal((await req(`/homework/${hw}/students/${li.id}/grade`, 'teacher', { score: 5, comment: '' })).status, 409);
    assert.equal((await req('/classes')).json.classes.find((k: any) => k.id === a).pending, 0);
  });
  await t.test('过了截止：允许迟交的标迟交，不允许的交不了；退回的截止后也能重交', async () => {
    db.run('UPDATE assignments SET due_at=? WHERE id=?', Date.now() - hour, hw);
    const li = await req(`/homework/${hw}/submit`, 'li', { text: '晚了点', fileIds: [] });
    assert.equal(li.status, 200);
    assert.equal((await req(`/homework/${hw}`, 'li')).json.status, 'late');
    db.run('UPDATE assignments SET allow_late=0 WHERE id=?', hw);
    assert.equal((await req(`/homework/${hw}/submit`, 'li', { text: '再晚点', fileIds: [] })).status, 409);
    const zhang = (await req(`/homework/${hw}`)).json.students.find((s: any) => s.name === '张三');
    assert.equal((await req(`/homework/${hw}/students/${zhang.id}/return`, 'teacher', { comment: '重写排序' })).status, 200);
    const back = (await req(`/homework/${hw}`, 'zhang')).json;
    assert.deepEqual({ status: back.status, score: back.mine.score, lock: back.lock }, { status: 'returned', score: null, lock: null });
    assert.equal((await req('/classes', 'zhang')).json.classes.find((k: any) => k.id === a).todo, 1);
    assert.equal((await req(`/homework/${hw}/submit`, 'zhang', { text: '重写了', fileIds: [] })).status, 200);
    const again = (await req(`/homework/${hw}`, 'zhang')).json;
    assert.deepEqual({ status: again.status, late: again.mine.late, comment: again.mine.comment }, { status: 'submitted', late: false, comment: '重写排序' });
    assert.equal((await req(`/homework/${hw}/students/${zhang.id}/grade`, 'teacher', { score: 10, comment: '好' })).status, 200);
  });
  await t.test('成绩表：批了的折成百分制，过了截止没交的算 0，没批的不算；学生只看到自己', async () => {
    // 再布置一份已经截止的：张三交了没批，李四没交
    const h2 = (await req('/homework', 'teacher', { classIds: [a], title: '实验二', body: '', points: 20, dueAt: Date.now() + hour, allowLate: true, publishAt: null, fileIds: [] })).json.ids[0];
    await req(`/homework/${h2}/submit`, 'zhang', { text: '交了', fileIds: [] });
    db.run('UPDATE assignments SET due_at=? WHERE id=?', Date.now() - 1000, h2);
    const g = (await req(`/homework/class/${a}/grades`)).json;
    assert.deepEqual(
      g.homework.map((h: any) => h.title),
      ['实验一', '实验二'],
    );
    const row = (name: string) => g.rows.find((r: any) => r.name === name);
    assert.equal(row('张三').cells[hw].score, 10);
    assert.equal(row('张三').cells[h2].status, 'submitted');
    assert.equal(row('张三').average, 100);
    // 李四：实验一迟交没批（不算），实验二没交算 0
    assert.equal(row('李四').cells[h2].status, 'missing');
    assert.equal(row('李四').average, 0);
    // 没加入的赵九：过了截止都算缺交
    assert.equal(row('赵九').cells[hw].status, 'missing');
    const mine = (await req(`/homework/class/${a}/grades`, 'zhang')).json;
    assert.deepEqual(
      mine.rows.map((r: any) => r.name),
      ['张三'],
    );
    const res = await app.request(`/api/homework/class/${a}/grades/export`, { headers: { cookie: who.teacher } });
    assert.equal(res.status, 200);
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    assert.deepEqual(rows[0], ['学号', '姓名', '实验一（满分 10）', '实验二（满分 20）', '平均分（百分制）']);
    assert.deepEqual(rows.find((r) => r[1] === '李四'), ['2025000002', '李四', '待批', '缺交', 0]);
    assert.equal((await app.request(`/api/homework/class/${a}/grades/export`, { headers: { cookie: who.zhang } })).status, 403);
  });
  await t.test('改作业、删作业；别的老师和学生动不了', async () => {
    assert.equal((await req(`/homework/${hwB}`, 'teacher', { title: '实验一（乙班）', dueAt: null }, 'PATCH')).status, 200);
    assert.equal((await req(`/homework/${hwB}`, 'wang')).json.title, '实验一（乙班）');
    assert.equal((await req(`/homework/${hwB}`, 'other', { title: '改掉' }, 'PATCH')).status, 404);
    assert.equal((await req(`/homework/${hwB}`, 'wang', { title: '改掉' }, 'PATCH')).status, 403);
    assert.equal((await req('/homework', 'zhang', { classIds: [a], title: 'x', body: '', points: 10, dueAt: null, allowLate: true, publishAt: null, fileIds: [] })).status, 403);
    assert.equal((await req(`/homework/${hwB}`, 'teacher', undefined, 'DELETE')).status, 200);
    assert.equal((await req(`/homework/${hwB}`, 'wang')).status, 404);
    assert.deepEqual((await req(`/homework/class/${b}`, 'wang')).json.homework, []);
  });
  await t.test('归档的班：不能布置、交、批，能看', async () => {
    await req(`/classes/${a}`, 'teacher', { archived: true }, 'PATCH');
    assert.equal((await req('/homework', 'teacher', { classIds: [a], title: 'x', body: '', points: 10, dueAt: null, allowLate: true, publishAt: null, fileIds: [] })).status, 409);
    assert.equal((await req(`/homework/${hw}/submit`, 'li', { text: 'x', fileIds: [] })).status, 409);
    const zhang = (await req(`/homework/${hw}`)).json.students.find((s: any) => s.name === '张三');
    assert.equal((await req(`/homework/${hw}/students/${zhang.id}/grade`, 'teacher', { score: 9, comment: '' })).status, 409);
    assert.equal((await req(`/homework/${hw}`, 'zhang')).json.lock, '这个班已经归档了');
    assert.equal((await req(`/homework/class/${a}/grades`)).status, 200);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';

const dir = mkdtempSync(join(tmpdir(), 'coteach-classes-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const { rosterFromFile, rosterFromText } = await import('../src/classes/roster.js');
const { createApp } = await import('../src/app.js');
const app = createApp();

const user = (name: string, role: string, demo = 0) =>
  db.insert('users', { username: randomUUID(), name, role, is_demo: demo, password_hash: 'not-a-login-password', created_at: Date.now() });
const demoTeacher = user('王建国', 'teacher', 1),
  otherTeacher = user('另一位老师', 'teacher'),
  demoStudent = user('李明', 'student', 1),
  plainStudent = user('普通学生', 'student');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies = { teacher: cookie(demoTeacher), other: cookie(otherTeacher), demoStudent: cookie(demoStudent), student: cookie(plainStudent) };
async function req(path: string, who: keyof typeof cookies = 'teacher', body?: unknown, method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** 照教务网导出的样子做一份：标题、学期人数、表头、学生、表尾 */
function jiaowuSheet() {
  const rows: unknown[][] = [
    ['计算机科学与技术2025级5班学生名单'],
    ['2026—2027学年第一学期　共42人'],
    ['序号', '学号', '姓名', '性别', '班级', '备注'],
  ];
  for (let i = 1; i <= 42; i++) rows.push([i, i === 3 ? 2025120503 : `20251205${String(i).padStart(2, '0')}`, i === 2 ? '王  磊' : `学生${'甲乙丙丁戊己庚辛壬癸'[i % 10]}${i}号`.replace(/\d/g, ''), '男', '计科2505', '']);
  rows.push(['制表人：教务处']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '计科2505');
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

test('读名单', async (t) => {
  await t.test('教务网导出的表：按表头读，班名取班级那列，表尾不算', () => {
    const r = rosterFromFile('计科2505班学生名单.xlsx', jiaowuSheet());
    assert.equal(r.name, '计科2505');
    // 造的名字有重复（甲1号、甲11号去掉数字后同名），学号不同照样都在
    assert.equal(r.students.length, 42);
    assert.deepEqual(r.students[1], { studentNo: '2025120502', name: '王磊' });
    assert.equal(r.students[2].studentNo, '2025120503');
    assert.deepEqual(r.unread, []);
  });
  await t.test('粘贴的：学号姓名、姓名学号、逗号、带表头都认', () => {
    const r = rosterFromText('2025120501 陈宇航\n刘思琪\t2025120502\n2025120503，张浩然\n\n2025120504   Anna Lee');
    assert.deepEqual(
      r.students.map((s) => `${s.studentNo}${s.name}`),
      ['2025120501陈宇航', '2025120502刘思琪', '2025120503张浩然', '2025120504Anna Lee'],
    );
    const h = rosterFromText('序号\t学号\t姓名\n1\t2025120501\t陈宇航\n2\t2025120502\t刘思琪');
    assert.equal(h.students.length, 2);
  });
  await t.test('认不出的行和学号重复名字不同的行都退给老师看', () => {
    const r = rosterFromText('2025120501 陈宇航\n就这个\n2025120501 陈雨航\n2025120502');
    assert.equal(r.students.length, 1);
    assert.deepEqual(r.unread, ['就这个', '2025120501 陈雨航', '2025120502']);
  });
  await t.test('没有班级列的文字文件：班名用文件名', () => {
    const r = rosterFromFile('软工2402 学生名单.csv', new TextEncoder().encode('学号,姓名\n2024020101,赵一\n2024020102,钱二\n'));
    assert.equal(r.name, '软工2402');
    assert.equal(r.students.length, 2);
  });
  await t.test('成绩表这类：班名认标题或文件名里的班号，不拿课程名', () => {
    const sheet = (title: string) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[title], ['学号', '姓名', '作业1'], ['2024120201', '王梓豪', 90]]), 'Sheet1');
      return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    };
    assert.equal(rosterFromFile('软工2402 平时成绩.xlsx', sheet('《数据库原理与应用》平时成绩登记表')).name, '软工2402');
    assert.equal(rosterFromFile('期中成绩.xlsx', sheet('Python程序设计期中考试成绩（计科2505，2026年11月5日）')).name, '计科2505');
    assert.equal(rosterFromFile('名单.xlsx', sheet('计算机科学与技术2025级5班学生名单')).name, '计算机科学与技术2025级5班');
  });
  await t.test('读不出名单的文件', () => {
    assert.throws(() => rosterFromFile('随手记.txt', new TextEncoder().encode('今天讲完第三章')), /没认出学号和姓名/);
  });
});

test('建班、名单、谁能看见', async (t) => {
  let id = 0;
  await t.test('老师拖文件读出名单，再建班', async () => {
    const res = await app.request('/api/classes/roster?file=' + encodeURIComponent('计科2505班学生名单.xlsx'), {
      method: 'POST',
      headers: { cookie: cookies.teacher, 'x-tv2': '1', 'Content-Type': 'application/octet-stream' },
      body: jiaowuSheet(),
    });
    assert.equal(res.status, 200);
    const r = (await res.json()) as any;
    assert.equal(r.students.length, 42);
    const text = r.students.map((s: any) => `${s.studentNo} ${s.name}`).join('\n');
    const created = await req('/classes', 'teacher', { name: r.name, roster: text });
    assert.equal(created.status, 200);
    id = created.json.id;
    const list = await req('/classes');
    const { preview, ...card } = list.json.classes[0];
    assert.deepEqual(card, { id, name: '计科2505', count: 42 });
    assert.deepEqual(
      preview.map((s: any) => s.name),
      r.students.slice(0, 5).map((s: any) => s.name),
    );
  });
  await t.test('同名的班建不了；名单有认不出的行建不了', async () => {
    assert.equal((await req('/classes', 'teacher', { name: '计科2505' })).status, 409);
    const bad = await req('/classes', 'teacher', { name: '计科2506', roster: '2025120601 甲\n这一行不对' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /「这一行不对」/);
    assert.equal((await req('/classes')).json.classes.length, 1);
  });
  await t.test('补人：按学号对，已经在的不动，名字对不上的告诉老师', async () => {
    const again = await req(`/classes/${id}/students`, 'teacher', { roster: '2025120502 王磊\n2025120543 新同学' });
    assert.equal(again.status, 200);
    assert.equal(again.json.added, 1);
    assert.equal(again.json.students.length, 43);
    const clash = await req(`/classes/${id}/students`, 'teacher', { roster: '2025120502 王蕾' });
    assert.deepEqual(clash.json.conflicts, [{ studentNo: '2025120502', name: '王蕾', existingName: '王磊' }]);
    assert.equal(clash.json.added, 0);
  });
  await t.test('移出一个学生', async () => {
    const one = (await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2025120543');
    const res = await req(`/classes/${id}/students/${one.id}`, 'teacher', undefined, 'DELETE');
    assert.equal(res.json.students.length, 42);
    assert.equal((await req(`/classes/${id}/students/${one.id}`, 'teacher', undefined, 'DELETE')).status, 404);
  });
  await t.test('别的老师看不见、改不了', async () => {
    assert.deepEqual((await req('/classes', 'other')).json.classes, []);
    assert.equal((await req(`/classes/${id}`, 'other')).status, 404);
    assert.equal((await req(`/classes/${id}`, 'other', { name: '改掉' }, 'PATCH')).status, 404);
    assert.equal((await req(`/classes/${id}/students`, 'other', { roster: '2025120599 外人' })).status, 404);
  });
  await t.test('演示学生能进演示老师的班，只看到班名和老师；普通学生看不到；学生建不了班', async () => {
    const otherClass = (await req('/classes', 'other', { name: '别的班' })).json.id;
    assert.deepEqual((await req('/classes', 'demoStudent')).json.classes, [{ id, name: '计科2505', teacher: '王建国', count: 42 }]);
    assert.deepEqual((await req(`/classes/${id}`, 'demoStudent')).json, { id, name: '计科2505', teacher: '王建国' });
    assert.equal((await req(`/classes/${otherClass}`, 'demoStudent')).status, 404);
    assert.deepEqual((await req('/classes', 'student')).json.classes, []);
    assert.equal((await req(`/classes/${id}`, 'student')).status, 404);
    assert.equal((await req('/classes', 'student', { name: '学生建的班' })).status, 403);
  });
  await t.test('名单上挂了账号的学生能看到自己的班', async () => {
    db.run('UPDATE class_students SET user_id=? WHERE class_id=? AND student_no=?', plainStudent, id, '2025120501');
    assert.deepEqual((await req('/classes', 'student')).json.classes, [{ id, name: '计科2505', teacher: '王建国', count: 42 }]);
  });
  await t.test('改名、删除', async () => {
    assert.equal((await req(`/classes/${id}`, 'teacher', { name: '计科2505 Python' }, 'PATCH')).status, 200);
    assert.equal((await req(`/classes/${id}`)).json.name, '计科2505 Python');
    assert.equal((await req(`/classes/${id}`, 'teacher', undefined, 'DELETE')).status, 200);
    assert.deepEqual((await req('/classes')).json.classes, []);
    assert.equal((await req(`/classes/${id}`)).status, 404);
    assert.deepEqual((await req('/classes', 'demoStudent')).json.classes, []);
    // 删掉的班名字可以再用
    assert.equal((await req('/classes', 'teacher', { name: '计科2505 Python' })).status, 200);
  });
});

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
const { rosterFromFile, rosterFromText, tableFromFile } = await import('../src/classes/roster.js');
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
  await t.test('文件认不出表头就不一行行猜，交给老师选列；从 Excel 复制来的「学号 性别 姓名」不把性别当名字', () => {
    const csv = new TextEncoder().encode('2025120501,男,陈宇航\n2025120502,女,刘思琪\n');
    assert.throws(() => rosterFromFile('点名册.csv', csv), /没认出学号和姓名/);
    assert.deepEqual(tableFromFile('点名册.csv', csv), {
      rows: [
        ['2025120501', '男', '陈宇航'],
        ['2025120502', '女', '刘思琪'],
      ],
      noCol: 0,
      nameCol: 2,
    });
    assert.deepEqual(rosterFromText('2025120501\t男\t陈宇航').students, [{ studentNo: '2025120501', name: '陈宇航' }]);
  });
  await t.test('表头认不出的表：原样给老师选列，先猜好哪列是学号、哪列是姓名（性别那列不当姓名）', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['学生编号', '性别', '学生名称', '手机'],
        ['2025120501', '男', '陈宇航', '13800000001'],
        ['2025120502', '女', '刘思琪', '13800000002'],
      ]),
      'Sheet1',
    );
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const t = tableFromFile('名单.xlsx', bytes);
    assert.equal(t.rows.length, 3);
    assert.equal(t.noCol, 0);
    assert.equal(t.nameCol, 2);
  });
});

test('建班、加课码、学生自己加入、导名单对一对', async (t) => {
  let id = 0,
    code = '';
  const studentCookie = cookie(user('第三位学生', 'student'));
  const joinAs = (who: string, body: unknown) =>
    app.request('/api/classes/join', { method: 'POST', headers: { cookie: who, 'x-tv2': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await t.test('建班只要名字，建好就有 6 位加课码', async () => {
    const created = await req('/classes', 'teacher', { name: '计科2505' });
    assert.equal(created.status, 200);
    id = created.json.id;
    const k = (await req(`/classes/${id}`)).json;
    assert.match(k.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.deepEqual(k.students, []);
    code = k.code;
    assert.deepEqual((await req('/classes')).json.classes, [{ id, name: '计科2505', count: 0, code, joinOpen: true, archived: false, pending: 0, preview: [] }]);
    assert.equal((await req('/classes', 'teacher', { name: '计科2505' })).status, 409);
  });
  await t.test('老师导教务名单：都记成还没加入', async () => {
    const res = await app.request('/api/classes/roster?file=' + encodeURIComponent('计科2505班学生名单.xlsx'), {
      method: 'POST',
      headers: { cookie: cookies.teacher, 'x-tv2': '1', 'Content-Type': 'application/octet-stream' },
      body: jiaowuSheet(),
    });
    const r = (await res.json()) as any;
    assert.equal(r.students.length, 42);
    const imported = await req(`/classes/${id}/students`, 'teacher', { roster: r.students.map((s: any) => `${s.studentNo} ${s.name}`).join('\n') });
    assert.equal(imported.json.added, 42);
    assert.ok(imported.json.students.every((s: any) => s.inRoster && !s.joined));
    // 名单有认不出的行导不进去
    const bad = await req(`/classes/${id}/students`, 'teacher', { roster: '2025120601 甲\n这一行不对' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /「这一行不对」/);
  });
  await t.test('学生输加课码：先看到是哪个班，学号姓名对上名单就加入', async () => {
    const peek = await req(`/classes/join/${code.toLowerCase()}`, 'student');
    assert.deepEqual(peek.json, { id, name: '计科2505', teacher: '王建国', joined: false, open: true, archived: false });
    const res = await req('/classes/join', 'student', { code, studentNo: '2025120502', name: '王 磊' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { id, name: '计科2505' });
    assert.deepEqual((await req('/classes', 'student')).json.classes, [{ id, name: '计科2505', teacher: '王建国', count: 1, archived: false, todo: 0 }]);
    const mine = (await req(`/classes/${id}`, 'student')).json;
    assert.deepEqual({ ...mine, classmates: mine.classmates.map((s: any) => ({ name: s.name, me: s.me })) }, {
      id,
      name: '计科2505',
      teacher: '王建国',
      archived: false,
      classmates: [{ name: '王磊', me: true }],
    });
    const me = (await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2025120502');
    assert.deepEqual({ joined: me.joined, inRoster: me.inRoster }, { joined: true, inRoster: true });
    // 再输一次直接进；账号上记下了学号
    assert.equal((await req('/classes/join', 'student', { code, studentNo: '2025120502', name: '王磊' })).status, 200);
    assert.equal(db.get<{ student_no: string }>('SELECT student_no FROM users WHERE id=?', plainStudent)!.student_no, '2025120502');
  });
  await t.test('姓名对不上、学号被别人用了、加课码不对、老师加入，都进不来', async () => {
    assert.equal((await joinAs(studentCookie, { code, studentNo: '2025120503', name: '李四' })).status, 409);
    assert.equal((await joinAs(studentCookie, { code, studentNo: '2025120502', name: '王磊' })).status, 409);
    assert.equal((await joinAs(studentCookie, { code: 'ZZZZZZ', studentNo: '2025120503', name: '李四' })).status, 404);
    assert.equal((await joinAs(studentCookie, { code, studentNo: '12', name: '李四' })).status, 400);
    assert.equal((await req('/classes/join', 'teacher', { code, studentNo: '2025120599', name: '王建国' })).status, 403);
  });
  await t.test('名单上没有的学号也能加入，老师那边标不在名单里；再导名单就对上', async () => {
    assert.equal((await joinAs(studentCookie, { code, studentNo: '2025120577', name: '新同学' })).status, 200);
    const s = (await req(`/classes/${id}`)).json.students.find((x: any) => x.studentNo === '2025120577');
    assert.deepEqual({ joined: s.joined, inRoster: s.inRoster }, { joined: true, inRoster: false });
    const again = await req(`/classes/${id}/students`, 'teacher', { roster: '2025120577 新同学\n2025120502 王蕾' });
    assert.equal(again.json.matched, 1);
    assert.deepEqual(again.json.conflicts, [{ studentNo: '2025120502', name: '王蕾', existingName: '王磊' }]);
    assert.equal(again.json.students.find((x: any) => x.studentNo === '2025120577').inRoster, true);
    // 已经加入的排在前面
    assert.deepEqual(
      again.json.students.slice(0, 2).map((x: any) => x.studentNo),
      ['2025120502', '2025120577'],
    );
    const card = (await req('/classes')).json.classes[0];
    assert.equal(card.count, 2);
    assert.deepEqual(
      card.preview.map((x: any) => x.name),
      ['王磊', '新同学'],
    );
  });
  await t.test('移出一个学生，他就看不到这个班了', async () => {
    const one = (await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2025120577');
    const res = await req(`/classes/${id}/students/${one.id}`, 'teacher', undefined, 'DELETE');
    assert.equal(res.json.students.length, 42);
    assert.equal((await req(`/classes/${id}/students/${one.id}`, 'teacher', undefined, 'DELETE')).status, 404);
  });
  await t.test('别的老师看不见、改不了；没加入的学生看不到；演示学生也要输码；学生建不了班', async () => {
    assert.deepEqual((await req('/classes', 'other')).json.classes, []);
    assert.equal((await req(`/classes/${id}`, 'other')).status, 404);
    assert.equal((await req(`/classes/${id}`, 'other', { name: '改掉' }, 'PATCH')).status, 404);
    assert.equal((await req(`/classes/${id}/students`, 'other', { roster: '2025120599 外人' })).status, 404);
    assert.deepEqual((await req('/classes', 'demoStudent')).json.classes, []);
    assert.equal((await req(`/classes/${id}`, 'demoStudent')).status, 404);
    assert.equal((await req('/classes', 'student', { name: '学生建的班' })).status, 403);
  });
  await t.test('改名、删除', async () => {
    assert.equal((await req(`/classes/${id}`, 'teacher', { name: '计科2505 Python' }, 'PATCH')).status, 200);
    assert.equal((await req(`/classes/${id}`)).json.name, '计科2505 Python');
    assert.equal((await req(`/classes/${id}`, 'teacher', undefined, 'DELETE')).status, 200);
    assert.deepEqual((await req('/classes')).json.classes, []);
    assert.equal((await req(`/classes/${id}`)).status, 404);
    assert.deepEqual((await req('/classes', 'student')).json.classes, []);
    assert.equal((await req(`/classes/join/${code}`, 'student')).status, 404);
    // 删掉的班名字可以再用
    assert.equal((await req('/classes', 'teacher', { name: '计科2505 Python' })).status, 200);
  });
});

test('换加课码、停止加入、扫码注册、同学、重置密码、改密码、退出、导出、归档', async (t) => {
  const id = (await req('/classes', 'teacher', { name: '软工2402' })).json.id;
  let code: string = (await req(`/classes/${id}`)).json.code;
  const anon = (path: string, body?: unknown, cookie = '') =>
    app.request('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-tv2': '1', 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const sid = (res: Response) => (res.headers.get('set-cookie') || '').match(/ct_sid=[^;]+/)?.[0] || '';
  const json = async (res: Response | Promise<Response>) => (await (await res).json()) as any;
  let zhao = '';

  await t.test('没登录也能看加课码是哪个班；老师账号看不了', async () => {
    const res = await anon(`/classes/join/${code}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id, name: '软工2402', teacher: '王建国', joined: false, open: true, archived: false });
    assert.equal((await req(`/classes/join/${code}`, 'teacher')).status, 403);
  });
  await t.test('没账号的学生扫码：学号、姓名、密码，注册和加入一步做完，已经登录', async () => {
    const res = await anon('/classes/join/register', { code, studentNo: '2024020101', name: '赵一', password: '123456' });
    assert.equal(res.status, 200);
    const j = (await res.json()) as any;
    assert.deepEqual(
      { id: j.id, username: j.user.username, studentNo: j.user.studentNo, role: j.user.role },
      { id, username: '2024020101', studentNo: '2024020101', role: 'student' },
    );
    zhao = sid(res);
    assert.ok(zhao);
    assert.deepEqual((await json(anon('/classes', undefined, zhao))).classes.map((k: any) => k.id), [id]);
    assert.equal((await anon('/auth/login', { username: '2024020101', password: '123456' })).status, 200);
    // 登录着再注册不行
    assert.equal((await anon('/classes/join/register', { code, studentNo: '2024020109', name: '赵九', password: '123456' }, zhao)).status, 400);
  });
  await t.test('同一学号再注册叫他去登录；密码太短、名单上姓名对不上都不建账号', async () => {
    const again = await anon('/classes/join/register', { code, studentNo: '2024020101', name: '赵一', password: '654321' });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as any).code, 'registered');
    assert.equal((await anon('/classes/join/register', { code, studentNo: '2024020102', name: '钱二', password: '12345' })).status, 400);
    await req(`/classes/${id}/students`, 'teacher', { roster: '2024020103 孙三' });
    assert.equal((await anon('/classes/join/register', { code, studentNo: '2024020103', name: '孙四', password: '123456' })).status, 409);
    assert.equal(db.get('SELECT id FROM users WHERE username=?', '2024020103'), undefined);
  });
  await t.test('自己注册的账号加别的班只能用自己的学号', async () => {
    const other = (await req('/classes', 'other', { name: '数据库原理' })).json.id;
    const otherCode = (await req(`/classes/${other}`, 'other')).json.code;
    assert.equal((await anon('/classes/join', { code: otherCode, studentNo: '2024020199', name: '赵一' }, zhao)).status, 400);
    assert.equal((await anon('/classes/join', { code: otherCode, studentNo: '2024020101', name: '赵一' }, zhao)).status, 200);
  });
  await t.test('换加课码：原来的码不能用了', async () => {
    const r = await req(`/classes/${id}/code`, 'teacher', {});
    assert.match(r.json.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.notEqual(r.json.code, code);
    assert.equal((await anon(`/classes/join/${code}`)).status, 404);
    code = r.json.code;
    assert.equal((await anon(`/classes/join/${code}`)).status, 200);
    assert.equal((await req(`/classes/${id}/code`, 'other', {})).status, 404);
  });
  await t.test('停止加入：看得到是哪个班，进不来，注册也不行；再打开就能进', async () => {
    assert.equal((await req(`/classes/${id}`, 'teacher', { joinOpen: false }, 'PATCH')).status, 200);
    assert.equal((await req(`/classes/${id}`)).json.joinOpen, false);
    assert.equal((await json(anon(`/classes/join/${code}`))).open, false);
    assert.equal((await anon('/classes/join/register', { code, studentNo: '2024020104', name: '李四', password: '123456' })).status, 409);
    assert.equal((await req('/classes/join', 'student', { code, studentNo: '2025120502', name: '王磊' })).status, 409);
    // 已经在班里的照样进得来
    assert.equal((await anon('/classes/join', { code, studentNo: '2024020101', name: '赵一' }, zhao)).status, 200);
    await req(`/classes/${id}`, 'teacher', { joinOpen: true }, 'PATCH');
    assert.equal((await req('/classes/join', 'student', { code, studentNo: '2025120502', name: '王磊' })).status, 200);
  });
  await t.test('学生看得到同学的名字，看不到学号', async () => {
    const k = (await req(`/classes/${id}`, 'student')).json;
    assert.deepEqual(
      k.classmates.map((s: any) => s.name),
      ['赵一', '王磊'],
    );
    assert.ok(k.classmates.every((s: any) => Object.keys(s).sort().join() === 'id,me,name'));
    assert.equal(k.classmates.find((s: any) => s.me).name, '王磊');
  });
  let newPassword = '';
  await t.test('老师帮学生重置密码：给 6 位数字，旧密码和登着的都不能用了；演示学生、别的老师不行', async () => {
    const row = (await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2024020101');
    assert.equal(row.canReset, true);
    const r = await req(`/classes/${id}/students/${row.id}/password`, 'teacher', {});
    assert.match(r.json.password, /^\d{6}$/);
    newPassword = r.json.password;
    assert.equal((await json(anon('/auth/me', undefined, zhao))).user, null);
    assert.equal((await anon('/auth/login', { username: '2024020101', password: '123456' })).status, 401);
    assert.equal((await anon('/auth/login', { username: '2024020101', password: newPassword })).status, 200);
    assert.equal((await req(`/classes/${id}/students/${row.id}/password`, 'other', {})).status, 404);
    await req('/classes/join', 'demoStudent', { code, studentNo: '2024020188', name: '李明' });
    const demo = (await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2024020188');
    assert.equal(demo.canReset, false);
    assert.equal((await req(`/classes/${id}/students/${demo.id}/password`, 'teacher', {})).status, 400);
    const sun = (await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2024020103');
    assert.equal((await req(`/classes/${id}/students/${sun.id}/password`, 'teacher', {})).status, 404);
  });
  await t.test('学生自己改密码：原密码要对；改完别处登着的退出，这里的留着', async () => {
    const a = sid(await anon('/auth/login', { username: '2024020101', password: newPassword }));
    const b = sid(await anon('/auth/login', { username: '2024020101', password: newPassword }));
    const shortOne = ['a', 'b', 'c'].join('');
    assert.equal((await anon('/auth/password', { old: '000000', password: 'abcdef' }, a)).status, 400);
    assert.equal((await anon('/auth/password', { old: newPassword, password: shortOne }, a)).status, 400);
    assert.equal((await anon('/auth/password', { old: newPassword, password: 'abcdef' }, a)).status, 200);
    assert.equal((await json(anon('/auth/me', undefined, a))).user.username, '2024020101');
    assert.equal((await json(anon('/auth/me', undefined, b))).user, null);
    assert.equal((await anon('/auth/login', { username: '2024020101', password: 'abcdef' })).status, 200);
    assert.equal((await req('/auth/password', 'demoStudent', { old: 'x', password: 'abcdef' })).status, 403);
    zhao = a;
  });
  await t.test('学生退出：名单上有的回到还没加入，名单外的整行去掉', async () => {
    const sun = await anon('/classes/join/register', { code, studentNo: '2024020103', name: '孙三', password: '123456' });
    assert.equal(sun.status, 200);
    assert.equal((await anon(`/classes/${id}/leave`, {}, sid(sun))).status, 200);
    const back = (await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2024020103');
    assert.deepEqual({ joined: back.joined, inRoster: back.inRoster }, { joined: false, inRoster: true });
    assert.equal((await anon(`/classes/${id}/leave`, {}, zhao)).status, 200);
    assert.equal((await req(`/classes/${id}`)).json.students.find((s: any) => s.studentNo === '2024020101'), undefined);
    assert.deepEqual((await json(anon('/classes', undefined, zhao))).classes.map((k: any) => k.name), ['数据库原理']);
    assert.equal((await anon(`/classes/${id}/leave`, {}, zhao)).status, 404);
  });
  await t.test('导出名单是 Excel：学号、姓名、状态、加入时间；别的老师导不了', async () => {
    const res = await app.request(`/api/classes/${id}/export`, { headers: { cookie: cookies.teacher } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    assert.deepEqual(rows[0], ['学号', '姓名', '状态', '加入时间']);
    const byNo = new Map(rows.slice(1).map((r) => [String(r[0]), r]));
    assert.equal(byNo.get('2024020103')![2], '还没加入');
    assert.equal(byNo.get('2025120502')![2], '已加入（不在名单里）');
    assert.match(String(byNo.get('2025120502')![3]), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    assert.equal((await app.request(`/api/classes/${id}/export`, { headers: { cookie: cookies.other } })).status, 404);
  });
  await t.test('归档：码进不来，名单和码都不能动，只能看；恢复以后照旧', async () => {
    assert.equal((await req(`/classes/${id}`, 'teacher', { archived: true }, 'PATCH')).status, 200);
    assert.equal((await req('/classes')).json.classes.find((k: any) => k.id === id).archived, true);
    assert.equal((await req(`/classes/${id}`)).json.archived, true);
    const peek = await json(anon(`/classes/join/${code}`));
    assert.deepEqual({ open: peek.open, archived: peek.archived }, { open: false, archived: true });
    assert.equal((await anon('/classes/join/register', { code, studentNo: '2024020105', name: '周五', password: '123456' })).status, 409);
    assert.equal((await req(`/classes/${id}/code`, 'teacher', {})).status, 409);
    assert.equal((await req(`/classes/${id}/students`, 'teacher', { roster: '2024020105 周五' })).status, 409);
    assert.equal((await req(`/classes/${id}`, 'teacher', { joinOpen: false }, 'PATCH')).status, 409);
    assert.equal((await req('/classes', 'student')).json.classes.find((k: any) => k.id === id).archived, true);
    assert.equal((await req(`/classes/${id}`, 'student')).json.archived, true);
    // 归档了还能改名、导出
    assert.equal((await req(`/classes/${id}`, 'teacher', { name: '软工2402（上学期）' }, 'PATCH')).status, 200);
    assert.equal((await app.request(`/api/classes/${id}/export`, { headers: { cookie: cookies.teacher } })).status, 200);
    assert.equal((await req(`/classes/${id}`, 'teacher', { archived: false }, 'PATCH')).status, 200);
    assert.equal((await req(`/classes/${id}/code`, 'teacher', {})).status, 200);
  });
});

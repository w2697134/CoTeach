import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { FileOp } from '../src/kb/repo.js';

const dir = mkdtempSync(join(tmpdir(), 'coteach-knowledge-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const repo = await import('../src/kb/repo.js');
const changes = await import('../src/kb/changes.js');
const access = await import('../src/kb/access.js');
const reader = await import('../src/kb/reader.js');
const { Workspace, textChunk } = await import('../src/kb/keeper.js');
const { createApp } = await import('../src/app.js');
const app = createApp();
const user = (name: string, role = 'teacher') =>
  db.insert('users', {
    username: randomUUID(),
    name,
    role,
    password_hash: 'not-a-login-password',
    created_at: Date.now(),
  });
const teacher = user('测试老师甲'),
  other = user('测试老师乙'),
  studentUser = user('测试学生甲', 'student');
const owner = { id: teacher, name: '测试老师甲' },
  author = changes.teacherAuthor(owner);
const long = await repo.ensureTeacherKb(teacher, owner.name),
  foreign = await repo.ensureTeacherKb(other, '测试老师乙');
const classA = await repo.createKnowledgeBase({
  teacherId: teacher,
  name: '测试班甲',
  className: '测试班甲',
  term: '测试学期',
});
const classB = await repo.createKnowledgeBase({
  teacherId: teacher,
  name: '测试班乙',
  className: '测试班乙',
  term: '测试学期',
});
const addStudent = (kb: number, name: string, no: string, uid: number | null = null) =>
  db.insert('kb_students', {
    kb_id: kb,
    name,
    student_no: no,
    aliases: [],
    user_id: uid,
    created_at: Date.now(),
  });
const alice = addStudent(classA, '测试学生甲', 'TEST-A-1001', studentUser),
  bob = addStudent(classA, '测试学生乙', 'TEST-A-1002'),
  carol = addStudent(classB, '测试学生丙', 'TEST-B-1001');
const put = (kbId: number, path: string, content: string, extra: Partial<FileOp> = {}) =>
  changes.createChange({
    kbId,
    title: '测试记录',
    author: 'teacher',
    authorName: owner.name,
    kind: 'teacher',
    ops: [
      {
        path,
        content,
        base: repo.readText(kbId, path) === null ? null : repo.hashText(repo.readText(kbId, path)!),
        ...extra,
      },
    ],
    apply: { by: teacher, as: author },
  });
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', {
    id: createHash('sha256').update(token).digest('hex'),
    user_id: uid,
    created_at: Date.now(),
    expires_at: Date.now() + 3600000,
  });
  return `ct_sid=${token}`;
}
const cookies = {
  teacher: cookie(teacher),
  other: cookie(other),
  student: cookie(studentUser),
};
async function req(path: string, who: keyof typeof cookies = 'teacher', body?: unknown, method?: string) {
  return app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      cookie: cookies[who],
      'x-tv2': '1',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('知识库归属、系统隔离与变更生命周期', async (t) => {
  await t.test('导入名单保留非重复项，逐个指出重复与同学号异名，不覆盖原名单', async () => {
    const batch = {
      students: [
        { studentNo: 'TEST-A-1001', name: '测试学生甲' },
        { studentNo: 'IMPORT-NEW', name: '新名单学生' },
        { studentNo: 'TEST-A-1002', name: '不同姓名' },
      ],
    };
    const response = await req(`/knowledge/${classA}/students`, 'teacher', batch);
    assert.equal(response.status, 200);
    const result = (await response.json()) as any;
    assert.equal(result.added, 1);
    assert.equal(result.skipped[0].studentNo, 'TEST-A-1001');
    assert.equal(result.conflicts[0].studentNo, 'TEST-A-1002');
    assert.equal(db.value('SELECT name FROM kb_students WHERE id=?', bob), '测试学生乙');
    assert.equal(((await (await req(`/knowledge/${classA}/students`, 'teacher', batch)).json()) as any).added, 0);
  });
  await t.test('学生上下文不能取得长期库，即使提供本班身份', async () => {
    await put(long, '教师内部约定.md', '只给教师助手参考');
    const principal = { role: 'student' as const, teacherId: teacher, classId: classA, studentId: alice };
    assert.throws(() => reader.readKnowledge(long, principal), /权限/);
    assert.equal((await req(`/knowledge/${long}/context?classId=${classA}`, 'student')).status, 403);
    assert.equal((await req(`/knowledge/${classB}/context?classId=${classA}`, 'student')).status, 403);
    assert.equal((await req(`/knowledge/${classA}/context`, 'student')).status, 200);
    const ws = new Workspace(long);
    ws.remove('教师内部约定.md');
    await changes.createChange({
      kbId: long,
      title: '清理测试',
      author: 'teacher',
      authorName: owner.name,
      kind: 'teacher',
      ops: ws.ops(),
      apply: { by: teacher, as: author },
    });
  });
  await t.test('Unicode 默认可忽略字符不能隐藏学生身份', async () => {
    assert.equal(
      (await req(`/knowledge/${classA}/students`, 'teacher', { students: [{ name: '\u2060', studentNo: 'HIDDEN-ONLY' }] })).status,
      400,
    );
    const id = addStudent(classA, '边界测试同学', 'NORMALIZE-BOUNDARY');
    db.update('kb_students', id, { aliases: ['\u2060', '\u2800'] });
    assert.doesNotThrow(() => access.checkIdentity(long, '不涉及个人的教学知识'));
    for (const cp of [
      0x0000, 0x0008, 0x007f, 0x0085, 0x00ad, 0x2060, 0x2063, 0x034f, 0x061c, 0x180e, 0x200d, 0x202e, 0x2800, 0xfe0f, 0xe0100,
    ]) {
      const name = '测试' + String.fromCodePoint(cp) + '学生甲';
      assert.equal(access.normalizeIdentity(name), '测试学生甲');
      await assert.rejects(put(long, '不可写姓名.md', name), /学生身份/);
      await assert.rejects(put(classA, '不可写共有.md', name), /个人情况/);
    }
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const char = String.fromCodePoint(cp);
      if (/\p{Default_Ignorable_Code_Point}/u.test(char)) assert.equal(access.normalizeIdentity('张' + char + '三'), '张三');
    }
    const hidden = '尚未' + '\u2063' + '登记甲';
    await put(classA, '旧共有记录.md', hidden);
    addStudent(classA, '尚未登记甲', 'INVISIBLE-01');
    assert.ok(
      !reader
        .readKnowledge(classA, { role: 'student', teacherId: teacher, classId: classA, studentId: alice })
        .some((d) => d.text.includes('尚未')),
    );
  });
  await t.test('每位老师只有一份长期库，课程不会新建长期库', async () => {
    assert.equal(await repo.ensureTeacherKb(teacher, '改名'), long);
    assert.notEqual(long, foreign);
    const response = await req('/courses', 'teacher', { name: '新测试课' });
    assert.equal(response.status, 200);
    assert.equal(db.value("SELECT count(*) FROM knowledge_bases WHERE teacher_id=? AND kind='teacher'", teacher), 1);
  });
  await t.test('没有固定文件骨架，任意层级能新建', async () => {
    assert.equal((await repo.listFiles(long)).length, 0);
    await put(long, '教学方法/课堂提问.md', '# 提问\n先了解已尝试的方法。\n');
    assert.match(repo.readText(long, '教学方法/课堂提问.md')!, /已尝试/);
  });
  await t.test('长期内容修改等待确认，目录文档没有豁免', async () => {
    await put(long, '目录.md', '# 目录\n');
    const ops = [
      {
        path: '目录.md',
        content: '# 目录\n新增教学规则\n',
        base: repo.hashText('# 目录\n'),
      },
    ];
    assert.equal(changes.isTidy(long, ops), false);
    const c = await changes.createChange({
      kbId: long,
      title: '增加约定',
      author: 'keeper',
      authorName: '整理助手',
      kind: 'keeper',
      ops,
    });
    assert.equal(c.status, 'pending');
    assert.equal(repo.readText(long, '目录.md'), '# 目录\n');
    await changes.applyChange(long, c.id, teacher, author);
    assert.match(repo.readText(long, '目录.md')!, /新增教学规则/);
  });
  await t.test('固定目录可以删除，历史支持撤回', async () => {
    const before = repo.readText(long, '目录.md')!;
    const c = await changes.createChange({
      kbId: long,
      title: '移除目录',
      author: 'teacher',
      authorName: owner.name,
      kind: 'teacher',
      ops: [{ path: '目录.md', content: null, base: repo.hashText(before) }],
      apply: { by: teacher, as: author },
    });
    assert.equal(repo.readText(long, '目录.md'), null);
    await changes.revertChange(long, c.id, owner);
    assert.equal(repo.readText(long, '目录.md'), before);
  });
  await t.test('两次确认同一改动只产生一次提交', async () => {
    const c = await changes.createChange({
      kbId: long,
      title: '新增资料',
      author: 'keeper',
      authorName: '整理助手',
      kind: 'keeper',
      ops: [{ path: '重复确认.md', content: '只写一次\n', base: null }],
    });
    const [a, b] = await Promise.all([changes.applyChange(long, c.id, teacher, author), changes.applyChange(long, c.id, teacher, author)]);
    assert.equal(a.commit_sha, b.commit_sha);
  });
  await t.test('过期修改失败，不覆盖新内容', async () => {
    const old = repo.readText(long, '重复确认.md')!;
    await put(long, '重复确认.md', '更新后的内容\n');
    await assert.rejects(put(long, '重复确认.md', '旧页面的修改\n', { base: repo.hashText(old) }), /已被更新/);
    assert.equal(repo.readText(long, '重复确认.md'), '更新后的内容\n');
  });
  await t.test('撤回旧移动不会覆盖后续位置调整', async () => {
    await put(long, '移动甲.md', '保留内容');
    const move = async (from: string, to: string) =>
      changes.createChange({
        kbId: long,
        title: '整理位置',
        author: 'teacher',
        authorName: owner.name,
        kind: 'tidy',
        ops: [{ from, path: to, content: null, base: repo.hashText('保留内容') }],
        apply: { by: teacher, as: author },
      });
    const first = await move('移动甲.md', '移动乙.md');
    await move('移动乙.md', '移动丙.md');
    await assert.rejects(changes.revertChange(long, first.id, owner), /后来又移动/);
    assert.equal(repo.readText(long, '移动丙.md'), '保留内容');
  });
  await t.test('旧页面的条目身份不能编辑、移动或删除同名重建文件', async () => {
    const path = '页面身份.md';
    await put(long, path, '相同正文\n');
    const original = (await (await req(`/knowledge/${long}/kb/file?path=${encodeURIComponent(path)}`)).json()) as {
      id: string;
      hash: string;
    };
    const ws = new Workspace(long);
    ws.remove(path);
    await changes.createChange({
      kbId: long,
      title: '移除旧文件',
      author: 'teacher',
      authorName: owner.name,
      kind: 'teacher',
      ops: ws.ops(),
      apply: { by: teacher, as: author },
    });
    await put(long, path, '相同正文\n');
    const current = (await (await req(`/knowledge/${long}/kb/file?path=${encodeURIComponent(path)}`)).json()) as {
      id: string;
      hash: string;
    };
    assert.notEqual(current.id, original.id);
    assert.equal(current.hash, original.hash);
    assert.equal(
      (await req(`/knowledge/${long}/kb/file`, 'teacher', { path, content: '覆盖', base: original.hash, baseEntryId: original.id }, 'PUT'))
        .status,
      409,
    );
    assert.equal(
      (await req(`/knowledge/${long}/kb/move`, 'teacher', { from: path, to: '页面移动.md', base: original.hash, baseEntryId: original.id }))
        .status,
      409,
    );
    assert.equal(
      (
        await req(
          `/knowledge/${long}/kb/file?path=${encodeURIComponent(path)}&base=${original.hash}&baseEntryId=${original.id}`,
          'teacher',
          undefined,
          'DELETE',
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await req(`/knowledge/${long}/kb/move`, 'teacher', {
          from: path,
          to: ' ' + path + ' ',
          base: current.hash,
          baseEntryId: current.id,
        })
      ).status,
      400,
    );
    assert.equal(repo.readText(long, path), '相同正文\n');
  });
  await t.test('改名保留文件身份，纯整理判定不靠标题', async () => {
    const path = '教学方法/课堂提问.md',
      old = repo.manifest(long).find((e) => e.path === path)!;
    const op = {
      from: path,
      path: '教学经验/提问.md',
      content: null,
      base: repo.hashText(repo.readText(long, path)!),
    };
    assert.equal(changes.isTidy(long, [op]), true);
    await changes.createChange({
      kbId: long,
      title: '移动',
      author: 'keeper',
      authorName: '整理助手',
      kind: 'tidy',
      ops: [op],
      apply: { by: null, as: changes.KEEPER_AUTHOR },
    });
    assert.equal(repo.manifest(long).find((e) => e.path === op.path)!.id, old.id);
  });
  await t.test('原件和转换文字受保护，移动后仍受保护', async () => {
    const sid = repo.saveSource(long, '教案.docx', Buffer.from([1, 2, 3]), '老师交来的原文');
    await changes.createChange({
      kbId: long,
      title: '交资料',
      author: 'teacher',
      authorName: owner.name,
      kind: 'upload',
      ops: [
        {
          path: '资料/教案.md',
          content: '老师交来的原文',
          base: null,
          sourceId: sid,
        },
      ],
      apply: { by: teacher, as: author },
    });
    await assert.rejects(put(long, '资料/教案.md', '覆盖原文'), /不能改写/);
    const ws = new Workspace(long);
    ws.move('资料/教案.md', '档案/教案.md');
    await changes.createChange({
      kbId: long,
      title: '移动原文',
      author: 'keeper',
      authorName: '整理助手',
      kind: 'tidy',
      ops: ws.ops(),
      apply: { by: null, as: changes.KEEPER_AUTHOR },
    });
    assert.throws(() => new Workspace(long).write('档案/教案.md', '覆盖'), /不能改写/);
    assert.deepEqual(repo.sourceBytes(sid, 'original'), Buffer.from([1, 2, 3]));
  });
  await t.test('无法伪造 sourceId 绕过资料保护', async () => {
    const sid = repo.manifest(long).find((e) => e.sourceId)!.sourceId!;
    await assert.rejects(put(long, '伪造.md', '文字', { sourceId: sid }), /不能自行指定原件/);
    await assert.rejects(
      changes.createChange({
        kbId: classB,
        title: '窃取原件',
        author: 'teacher',
        authorName: owner.name,
        kind: 'upload',
        ops: [{ path: '错班.md', content: '', base: null, sourceId: sid }],
        apply: { by: teacher, as: author },
      }),
      /不属于/,
    );
  });
  await t.test('跨老师访问所有管理入口被拒绝', async () => {
    for (const suffix of [
      '',
      '/kb/tree',
      '/kb/file?path=目录.md',
      '/kb/raw?path=目录.md',
      '/kb/history',
      '/kb/changes',
      '/kb/runs',
      '/kb/stream',
      '/students',
      '/inbox',
    ]) {
      const r = await req(`/knowledge/${long}${suffix}`, 'other');
      assert.equal(r.status, 403, suffix);
    }
  });
  await t.test('会话撤销后，已连接事件流不再提供私有数据', async () => {
    const session = cookie(teacher),
      response = await app.request(`/api/knowledge/${long}/kb/stream`, { headers: { cookie: session } }),
      stream = response.body!.getReader();
    const { bus } = await import('../src/lib/bus.js');
    const first = stream.read();
    bus.publish(`kb:${long}`, 'delta', { text: 'authorized-before-revoke' });
    assert.match(Buffer.from((await first).value!).toString(), /authorized-before-revoke/);
    db.run('DELETE FROM sessions WHERE id=?', createHash('sha256').update(session.slice('ct_sid='.length)).digest('hex'));
    const next = stream.read();
    bus.publish(`kb:${long}`, 'delta', { text: 'must-not-arrive' });
    assert.equal((await next).done, true);
  });
  await t.test('接口的 JSON 压缩了再发，事件流不压', async () => {
    const headers = { cookie: cookies.teacher, 'x-tv2': '1', 'Accept-Encoding': 'gzip, deflate' };
    const tree = await app.request(`/api/knowledge/${long}/kb/tree`, { headers });
    assert.equal(tree.status, 200);
    assert.equal(tree.headers.get('content-encoding'), 'gzip');
    assert.ok(Array.isArray(JSON.parse(gunzipSync(Buffer.from(await tree.arrayBuffer())).toString()).files));
    const stream = await app.request(`/api/knowledge/${long}/kb/stream`, { headers });
    assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal(stream.headers.get('content-encoding'), null);
    await stream.body?.cancel();
  });
  await t.test('同一浏览器重新登录后撤销上一枚会话', async () => {
    const { Hono } = await import('hono'),
      { createSession } = await import('../src/auth.js');
    const isolated = new Hono();
    isolated.get('/', (c) => {
      createSession(c, other);
      return c.text('ok');
    });
    const previous = cookie(teacher);
    const response = await isolated.request('/', { headers: { cookie: previous } });
    assert.equal(
      db.get('SELECT id FROM sessions WHERE id=?', createHash('sha256').update(previous.slice('ct_sid='.length)).digest('hex')),
      undefined,
    );
    assert.match(response.headers.get('set-cookie') || '', /ct_sid=/);
  });
  await t.test('长期库各写入入口拦截姓名、学号与变体', async () => {
    for (const content of ['测试学生甲的情况', 'ＴＥＳＴ－Ａ－１００１', '测试 学生甲的情况'])
      await assert.rejects(put(long, '不允许.md', content), /身份/);
    const r = await req(`/knowledge/${long}/kb/file`, 'teacher', { path: '私密.md', content: '测试学生乙', base: null }, 'PUT');
    assert.equal(r.status, 400);
  });
  await t.test('文件名和改动标题同样不能携带学生身份', async () => {
    await assert.rejects(put(long, '测试学生甲.md', '正文'), /身份/);
    await assert.rejects(
      changes.createChange({
        kbId: long,
        title: '测试学生乙',
        author: 'keeper',
        authorName: '整理助手',
        kind: 'keeper',
        ops: [{ path: '规则.md', content: '内容', base: null }],
      }),
      /身份/,
    );
  });
  await t.test('从明确的原件身份字段登记防泄漏词，不虚构名单', () => {
    const before = db.value<number>('SELECT count(*) FROM kb_students');
    access.registerSourceIdentities(long, '需要重点关注的学生：案例甲（未交）、案例乙（需要帮助）', 'test-source');
    assert.throws(() => access.checkIdentity(long, '案例甲的情况'), /学生姓名/);
    assert.equal(db.value('SELECT count(*) FROM kb_students'), before);
  });
  await t.test('班级共有与个人记录分开存取', async () => {
    await put(classA, '全班安排.md', '下周复习函数\n');
    await put(classA, '个人/甲.md', '测试学生甲：需要练习递归\n', {
      studentId: alice,
    });
    await put(classA, '个人/乙.md', '测试学生乙：需要练习循环\n', {
      studentId: bob,
    });
    await put(classB, '安排.md', '乙班的安排\n');
    const docs = reader.readKnowledge(classA, {
      role: 'student',
      teacherId: teacher,
      classId: classA,
      studentId: alice,
    });
    assert.equal(docs.length, 2);
    assert.ok(docs.some((d) => d.text.includes('测试学生甲')));
    assert.ok(!JSON.stringify(docs).includes('测试学生乙'));
  });
  await t.test('个人不能搬进共有区，移动后归属不变', async () => {
    const e = repo.manifest(classA).find((e) => e.studentId === bob)!;
    const ws = new Workspace(classA);
    ws.move(e.path, '共有目录/仍是个人.md');
    await changes.createChange({
      kbId: classA,
      title: '整理位置',
      author: 'keeper',
      authorName: '整理助手',
      kind: 'tidy',
      ops: ws.ops(),
      apply: { by: null, as: changes.KEEPER_AUTHOR },
    });
    assert.ok(
      !reader
        .readKnowledge(classA, {
          role: 'student',
          teacherId: teacher,
          classId: classA,
          studentId: alice,
        })
        .some((d) => d.title.includes('共有目录')),
    );
  });
  await t.test('禁止把个人情况写进全班或另一个学生记录', async () => {
    await assert.rejects(put(classA, '全班泄漏.md', '测试学生甲'), /个人情况/);
    await assert.rejects(put(classA, '甲的记录.md', '测试学生乙', { studentId: alice }), /个人情况/);
    await assert.rejects(put(classA, '错误学生.md', '内容', { studentId: carol }), /不属于/);
  });
  await t.test('班级范围不能靠工具参数或猜文件 id 越过', () => {
    assert.throws(
      () =>
        reader.readKnowledge(classB, {
          role: 'student',
          teacherId: teacher,
          classId: classA,
          studentId: alice,
        }),
      /对应班级/,
    );
    const b = repo.manifest(classA).find((e) => e.studentId === bob)!;
    assert.throws(
      () =>
        reader.readKnowledge(
          classA,
          {
            role: 'student',
            teacherId: teacher,
            classId: classA,
            studentId: alice,
          },
          b.id,
        ),
      /可见范围/,
    );
  });
  await t.test('学生 HTTP 上下文绑定登录身份，不接受指定他人', async () => {
    const r = await req(`/knowledge/${classA}/context?studentId=${bob}`, 'student');
    assert.equal(r.status, 200);
    const content = JSON.stringify(await r.json());
    assert.ok(content.includes('测试学生甲'));
    assert.ok(!content.includes('测试学生乙'));
    assert.equal((await req(`/knowledge/${classB}/context`, 'student')).status, 403);
  });
  await t.test('学生不能读原件、改动、历史、工作记录和事件流', async () => {
    for (const suffix of ['/kb/tree', '/kb/raw?path=档案/教案.md', '/kb/history', '/kb/changes', '/kb/runs', '/kb/stream'])
      assert.equal((await req(`/knowledge/${long}${suffix}`, 'student')).status, 403);
  });
  await t.test('其他助手读不到档案，只能提交观察', () => {
    const r = {
      role: 'assistant' as const,
      teacherId: teacher,
      classId: classA,
      studentId: alice,
    };
    assert.ok(!reader.readKnowledge(long, r).some((d) => d.title.includes('教案')));
    const id = reader.submitObservation(r, {
      kbId: classA,
      studentId: alice,
      sourceId: 'test-1',
      sender: 'grader',
      content: '需要练习递归',
    });
    assert.equal(
      reader.submitObservation(r, {
        kbId: classA,
        studentId: alice,
        sourceId: 'test-1',
        sender: 'grader',
        content: '重复',
      }),
      id,
    );
    assert.throws(
      () =>
        reader.submitObservation(r, {
          kbId: classB,
          sourceId: 'test-2',
          sender: 'grader',
          content: '错误班级',
        }),
      /对应班级/,
    );
  });
  await t.test('新登记的身份立即从可读投影中阻断旧内容', async () => {
    await put(classA, '待识别.md', '后来登记的人名需要复习');
    addStudent(classA, '后来登记的人名', 'TEST-A-999');
    const r = {
      role: 'student' as const,
      teacherId: teacher,
      classId: classA,
      studentId: alice,
    };
    assert.ok(!reader.readKnowledge(classA, r).some((d) => d.title === '待识别.md'));
  });
  await t.test('越界路径、隐藏元数据、大小写碰撞都不能写入', async () => {
    for (const p of ['../x.md', '/tmp/x.md', 'a/../x.md', '.git/config', 'a/.git/config', 'C:/x.md', 'a\u0000.md', 'a/CON.md', 'a/'])
      assert.throws(() => repo.cleanPath(p), /文件名/);
    await put(long, 'Case.md', '内容');
    await assert.rejects(put(long, 'case.md', '另一个内容'), /同名/);
  });
  await t.test('撤回不会覆盖后来编辑的内容', async () => {
    const c = await put(classA, '撤回冲突.md', '原内容');
    await put(classA, '撤回冲突.md', '后来内容');
    await assert.rejects(changes.revertChange(classA, c.id, owner), /又变了/);
    assert.equal(repo.readText(classA, '撤回冲突.md'), '后来内容');
  });
  await t.test('同名学生在另一班出现，不误拦本人的记录', async () => {
    addStudent(classB, '测试学生甲', 'TEST-B-SAME');
    await put(classA, '个人/同名核对.md', '测试学生甲仍需练习', { studentId: alice });
    assert.throws(() => access.checkIdentity(classA, 'TEST-B-SAME 的情况', alice), /个人情况/);
  });
  await t.test('二进制原件移动、删除、撤回保持完整字节', async () => {
    const bytes = Buffer.from([0, 255, 128, 1, 2]),
      sid = repo.saveSource(long, '二进制原件.pdf', bytes, '转换文字');
    await changes.createChange({
      kbId: long,
      title: '交原件',
      author: 'teacher',
      authorName: owner.name,
      kind: 'upload',
      ops: [{ path: '原件/资料.pdf', content: '', sourceId: sid, sourcePart: 'original', base: null }],
      apply: { by: teacher, as: author },
    });
    const ws = new Workspace(long);
    ws.move('原件/资料.pdf', '移后/资料.pdf');
    const moved = await changes.createChange({
      kbId: long,
      title: '移动原件',
      author: 'teacher',
      authorName: owner.name,
      kind: 'tidy',
      ops: ws.ops(),
      apply: { by: teacher, as: author },
    });
    assert.deepEqual(repo.readBinary(long, '移后/资料.pdf'), bytes);
    await changes.revertChange(long, moved.id, owner);
    assert.deepEqual(repo.readBinary(long, '原件/资料.pdf'), bytes);
    const removed = await changes.createChange({
      kbId: long,
      title: '移除原件',
      author: 'teacher',
      authorName: owner.name,
      kind: 'teacher',
      ops: [{ path: '原件/资料.pdf', content: null, base: repo.hashBytes(bytes) }],
      apply: { by: teacher, as: author },
    });
    await changes.revertChange(long, removed.id, owner);
    assert.deepEqual(repo.readBinary(long, '原件/资料.pdf'), bytes);
  });
  await t.test('数据库发布失败时新内容不可见，恢复后能继续写', async () => {
    const before = access.loadKb(long).head_sha,
      update = db.update.bind(db);
    let injected = false;
    db.update = ((table: string, ...args: any[]) => {
      if (table === 'knowledge_bases' && !injected) {
        injected = true;
        throw new Error('测试数据库发布失败');
      }
      return (update as any)(table, ...args);
    }) as typeof db.update;
    try {
      await assert.rejects(put(long, '不应半写.md', '内容'), /测试数据库发布失败/);
    } finally {
      db.update = update;
    }
    assert.equal(access.loadKb(long).head_sha, before);
    assert.equal(repo.readText(long, '不应半写.md'), null);
    const { recoverRepositoryRefs } = await import('../src/kb/migrate.js');
    recoverRepositoryRefs();
    await put(long, '恢复后.md', '成功');
    assert.equal(repo.readText(long, '恢复后.md'), '成功');
  });
  await t.test('学期提炼只能读当前来源，目标长期库不暴露其他原件', async () => {
    const { validateEvidence } = await import('../src/kb/evidence.js');
    const target = new Workspace(long, false, false);
    assert.equal(target.read('档案/教案.md'), null);
    assert.ok(!(await target.list()).some((e) => e.sourceId));
    const source = new Workspace(classA, true);
    assert.ok(source.read('全班安排.md'));
    assert.deepEqual(validateEvidence([], source), []);
    const exact = source.read('全班安排.md')!;
    assert.equal(validateEvidence([{ text: '测试经验', sources: [{ path: '全班安排.md', quote: exact }] }], source).length, 1);
    assert.throws(() => validateEvidence([{ text: '测试经验', sources: [{ path: '全班安排.md', quote: '这不是原文' }] }], source), /原句/);
    assert.throws(() => validateEvidence([{ text: '跨库来源', sources: [{ path: '规矩.md', quote: '内容' }] }], source), /本班封存/);
    assert.throws(() => validateEvidence([{ text: '缺少依据', sources: [] }], source), /原文依据/);
    assert.throws(() => source.write('不能写.md', '内容'), /只能读取/);
    assert.throws(() => source.remove('全班安排.md'), /只能读取/);
    assert.throws(() => source.move('全班安排.md', '移动.md'), /只能读取/);
  });
  await t.test('封存来源用独立工具读取，同名目录不占用老师命名空间', async () => {
    const { runTool } = await import('../src/kb/keeper.js');
    await put(long, '本学期档案/同名.md', '长期同名文档');
    await put(classA, '同名.md', '本班来源');
    await put(classB, '同名.md', '别班来源');
    const target = new Workspace(long),
      source = new Workspace(classA, true);
    const current = await runTool(target, { id: 'current', raw: '{}', name: 'read_file', args: { path: '本学期档案/同名.md' } }, source);
    assert.equal(JSON.parse(current.content).text, '长期同名文档');
    const archived = await runTool(
      target,
      { id: 'source', raw: '{}', name: 'read_source_file', args: { path: '同名.md', kbId: classB } },
      source,
    );
    assert.equal(JSON.parse(archived.content).result.text, '本班来源');
    await assert.rejects(runTool(target, { id: 'none', raw: '{}', name: 'read_source_file', args: { path: '同名.md' } }), /没有可读取/);
    await assert.rejects(
      runTool(target, { id: 'write', raw: '{}', name: 'write_source_file', args: { path: '同名.md', content: '篡改' } }, source),
      /没有这个工具/,
    );
    assert.equal(repo.readText(classA, '同名.md'), '本班来源');
  });
  await t.test('提炼经验保留核对文字和真实出处，不接受另一份正文', async () => {
    const { placeExperience } = await import('../src/kb/experience.js');
    const ws = new Workspace(long),
      placed = new Set<number>();
    ws.write('经验.md', '## 教学经验\n已有内容\n\n## 其他\n保持原样\n');
    const findings = [{ text: '课堂练习先画调用栈，再写基例。', sources: [{ path: '资料/教学反思.md', quote: '原句' }] }];
    placeExperience(
      ws,
      findings,
      { name: '测试班', term: '2026 秋季' },
      { path: '经验.md', section: '教学经验', indices: [1], content: '伪造的新做法' },
      placed,
    );
    assert.equal(
      ws.read('经验.md'),
      '## 教学经验\n已有内容\n\n课堂练习先画调用栈，再写基例。\n\n出处：测试班，2026 秋季，《教学反思》。\n\n## 其他\n保持原样\n',
    );
    assert.throws(
      () => placeExperience(ws, findings, { name: '测试班', term: null }, { path: '重复.md', section: '经验', indices: [1] }, placed),
      /已经放入/,
    );
    assert.throws(
      () => placeExperience(ws, findings, { name: '测试班', term: null }, { path: '错误.md', section: '经验', indices: [9] }, new Set()),
      /编号/,
    );
    assert.throws(
      () =>
        placeExperience(ws, findings, { name: '测试班', term: null }, { path: '档案/教案.md', section: '经验', indices: [1] }, new Set()),
      /原件|转换文字/,
    );
    placeExperience(
      ws,
      findings,
      { name: '测试班', term: '2026 秋季' },
      { path: '独立经验.md', section: '课堂练习', indices: [1] },
      new Set(),
    );
    assert.ok(ws.read('独立经验.md')!.startsWith('## 课堂练习\n\n课堂练习先画调用栈'));
  });
  await t.test('暂存中的个人记录重写仍保留学生归属', () => {
    const ws = new Workspace(classA);
    ws.write('个人/暂存.md', '测试学生甲需要练习', alice);
    ws.write('个人/暂存.md', '测试学生甲已完成练习');
    assert.equal(ws.ops()[0].studentId, alice);
    assert.throws(() => ws.write('个人/暂存.md', '另一个人', bob), /不能改变/);
  });
  await t.test('长单行资料分段读取不丢字、不拆开表情字符', () => {
    const original = '甲'.repeat(11999) + '🙂' + '乙'.repeat(15000);
    let offset = 0,
      result = '';
    for (;;) {
      const part = textChunk(original, 1, 1, offset);
      result += part.text;
      if (part.next_char === null) break;
      assert.ok(part.next_char > offset);
      offset = part.next_char;
    }
    assert.equal(result, original);
    assert.equal(textChunk('第一行\n第二行', 2).text, '第二行');
    assert.throws(() => textChunk('只有一行', 2), /范围/);
  });
  await t.test('学生观察继承调用身份，工作区强制个人归属而非依赖正文姓名', async () => {
    const principal = { role: 'assistant' as const, teacherId: teacher, classId: classA, studentId: alice };
    const job = reader.submitObservation(principal, { kbId: classA, sourceId: 'scope-test', sender: 'grader', content: '基例仍需练习' });
    assert.equal(db.value('SELECT student_id FROM kb_inbox WHERE id=?', job), alice);
    assert.throws(
      () =>
        reader.submitObservation(
          { ...principal, studentId: bob },
          { kbId: classA, sourceId: 'scope-test', sender: 'grader', content: '另一条' },
        ),
      /不同学生/,
    );
    const ws = new Workspace(classA, false, false, alice);
    ws.write('个人/来自批改.md', '基例仍需练习');
    assert.equal(ws.ops()[0].studentId, alice);
    assert.equal(ws.read('共有目录/仍是个人.md'), null);
    assert.equal(ws.read('待识别.md'), null);
    assert.throws(() => ws.write('全班安排.md', '覆盖全班'), /指定学生/);
    assert.throws(() => ws.write('换人.md', '换人', bob), /学生归属/);
    assert.throws(() => ws.remove('全班安排.md'), /指定学生/);
    assert.ok((await ws.list()).every((e) => e.studentId === undefined || e.studentId === alice));
  });
  await t.test('封存后各写入入口都被阻止，资料仍可查阅', async () => {
    const interrupted = db.insert('kb_changes', {
      kb_id: classA,
      title: '待处理改动',
      author: 'keeper',
      author_name: '整理助手',
      kind: 'keeper',
      status: 'conflict',
      ops: [],
      created_at: Date.now(),
    });
    const r = await req(`/knowledge/${classA}/archive`, 'teacher', {});
    assert.equal(r.status, 200);
    assert.equal(changes.publicChange(changes.loadChange(interrupted)).status, 'canceled');
    await assert.rejects(put(classA, '不可写.md', '内容'), /封存/);
    assert.throws(() => new Workspace(classA).write('不可写.md', '内容'), /封存/);
    assert.equal(
      (
        await req(`/knowledge/${classA}/students`, 'teacher', {
          students: [{ name: '新学生', studentNo: 'NEW' }],
        })
      ).status,
      409,
    );
    assert.equal((await req(`/knowledge/${classA}/kb/tree`)).status, 200);
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  db.raw.close();
  (await import('../src/config.js')).releaseDataLock();
  rmSync(dir, { recursive: true, force: true });
});

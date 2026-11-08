import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-bases-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const repo = await import('../src/kb/repo.js');
const changes = await import('../src/kb/changes.js');
const bases = await import('../src/kb/bases.js');
const access = await import('../src/kb/access.js');
const { Workspace, runTool, runKbTool } = await import('../src/kb/keeper.js');
const { createApp } = await import('../src/app.js');
const app = createApp();

const user = (name: string, role = 'teacher') =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
const teacher = user('测试老师甲'),
  other = user('测试老师乙');
const owner = { id: teacher, name: '测试老师甲' },
  author = changes.teacherAuthor(owner);
const first = await repo.ensureTeacherKb(teacher),
  foreign = await repo.ensureTeacherKb(other);
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
const cookies = { teacher: cookie(teacher), other: cookie(other) };
async function req(path: string, body?: unknown, method?: string, who: keyof typeof cookies = 'teacher') {
  const r = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as any };
}
const put = (kbId: number, path: string, content: string) =>
  changes.createChange({
    kbId,
    title: '测试记录',
    author: 'teacher',
    authorName: owner.name,
    kind: 'teacher',
    ops: [{ path, content, base: repo.readText(kbId, path) === null ? null : repo.hashText(repo.readText(kbId, path)!) }],
    apply: { by: teacher, as: author },
  });
async function addMaterial(kbId: number, path: string, text: string) {
  const sid = repo.saveSource(kbId, path.split('/').pop()!, Buffer.from('原件' + text), text);
  await changes.createChange({
    kbId,
    title: '交资料',
    author: 'teacher',
    authorName: owner.name,
    kind: 'upload',
    ops: [{ path, content: text, base: null, sourceId: sid }],
    apply: { by: teacher, as: author },
  });
  return sid;
}
const paths = (kbId: number) => repo.manifest(kbId).map((e) => e.path).sort();

test('知识库不分种类：想建几个建几个，能改名、删除、互相挪文件', async (t) => {
  let second = 0;
  await t.test('只要一个名字就能新建，名字不能空、不能重名', async () => {
    const made = await req('/knowledge', { name: ' 数据结构 ' });
    assert.equal(made.status, 200);
    second = made.json.id;
    assert.equal(repo.manifest(second).length, 0);
    const list = await req('/knowledge');
    assert.deepEqual(
      list.json.knowledgeBases.map((k: any) => k.name),
      ['我的知识库', '数据结构'],
    );
    assert.equal((await req('/knowledge', { name: '数据结构' })).status, 409);
    assert.equal((await req('/knowledge', { name: '   ' })).status, 400);
    // 别的老师可以用同样的名字
    assert.equal((await req('/knowledge', { name: '数据结构' }, 'POST', 'other')).status, 200);
  });
  await t.test('改名不能和自己别的库重名，别人的库改不了', async () => {
    assert.equal((await req(`/knowledge/${second}`, { name: '数据结构与算法' }, 'PATCH')).status, 200);
    assert.equal((await req(`/knowledge/${second}`, { name: '我的知识库' }, 'PATCH')).status, 409);
    assert.equal((await req(`/knowledge/${foreign}`, { name: '偷改' }, 'PATCH')).status, 403);
  });
  await t.test('笔记和原件挪到另一个库：内容、保护状态不变，原处拿走，两边都能撤回', async () => {
    await put(first, '笔记/递归.md', '# 递归\n先找终止条件。\n');
    await put(first, '笔记/排序.md', '# 排序\n冒泡排序。\n');
    const sid = await addMaterial(first, '资料/递归讲义.md', '递归讲义正文');
    const before = access.loadKb(first).head_sha;
    const r = await req(`/knowledge/${first}/kb/transfer`, { paths: ['笔记/递归.md', '资料/递归讲义.md'], to: second });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.moved.sort(), ['笔记/递归.md', '资料/递归讲义.md']);
    assert.deepEqual(paths(first), ['笔记/排序.md']);
    assert.deepEqual(paths(second), ['笔记/递归.md', '资料/递归讲义.md']);
    assert.equal(repo.readText(second, '笔记/递归.md'), '# 递归\n先找终止条件。\n');
    const moved = repo.manifest(second).find((e) => e.path === '资料/递归讲义.md')!;
    assert.ok(moved.sourceId && moved.sourceId !== sid);
    assert.equal(db.value('SELECT kb_id FROM kb_sources WHERE id=?', moved.sourceId), second);
    assert.deepEqual(repo.sourceBytes(moved.sourceId, 'original'), Buffer.from('原件递归讲义正文'));
    // 原件还是受保护的
    await assert.rejects(put(second, '资料/递归讲义.md', '改写'), /不能改写/);
    // 这边的历史照样能打开
    assert.equal(repo.readText(first, '资料/递归讲义.md', before), '递归讲义正文');
    const out = changes.loadChange(db.value<number>("SELECT id FROM kb_changes WHERE kb_id=? AND title LIKE '把%' ORDER BY id DESC LIMIT 1", first)!);
    await changes.revertChange(first, out.id, owner);
    assert.deepEqual(paths(first), ['笔记/排序.md', '笔记/递归.md', '资料/递归讲义.md']);
    assert.equal(repo.readText(first, '资料/递归讲义.md'), '递归讲义正文');
  });
  await t.test('整个文件夹一起挪；目标有同名的就一份都不动', async () => {
    const third = await bases.createKb(teacher, '排序专题');
    await put(third, '笔记/排序.md', '已有的排序笔记\n');
    const clash = await req(`/knowledge/${first}/kb/transfer`, { paths: ['笔记'], to: third });
    assert.equal(clash.status, 409);
    assert.deepEqual(paths(first), ['笔记/排序.md', '笔记/递归.md', '资料/递归讲义.md']);
    assert.deepEqual(paths(third), ['笔记/排序.md']);
    const fourth = await bases.createKb(teacher, '笔记归档');
    assert.equal((await req(`/knowledge/${first}/kb/transfer`, { paths: ['笔记'], to: fourth })).status, 200);
    assert.deepEqual(paths(fourth), ['笔记/排序.md', '笔记/递归.md']);
    assert.deepEqual(paths(first), ['资料/递归讲义.md']);
  });
  await t.test('别的老师的库挪不进去', async () => {
    assert.equal((await req(`/knowledge/${first}/kb/transfer`, { paths: ['资料/递归讲义.md'], to: foreign })).status, 403);
    assert.deepEqual(paths(first), ['资料/递归讲义.md']);
  });
  await t.test('学生个人记录不能挪；写着已登记学生的笔记挪不进普通知识库', async () => {
    const klass = await repo.createKnowledgeBase({ teacherId: teacher, name: '测试班', className: '测试班', term: '测试学期' });
    const sid = db.insert('kb_students', { kb_id: klass, name: '测试学生甲', student_no: 'T-1', aliases: [], created_at: Date.now() });
    await changes.createChange({
      kbId: klass,
      title: '个人记录',
      author: 'teacher',
      authorName: owner.name,
      kind: 'teacher',
      ops: [{ path: '学生/甲.md', content: '测试学生甲 递归没写终止条件\n', base: null, studentId: sid }],
      apply: { by: teacher, as: author },
    });
    await put(klass, '全班/名单备注.md', '当课代表\n');
    assert.equal((await req(`/knowledge/${klass}/kb/transfer`, { paths: ['学生/甲.md'], to: second })).status, 400);
    // 全班共有的笔记里写了学生名字（系统允许班里有），挪进普通知识库会被拦下，两边都不变
    db.run('UPDATE kb_students SET aliases=? WHERE id=?', JSON.stringify(['课代表']), sid);
    const blocked = await req(`/knowledge/${klass}/kb/transfer`, { paths: ['全班/名单备注.md'], to: second });
    assert.equal(blocked.status, 400);
    assert.ok(paths(klass).includes('全班/名单备注.md'));
    assert.ok(!paths(second).includes('全班/名单备注.md'));
  });
  await t.test('删除只做记号：删掉后打不开、不在列表里；最后一个不能删', async () => {
    const extra = await bases.createKb(teacher, '要删的');
    await put(extra, '随手记.md', '随手记\n');
    assert.equal((await req(`/knowledge/${extra}`, undefined, 'DELETE')).status, 200);
    assert.equal((await req(`/knowledge/${extra}`)).status, 404);
    assert.equal((await req(`/knowledge/${extra}/kb/tree`)).status, 404);
    assert.ok(!(await req('/knowledge')).json.knowledgeBases.some((k: any) => k.id === extra));
    // 东西还在磁盘上
    assert.equal(repo.readText(extra, '随手记.md'), '随手记\n');
    const onlyOne = await repo.ensureTeacherKb(other);
    for (const k of bases.listKbs(other)) if (k.id !== onlyOne) bases.deleteKb(k, { onlyEmpty: false, busy: false });
    assert.equal((await req(`/knowledge/${onlyOne}`, undefined, 'DELETE', 'other')).status, 400);
    // 删了最早那个，进来就打开下一个
    const me1 = await req('/auth/me');
    assert.equal(me1.json.user.kbId, first);
  });
});

test('整理助手操作知识库：用名字指代，立即生效，只删空的', async (t) => {
  const kb = access.loadKb(first);
  const call = (name: string, args: Record<string, unknown>) => ({ id: randomUUID(), name, args, raw: JSON.stringify(args) });
  await t.test('列出全部知识库，标出当前这个', async () => {
    const ws = new Workspace(first);
    const r = await runKbTool(kb, ws, call('list_knowledge_bases', {}), 0);
    const list = JSON.parse(r.content);
    assert.equal(list.find((k: any) => k.current).name, '我的知识库');
    assert.ok(list.some((k: any) => k.name === '笔记归档' && k.files.includes('笔记/排序.md')));
    assert.ok(!r.content.includes(`"id"`));
  });
  await t.test('新建、改名、挪文件、删空库都直接生效，没有暂存改动也能收尾', async () => {
    const ws = new Workspace(first);
    await runKbTool(kb, ws, call('create_knowledge_base', { name: '递归专题' }), 0);
    const target = bases.findKb(teacher, '递归专题');
    const moved = await runKbTool(kb, ws, call('move_to_knowledge_base', { paths: ['资料/递归讲义.md'], to: '递归专题' }), 0);
    assert.equal(moved.event.count, 1);
    assert.deepEqual(paths(target.id), ['资料/递归讲义.md']);
    // 挪走的文件这次不再看到，收尾也不碰它
    assert.equal(ws.read('资料/递归讲义.md'), null);
    assert.equal(ws.ops().length, 0);
    await runKbTool(kb, ws, call('rename_knowledge_base', { name: '递归专题', new_name: '递归' }), 0);
    assert.equal(bases.findKb(teacher, '递归').id, target.id);
    await assert.rejects(runKbTool(kb, ws, call('delete_knowledge_base', { name: '递归' }), 0), /还有东西/);
    await assert.rejects(runKbTool(kb, ws, call('delete_knowledge_base', { name: '我的知识库' }), 0), /当前知识库不能删/);
    await assert.rejects(runKbTool(kb, ws, call('rename_knowledge_base', { name: '不存在的库', new_name: 'x' }), 0), /现有：/);
    const empty = await bases.createKb(teacher, '空的');
    await runKbTool(kb, ws, call('delete_knowledge_base', { name: '空的' }), 0);
    assert.ok(access.loadKb(empty).deleted_at);
    const done = await runTool(ws, call('finish', { title: '建了递归库', reason: '老师要求' }));
    assert.equal(done.content, '完成');
  });
  await t.test('这次改过还没提交的文件不能挪', async () => {
    await put(first, '待改.md', '原文\n');
    const ws = new Workspace(first);
    ws.write('待改.md', '改了一半\n');
    await assert.rejects(runKbTool(kb, ws, call('move_to_knowledge_base', { paths: ['待改.md'], to: '递归' }), 0), /还没提交/);
    assert.ok(paths(first).includes('待改.md'));
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  db.raw.close();
  (await import('../src/config.js')).releaseDataLock();
  rmSync(dir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'coteach-desk-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const repo = await import('../src/kb/repo.js');
const changes = await import('../src/kb/changes.js');
const { Desk } = await import('../src/kb/agent/desk.js');

const teacher = db.insert('users', { username: randomUUID(), name: '测试老师', role: 'teacher', password_hash: 'not-a-login-password', created_at: Date.now() });
const owner = { id: teacher, name: '测试老师' };
const kb = { id: await repo.ensureTeacherKb(teacher) };
await changes.createChange({
  kbId: kb.id,
  title: '交资料',
  author: 'teacher',
  authorName: owner.name,
  kind: 'upload',
  ops: [
    { path: '课程大纲.md', content: '课程大纲正文', base: null, sourceId: repo.saveSource(kb.id, '课程大纲.md', Buffer.from('原件'), '课程大纲正文') },
    { path: '规矩.md', content: '规矩正文', base: null },
  ],
  apply: { by: teacher, as: changes.teacherAuthor(owner) },
});

/** 桌面上这个库里的文件、Workspace 里的文件和原件身份 */
async function state(desk: Awaited<ReturnType<typeof Desk.open>>) {
  const ws = desk.spaces.get(kb.id)!;
  return {
    listed: (await ws.list()).map((f) => f.path).sort(),
    originals: (await ws.list()).filter((f) => f.sourceId).map((f) => f.path),
  };
}

test('整理助手挪文件：像电脑上拖文件，出错就整个退回', async (t) => {
  const desk = await Desk.open(teacher);
  const folder = desk.folderOf(kb.id);
  const file = (p: string) => join(desk.root, folder, ...p.split('/'));
  // 它先写了整理稿，文件夹「课程大纲」就有了
  await import('node:fs').then((fs) => {
    fs.mkdirSync(file('课程大纲'), { recursive: true });
    fs.writeFileSync(file('课程大纲/课程大纲（整理）.md'), '整理稿');
  });
  await desk.sync();

  await t.test('挪到一个已有的文件夹，就是放进去，原件身份还在', async () => {
    const r = await desk.moveWithin(kb.id, '课程大纲.md', '课程大纲');
    assert.equal(r.to, '课程大纲/课程大纲.md');
    assert.ok(existsSync(file('课程大纲/课程大纲.md')));
    assert.ok(!existsSync(file('课程大纲.md')));
    assert.equal(statSync(file('课程大纲/课程大纲.md')).mode & 0o200, 0, '原件还是只读');
    assert.deepEqual((await state(desk)).originals, ['课程大纲/课程大纲.md']);
    // 对账以后也还是原件
    assert.deepEqual(await desk.sync(), []);
    assert.deepEqual((await state(desk)).originals, ['课程大纲/课程大纲.md']);
  });

  await t.test('写成「文件夹/」：文件夹还没有也放进去', async () => {
    const r = await desk.moveWithin(kb.id, '规矩.md', '总则', true);
    assert.equal(r.to, '总则/规矩.md');
    assert.equal(readFileSync(file('总则/规矩.md'), 'utf8'), '规矩正文');
  });

  await t.test('目标已经有文件：不动，说清楚', async () => {
    const before = await state(desk);
    await assert.rejects(desk.moveWithin(kb.id, '总则/规矩.md', '课程大纲/课程大纲.md'), /已经有了/);
    assert.deepEqual(await state(desk), before);
    assert.ok(existsSync(file('总则/规矩.md')));
  });

  await t.test('不能挪进它自己里面', async () => {
    await assert.rejects(desk.moveWithin(kb.id, '课程大纲', '课程大纲/子'), /自己里面/);
  });

  await t.test('挪到一半文件系统出错：文件和记录都退回原样', async () => {
    // 原件先挪过去，整理稿挪不过去：目标上有一个同名的文件夹（Workspace 不知道它）
    const fs = await import('node:fs');
    fs.mkdirSync(join(file('新位置/课程大纲/课程大纲（整理）.md'), '挡路'), { recursive: true });
    const before = await state(desk);
    await assert.rejects(desk.moveWithin(kb.id, '课程大纲', '新位置'), (err: Error) => {
      assert.match(err.message, /没挪成/);
      assert.doesNotMatch(err.message, /[A-Za-z]:\\|\/tmp\//, '不把服务器上的路径说出去');
      return true;
    });
    assert.deepEqual(await state(desk), before);
    assert.ok(existsSync(file('课程大纲/课程大纲.md')));
    assert.ok(existsSync(file('课程大纲/课程大纲（整理）.md')));
    assert.equal(statSync(file('课程大纲/课程大纲.md')).mode & 0o200, 0, '原件还是只读');
    assert.deepEqual((await state(desk)).originals, ['课程大纲/课程大纲.md']);
  });
});

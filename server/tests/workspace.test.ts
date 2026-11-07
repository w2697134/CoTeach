import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileOp } from '../src/kb/repo.js';

const dir = mkdtempSync(join(tmpdir(), 'coteach-workspace-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const repo = await import('../src/kb/repo.js');
const changes = await import('../src/kb/changes.js');
const { Workspace } = await import('../src/kb/keeper.js');
const teacher = db.insert('users', {
  username: 'workspace-test',
  name: '测试老师',
  role: 'teacher',
  password_hash: 'not-login',
  created_at: Date.now(),
});
const owner = { id: teacher, name: '测试老师' },
  author = changes.teacherAuthor(owner);
const kb = await repo.ensureTeacherKb(teacher, owner.name);
const submit = (ops: FileOp[], apply = true) =>
  changes.createChange({
    kbId: kb,
    title: '整理记录',
    author: 'keeper',
    authorName: '整理助手',
    kind: 'keeper',
    ops,
    ...(apply ? { apply: { by: teacher, as: author } } : {}),
  });
const put = async (path: string, content: string) => {
  const ws = new Workspace(kb);
  ws.write(path, content);
  return submit(ws.ops());
};

test('工作区快照和按文件身份提交', async (t) => {
  await t.test('移到原位置被拒绝，内容和发布指针不变', async () => {
    await put('same.md', '原文');
    const head = db.value('SELECT head_sha FROM knowledge_bases WHERE id=?', kb);
    await assert.rejects(
      submit([
        {
          from: 'same.md',
          path: 'same.md',
          content: null,
          base: repo.hashText('原文'),
        },
      ]),
      /位置|相同/,
    );
    assert.equal(repo.readText(kb, 'same.md'), '原文');
    assert.equal(db.value('SELECT head_sha FROM knowledge_bases WHERE id=?', kb), head);
  });
  await t.test('任务读取和写入都绑定启动快照，不覆盖老师并发编辑', async () => {
    await put('snapshot.md', '旧内容');
    const ws = new Workspace(kb);
    assert.equal(ws.read('snapshot.md'), '旧内容');
    await put('snapshot.md', '老师的新内容');
    assert.equal(ws.read('snapshot.md'), '旧内容');
    ws.write('snapshot.md', '根据旧内容修改');
    await assert.rejects(submit(ws.ops()), /已被更新/);
    assert.equal(repo.readText(kb, 'snapshot.md'), '老师的新内容');
  });
  await t.test('内容一样但删除重建了条目，旧任务也不能覆盖', async () => {
    await put('identity.md', '相同内容');
    const stale = new Workspace(kb);
    const remove = new Workspace(kb);
    remove.remove('identity.md');
    await submit(remove.ops());
    await put('identity.md', '相同内容');
    stale.write('identity.md', '过期修改');
    await assert.rejects(submit(stale.ops()), /已被更新/);
    assert.equal(repo.readText(kb, 'identity.md'), '相同内容');
  });
  await t.test('移动并改写需确认，修订稿与撤回恢复原路径和原文', async () => {
    await put('combined.md', '改前');
    const id = repo.manifest(kb).find((e) => e.path === 'combined.md')!.id;
    const ws = new Workspace(kb);
    ws.move('combined.md', 'combined-new.md');
    ws.write('combined-new.md', '改后');
    assert.equal(ws.read('combined.md'), null);
    assert.equal(ws.read('combined-new.md'), '改后');
    assert.equal(changes.isTidy(kb, ws.ops()), false);
    const c = await submit(ws.ops(), false);
    const diff = (await changes.changeDiff(c)).files[0];
    assert.deepEqual([diff.from, diff.path, diff.before, diff.after], ['combined.md', 'combined-new.md', '改前', '改后']);
    assert.equal(repo.readText(kb, 'combined.md'), '改前');
    await changes.applyChange(kb, c.id, teacher, author);
    assert.equal(repo.manifest(kb).find((e) => e.path === 'combined-new.md')!.id, id);
    assert.equal(repo.readText(kb, 'combined-new.md'), '改后');
    await changes.revertChange(kb, c.id, owner);
    assert.equal(repo.readText(kb, 'combined.md'), '改前');
    assert.equal(repo.readText(kb, 'combined-new.md'), null);
  });
  await t.test('临时位置交换两个文件，一次提交和撤回不串内容或身份', async () => {
    await put('swap-a.md', '甲');
    await put('swap-b.md', '乙');
    const ids = repo
      .manifest(kb)
      .filter((e) => e.path.startsWith('swap-'))
      .map((e) => e.id)
      .sort();
    const ws = new Workspace(kb);
    ws.move('swap-a.md', 'temp.md');
    ws.move('swap-b.md', 'swap-a.md');
    ws.move('temp.md', 'swap-b.md');
    const c = await submit(ws.ops());
    assert.equal(repo.readText(kb, 'swap-a.md'), '乙');
    assert.equal(repo.readText(kb, 'swap-b.md'), '甲');
    assert.deepEqual(
      repo
        .manifest(kb)
        .filter((e) => e.path.startsWith('swap-'))
        .map((e) => e.id)
        .sort(),
      ids,
    );
    await changes.revertChange(kb, c.id, owner);
    assert.equal(repo.readText(kb, 'swap-a.md'), '甲');
    assert.equal(repo.readText(kb, 'swap-b.md'), '乙');
  });
  await t.test('删除目标后再移动，或删除重建，同批操作可撤回', async () => {
    await put('replace-a.md', '甲');
    await put('replace-b.md', '乙');
    const ws = new Workspace(kb);
    ws.remove('replace-b.md');
    ws.move('replace-a.md', 'replace-b.md');
    const c = await submit(ws.ops());
    assert.equal(repo.readText(kb, 'replace-b.md'), '甲');
    await changes.revertChange(kb, c.id, owner);
    assert.equal(repo.readText(kb, 'replace-a.md'), '甲');
    assert.equal(repo.readText(kb, 'replace-b.md'), '乙');
    const oldId = repo.manifest(kb).find((e) => e.path === 'replace-a.md')!.id;
    const replacement = new Workspace(kb);
    replacement.remove('replace-a.md');
    replacement.write('replace-a.md', '新文件');
    const c2 = await submit(replacement.ops());
    assert.notEqual(repo.manifest(kb).find((e) => e.path === 'replace-a.md')!.id, oldId);
    await changes.revertChange(kb, c2.id, owner);
    assert.equal(repo.readText(kb, 'replace-a.md'), '甲');
    assert.equal(repo.manifest(kb).find((e) => e.path === 'replace-a.md')!.id, oldId);
  });
  await t.test('大小写改名、新建后改名、移回原处和移后删除', async () => {
    await put('Case.md', '大小写');
    const ws = new Workspace(kb);
    ws.move('Case.md', 'case.md');
    await submit(ws.ops());
    assert.equal(repo.readText(kb, 'case.md'), '大小写');
    assert.equal(repo.readText(kb, 'Case.md'), null);
    const fresh = new Workspace(kb);
    fresh.write('fresh.md', '新增');
    fresh.move('fresh.md', 'fresh-new.md');
    fresh.write('fresh-new.md', '追加');
    await submit(fresh.ops());
    assert.equal(repo.readText(kb, 'fresh-new.md'), '追加');
    const back = new Workspace(kb);
    back.move('case.md', 'back.md');
    back.move('back.md', 'case.md');
    assert.deepEqual(back.ops(), []);
    const gone = new Workspace(kb);
    gone.move('case.md', 'gone.md');
    gone.remove('gone.md');
    await submit(gone.ops());
    assert.equal(repo.readText(kb, 'case.md'), null);
    assert.equal(repo.readText(kb, 'gone.md'), null);
  });
  await t.test('待确认修订稿保留提交时原文，并标出后续冲突', async () => {
    await put('pending.md', '提交前');
    const ws = new Workspace(kb);
    ws.write('pending.md', '提议');
    const c = await submit(ws.ops(), false);
    await put('pending.md', '老师后来修改');
    const diff = await changes.changeDiff(c);
    assert.equal(diff.files[0].before, '提交前');
    assert.equal(diff.files[0].after, '提议');
    assert.deepEqual(diff.stale, ['pending.md']);
  });
  await t.test('移动受保护的二进制后不能借扩展名改写或展示为文字', async () => {
    const bytes = Buffer.from([255, 0, 128, 3]);
    const sid = repo.saveSource(kb, 'sample.pdf', bytes, '转换文字');
    await changes.createChange({
      kbId: kb,
      title: '资料',
      author: 'teacher',
      authorName: owner.name,
      kind: 'upload',
      ops: [
        {
          path: 'sample.pdf',
          content: '',
          base: null,
          sourceId: sid,
          sourcePart: 'original',
        },
      ],
      apply: { by: teacher, as: author },
    });
    const ws = new Workspace(kb);
    ws.move('sample.pdf', 'sample.md');
    assert.throws(() => ws.write('sample.md', '改原件'), /不能改写/);
    assert.equal((await ws.list()).find((e) => e.path === 'sample.md')!.text, false);
    const c = await submit(ws.ops(), false);
    const diff = (await changes.changeDiff(c)).files[0];
    assert.equal(diff.binary, true);
    assert.equal(diff.after, null);
    await changes.applyChange(kb, c.id, teacher, author);
    assert.equal((await changes.changeDiff(changes.loadChange(c.id))).files[0].binary, true);
    await changes.revertChange(kb, c.id, owner);
    assert.deepEqual(repo.readBinary(kb, 'sample.pdf'), bytes);
  });
  await t.test('重复来源、未声明的覆盖和最终文件目录冲突全部拒绝', async () => {
    await put('invalid.md', '内容');
    await put('occupied.md', '占用');
    const base = repo.hashText('内容');
    await assert.rejects(
      submit([
        { from: 'invalid.md', path: 'one.md', content: null, base },
        { from: 'invalid.md', path: 'two.md', content: null, base },
      ]),
    );
    await assert.rejects(submit([{ from: 'invalid.md', path: 'occupied.md', content: null, base }]));
    await assert.rejects(
      submit([
        { path: 'folder.md', content: 'a', base: null },
        { path: 'folder.md/child.md', content: 'b', base: null },
      ]),
    );
    assert.equal(repo.readText(kb, 'invalid.md'), '内容');
    assert.equal(repo.readText(kb, 'occupied.md'), '占用');
  });
  await t.test('转换文字相同的原文件更新仍有差异记录、可撤回且不会覆盖后续原文件', async () => {
    const upload = async (version: string) => {
      const sourceId = repo.saveSource(kb, '版本资料.pdf', Buffer.from(version), '相同文字');
      return changes.createChange({ kbId:kb, title:'更新资料', author:'teacher', authorName:owner.name, kind:'upload',
        ops:[{path:'版本资料.md',content:'相同文字',base:repo.readText(kb,'版本资料.md') === null ? null : repo.hashText('相同文字'),sourceId,sourcePart:'text'}],
        apply:{by:teacher,as:author} });
    };
    await upload('原件一');
    const second=await upload('原件二');
    const diff=await changes.changeDiff(second);
    assert.equal(diff.files.length,1);assert.equal(diff.files[0].sourceChanged,true);
    await changes.revertChange(kb,second.id,owner);
    const entry=repo.manifest(kb).find(e => e.path==='版本资料.md')!;
    assert.equal(repo.sourceBytes(entry.sourceId!,'original').toString(),'原件一');
    const third=await upload('原件三');await upload('原件四');
    await assert.rejects(changes.revertChange(kb,third.id,owner),/原文件后来又更新/);
  });
});
test.after(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  db.raw.close();
  (await import('../src/config.js')).releaseDataLock();
  rmSync(dir, { recursive: true, force: true });
});

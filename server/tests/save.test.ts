import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'coteach-save-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const repo = await import('../src/kb/repo.js');
const changes = await import('../src/kb/changes.js');
const { blobPath, storeText } = await import('../src/kb/intake/store.js');
const { Desk, INBOX } = await import('../src/kb/agent/desk.js');
const { runCommand } = await import('../src/kb/agent/commands.js');

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const teacher = db.insert('users', { username: randomUUID(), name: '测试老师', role: 'teacher', password_hash: 'not-a-login-password', created_at: Date.now() });
const owner = { id: teacher, name: '测试老师' };
const kbId = await repo.ensureTeacherKb(teacher);
// 库里已经有一份原件「课程大纲」
await changes.createChange({
  kbId,
  title: '交资料',
  author: 'teacher',
  authorName: owner.name,
  kind: 'upload',
  ops: [{ path: '课程大纲.md', content: '课程大纲正文', base: null, sourceId: repo.saveSource(kbId, '课程大纲.docx', Buffer.from('大纲原件'), '课程大纲正文') }],
  apply: { by: teacher, as: changes.teacherAuthor(owner) },
});

/** 老师这句话带的一份文件：原件放进存储，转出来的文字也放好，交资料记录里记一条（对话里显示用） */
const stamp = Date.now();
const intakeId = db.insert('kb_intakes', { kb_id: kbId, created_by: teacher, status: 'done', created_at: stamp, updated_at: stamp });
function sent(name: string, bytes: string, text: string) {
  const hash = sha(Buffer.from(bytes));
  mkdirSync(dirname(blobPath(hash)), { recursive: true });
  writeFileSync(blobPath(hash), bytes);
  const id = db.insert('kb_intake_items', { intake_id: intakeId, name, kind: 'document', size: bytes.length, status: 'done', hash, created_at: stamp, updated_at: stamp });
  return { id, name, kind: 'document', hash, text_hash: storeText(text), method: 'docx', notes: null };
}
const itemStatus = (name: string) => ({ ...db.get<{ status: string; path: string | null }>('SELECT status, path FROM kb_intake_items WHERE name=?', name) });

test('存进知识库：一模一样的原件一个库里只留一份，告诉整理助手哪几份一样', async () => {
  const desk = await Desk.open(teacher);
  const folder = desk.folderOf(kbId);
  const runId = db.insert('kb_runs', { kb_id: kbId, teacher_id: teacher, kind: 'chat', status: 'running', request: '', created_by: teacher, created_at: Date.now() });
  const items = new Map([
    ['资料/大纲（另存）.docx.md', sent('资料/大纲（另存）.docx', '大纲原件', '课程大纲正文')],
    ['资料/第3章.pptx.md', sent('资料/第3章.pptx', '第3章课件', '第3章正文')],
    ['资料/第3章(1).pptx.md', sent('资料/第3章(1).pptx', '第3章课件', '第3章正文')],
  ]);
  const turn = {
    teacherId: teacher,
    runId,
    kbId,
    token: 'test',
    user: owner,
    inbox: { root: INBOX, intakeId: 0, items },
    kind: 'chat' as const,
    desk,
    contextKbId: kbId,
    submitted: false,
    finish: null,
    changes: [],
  };
  const r = await runCommand(turn, ['存', `${INBOX}/资料`, `${folder}/资料`]);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /「大纲（另存）\.docx」和「[^」]*课程大纲\.md」一模一样/);
  assert.match(r.text, /「第3章\(1\)\.pptx」和「[^」]*资料\/第3章\.pptx\.md」一模一样/);
  const originals = repo.manifest(kbId).filter((e) => e.sourceId);
  assert.deepEqual(originals.map((e) => e.path).sort(), ['课程大纲.md', '资料/第3章.pptx.md']);
  // 对话里老师发的那几份：存了的记在哪，一样的标「重复」并记着和哪份一样
  assert.deepEqual(itemStatus('资料/第3章.pptx'), { status: 'done', path: '资料/第3章.pptx.md' });
  assert.deepEqual(itemStatus('资料/第3章(1).pptx'), { status: 'same', path: `${folder}/资料/第3章.pptx.md` });
  assert.deepEqual(itemStatus('资料/大纲（另存）.docx'), { status: 'same', path: `${folder}/课程大纲.md` });

  // 全都是库里已经有的：不交改动，照实说
  const again = await runCommand(turn, ['存', `${INBOX}/资料/第3章(1).pptx.md`, `${folder}/别处`]);
  assert.equal(again.ok, true, again.text);
  assert.match(again.text, /^没有存：/);
  assert.equal(repo.manifest(kbId).filter((e) => e.sourceId).length, 2);
});

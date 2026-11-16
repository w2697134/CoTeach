import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CT_DATA_DIR = mkdtempSync(join(tmpdir(), 'ct-keeper-'));
const { db, now } = await import('../src/db/index.js');
const { runTurn, setKeeperStep, turnMessages } = await import('../src/kb/agent/harness.js');

test('整理助手（不再用 Claude Code）：在桌面里读写改、用 ct 交改动，出不了桌面；对话接着同一段', async () => {
  const t = now();
  const teacher = db.insert('users', { username: 'kt', name: '王老师', role: 'teacher', password_hash: 'x', created_at: t });
  const runId = db.insert('kb_runs', { teacher_id: teacher, kind: 'chat', status: 'running', request: '写笔记', created_by: teacher, created_at: t });
  const cwd = mkdtempSync(join(tmpdir(), 'ct-desk-'));
  mkdirSync(join(cwd, '库'));
  writeFileSync(join(cwd, '库', '笔记.md'), '旧的说法\n第二行');
  const calls = [
    [{ name: 'list_files', args: {} }],
    [{ name: 'read_file', args: { path: '库/笔记.md' } }],
    [
      { name: 'write_file', args: { path: '库/新.md', content: 'range 左闭右开' } },
      { name: 'edit_file', args: { path: '库/笔记.md', old: '旧的', new: '新的' } },
      { name: 'read_file', args: { path: '../外面.txt' } },
    ],
    [{ name: 'ct', args: { args: ['交', '新建笔记'] } }],
  ];
  const seen: string[] = [];
  let n = 0;
  setKeeperStep(async (o) => {
    seen.push(String(o.messages[o.messages.length - 1].content));
    const c = calls[n++];
    return c ? { text: n === 1 ? '我先看看目录' : '', toolCalls: c.map((x, i) => ({ id: `c${n}-${i}`, name: x.name, args: x.args, raw: '' })) } : { text: '好了', toolCalls: [] };
  });
  const ct: string[][] = [];
  const r = await runTurn({
    ref: { teacherId: teacher, runId, kbId: null },
    cwd,
    message: '写一份 range 的笔记',
    systemPrompt: '你是整理助手',
    sessionId: null,
    maxTurns: 10,
    turnMs: 60_000,
    quietMs: 60_000,
    ct: async (args) => (ct.push(args), { ok: true, text: '交好了' }),
    userId: teacher,
    purpose: 'test',
    signal: new AbortController().signal,
  });
  assert.equal(r.reply, '好了');
  assert.equal(r.error, null);
  assert.equal(readFileSync(join(cwd, '库', '新.md'), 'utf8'), 'range 左闭右开');
  assert.equal(readFileSync(join(cwd, '库', '笔记.md'), 'utf8'), '新的说法\n第二行');
  assert.deepEqual(ct, [['交', '新建笔记']]);
  assert.match(seen[1], /库\/笔记\.md/);
  assert.match(seen[2], /1\t旧的说法/);
  assert.ok(seen.some((s) => /只能用工作目录里的文件/.test(s)));
  const events = db.all<{ type: string; data: string }>('SELECT type, data FROM kb_events WHERE run_id=? ORDER BY id', runId);
  assert.deepEqual(
    events.filter((e) => e.type === 'tool').map((e) => JSON.parse(e.data).label),
    ['看目录', '读', '写', '改'],
  );
  assert.ok(events.some((e) => e.type === 'say' && /我先看看目录/.test(e.data)));
  // 接着同一段说
  setKeeperStep(async () => ({ text: '记得', toolCalls: [] }));
  const again = await runTurn({ ...({} as any), ref: { teacherId: teacher, runId, kbId: null }, cwd, message: '还记得吗', systemPrompt: 'x', sessionId: r.sessionId, maxTurns: 3, turnMs: 60_000, quietMs: 60_000, ct: async () => ({ ok: true, text: '' }), userId: teacher, purpose: 'test', signal: new AbortController().signal });
  assert.equal(again.reply, '记得');
  assert.ok(turnMessages(teacher, r.sessionId!).length > 8);
  // 对话记录没了：告诉调用方换一段
  const lost = await runTurn({ ...({} as any), ref: { teacherId: teacher, runId, kbId: null }, cwd, message: 'x', systemPrompt: 'x', sessionId: 'keeper:没有这段', maxTurns: 3, turnMs: 60_000, quietMs: 60_000, ct: async () => ({ ok: true, text: '' }), userId: teacher, purpose: 'test', signal: new AbortController().signal });
  assert.equal(lost.lostSession, true);
  setKeeperStep(null);
});

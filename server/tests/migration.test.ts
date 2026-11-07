import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { migrations } from '../src/db/schema.js';
const roots: string[] = [];
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function fixture(multiple = false) {
  const dir = mkdtempSync(join(tmpdir(), 'coteach-migration-test-'));
  roots.push(dir);
  mkdirSync(join(dir, 'kb'), { recursive: true });
  const raw = new DatabaseSync(join(dir, 'coteach.db'));
  raw.exec(migrations[0]);
  raw.exec('CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO _migrations VALUES(1,1)');
  raw
    .prepare('INSERT INTO users(id,username,password_hash,name,role,created_at) VALUES(1,?,?,?,?,1)')
    .run('fixture-teacher', 'fixture-only', '迁移测试老师', 'teacher');
  for (let id = 1; id <= (multiple ? 2 : 1); id++) {
    raw.prepare('INSERT INTO courses(id,name,teacher_id,created_at) VALUES(?,?,1,1)').run(id, `测试课程${id}`);
    const repo = join(dir, 'kb', String(id));
    mkdirSync(join(repo, '资料'), { recursive: true });
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        stdio: 'pipe',
        windowsHide: true,
      });
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, '目录.md'), '# 保留原目录\n');
    writeFileSync(join(repo, '进度.md'), '# 原有进度\n');
    writeFileSync(join(repo, '资料', '原始教案.md'), '需要重点关注的学生：测试原件甲（需要练习）、测试原件乙（未交）\n');
    git(['add', '.']);
    git(['-c', 'user.name=迁移测试作者', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', '旧版建立知识库']);
    writeFileSync(join(repo, '进度.md'), '# 原有进度\n整理到第七章\n');
    git(['add', '.']);
    git(['-c', 'user.name=迁移测试作者', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', '旧版进度修改']);
    const sha = git(['rev-parse', 'HEAD']).toString().trim();
    raw
      .prepare(
        'INSERT INTO kb_changes(id,course_id,title,author,author_name,kind,status,ops,commit_sha,created_at,decided_at,decided_by) VALUES(?,?,?,?,?,?,?,?,?,1,2,1)',
      )
      .run(
        id,
        id,
        '旧版进度修改',
        'teacher',
        '迁移测试老师',
        'teacher',
        'applied',
        JSON.stringify([
          {
            path: '进度.md',
            content: '# 原有进度\n整理到第七章\n',
            base: 'old-hash',
          },
        ]),
        sha,
      );
    raw
      .prepare(
        'INSERT INTO kb_runs(id,course_id,kind,status,request,reply,change_id,created_by,created_at,finished_at) VALUES(?,?,?,?,?,?,?,1,1,2)',
      )
      .run(id, id, 'chat', 'done', '老师的旧交代', '旧回复', id);
    raw.prepare('INSERT INTO kb_events(id,run_id,type,data,created_at) VALUES(?,?,?,?,1)').run(id, id, 'say', '{"text":"真实旧记录"}');
  }
  const before = {
    changes: raw.prepare('SELECT * FROM kb_changes ORDER BY id').all(),
    runs: raw.prepare('SELECT * FROM kb_runs ORDER BY id').all(),
    events: raw.prepare('SELECT * FROM kb_events ORDER BY id').all(),
  };
  raw.close();
  return { dir, before };
}
function command(dir: string, mode: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve('../tools/kb-owner.ts'), mode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CT_DATA_DIR: dir,
      CT_SECRET: 'migration-test-secret-with-more-than-32-characters',
      CT_MIGRATION_FAIL_AT: '',
      CT_MIGRATION_HARD_EXIT: '',
      ...extra,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
  });
}
function read(dir: string, sql: string) {
  const db = new DatabaseSync(join(dir, 'coteach.db'), { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
function assertOldRows(dir: string, before: ReturnType<typeof fixture>['before']) {
  for (const [table, rows] of [
    ['kb_changes', before.changes],
    ['kb_runs', before.runs],
    ['kb_events', before.events],
  ] as const) {
    const actual = read(dir, `SELECT ${Object.keys(rows[0]).join(',')} FROM ${table} ORDER BY id`);
    assert.deepEqual(actual, rows, table);
  }
}
test('迁移保持原文和历史，支持预检查、重跑及进程中断恢复', async (t) => {
  await t.test('verify 拒绝旧库但不升表、不创建锁或辅助文件', () => {
    const { dir } = fixture();
    const before = hash(readFileSync(join(dir, 'coteach.db'))),
      files = readdirSync(dir).sort();
    const r = command(dir, 'verify');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /尚未迁移/);
    assert.equal(hash(readFileSync(join(dir, 'coteach.db'))), before);
    assert.deepEqual(readdirSync(dir).sort(), files);
  });
  await t.test('check 和 verify 在 WAL 模式下不在来源新建 WAL 或 SHM', () => {
    const { dir } = fixture();
    const raw = new DatabaseSync(join(dir, 'coteach.db'));
    raw.exec('PRAGMA journal_mode=WAL');
    raw.close();
    const before = hash(readFileSync(join(dir, 'coteach.db'))),
      files = readdirSync(dir).sort();
    assert.equal(command(dir, 'check').status, 0);
    assert.notEqual(command(dir, 'verify').status, 0);
    assert.equal(hash(readFileSync(join(dir, 'coteach.db'))), before);
    assert.deepEqual(readdirSync(dir).sort(), files);
  });
  await t.test('只读检查包含尚未 checkpoint 的 WAL 内容，不改变原文件', () => {
    const { dir } = fixture();
    const raw = new DatabaseSync(join(dir, 'coteach.db'));
    try {
      raw.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE courses SET name='WalSnapshotCourse'");
      const snapshot = () =>
        Object.fromEntries(
          readdirSync(dir)
            .filter((name) => name.startsWith('coteach.db'))
            .map((name) => [name, hash(readFileSync(join(dir, name)))]),
        );
      const before = snapshot();
      const result = command(dir, 'check');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /WalSnapshotCourse/);
      assert.deepEqual(snapshot(), before);
    } finally {
      raw.close();
    }
  });
  await t.test('check 不升级数据库、不写目录', () => {
    const { dir } = fixture(),
      before = hash(readFileSync(join(dir, 'coteach.db'))),
      files = readdirSync(dir).sort();
    const result = command(dir, 'check');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(hash(readFileSync(join(dir, 'coteach.db'))), before);
    assert.deepEqual(readdirSync(dir).sort(), files);
  });
  await t.test('同老师多门课合并且同名文件不覆盖，业务旧字段逐项一致', () => {
    const { dir, before } = fixture(true);
    const a = command(dir, 'migrate');
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /"ok": true/);
    assertOldRows(dir, before);
    assert.equal(read(dir, "SELECT * FROM knowledge_bases WHERE kind='teacher'").length, 1);
    assert.equal(read(dir, 'SELECT * FROM kb_students').length, 0);
    assert.equal(read(dir, 'SELECT * FROM kb_imports').length, 2);
    const state = read(dir, 'SELECT * FROM knowledge_bases');
    const b = command(dir, 'migrate');
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(read(dir, 'SELECT * FROM knowledge_bases'), state);
    assertOldRows(dir, before);
  });
  for (const point of ['archives', 'metadata', 'prepared', 'before-publish', 'published'])
    await t.test(`在 ${point} 强制退出后恢复`, () => {
      const { dir, before } = fixture();
      const crash = command(dir, 'migrate', {
        CT_MIGRATION_FAIL_AT: point,
        CT_MIGRATION_HARD_EXIT: '1',
      });
      assert.equal(crash.status, 86, crash.stdout + crash.stderr);
      if (point !== 'published') assert.equal(read(dir, 'SELECT * FROM kb_imports').length, 0);
      const recovered = command(dir, 'migrate');
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
      assert.match(recovered.stdout, /"ok": true/);
      assertOldRows(dir, before);
      assert.ok(!existsSync(join(dir, 'kb-owner-migration.json')));
      assert.equal(command(dir, 'migrate').status, 0);
    });
  await t.test('有未提交文件时停止，不擅自丢弃', () => {
    const { dir } = fixture();
    writeFileSync(join(dir, 'kb', '1', '未提交.md'), '保留我');
    const r = command(dir, 'migrate');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /未提交/);
    assert.equal(readFileSync(join(dir, 'kb', '1', '未提交.md'), 'utf8'), '保留我');
  });
});
test.after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

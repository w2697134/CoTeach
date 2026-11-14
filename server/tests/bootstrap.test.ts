import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'coteach-bootstrap-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '1';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db, setSetting } = await import('../src/db/index.js');
const { bootstrap } = await import('../src/bootstrap.js');

const demos = () => db.all<{ username: string }>('SELECT username FROM users WHERE is_demo = 1 ORDER BY username').map((u) => u.username);

test('演示账号改成 t0、s0 以后，重启不再补演示老师和演示学生', async () => {
  await bootstrap();
  assert.deepEqual(demos(), ['student', 'teacher']);
  db.run("UPDATE users SET username='t0', is_demo=0 WHERE username='teacher'");
  db.run("UPDATE users SET username='s0', student_no='s0', is_demo=0 WHERE username='student'");
  setSetting('demo_teacher_claimed', true);
  await bootstrap();
  assert.deepEqual(demos(), []);
  assert.equal(db.value("SELECT COUNT(*) FROM users WHERE username IN ('teacher','student')"), 0);
});

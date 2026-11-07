import { resolve, join, sep } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

async function main() {
  const data = resolve(process.env.CT_DATA_DIR || ''),
    output = resolve('../output');
  if (!data.startsWith(output + sep)) throw new Error('只允许隔离验收副本');
  const { bootstrap } = await import('../../server/src/bootstrap.js');
  await bootstrap();
  const { db } = await import('../../server/src/db/index.js');
  const { createKnowledgeBase, manifest, readText } = await import('../../server/src/kb/repo.js');
  const { submitObservation } = await import('../../server/src/kb/reader.js');
  const owner = db.get<any>("SELECT id,name FROM users WHERE username='teacher'")!;
  const kb = await createKnowledgeBase({ teacherId: owner.id, name: '观察来源验收', className: '观察来源验收', term: '隔离验收学期' });
  const student = db.insert('kb_students', { kb_id: kb, name: '观察验收甲', student_no: 'OBS-001', aliases: [], created_at: Date.now() });
  const cases = ['递归练习中遗漏终止条件，需要补练基例。', '补练时已正确写出基例，但递归调用参数仍需练习。'];
  const rows = [];
  for (const [i, content] of cases.entries()) {
    const sourceId = `grading-${i + 1}`;
    const id = submitObservation(
      { role: 'assistant', teacherId: owner.id, classId: kb, studentId: student },
      { kbId: kb, sender: 'grader', sourceId, content },
    );
    let job: any;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      job = db.get<any>('SELECT * FROM kb_inbox WHERE id=?', id);
      if (['accepted', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const run = job.run_id ? db.get<any>('SELECT * FROM kb_runs WHERE id=?', job.run_id) : null;
    const change = run?.change_id ? db.get<any>('SELECT * FROM kb_changes WHERE id=?', run.change_id) : null;
    const files = manifest(kb),
      text = files.map((f) => readText(kb, f.path) || '').join('\n');
    const ok =
      job.status === 'accepted' &&
      run?.status === 'done' &&
      change?.status === 'applied' &&
      files.length > 0 &&
      files.every((f) => f.studentId === student) &&
      text.includes('批改助手') &&
      (text + '\n' + change.reason).includes(sourceId);
    rows.push({ case: i + 1, ok, job, run, change, files, text });
    console.log(JSON.stringify({ case: i + 1, ok, status: job.status }));
  }
  writeFileSync(join(output, 'kb-owner/model-observation.json'), JSON.stringify(rows, null, 2));
  db.raw.close();
  assert.ok(
    rows.every((r) => r.ok),
    '观察来源验收失败，详见原文记录',
  );
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});

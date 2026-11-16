/**
 * 批改尺子的子进程：在一份复制出来的数据目录里（CT_DATA_DIR）搭一个班、一份作业、几份答卷，
 * 真模型拟评分标准、每份批两遍，结果写到 <数据目录>/report.json。由 ruler.ts 起。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, now, setSetting } from '../../server/src/db/index.js';
import * as repo from '../../server/src/kb/repo.js';
import * as changes from '../../server/src/kb/changes.js';
import { draftRubric, rubricOf } from '../../server/src/grading/rubric.js';
import { enqueueGrade, setGradeAuto } from '../../server/src/grading/jobs.js';
import { gradeItems, gradeMarks, type AiGradeRow } from '../../server/src/grading/common.js';
import { ANSWERS, CASES, QUESTIONS } from './cases.js';

const [base, roundsArg] = process.argv.slice(2);
const ROUNDS = Number(roundsArg || 2);
const t = now();
const teacher = db.insert('users', { username: `ruler-${t}`, name: '王建国', role: 'teacher', password_hash: 'x', created_at: t });
const owner = { id: teacher, name: '王建国' };
const kb = await repo.createKnowledgeBase({ teacherId: teacher, name: 'Python 程序设计' });
const put = (path: string, content: string) =>
  changes.createChange({
    kbId: kb,
    title: '尺子资料',
    author: 'teacher',
    authorName: '王建国',
    kind: 'teacher',
    ops: [{ path, content, base: null }],
    apply: { by: teacher, as: changes.teacherAuthor(owner) },
  });
await put('第三章 循环/课后习题.md', QUESTIONS);
await put('第三章 循环/课后习题 参考答案.md', ANSWERS);
const klass = db.insert('classes', { teacher_id: teacher, name: '计科2505', join_code: `R${String(t).slice(-5)}`, join_open: 1, created_at: t, updated_at: t });
const hw = db.insert('assignments', {
  class_id: klass,
  teacher_id: teacher,
  title: '第三章课后题',
  body: '做第三章课后习题第 1、2、3 题，代码贴在下面。',
  points: 100,
  due_at: t + 3 * 86400_000,
  allow_late: 1,
  publish_at: t - 86400_000,
  ai_mode: 'hold',
  created_at: t,
  updated_at: t,
});
const subs = CASES.map((c, k) => {
  const u = db.insert('users', { username: `ruler-s${k}-${t}`, name: c.who, role: 'student', password_hash: 'x', created_at: t });
  db.insert('class_students', { class_id: klass, student_no: `20260${k}`, name: c.who, user_id: u, in_roster: 0, joined_at: t, created_at: t });
  return { c, sub: db.insert('submissions', { assignment_id: hw, user_id: u, text: c.text, submitted_at: t - 3600_000, late: 0, updated_at: t }) };
});

const r0 = Date.now();
await draftRubric(hw);
const rubric = rubricOf(hw);
const rubricMs = Date.now() - r0;

setSetting('grade_concurrency', 4);
setGradeAuto(true);
const runs: Record<string, AiGradeRow[]> = {};
for (let round = 0; round < ROUNDS; round++) {
  for (const s of subs) enqueueGrade(s.sub, { release: false, redo: true });
  // kick 由 enqueue 开起来；等这一轮都批完
  for (;;) {
    const left = db.value<number>("SELECT count(*) FROM ai_grades WHERE assignment_id=? AND status IN ('queued','running')", hw) || 0;
    if (!left) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}
for (const s of subs) runs[s.c.key] = db.all<AiGradeRow>("SELECT * FROM ai_grades WHERE submission_id=? AND status<>'stale' ORDER BY id", s.sub);

writeFileSync(
  join(base, 'report.json'),
  JSON.stringify(
    {
      rubric,
      rubricMs,
      cases: subs.map(({ c }) => ({
        key: c.key,
        who: c.who,
        band: c.band,
        flagExpected: !!c.flag,
        text: c.text,
        runs: runs[c.key].map((g) => ({
          status: g.status,
          error: g.error,
          score: g.score,
          items: gradeItems(g.items),
          marks: gradeMarks(g.marks),
          comment: g.comment,
          flag: g.flag,
          ms: g.finished_at && g.started_at ? g.finished_at - g.started_at : null,
        })),
      })),
    },
    null,
    2,
  ),
);
process.exit(0);

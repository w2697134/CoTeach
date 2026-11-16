/**
 * 批改对题尺子的子进程（2026-11-16）：在复制出来的数据目录里（CT_DATA_DIR）搭一个班、两份作业，
 * 评分标准照抄线上演示班那两份（rubrics.json，不让模型重拟：每道题下面又分了（1）（2）（3）小项，线上就是这样批错的），
 * 答卷是演示班那 70 份（server/src/demo/answers.json），每份批一遍，结果写到 <数据目录>/report.json。由 ruler.ts 起。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, now, setSetting } from '../../server/src/db/index.js';
import { enqueueGrade, setGradeAuto } from '../../server/src/grading/jobs.js';
import { gradeItems, type AiGradeRow } from '../../server/src/grading/common.js';
import answers from '../../server/src/demo/answers.json' with { type: 'json' };

const [base, only] = process.argv.slice(2);
const RUBRICS = JSON.parse(readFileSync(new URL('./rubrics.json', import.meta.url), 'utf8')) as Record<
  string,
  { title: string; body: string; points: number; rubric: unknown[] }
>;
const t = now();
const teacher = db.insert('users', { username: `map-${t}`, name: '王建国', role: 'teacher', password_hash: 'x', created_at: t });
const klass = db.insert('classes', { teacher_id: teacher, name: '计科2501 Python 程序设计', join_code: `M${String(t).slice(-5)}`, join_open: 1, created_at: t, updated_at: t });
const subs: { hw: string; k: string; sid: number }[] = [];
let n = 0;
for (const key of Object.keys(RUBRICS).filter((k) => !only || only.split(',').includes(k))) {
  const R = RUBRICS[key];
  const hw = db.insert('assignments', {
    class_id: klass,
    teacher_id: teacher,
    title: R.title,
    body: R.body,
    points: R.points,
    due_at: t - 86400_000,
    allow_late: 1,
    publish_at: t - 10 * 86400_000,
    ai_mode: 'hold',
    created_at: t,
    updated_at: t,
  });
  db.insert('hw_rubrics', { assignment_id: hw, items: JSON.stringify(R.rubric), source: 'teacher', status: 'ready', created_at: t, updated_at: t });
  for (const [k, text] of Object.entries((answers as Record<string, Record<string, string>>)[key] || {})) {
    let u = db.value<number>('SELECT id FROM users WHERE username=?', `map-s${k}-${t}`);
    if (!u) {
      u = db.insert('users', { username: `map-s${k}-${t}`, name: `学生${k}`, role: 'student', password_hash: 'x', created_at: t });
      db.insert('class_students', { class_id: klass, student_no: `2025${String(k).padStart(3, '0')}`, name: `学生${k}`, user_id: u, in_roster: 0, joined_at: t, created_at: t });
    }
    subs.push({ hw: key, k, sid: db.insert('submissions', { assignment_id: hw, user_id: u, text, submitted_at: t - 3600_000 - n++, late: 0, updated_at: t }) });
  }
}

setSetting('grade_concurrency', 8);
setGradeAuto(true);
for (const s of subs) enqueueGrade(s.sid, { release: false, redo: true });
for (;;) {
  const left = db.value<number>("SELECT count(*) FROM ai_grades WHERE status IN ('queued','running')") || 0;
  if (!left) break;
  await new Promise((ok) => setTimeout(ok, 1000));
}
writeFileSync(
  join(base, 'report.json'),
  JSON.stringify(
    {
      rubrics: RUBRICS,
      sheets: subs.map((s) => {
        const g = db.get<AiGradeRow>("SELECT * FROM ai_grades WHERE submission_id=? AND status<>'stale' ORDER BY id DESC LIMIT 1", s.sid);
        return {
          hw: s.hw,
          k: s.k,
          status: g?.status ?? 'none',
          error: g?.error ?? null,
          score: g?.score ?? null,
          items: g ? gradeItems(g.items) : [],
          comment: g?.comment ?? '',
          flag: g?.flag ?? null,
          ms: g?.finished_at && g?.started_at ? g.finished_at - g.started_at : null,
        };
      }),
    },
    null,
    2,
  ),
);
process.exit(0);

/**
 * 量学生来问的卡片（2026-11-17）：拿开发数据的一份副本，把 t0 现在等老师回的几件学生来问，原样再交给替老师回学伴的那一手，
 * 看它这回转给老师的问题和选项多长（学生的原话卡片上另摆）。不写开发库。
 *   在 server 目录：node --import tsx ../tools/card-check/check.ts <输出目录>
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] || '../output/card-check');
const dev = resolve('E:/Codex/zhongzhuan/projects/coteach/server/data');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'data', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'data', '.secret'));
for (const d of ['knowledge', 'kb', 'sources', 'homework']) if (existsSync(join(dev, d))) cpSync(join(dev, d), join(out, 'data', d), { recursive: true });
process.env.CT_DATA_DIR = join(out, 'data');
process.env.CT_DEMO_MODE = '0';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
process.env.CT_SUGGEST_AUTO = '0';

const { db } = await import('../../server/src/db/index.js');
const { runHelper } = await import('../../server/src/assistant/helper.js');
const asks = db.all<{ id: number; class_id: number; teacher_id: number; question: string; student: string; cls: string }>(
  `SELECT a.id, a.class_id, a.teacher_id, a.question, u.name AS student, c.name AS cls FROM student_asks a JOIN users u ON u.id=a.student_id
   JOIN classes c ON c.id=a.class_id JOIN users t ON t.id=a.teacher_id WHERE t.username='t0' AND a.status='teacher' ORDER BY a.id`,
);
const rows: any[] = [];
for (const a of asks) {
  const t0 = Date.now();
  try {
    const r = await runHelper({ teacherId: a.teacher_id, classId: a.class_id, mode: 'answer', request: `${a.student}的学伴来问：${a.question}`, task: `「${a.cls}」的学生${a.student}的学伴来问：\n${a.question}` });
    const e = r.escalation;
    rows.push({ id: a.id, sec: Math.round((Date.now() - t0) / 1000), escalated: !!e, q: e?.question, qLen: e?.question.length ?? 0, opts: e?.options ?? [], optLens: (e?.options ?? []).map((o) => o.length) });
  } catch (err) {
    rows.push({ id: a.id, error: (err as Error).message });
  }
  console.log(JSON.stringify(rows[rows.length - 1]));
}
writeFileSync(join(out, 'result.json'), JSON.stringify(rows, null, 1));
process.exit(0);

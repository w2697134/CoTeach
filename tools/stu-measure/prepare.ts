/**
 * 学伴尺子开跑前：在 base 里摆好世界，让助教（真的 DeepSeek）给计科2505、软工2402 写资料包（课程说明、每份作业的说明、放哪些文件），
 * 每句都从这一份开始。顺便量助教写的资料包：漏没漏不该给的、课件放没放进去。
 *   在 server 目录：node --import tsx ../tools/stu-measure/prepare.ts <base 目录>
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = resolve(process.argv[2]);
process.env.CT_DATA_DIR = base;
process.env.CT_DEMO_MODE = '0';
process.env.CT_PACK_AUTO = '0';

const { db } = await import('../../server/src/db/index.js');
const { createApp } = await import('../../server/src/app.js');
const { runPackJob } = await import('../../server/src/assistant/pack-jobs.js');
const { renderPack, classFiles } = await import('../../server/src/assistant/pack.js');
const { seedStudentWorld, LEAKS } = await import('./world.js');

createApp();
const w = await seedStudentWorld();
const t0 = Date.now();
const jobs: { what: string; ms: number; error?: string }[] = [];
for (const name of ['计科2505 Python', '软工2402 数据库']) {
  const k = w.classes[name];
  const run = async (what: string, kind: 'course' | 'homework', ref: number | null) => {
    const s = Date.now();
    try {
      await runPackJob(k, kind, ref);
      jobs.push({ what, ms: Date.now() - s });
    } catch (err) {
      jobs.push({ what, ms: Date.now() - s, error: String((err as Error).message) });
    }
  };
  await run(`「${name}」课程说明`, 'course', null);
  for (const h of db.all<{ id: number; title: string }>('SELECT id, title FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY id', k)) await run(`「${name}」「${h.title}」`, 'homework', h.id);
}
const packs = ['计科2505 Python', '软工2402 数据库'].map((n) => ({ name: n, text: renderPack(w.classes[n], { teacherView: true }), files: classFiles(w.classes[n]).map((f) => f.name) }));
const all = packs.map((p) => p.text + '\n' + p.files.join('\n')).join('\n');
const leaks = LEAKS.filter((l) => l.re.test(all)).map((l) => l.what);
const badFiles = packs.flatMap((p) => p.files).filter((f) => /答案|试卷|考试|成绩|名单/.test(f));
const report = {
  ms: Date.now() - t0,
  jobs,
  leaks,
  badFiles,
  slides: packs[0].files.some((f) => /课件/.test(f)),
  packs,
};
writeFileSync(join(base, 'world.json'), JSON.stringify(w, null, 2));
writeFileSync(join(base, 'pack-report.json'), JSON.stringify(report, null, 2));
console.log(`资料包写好了：${jobs.length} 条，用时 ${Math.round(report.ms / 1000)} 秒；漏的 ${leaks.join('、') || '无'}；不该给的文件 ${badFiles.join('、') || '无'}；课件 ${report.slides ? '放了' : '没放'}`);
process.exit(0);

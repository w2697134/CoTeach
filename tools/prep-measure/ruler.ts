/**
 * 尺子：备课（2026-11-17 重做）。拿开发数据的一份副本，几节课各让助教真备一遍，量做出来的东西：
 *   几手各用了多久、有没有做成；教案几个环节、分钟加起来对不对；课件几页、用了哪些版式、讲稿有没有、字会不会多到放不下；
 *   练习和作业几道、什么题型、选择题有没有答案、作业分数加起来多少；核对改了几处。
 *   在 server 目录：node --import tsx ../tools/prep-measure/ruler.ts <标签> [句子编号…]
 * 用的是副本（.secret 原样复制，不打开），不写开发库；花的是开发和线上共用的模型额度，跑前想好跑几句。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [label = 'run', ...only] = process.argv.slice(2);
const out = join(ROOT, 'output', 'prep-measure', label);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });
const dev = join(ROOT, 'server', 'data');
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'data', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'data', '.secret'));
// 知识库（git）、整理出来的、原件、作业附件也要：不复制的话助教翻不了资料，备出来的课不算数（prep-v1 就是这样）
for (const d of ['knowledge', 'kb', 'sources', 'homework']) if (existsSync(join(dev, d))) cpSync(join(dev, d), join(out, 'data', d), { recursive: true });
process.env.CT_DATA_DIR = join(out, 'data');
process.env.CT_DEMO_MODE = '0';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';

const { db, j } = await import('../../server/src/db/index.js');
const { startLesson } = await import('../../server/src/prep/make.js');

/** 几节课：班名里带的字、老师说的话（null 是按进度备下一节）、多长 */
const CASES = [
  { id: 'p1', cls: '计科2501', request: '字典的常用操作，课上安排两次练习', minutes: 90 },
  { id: 'p2', cls: '计科2501', request: null, minutes: 90 },
  { id: 'p3', cls: '数据库', request: null, minutes: 90 },
].filter((c) => !only.length || only.includes(c.id));

const chars = (s: unknown) => String(s ?? '').length;
const rows: any[] = [];
for (const c of CASES) {
  const k = db.get<{ id: number; teacher_id: number; name: string }>(
    "SELECT id, teacher_id, name FROM classes WHERE name LIKE ? AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id DESC LIMIT 1",
    `%${c.cls}%`,
  );
  if (!k) throw new Error(`没有「${c.cls}」这个班`);
  const t0 = Date.now();
  const id = startLesson(k.teacher_id, k.id, c.request, c.minutes);
  while (db.value<string>('SELECT status FROM lessons WHERE id=?', id) === 'making' && Date.now() - t0 < 15 * 60_000) await new Promise((r) => setTimeout(r, 2000));
  const r = db.get<any>('SELECT * FROM lessons WHERE id=?', id)!;
  const lanes = j<Record<string, { status: string; note?: string; at?: number }>>(r.lanes, {});
  const plan = j<any>(r.plan, null);
  const deck = j<any>(r.deck, null);
  const practice = j<any[]>(r.practice, []);
  const homework = j<any[]>(r.homework, []);
  const slides: any[] = deck?.slides || [];
  const layouts: Record<string, number> = {};
  for (const s of slides) layouts[s.layout] = (layouts[s.layout] || 0) + 1;
  // 一页上的字（标题、要点、代码行、表格），太多放不下
  const load = (s: any) =>
    chars(s.title) + (s.points || []).reduce((n: number, p: string) => n + chars(p), 0) + (s.steps || []).reduce((n: number, p: any) => n + chars(p.head) + chars(p.text), 0) +
    (s.compare ? [...s.compare.left.points, ...s.compare.right.points].reduce((n: number, p: string) => n + chars(p), 0) : 0) + (s.quiz ? chars(s.quiz.question) + s.quiz.options.reduce((n: number, o: string) => n + chars(o), 0) : 0);
  const heavy = slides.filter((s) => load(s) > 220 || (s.code?.text || '').split('\n').length > 18 || (s.points || []).length > 6).map((s) => `${slides.indexOf(s) + 1}`);
  const choice = [...practice, ...homework].filter((q) => q.type === 'single' || q.type === 'multi');
  const row = {
    id: c.id,
    class: k.name,
    request: c.request,
    status: r.status,
    error: r.error,
    sec: Math.round((Date.now() - t0) / 1000),
    lanes: Object.fromEntries(Object.entries(lanes).map(([key, v]) => [key, `${v.status}${v.note ? `：${v.note}` : ''}`])),
    title: plan?.title,
    steps: plan?.steps?.length ?? 0,
    minutes: plan?.steps?.reduce((n: number, s: any) => n + (s.minutes || 0), 0) ?? 0,
    slides: slides.length,
    layouts,
    notes: slides.filter((s) => s.notes).length,
    heavy,
    practice: practice.map((q) => q.type).join(','),
    homework: homework.map((q) => `${q.type}${q.points}`).join(','),
    homeworkPoints: homework.reduce((n, q) => n + (q.points || 0), 0),
    choiceNoAnswer: choice.filter((q) => !q.choice?.length).length,
  };
  rows.push(row);
  writeFileSync(join(out, `${c.id}.json`), JSON.stringify({ row, plan, deck, practice, homework, brief: j(r.brief, null) }, null, 1));
  console.log(c.id, row.status, row.sec, '秒', row.slides, '页', row.practice, '|', row.homework);
}
const md = [
  `# 备课尺子 ${label}`,
  '',
  '| 节 | 结果 | 用时 | 教案环节/分钟 | 课件页/讲稿 | 版式 | 字多的页 | 练习 | 作业（分） | 选择题没答案 | 核对 |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.id} ${r.title || ''} | ${r.status}${r.error ? `（${r.error}）` : ''} | ${r.sec} 秒 | ${r.steps}/${r.minutes} | ${r.slides}/${r.notes} | ${Object.entries(r.layouts).map(([k, v]) => `${k}${v}`).join(' ')} | ${r.heavy.join(',') || '无'} | ${r.practice} | ${r.homework}（${r.homeworkPoints}） | ${r.choiceNoAnswer} | ${String(r.lanes.check || '').replace(/\|/g, '/')} |`,
  ),
  '',
  '```',
  JSON.stringify(rows, null, 1),
  '```',
].join('\n');
writeFileSync(join(out, 'summary.md'), md);
console.log(md.split('\n').slice(0, 3 + rows.length + 1).join('\n'));
db.close?.();
process.exit(0);

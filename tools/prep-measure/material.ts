/**
 * 尺子：备课带文件（2026-11-18）。同一句话，带一份章节讲义（PDF）和不带，各备几遍，量教案、课件、题目是不是照着讲义走：
 *   讲义词：讲义里只有这一份才有的 16 个说法（例子里的学号人名、变量名、小节的叫法），教案、课件、题目里各出现了几个；
 *   课件标题：课件每页标题（封面不算）里带讲义小节、例子说法的占几成，讲义的 11 个小节和例子在标题里出现了几个；
 *   用时：读文件、写教案、做课件内容、出题各到第几秒。
 * 在 server 目录：CT_ENV_FILE=<主目录 server/.env> CT_DEV_DATA=<开发数据目录> node --import tsx ../tools/prep-measure/material.ts <标签> [每样几遍，默认 2] [quiet]
 *   quiet：只带讲义、一句话不说（量「老师只带了文件」那种），只跑带讲义的
 * 用开发数据的副本（不写开发库）。讲义的字走真的读法（documentText：PDF 抽字），登记成一次已经读好的交资料（不放进知识库，不触发整理）。
 * 课件内容和题目存好就停（做成幻灯片、核对那两手不等，量的是内容）。讲义原文和打印成 PDF 的那份在 material/。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [label = 'run', times = '2', mode = ''] = process.argv.slice(2);
const quiet = mode === 'quiet';
const out = join(ROOT, 'output', 'prep-measure', `material-${label}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });
const dev = resolve(process.env.CT_DEV_DATA || join(ROOT, 'server', 'data'));
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'data', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'data', '.secret'));
for (const d of ['knowledge', 'kb', 'sources', 'homework']) if (existsSync(join(dev, d))) cpSync(join(dev, d), join(out, 'data', d), { recursive: true });
process.env.CT_DATA_DIR = join(out, 'data');
process.env.CT_DEMO_MODE = '0';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
process.env.CT_SUGGEST_AUTO = '0';

const { db, j, now } = await import('../../server/src/db/index.js');
const { startLesson, stopLesson, isMaking } = await import('../../server/src/prep/make.js');
const { documentText, closeReaders } = await import('../../server/src/kb/intake/service.js');
const { storeText } = await import('../../server/src/kb/intake/store.js');
const { planText } = await import('../../server/src/prep/make.js');

const CLASS = '计科2501';
const REQUEST = quiet ? null : '第5章 字符串处理，讲常用方法和格式化输出';
const PDF = join(here, 'material', '第5章 字符串处理 讲义.pdf');

/** 只有这份讲义才有的说法（跑之前定好的，不看结果改） */
const TERMS: [string, RegExp][] = [
  ['stu_code', /stu_code/],
  ['陈思远', /陈思远/],
  ['学号拆分', /学号拆分/],
  ['mask_phone', /mask_phone/],
  ['手机号打码', /手机号打码/],
  ['138****5678', /138\*{4}5678/],
  ['成绩条', /成绩条/],
  ['李一诺', /李一诺/],
  ['查、改、判', /查[、，,和\s]{0,2}改[、，,和\s]{0,2}判/],
  ['strip 三兄弟', /三兄弟/],
  ['课程表', /课程表/],
  ['全角空格', /全角空格/],
  ['大小写归一', /大小写归一/],
  ['initials', /initials/],
  ['mask_id', /mask_id/],
  ['2505-07', /2505-07/],
];
/** 讲义的 5 个小节、6 个例子（加课堂小测）在课件标题里怎么认 */
const UNITS: [string, RegExp][] = [
  ['5.1 不能改的字符', /不可变|不能改/],
  ['例 学号拆分', /学号/],
  ['5.2 查改判三组', /查.{0,2}改.{0,2}判|三组/],
  ['例 手机号打码', /打码/],
  ['5.3 join 和 split 是一对', /一对|join.{0,6}split|split.{0,6}join/i],
  ['例 课程表', /课程表/],
  ['5.4 f-string 和对齐', /对齐/],
  ['例 成绩条', /成绩条/],
  ['5.5/例 回文', /回文/],
  ['例 词频', /词频/],
  ['课堂小测', /小测/],
];

const k = db.get<{ id: number; teacher_id: number; name: string }>("SELECT id, teacher_id, name FROM classes WHERE name LIKE ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", `%${CLASS}%`);
if (!k) throw new Error(`没有「${CLASS}」这个班`);
const kbId = db.value<number>("SELECT id FROM knowledge_bases WHERE teacher_id=? AND status='active' AND deleted_at IS NULL ORDER BY id LIMIT 1", k.teacher_id)!;

// 讲义读成字（真的读法），记一次已经读好的交资料
const read = await documentText('第5章 字符串处理 讲义.pdf', PDF, k.teacher_id);
if (!('text' in read)) throw new Error(`讲义没读出来：${read.reason}`);
writeFileSync(join(out, '讲义读出来的字.md'), read.text);
function givenIntake() {
  const t = now();
  const intake = db.insert('kb_intakes', { kb_id: kbId, created_by: k!.teacher_id, status: 'done', route: 1, created_at: t, updated_at: t, finished_at: t });
  db.insert('kb_intake_items', {
    intake_id: intake,
    name: '第5章 字符串处理 讲义.pdf',
    kind: 'pdf',
    size: 1,
    received: 1,
    status: 'done',
    text_hash: storeText((read as { text: string }).text + '\n'),
    method: 'text',
    created_at: t,
    updated_at: t,
  });
  return intake;
}

const hits = (text: string, list: [string, RegExp][]) => list.filter(([, re]) => re.test(text)).map(([name]) => name);
const slideText = (s: any) => JSON.stringify({ t: s.title, s: s.subtitle, p: s.points, c: s.code, cm: s.compare, st: s.steps, q: s.quiz, tb: s.table, n: s.notes });
const rows: any[] = [];
const order = Array.from({ length: Number(times) }, (_, n) => (quiet ? [`file-${n + 1}`] : [`file-${n + 1}`, `none-${n + 1}`])).flat();
for (const run of order) {
  const withFile = run.startsWith('file');
  const t0 = Date.now();
  const id = startLesson(k.teacher_id, k.id, REQUEST, 90, withFile ? givenIntake() : null);
  const at: Record<string, number> = {};
  for (;;) {
    const r = db.get<any>('SELECT * FROM lessons WHERE id=?', id)!;
    const lanes = j<Record<string, { status: string }>>(r.lanes, {});
    if (withFile && !at.read && lanes.read?.status === 'done') at.read = Math.round((Date.now() - t0) / 1000);
    for (const p of ['plan', 'deck', 'practice'] as const) if (!at[p] && r[p]) at[p] = Math.round((Date.now() - t0) / 1000);
    if ((r.plan && r.deck && r.practice) || r.status !== 'making' || Date.now() - t0 > 20 * 60_000) break;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  stopLesson(id);
  while (isMaking(id)) await new Promise((ok) => setTimeout(ok, 500));
  const r = db.get<any>('SELECT * FROM lessons WHERE id=?', id)!;
  const plan = j<any>(r.plan, null);
  const slides: any[] = j<any>(r.deck, null)?.slides || [];
  const questions = [...j<any[]>(r.practice, []), ...j<any[]>(r.homework, [])];
  const planStr = plan ? planText(plan, 90) : '';
  const deckStr = slides.map(slideText).join('\n');
  const titles = slides.filter((s) => s.layout !== 'cover').map((s) => s.title as string);
  const row = {
    run,
    error: plan ? null : r.error,
    at,
    title: plan?.title,
    plan: hits(planStr, TERMS),
    deck: hits(deckStr, TERMS),
    questions: hits(JSON.stringify(questions), TERMS),
    titles: titles.length,
    titlesFromFile: titles.filter((t) => UNITS.some(([, re]) => re.test(t))).length,
    units: hits(titles.join('\n'), UNITS),
  };
  rows.push(row);
  writeFileSync(join(out, `${run}.json`), JSON.stringify({ row, plan, titles, slides, questions }, null, 1));
  console.log(run, `教案 ${row.plan.length}/16 课件 ${row.deck.length}/16 题目 ${row.questions.length}/16 标题 ${row.titlesFromFile}/${row.titles} 小节 ${row.units.length}/11`, JSON.stringify(at));
}
const md = [
  `# 备课带文件尺子 ${label}`,
  '',
  `${REQUEST ? `同一句话「${REQUEST}」` : '一句话不说、只带讲义'}，${CLASS}，90 分钟。讲义词 16 个，小节和例子 11 个。`,
  '',
  '| 遍 | 课题 | 讲义词：教案 | 课件 | 题目 | 课件标题带讲义说法 | 标题里的小节/例子 | 读完/教案/课件/题目（秒） |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (x) =>
      `| ${x.run} | ${x.title || x.error || ''} | ${x.plan.length}/16 | ${x.deck.length}/16 | ${x.questions.length}/16 | ${x.titlesFromFile}/${x.titles} | ${x.units.length}/11 | ${[x.at.read ?? '—', x.at.plan ?? '—', x.at.deck ?? '—', x.at.practice ?? '—'].join(' / ')} |`,
  ),
  '',
  '```',
  JSON.stringify(rows, null, 1),
  '```',
].join('\n');
writeFileSync(join(out, 'summary.md'), md);
console.log(md.split('\n').slice(0, 6 + rows.length).join('\n'));
await closeReaders();
process.exit(0);

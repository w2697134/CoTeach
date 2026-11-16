/**
 * 量助教批改（2026-11-16）：一份三道题的作业、8 份好坏分明的答卷，真模型拟评分标准、每份批两遍。
 *   在 server 目录：node --import tsx ../tools/grade-measure/ruler.ts <标签> [遍数]
 * 结果在 output/grade-measure/<标签>/：report.json 是每份每遍的批改，summary.md 是总表。
 * 量的是：分数落没落在该落的段、好的分是不是比差的高、同一份两遍差多少、同样的错两个人分数差多少、
 * 批注能不能在原文里找到、批注评语里有没有漏出参考答案、该留给老师看的留没留。
 * 花的是开发和线上共用的那把 DeepSeek 钥匙，跑前跑后看余额。开发数据目录里的 .secret 只原样复制（接模型要用），不打开。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER_LINES, ANSWER_MARK } from './cases.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [label, rounds = '2'] = process.argv.slice(2);
if (!label) throw new Error('要给这次量起个标签');
const out = join(ROOT, 'output', 'grade-measure', label);
const base = join(out, 'base');
rmSync(out, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
const dev = join(ROOT, 'server', 'data');
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(base, 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(base, '.secret'));
const before = (() => {
  const b = new DatabaseSync(join(base, 'coteach.db'));
  b.exec("DELETE FROM pack_jobs WHERE status IN ('queued','running')");
  const n = (b.prepare('SELECT coalesce(max(id),0) n FROM llm_calls').get() as any).n as number;
  b.close();
  return n;
})();

const t0 = Date.now();
await new Promise<void>((done) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(here, 'run.ts'), base, rounds], {
    cwd: join(ROOT, 'server'),
    env: { ...process.env, CT_DATA_DIR: base, CT_GRADE_AUTO: '0', CT_PACK_AUTO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  p.stdout.on('data', (c) => (text += c));
  p.stderr.on('data', (c) => (text += c));
  p.on('close', () => {
    writeFileSync(join(out, 'run.log'), text);
    done();
  });
});
const rep = JSON.parse(readFileSync(join(base, 'report.json'), 'utf8'));
writeFileSync(join(out, 'report.json'), JSON.stringify(rep, null, 2));
const cost = (() => {
  const b = new DatabaseSync(join(base, 'coteach.db'), { readOnly: true });
  const r = b.prepare('SELECT count(*) c, coalesce(sum(prompt_tokens),0) i, coalesce(sum(completion_tokens),0) o FROM llm_calls WHERE id>?').get(before) as any;
  b.close();
  return { calls: r.c as number, input: r.i as number, output: r.o as number };
})();

type Run = { status: string; error: string | null; score: number | null; items: any[]; marks: any[]; comment: string; flag: string | null; ms: number | null };
type Row = { key: string; who: string; band: [number, number]; flagExpected: boolean; text: string; runs: Run[] };
const rows: Row[] = rep.cases;
const avg = (xs: number[]) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : NaN);
const mean = (k: string) => avg(rows.find((r) => r.key === k)!.runs.map((x) => x.score ?? NaN).filter((x) => !Number.isNaN(x)));
const lines: string[] = [];
let bandHit = 0,
  bandAll = 0,
  marks = 0,
  located = 0,
  leaks = 0,
  steady = 0,
  flagsOk = 0,
  flagsAll = 0,
  failed = 0;
const comments: number[] = [];
const times: number[] = [];
for (const r of rows) {
  const scores = r.runs.map((x) => x.score);
  for (const x of r.runs) {
    if (x.status !== 'done') failed++;
    bandAll++;
    if (x.score !== null && x.score >= r.band[0] && x.score <= r.band[1]) bandHit++;
    marks += x.marks.length;
    located += x.marks.filter((m) => m.start >= 0).length;
    const said = [x.comment, ...x.items.map((i) => i.why), ...x.marks.map((m) => m.note)].join('\n');
    if (said.includes(ANSWER_MARK) || ANSWER_LINES.some((l) => said.includes(l) && !r.text.includes(l))) leaks++;
    if (x.comment) comments.push(x.comment.length);
    if (x.ms) times.push(x.ms);
    if (r.flagExpected) {
      flagsAll++;
      if (x.flag) flagsOk++;
    }
  }
  const ok = scores.filter((s): s is number => s !== null);
  const spread = ok.length > 1 ? Math.max(...ok) - Math.min(...ok) : 0;
  if (spread <= 5) steady++;
  lines.push(
    `| ${r.key} ${r.who} | ${r.band.join('–')} | ${scores.map((s) => s ?? '×').join(' / ')} | ${spread} | ${r.runs.map((x) => (x.flag ? '要看' : '')).join(' / ')} | ${r.runs[0]?.comment?.slice(0, 60).replace(/\n/g, ' ') ?? ''} |`,
  );
}
const order = ['A', 'G', 'B', 'C', 'D', 'E'].map((k) => [k, mean(k)] as const);
const ordered = order.every(([, v], i) => i === 0 || order[i - 1][1] >= v);
const fair = Math.abs(mean('B') - mean('B2'));
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const summary = [
  `# 批改尺子 ${label}（${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`,
  '',
  `评分标准：${(rep.rubric?.items || []).map((x: any) => `${x.title} ${x.points}`).join('；')}（拟了 ${Math.round(rep.rubricMs / 1000)} 秒）`,
  '',
  `- 落在该落的分数段：${bandHit}/${bandAll}`,
  `- 好坏排序（A≥G≥B≥C≥D≥E 平均分）：${ordered ? '对' : '不对'}（${order.map(([k, v]) => `${k} ${Math.round(v * 10) / 10}`).join('，')}）`,
  `- 同一份两遍差 ≤5 分：${steady}/${rows.length}`,
  `- 同样的错（B、B2）平均分差：${Math.round(fair * 10) / 10}`,
  `- 批注在原文里找得到：${located}/${marks}`,
  `- 漏出参考答案：${leaks} 遍`,
  `- 该留给老师看的留了：${flagsOk}/${flagsAll}`,
  `- 没批成：${failed}`,
  `- 评语字数中位数：${med(comments)}；每份用时中位数：${Math.round(med(times) / 1000)} 秒；总用时 ${Math.round((Date.now() - t0) / 1000)} 秒`,
  `- 调用 ${cost.calls} 次，输入 ${cost.input}，输出 ${cost.output}`,
  '',
  '| 答卷 | 该落的段 | 每遍分数 | 两遍差 | 留给老师 | 第一遍评语 |',
  '|---|---|---|---|---|---|',
  ...lines,
].join('\n');
writeFileSync(join(out, 'summary.md'), summary + '\n');
console.log(summary);

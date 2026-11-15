/**
 * 量 CoT 助教：40 句话各在一份干净的世界里让真的 DeepSeek 去办，再比对数据库（2026-11-16）。
 *   在 server 目录：node --import tsx ../tools/ta-measure/ruler.ts <标签> [句子编号…]
 * 结果在 output/ta-measure/<标签>/：每句一份 json，summary.md 是总表。花的是开发和线上共用的那把 DeepSeek 钥匙，跑前跑后看余额。
 * 开发数据目录里的 .secret 只原样复制（接模型要用），不打开。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [label, ...only] = process.argv.slice(2);
if (!label) throw new Error('要给这次量起个标签');
const out = join(ROOT, 'output', 'ta-measure', label);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'base'), { recursive: true });
const dev = join(ROOT, 'server', 'data');
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'base', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'base', '.secret'));

const cases = CASES.filter((c) => !only.length || only.includes(c.id));
const PARALLEL = Number(process.env.TA_PARALLEL || 4);

function runOne(id: string) {
  return new Promise<void>((done) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(here, 'case.ts'), id, out], {
      cwd: join(ROOT, 'server'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    p.stdout.on('data', (c) => (log += c));
    p.stderr.on('data', (c) => (log += c));
    p.on('close', () => {
      writeFileSync(join(out, `${id}.log`), log);
      done();
    });
  });
}

const t0 = Date.now();
const queue = cases.map((c) => c.id);
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift()!;
      await runOne(id);
      process.stdout.write(`${id} `);
    }
  }),
);
console.log(`\n用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);

/* ---------------- 总表 ---------------- */
const results = cases.map((c) => {
  const f = join(out, `${c.id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { id: c.id, cat: c.cat, error: '没有结果（看 .log）', ok: false, wrong: [], turns: [], expectAsk: c.ask ?? null, asked: false };
});
const ms = results.flatMap((r: any) => (r.turns || []).map((t: any) => t.ms)).sort((a: number, b: number) => a - b);
const q = (p: number) => (ms.length ? (ms[Math.floor((ms.length - 1) * p)] / 1000).toFixed(1) : '-');
const ok = results.filter((r: any) => r.ok).length;
const wrong = results.reduce((n: number, r: any) => n + (r.wrong?.length || 0), 0);
const missedAsk = results.filter((r: any) => r.expectAsk === true && !r.asked).length;
const extraAsk = results.filter((r: any) => r.expectAsk === false && r.asked).length;
const errors = results.filter((r: any) => r.error).length;
const lines = [
  `# 助教尺子 ${label}`,
  '',
  `办对 ${ok}/${results.length}；办错 ${wrong} 处；该问没问 ${missedAsk}；不该问问了 ${extraAsk}；出错 ${errors}`,
  `每一步等的时间：中位 ${q(0.5)} 秒，四分之一到四分之三 ${q(0.25)}–${q(0.75)} 秒，最慢 ${q(1)} 秒`,
  '',
  '| 句子 | 类 | 结果 | 问了 | 办错 | 时间 | 哪里不对 |',
  '|---|---|---|---|---|---|---|',
  ...results.map((r: any) => {
    const sec = (r.turns || []).map((t: any) => (t.ms / 1000).toFixed(1)).join('+');
    const why = [r.error ? `出错：${String(r.error).split('\n')[0]}` : '', r.result || '', ...(r.wrong || []).map((w: string) => `办错：${w}`)]
      .filter(Boolean)
      .join('；')
      .replace(/\|/g, '/');
    return `| ${r.id} | ${r.cat} | ${r.ok ? '对' : '不对'} | ${r.asked ? (r.expectAsk === false ? '多问' : '问了') : r.expectAsk === true ? '没问' : ''} | ${r.wrong?.length || 0} | ${sec} | ${why.slice(0, 160)} |`;
  }),
];
writeFileSync(join(out, 'summary.md'), lines.join('\n'));
console.log(lines.slice(0, 4).join('\n'));

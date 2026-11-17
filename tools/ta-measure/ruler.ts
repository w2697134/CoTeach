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

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [label, ...only] = process.argv.slice(2);
if (!label) throw new Error('要给这次量起个标签');
const out = join(ROOT, 'output', 'ta-measure', label);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'base'), { recursive: true });
// 开发数据目录：CT_DEV_DATA 指（工作树里没有 server/data 时用），不写用 server/data
const dev = resolve(process.env.CT_DEV_DATA || join(ROOT, 'server', 'data'));
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'base', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'base', '.secret'));
// 思考开到哪一档：TA_THINK=off|low|high|max（不写按代码里的默认）
const THINK = process.env.TA_THINK || '';
if (THINK) {
  const b = new DatabaseSync(join(out, 'base', 'coteach.db'));
  b.prepare("INSERT INTO settings (key, value) VALUES ('ta_think', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(THINK));
  b.close();
}

// 只用 DeepSeek：TA_MODEL=deepseek（把备用模型设成主模型）
if (process.env.TA_MODEL === 'deepseek') {
  const b = new DatabaseSync(join(out, 'base', 'coteach.db'));
  const fb = b.prepare("SELECT value FROM settings WHERE key='fallback_model_id'").get() as { value: string } | undefined;
  if (fb) b.prepare("UPDATE settings SET value=? WHERE key='default_model_id'").run(fb.value);
  b.close();
}
// 句子那份文件会连库：这个进程自己用一个空目录（不跟开着的服务、别的尺子抢同一个目录）
process.env.CT_DATA_DIR = join(out, 'ruler-data');
const { CASES } = await import('./cases.js');
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
// 用了多少字（每句一份库，里面记着每次调模型的用量）
let input = 0,
  output = 0,
  calls = 0;
for (const c of cases) {
  const f = join(out, 'cases', c.id, 'coteach.db');
  if (!existsSync(f)) continue;
  const d = new DatabaseSync(f, { readOnly: true });
  const s = d.prepare("SELECT count(*) n, coalesce(sum(prompt_tokens),0) i, coalesce(sum(completion_tokens),0) o FROM llm_calls WHERE purpose='ta:chat'").get() as any;
  d.close();
  calls += s.n;
  input += s.i;
  output += s.o;
}
const lines = [
  `# 助教尺子 ${label}（思考：${THINK || '默认'}）`,
  '',
  `办对 ${ok}/${results.length}；办错 ${wrong} 处；该问没问 ${missedAsk}；不该问问了 ${extraAsk}；出错 ${errors}`,
  `每一步等的时间：中位 ${q(0.5)} 秒，四分之一到四分之三 ${q(0.25)}–${q(0.75)} 秒，最慢 ${q(1)} 秒`,
  `调模型 ${calls} 次，读进 ${input} 字（词元），写出 ${output}（含思考）`,
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
console.log(lines.slice(0, 5).join('\n'));

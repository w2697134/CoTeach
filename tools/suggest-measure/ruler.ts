/**
 * 量「助教看一眼要不要分专门助手」（2026-11-17）：每个世界在一份干净的数据库里真的调模型看一眼，每个世界跑两遍。
 *   在 server 目录：node --import tsx ../tools/suggest-measure/ruler.ts <标签> [世界…]
 * 量：该提的提没提、不该提的有没有提；提的名字、管的事、做法、绑的作业对不对；问老师的话是不是一句；
 * 该提的提了以后，第 1 遍点「分出来」、第 2 遍打字「那个分了吧」，助教分没分对（只改了看一眼的话时可以 SUGGEST_E2E=0 不走这一步）。
 * 几遍、同时跑几个：SUGGEST_REPS（默认 2）、SUGGEST_PARALLEL（默认 2，Gemini 接口只有两个位子）。
 * 结果在 output/suggest-measure/<标签>/：每遍一份 json，summary.md 是总表和问老师的话的原文。
 * 数据从开发库拷一份（只读，不写开发库；在工作树里跑时用 CT_DEV_DATA 指到开发数据目录）；.secret 原样复制（接模型要用），不打开。
 * 模型照开发库里的设置：Gemini 优先，出错换 DeepSeek（DeepSeek 开发和线上共用一把钥匙，别多跑）。
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
const out = join(ROOT, 'output', 'suggest-measure', label);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'base'), { recursive: true });
const dev = resolve(process.env.CT_DEV_DATA || join(ROOT, 'server', 'data'));
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'base', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'base', '.secret'));
// 只用一个模型：SUGGEST_MODEL=deepseek|gemini（不写就照开发库：Gemini 优先、出错换 DeepSeek）。
// 比两版话的时候要定住模型：Gemini 接口忙的时候一分钟没动静就换 DeepSeek，两版各用了哪个说不准，就比不出是话的功劳还是模型的
const MODEL = process.env.SUGGEST_MODEL || '';
if (MODEL) {
  const b = new DatabaseSync(join(out, 'base', 'coteach.db'));
  const row = b.prepare("SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=1 AND p.enabled=1 AND (p.kind=? OR m.model LIKE ?) ORDER BY m.id LIMIT 1").get(MODEL === 'gemini' ? 'agy' : MODEL, `${MODEL}%`) as { id: number } | undefined;
  if (!row) throw new Error(`开发库里没有能用的 ${MODEL}`);
  b.prepare("INSERT INTO settings (key, value) VALUES ('default_model_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(row.id));
  b.prepare("DELETE FROM settings WHERE key='fallback_model_id'").run();
  b.close();
}

// 世界的名单从 worlds.ts 读（这里不引服务的代码，免得在主进程里开数据库）
const ids = [...readFileSync(join(here, 'worlds.ts'), 'utf8').matchAll(/^\s{4}id: '([^']+)',$/gm)].map((m) => m[1]).filter((id) => !only.length || only.includes(id));
const REPS = Number(process.env.SUGGEST_REPS || 2);
const PARALLEL = Number(process.env.SUGGEST_PARALLEL || 2);
const jobs = ids.flatMap((id) => Array.from({ length: REPS }, (_, i) => ({ id, rep: String(i + 1) })));

function runOne(id: string, rep: string) {
  return new Promise<void>((done) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(here, 'case.ts'), id, rep, out], {
      cwd: join(ROOT, 'server'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    p.stdout.on('data', (c) => (log += c));
    p.stderr.on('data', (c) => (log += c));
    p.on('close', () => {
      writeFileSync(join(out, `${id}-${rep}.log`), log);
      done();
    });
  });
}

const t0 = Date.now();
const queue = [...jobs];
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) {
      const j = queue.shift()!;
      await runOne(j.id, j.rep);
      process.stdout.write(`${j.id}-${j.rep} `);
    }
  }),
);
console.log(`\n用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);

/* ---------------- 总表 ---------------- */
const results = jobs.map((j) => {
  const f = join(out, `${j.id}-${j.rep}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { id: j.id, rep: j.rep, error: '没有结果（看 .log）', ok: false };
});
const should = results.filter((r: any) => r.should === true);
const shouldNot = results.filter((r: any) => r.should === false);
const proposed = results.filter((r: any) => r.suggested && r.should);
const e2e = results.filter((r: any) => r.e2e);
const ms = results.map((r: any) => r.ms).filter((x: unknown) => typeof x === 'number').sort((a: number, b: number) => a - b);
const q = (p: number) => (ms.length ? (ms[Math.floor((ms.length - 1) * p)] / 1000).toFixed(1) : '-');
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const lines = [
  `# 看一眼尺子 ${label}（模型：${MODEL || "照开发库，Gemini 优先"}）`,
  '',
  `提得对 ${results.filter((r: any) => !r.error && r.suggested === r.should).length}/${results.length}：该提的提了 ${should.filter((r: any) => r.suggested).length}/${should.length}，不该提的没提 ${shouldNot.filter((r: any) => !r.suggested && !r.error).length}/${shouldNot.length}；出错 ${results.filter((r: any) => r.error).length}`,
  `提了的里面名字、管的事、做法、作业都对 ${proposed.filter((r: any) => !r.wrong).length}/${proposed.length}；问老师的话是一句 ${results.filter((r: any) => r.suggested && r.oneSentence).length}/${results.filter((r: any) => r.suggested).length}`,
  `答应以后助教分对了 ${e2e.filter((r: any) => r.e2e.ok).length}/${e2e.length}；这一轮最后回老师那一步没回成 ${e2e.filter((r: any) => r.e2e.turnError).length} 次`,
  `看一眼等的时间：中位 ${q(0.5)} 秒，四分之一到四分之三 ${q(0.25)}–${q(0.75)} 秒，最慢 ${q(1)} 秒`,
  '',
  '| 世界 | 遍 | 该提 | 提了 | 对 | 哪里不对 | 问老师的话 | 字 | 名字／管什么／批 | 答应以后 | 秒 | 模型 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...results.map((r: any) =>
    [
      r.id,
      r.rep,
      r.should ? '该' : '不该',
      r.suggested ? '提了' : '没提',
      r.ok ? '对' : '不对',
      cell(r.error ? `出错：${String(r.error).split('\n')[0]}` : r.wrong || ''),
      cell(r.proposal?.question),
      r.proposal ? r.chars : '',
      cell(r.proposal ? `${r.proposal.name}／${r.proposal.duty}${r.proposal.homework ? `／${r.proposal.homework}` : ''}` : ''),
      cell(r.e2e ? `${r.e2e.how}：${r.e2e.ok ? '分对了' : r.e2e.why}${r.e2e.turnError ? `（${r.e2e.turnError}）` : ''}` : ''),
      typeof r.ms === 'number' ? (r.ms / 1000).toFixed(1) : '',
      cell((r.models || []).join('、')),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
  ),
  '',
  '## 原文',
  '',
  ...results.flatMap((r: any) => [
    `### ${r.id} 第 ${r.rep} 遍（${r.should ? '该提' : '不该提'}，${r.suggested ? '提了' : '没提'}）`,
    '',
    ...(r.proposal
      ? [`- 问老师：${r.proposal.question}`, `- 名字：${r.proposal.name}`, `- 管：${r.proposal.duty}`, `- 做法：${r.proposal.guide}`, `- 批：${r.proposal.homework || '（没有）'}`]
      : []),
    ...(r.reply ? [`- 它说的话：${String(r.reply).replace(/\n+/g, ' ')}`] : []),
    ...(r.e2e
      ? [`- ${r.e2e.how} → 用的工具 ${r.e2e.tools.join('、') || '没有'}；分出来：${r.e2e.made.map((s: any) => `「${s.name}」${s.duty}`).join('、') || '没有'}；助教回：${String(r.e2e.reply || '').replace(/\n+/g, ' ')}`]
      : []),
    '',
  ]),
];
writeFileSync(join(out, 'summary.md'), lines.join('\n'));
console.log(lines.slice(0, 7).join('\n'));

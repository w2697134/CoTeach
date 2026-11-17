/**
 * 量 CoT 助教办消息的事（通知、签到、选人、发消息）：每句在一份干净的世界里让真的模型去办，再查库（2026-11-18）。
 *   在 server 目录：node --import tsx ../tools/msg-measure/ruler.ts <标签> [句子编号…]
 * 模型的设置照数据目录里的（默认 Gemini，出错换 DeepSeek）；MSG_MODEL=deepseek 只用 DeepSeek。
 * 数据目录用 CT_DEV_DATA 指，不写用 output/room-data。结果在 output/msg-measure/<标签>/：每句一份 json，summary.md 是总表。
 * .secret 只原样复制（接模型要用），不打开。
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
const out = join(ROOT, 'output', 'msg-measure', label);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'base'), { recursive: true });
const dev = resolve(process.env.CT_DEV_DATA || join(ROOT, 'output', 'room-data'));
const target = join(out, 'base', 'coteach.db').split("'").join("''");
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${target}'`);
copyFileSync(join(dev, '.secret'), join(out, 'base', '.secret'));
if (process.env.MSG_MODEL === 'deepseek') {
  const b = new DatabaseSync(join(out, 'base', 'coteach.db'));
  const fb = b.prepare("SELECT value FROM settings WHERE key='fallback_model_id'").get() as { value: string } | undefined;
  if (fb) b.prepare("UPDATE settings SET value=? WHERE key='default_model_id'").run(fb.value);
  b.close();
}

// 句子那份文件会连库：这个进程自己用一个空目录（不跟开着的服务、别的尺子抢同一个目录）
process.env.CT_DATA_DIR = join(out, 'ruler-data');
const { CASES } = await import('./cases.js');
const cases = CASES.filter((c) => !only.length || only.includes(c.id));
const PARALLEL = Number(process.env.MSG_PARALLEL || 3);
function runOne(id: string) {
  return new Promise<void>((done) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(here, 'case.ts'), id, out], { cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
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

const results = cases.map((c) => {
  const f = join(out, `${c.id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { id: c.id, cat: c.cat, error: '没有结果（看 .log）', ok: false, wrong: [], turns: [], expectAsk: c.ask ?? null, asked: false, replies: [] };
});
// 每一轮从说完到办好的秒数
const ms = results.flatMap((r: any) => (r.turns || []).map((t: any) => t.ms)).sort((a: number, b: number) => a - b);
const q = (p: number) => (ms.length ? (ms[Math.floor((ms.length - 1) * p)] / 1000).toFixed(1) : '-');
const ok = results.filter((r: any) => r.ok).length;
const wrong = results.reduce((n: number, r: any) => n + (r.wrong?.length || 0), 0);
const missedAsk = results.filter((r: any) => r.expectAsk === true && !r.asked).length;
const extraAsk = results.filter((r: any) => r.expectAsk === false && r.asked).length;
const errors = results.filter((r: any) => r.error).length;
// 用的哪个模型、几次（没成的另记）
const models: Record<string, number> = {};
for (const c of cases) {
  const f = join(out, 'cases', c.id, 'coteach.db');
  if (!existsSync(f)) continue;
  const d = new DatabaseSync(f, { readOnly: true });
  for (const r of d.prepare("SELECT model, status, count(*) n FROM llm_calls WHERE purpose='ta:chat' GROUP BY model, status").all() as any[]) {
    const k = `${r.model}${r.status === 'ok' ? '' : `（${r.status}）`}`;
    models[k] = (models[k] || 0) + r.n;
  }
  d.close();
}
const lines = [
  `# 消息尺子 ${label}`,
  '',
  `办对 ${ok}/${results.length}；表里多出不该有的变化 ${wrong} 处；该问没问 ${missedAsk}；不该问问了 ${extraAsk}；出错 ${errors}`,
  `每句从说完到办好：中位 ${q(0.5)} 秒，四分之一到四分之三 ${q(0.25)}–${q(0.75)} 秒，最慢 ${q(1)} 秒`,
  `调模型：${Object.entries(models)
    .map(([k, v]) => `${k} ${v} 次`)
    .join('，')}`,
  '',
  '| 句子 | 类 | 结果 | 问了 | 时间（秒，几步） | 用的工具 | 最后一句回话 | 哪里不对 |',
  '|---|---|---|---|---|---|---|---|',
  ...results.map((r: any) => {
    const sec = (r.turns || []).map((t: any) => `${(t.ms / 1000).toFixed(1)}(${t.steps})`).join('+');
    const why = [r.error ? `出错：${String(r.error).split('\n')[0]}` : '', r.result || '', ...(r.wrong || []).map((w: string) => `多出：${w}`)]
      .filter(Boolean)
      .join('；')
      .replace(/\|/g, '/');
    const tools = (r.tools || []).map((t: any) => t.name).join('、');
    const last = String((r.replies || []).slice(-1)[0] || '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '/');
    return `| ${r.id} | ${r.cat} | ${r.ok ? '对' : '不对'} | ${r.asked ? (r.expectAsk === false ? '多问' : '问了') : r.expectAsk === true ? '没问' : ''} | ${sec} | ${tools} | ${last.slice(0, 80)} | ${why.slice(0, 160)} |`;
  }),
];
writeFileSync(join(out, 'summary.md'), lines.join('\n'));
console.log(lines.slice(0, 5).join('\n'));

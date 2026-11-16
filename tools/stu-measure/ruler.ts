/**
 * 量 CoT 学伴（2026-11-16）：先让助教给尺子的世界写好资料包（prepare），再把学生常说的话一句一句交给学伴（每句一份干净的世界）。
 *   在 server 目录：node --import tsx ../tools/stu-measure/ruler.ts <标签> [句子编号…]
 * 结果在 output/stu-measure/<标签>/：每句一份 json，pack-report.json 是资料包写得怎样，summary.md 是总表。
 * 花的是开发和线上共用的那把 DeepSeek 钥匙，跑前跑后看余额。开发数据目录里的 .secret 只原样复制（接模型要用），不打开。
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
const out = join(ROOT, 'output', 'stu-measure', label);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'base'), { recursive: true });
const dev = join(ROOT, 'server', 'data');
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'base', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'base', '.secret'));
// 开发库里还排着的资料包活不带过来；开发库里原来的调用记录不算这次的钱
const devCalls = (() => {
  const b = new DatabaseSync(join(out, 'base', 'coteach.db'));
  b.exec("DELETE FROM pack_jobs WHERE status IN ('queued','running')");
  const n = (b.prepare('SELECT coalesce(max(id),0) n FROM llm_calls').get() as any).n as number;
  b.close();
  return n;
})();

function child(script: string, args: string[], log: string) {
  return new Promise<void>((done) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(here, script), ...args], {
      cwd: join(ROOT, 'server'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    p.stdout.on('data', (c) => (text += c));
    p.stderr.on('data', (c) => (text += c));
    p.on('close', () => {
      writeFileSync(log, text);
      done();
    });
  });
}

const t0 = Date.now();
await child('prepare.ts', [join(out, 'base')], join(out, 'prepare.log'));
const report = existsSync(join(out, 'base', 'pack-report.json')) ? JSON.parse(readFileSync(join(out, 'base', 'pack-report.json'), 'utf8')) : null;
const baseCalls = (() => {
  const b = new DatabaseSync(join(out, 'base', 'coteach.db'), { readOnly: true });
  const r = b.prepare('SELECT coalesce(max(id),0) n, count(*) c, coalesce(sum(prompt_tokens),0) i, coalesce(sum(completion_tokens),0) o FROM llm_calls WHERE id>?').get(devCalls) as any;
  const n = (b.prepare('SELECT coalesce(max(id),0) n FROM llm_calls').get() as any).n as number;
  b.close();
  return { max: n, calls: r.c as number, input: r.i as number, output: r.o as number };
})();
if (!report) throw new Error('资料包没写成，看 prepare.log');
writeFileSync(join(out, 'pack-report.json'), JSON.stringify(report, null, 2));
console.log(`资料包：${report.jobs.length} 条，${Math.round(report.ms / 1000)} 秒，漏 ${report.leaks.join('、') || '无'}，不该给的文件 ${report.badFiles.join('、') || '无'}，课件${report.slides ? '放了' : '没放'}`);

const cases = CASES.filter((c) => !only.length || only.includes(c.id));
const PARALLEL = Number(process.env.STU_PARALLEL || 4);
const queue = cases.map((c) => c.id);
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift()!;
      await child('case.ts', [id, out], join(out, `${id}.log`));
      process.stdout.write(`${id} `);
    }
  }),
);
console.log(`\n用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);

/* ---------------- 总表 ---------------- */
const results = cases.map((c) => {
  const f = join(out, `${c.id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { id: c.id, cat: c.cat, error: '没有结果（看 .log）', ok: false, turns: [], leaks: [] };
});
const ms = results.flatMap((r: any) => (r.turns || []).map((t: any) => t.ms)).sort((a: number, b: number) => a - b);
const q = (p: number) => (ms.length ? (ms[Math.floor((ms.length - 1) * p)] / 1000).toFixed(1) : '-');
const ok = results.filter((r: any) => r.ok).length;
const leaked = results.filter((r: any) => r.leaks?.length).length;
const missed = results.filter((r: any) => r.expectEscalate === true && !r.escalated).length;
const extra = results.filter((r: any) => r.expectEscalate === false && r.escalated).length;
const errors = results.filter((r: any) => r.error).length;
let input = 0,
  output = 0,
  calls = 0;
for (const c of cases) {
  const f = join(out, 'cases', c.id, 'coteach.db');
  if (!existsSync(f)) continue;
  const d = new DatabaseSync(f, { readOnly: true });
  const s = d.prepare('SELECT count(*) n, coalesce(sum(prompt_tokens),0) i, coalesce(sum(completion_tokens),0) o FROM llm_calls WHERE id>?').get(baseCalls.max) as any;
  d.close();
  calls += s.n;
  input += s.i;
  output += s.o;
}
// 话多不多：最后那句回话平均几个字；跟作业无关的几句里，顺手又提了没交的作业、截止的有几句（v1 读原话：打招呼也把没交的作业全列一遍）
const OFF = ['g01', 'g02', 'b01', 'b03', 'b06', 'c06', 'c07', 'a05'];
const lastOf = (r: any) => String((r.replies || []).slice(-1)[0] || '');
const avgLen = Math.round(results.reduce((n: number, r: any) => n + lastOf(r).length, 0) / Math.max(1, results.length));
const chatty = results.filter((r: any) => OFF.includes(r.id) && /没交|截止/.test(lastOf(r))).map((r: any) => r.id);
// 一般知识点转去问助教的有几句（直接讲就行，去问一趟要多等十几秒，还可能转到老师那）
const KNOW = ['b01', 'b06', 'b07', 'b08', 'b09'];
const askedTa = results.filter((r: any) => KNOW.includes(r.id) && (r.stuTools || []).includes('ask_ta')).map((r: any) => r.id);
// 资料包说明里写了多少条给学伴的规矩（「不要」「不能」「先问老师」这类）：规矩只该来自老师
const packText = (report.packs || []).map((p: any) => p.text).join('\n');
const ruleHits = (packText.match(/不要|不能|不给|别给|一律|先问老师|报给老师|转老师|问老师/g) || []).length;
// 老师那边的卡片有多长：问题、每个选项、拟回复、整张，取中位和中间一半
const cards = results.map((r: any) => r.card).filter(Boolean) as { question: string; options: string[]; draft: string }[];
const chars = (s: string) => [...s].length;
const mid = (xs: number[]) => {
  if (!xs.length) return '-';
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.round((s.length - 1) * p)];
  return `${at(0.5)}（${at(0.25)}–${at(0.75)}）`;
};
const cardLine = cards.length
  ? `卡片 ${cards.length} 张，字数中位（中间一半）：问题 ${mid(cards.map((c) => chars(c.question)))}，选项 ${mid(cards.flatMap((c) => c.options.map(chars)))}，拟回复 ${mid(cards.map((c) => chars(c.draft)))}，整张 ${mid(cards.map((c) => chars(c.question + c.draft + c.options.join(''))))}`
  : '没有弹卡片';
const lines = [
  `# 学伴尺子 ${label}`,
  '',
  `答对 ${ok}/${results.length}；漏给 ${leaked} 句；该转老师没转 ${missed}；不该转转了 ${extra}；出错 ${errors}`,
  `资料包：漏 ${report.leaks.join('、') || '无'}，不该给的文件 ${report.badFiles.join('、') || '无'}，课件${report.slides ? '放了' : '没放'}`,
  `每句等的时间：中位 ${q(0.5)} 秒，四分之一到四分之三 ${q(0.25)}–${q(0.75)} 秒，最慢 ${q(1)} 秒`,
  `回话平均 ${avgLen} 字；跟作业无关却提了没交的作业 ${chatty.length}/${OFF.filter((id) => results.some((r: any) => r.id === id)).length}${chatty.length ? `（${chatty.join('、')}）` : ''}`,
  `一般知识点去问了助教 ${askedTa.length}/${KNOW.filter((id) => results.some((r: any) => r.id === id)).length}${askedTa.length ? `（${askedTa.join('、')}）` : ''}；资料包里规矩性的字眼 ${ruleHits} 处，资料包 ${packText.length} 字`,
  `学生这边调模型 ${calls} 次，读进 ${input} 字（词元），写出 ${output}（含思考）；写资料包调了 ${baseCalls.calls} 次，读进 ${baseCalls.input}，写出 ${baseCalls.output}`,
  cardLine,
  '',
  '| 句子 | 类 | 结果 | 转老师 | 时间 | 哪里不对 | 回话 |',
  '|---|---|---|---|---|---|---|',
  ...results.map((r: any) => {
    const sec = (r.turns || []).map((t: any) => (t.ms / 1000).toFixed(1)).join('+');
    const why = [r.error ? `出错：${String(r.error).split('\n')[0]}` : '', r.result || ''].filter(Boolean).join('；').replace(/\|/g, '/');
    const said = String((r.replies || []).slice(-1)[0] || '').replace(/\s+/g, ' ').replace(/\|/g, '/');
    return `| ${r.id} | ${r.cat} | ${r.ok ? '对' : '不对'} | ${r.escalated ? '转了' : ''} | ${sec} | ${why.slice(0, 120)} | ${said.slice(0, 140)} |`;
  }),
];
lines.push(
  '',
  '## 卡片',
  ...results
    .filter((r: any) => r.card)
    .flatMap((r: any) => [
      `### ${r.id}`,
      r.card.question,
      r.card.draft ? `拟回复：${r.card.draft}` : '',
      `选项：${r.card.options.join(' ｜ ')}`,
      `学生收到：${(r.notices || []).join(' / ') || '（没有）'}`,
      '',
    ]),
);
writeFileSync(join(out, 'summary.md'), lines.join('\n'));
console.log(lines.slice(0, 9).join('\n'));

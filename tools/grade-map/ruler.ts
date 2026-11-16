/**
 * 量批改对没对上题（2026-11-16）：线上演示班 93 份里 13 份，助教把第1题底下的（1）（2）（3）小项当成了三道大题交分，
 * 吴泽宇第三章 27 分（该八十来分），评语却写「两题满分」。这把尺子拿那两份评分标准把演示班 70 份答卷各批一遍，数对错题的份数。
 *   在 server 目录：node --import tsx ../tools/grade-map/ruler.ts <标签> [ch2,ch3]
 * 结果在 output/grade-map/<标签>/：report.json 是每份的批改，summary.md 是总表。
 * 花的是开发和线上共用的那把 DeepSeek 钥匙，跑前跑后看余额。开发数据目录里的 .secret 只原样复制（接模型要用），不打开。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [label, only = ''] = process.argv.slice(2);
if (!label) throw new Error('要给这次量起个标签');
const out = join(ROOT, 'output', 'grade-map', label);
const base = join(out, 'base');
rmSync(out, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
const dev = join(ROOT, 'server', 'data');
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(base, 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(base, '.secret'));
const before = (() => {
  const b = new DatabaseSync(join(base, 'coteach.db'));
  // 开发库里还排着的活不带过来（资料包、批改、评分标准）
  b.exec("DELETE FROM pack_jobs WHERE status IN ('queued','running')");
  b.exec("UPDATE ai_grades SET status='stale' WHERE status IN ('queued','running')");
  b.exec("UPDATE hw_rubrics SET status='error' WHERE status='drafting'");
  b.exec("DELETE FROM settings WHERE key='demo_pending'");
  const n = (b.prepare('SELECT coalesce(max(id),0) n FROM llm_calls').get() as any).n as number;
  b.close();
  return n;
})();

const t0 = Date.now();
await new Promise<void>((done) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(here, 'run.ts'), base, only], {
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

type Item = { title: string; max: number; got: number; why: string };
type Sheet = { hw: string; k: string; status: string; error: string | null; score: number | null; items: Item[]; comment: string; flag: string | null; ms: number | null };
const sheets: Sheet[] = rep.sheets;
/** 一项写的理由头一回提到的是第几题，跟这一项本身是第几题对不上，就是交错了题（线上的样子：「第1题」那项写「第1题（1）」，「第2题」那项写「第1题（2）」） */
const qno = (s: string) => String(s || '').match(/第\s*(\d+)\s*题/)?.[1] ?? null;
const offItems = (s: Sheet) => s.items.filter((it) => qno(it.title) && qno(it.why) && qno(it.title) !== qno(it.why));
const done = sheets.filter((s) => s.status === 'done');
const wrong = done.filter((s) => offItems(s).length);
const by = (hw: string) => {
  const d = done.filter((s) => s.hw === hw);
  return `${hw}：错 ${d.filter((s) => offItems(s).length).length}/${d.length}，平均 ${(d.reduce((n, s) => n + (s.score ?? 0), 0) / Math.max(1, d.length)).toFixed(1)} 分`;
};
const ms = done.map((s) => s.ms ?? 0).sort((a, b) => a - b);
const lines = [
  `# 批改对题尺子 ${label}`,
  '',
  `批好 ${done.length}/${sheets.length} 份，没批成 ${sheets.length - done.length} 份；交错了题的 ${wrong.length} 份`,
  ...[...new Set(sheets.map((s) => s.hw))].map(by),
  `每份用时中位 ${ms.length ? (ms[Math.floor(ms.length / 2)] / 1000).toFixed(1) : '-'} 秒；总用时 ${Math.round((Date.now() - t0) / 1000)} 秒`,
  `调模型 ${cost.calls} 次，读进 ${cost.input}，写出 ${cost.output}（含思考）`,
  '',
  '## 交错了题的',
  ...wrong.flatMap((s) => [`- ${s.hw} #${s.k}：${s.score} 分`, ...s.items.map((it) => `  - ${it.title} ${it.got}/${it.max}：${it.why.slice(0, 80)}`)]),
  '',
  '## 没批成的',
  ...sheets.filter((s) => s.status !== 'done').map((s) => `- ${s.hw} #${s.k}：${s.status} ${s.error || ''}`),
];
writeFileSync(join(out, 'summary.md'), lines.join('\n'));
console.log(lines.slice(0, 7).join('\n'));

/**
 * 给演示班写答卷（2026-11-16）：每个学生按水平请 DeepSeek 写一份像真学生交的作业，写到 server/src/demo/answers.json。
 *   在 server 目录：node --import tsx ../tools/demo-class/gen.ts
 * 用开发库的复制品接模型（.secret 只原样复制，不打开），不碰开发库本身。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { EXTRA, HOMEWORK, STUDENTS, type DemoHomework } from '../../server/src/demo/spec.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const base = join(ROOT, 'output', 'demo-gen');
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
const dev = join(ROOT, 'server', 'data');
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(base, 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(base, '.secret'));
process.env.CT_DATA_DIR = base;
process.env.CT_PACK_AUTO = '0';
process.env.CT_GRADE_AUTO = '0';
const { chat } = await import('../../server/src/llm/index.js');

const LEVEL: Record<string, string> = {
  A: '基础扎实，几道题基本都对，偶尔有一点不规范',
  B: '大部分对，有一两处常见的错（比如范围边界、格式、漏了输出）',
  C: '做了一部分，有明显的错，或者漏做了一题',
  D: '基础弱，只做了一点，错得多',
};
const QUIRKS = [
  '注释写得比较多',
  '基本不写注释',
  '变量名有的用拼音',
  '把题号写在代码前面',
  '最后写一句自己的感受',
  '用了一点课上没讲的写法',
  '代码前面写一两句自己的思路',
  '',
];
const rnd = (seed: number) => {
  let x = seed * 9301 + 49297;
  return () => ((x = (x * 9301 + 49297) % 233280) / 233280);
};

async function write(h: DemoHomework, i: number | string, level: string, quirk: string): Promise<string> {
  const name = typeof i === 'number' ? STUDENTS[i].name : EXTRA.find((x) => x.username === i)!.name;
  const r = await chat({
    agentKey: 'demo',
    purpose: 'demo:answer',
    countQuota: false,
    think: 'off',
    temperature: 1,
    maxTokens: 1500,
    messages: [
      { role: 'system', content: '你在给一个教学系统造演示数据，模拟大一学生在网上交的 Python 作业。' },
      {
        role: 'user',
        content: `作业「${h.title}」，要求：\n${h.body}\n\n学生${name}，水平：${LEVEL[level]}。${quirk ? `习惯：${quirk}。` : ''}\n写出这个学生交上来的内容：代码，加上他自己写的几句话或者运行结果。只输出交上来的内容，不要加任何解释，不要用 Markdown 代码块标记。像真学生写的，别太工整。`,
      },
    ],
  });
  return r.text.replace(/^```[a-z]*\n?|```$/gm, '').trim();
}

const target = join(ROOT, 'server', 'src', 'demo', 'answers.json');
const out: Record<string, Record<string, string>> = {};
// 只补测试号那几份：别的照旧
if (process.env.ONLY_EXTRA && existsSync(target)) {
  Object.assign(out, JSON.parse(readFileSync(target, 'utf8')));
  for (const h of HOMEWORK.filter((x) => x.answers))
    for (const x of EXTRA) out[h.key][x.username] = await write(h, x.username, x.level, '');
  writeFileSync(target, JSON.stringify(out, null, 1));
  console.log('补好了');
  process.exit(0);
}
for (const h of HOMEWORK.filter((x) => x.answers)) {
  out[h.key] = {};
  const who = STUDENTS.map((_, i) => i).filter((i) => !h.skip.includes(i) && (h.firstN === undefined || i < h.firstN));
  const r = rnd(h.key.length * 7 + h.title.length);
  const jobs = who.map((i) => async () => {
    if (h.copy && i === h.copy[1]) return; // 抄的那份后面照着改
    if (h.wrong === i) {
      out[h.key][i] = '第二章作业\n\nr = float(input("半径："))\nprint("面积", 3.14 * r * r)\nprint("周长", 2 * 3.14 * r)';
      return;
    }
    // 水平上下浮动一档
    const base = STUDENTS[i].level;
    const shift = r() < 0.2 ? -1 : r() > 0.85 ? 1 : 0;
    const level = 'ABCD'[Math.min(3, Math.max(0, 'ABCD'.indexOf(base) + shift))];
    out[h.key][i] = await write(h, i, level, QUIRKS[Math.floor(r() * QUIRKS.length)]);
  });
  // 一次 6 个
  for (let k = 0; k < jobs.length; k += 6) await Promise.all(jobs.slice(k, k + 6).map((f) => f()));
  if (h.copy) {
    const [from, to] = h.copy;
    out[h.key][to] = out[h.key][from].replace(/\btotal\b/g, 'he').replace(/\bs\b/g, 'sum1').replace(/# ?/g, '#');
  }
  console.log(h.key, Object.keys(out[h.key]).length);
}
mkdirSync(join(ROOT, 'server', 'src', 'demo'), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 1));
console.log('写好了');
process.exit(0);

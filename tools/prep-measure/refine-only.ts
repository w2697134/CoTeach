// 只跑精修那一手（2026-11-17）：拿备课尺子做好的那节课（output/prep-measure/<来源>），挑程序量出来带某个毛病的页再精修一遍，
// 课件写成 json 给幻灯片尺子（tools/slide-measure）量。只动复制出来的数据。
// 用法：node --import tsx ../tools/prep-measure/refine-only.ts <来源> <这次的名字> <课件.json> [只挑带这几个字的毛病] [第几节课的 id]
// 来源写 dev：从开发库复制（数据库用 VACUUM INTO 读一份，开发服务器开着也行）
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [from = 'refine-v1', label = 'refine-only', outJson = 'refine-only-deck.json', only = '', lessonId = ''] = process.argv.slice(2);
const out = join(ROOT, 'output', 'prep-measure', label);
rmSync(out, { recursive: true, force: true });
if (from === 'dev') {
  const dev = join(ROOT, 'server', 'data');
  mkdirSync(join(out, 'data'), { recursive: true });
  new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'data', 'coteach.db').replace(/'/g, "''")}'`);
  copyFileSync(join(dev, '.secret'), join(out, 'data', '.secret'));
} else {
  const src = join(ROOT, 'output', 'prep-measure', from, 'data');
  if (!existsSync(src)) throw new Error(`没有 ${src}`);
  cpSync(src, join(out, 'data'), { recursive: true });
}
process.env.CT_DATA_DIR = join(out, 'data');
process.env.CT_DEMO_MODE = '0';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';

const { db, j } = await import('../../server/src/db/index.js');
const { refinePages } = await import('../../server/src/prep/make.js');
const { tooFull } = await import('../../server/src/prep/kit.js');
const { userName } = await import('../../server/src/grading/common.js');

const r = (lessonId ? db.get<any>('SELECT * FROM lessons WHERE id=?', Number(lessonId)) : db.get<any>('SELECT * FROM lessons WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1'))!;
const deck = j<any>(r.deck, null);
const html = new Map<number, string>();
deck.slides.forEach((s: any, i: number) => {
  const why = s.html ? tooFull(s.html) : [];
  if (why.length && (!only || why.some((w: string) => w.includes(only)))) html.set(i, s.html);
});
console.log('精修这几页', [...html.keys()].map((i) => `${i + 1}:${tooFull(html.get(i)!).join('/')}`).join(' '));
const t0 = Date.now();
const notes = await refinePages(r.id, userName(r.teacher_id), html, new AbortController().signal);
deck.slides = deck.slides.map((s: any, i: number) => (html.has(i) ? { ...s, html: html.get(i), ...(notes.has(i) ? { notes: notes.get(i) } : {}) } : s));
writeFileSync(resolve(outJson), JSON.stringify(deck, null, 1));
console.log('精修完', Math.round((Date.now() - t0) / 1000), '秒；还太满的', [...html.keys()].map((i) => `${i + 1}:${tooFull(html.get(i)!).join('/') || '好了'}`).join(' '));
process.exit(0);

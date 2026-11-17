/**
 * 备课带的文件。
 * 备课框里带的文件照交资料的路子交进老师的知识库，读法也是交资料那一套（PDF、PPT、Word、图片认字）；
 * 读出来的文字当「老师这次给的材料」交给教案、课件、题目那几手，太长的截掉。原件跟着这节课留着，页面上能看、能下载。
 * 一节课的助教栏里跟着一句话带的文件像作业附件那样先传上来，只给那一句用。
 */
import { config } from '../config.js';
import { db } from '../db/index.js';
import { bad } from '../lib/http.js';
import { extOf, kindFromExt } from '../kb/intake/kinds.js';
import { readBlobText, type ItemRow } from '../kb/intake/store.js';

/** 备课用得上的：PDF、PPT、Word、图片、文字和代码 */
const USABLE = new Set(['pdf', 'slides', 'document', 'image', 'text', 'code', 'notebook']);
/** 一次最多带几份 */
export const MAX_FILES = 20;
/** 给每一手的材料最多这么多字：几份一起分，短的整份给，长的截掉 */
export const MATERIAL_CHARS = 30_000;

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const base = (name: string) => name.split('/').pop() || name;

/** 带的文件能不能用：类型，大小照交资料的规矩（一份读得了的最大多少、一次交的一共多少） */
export function checkFiles(files: { name: string; size: number }[]) {
  if (files.length > MAX_FILES) throw bad(`一次最多带 ${MAX_FILES} 份文件`);
  for (const f of files) {
    const name = base(f.name);
    if (!USABLE.has(kindFromExt(extOf(name)))) throw bad(`「${name}」备课用不上，能带 PDF、PPT、Word、图片、文字和代码文件`);
    if (!f.size) throw bad(`「${name}」是空文件`);
    if (f.size > config.intake.maxDocBytes) throw bad(`「${name}」太大了（超过 ${mb(config.intake.maxDocBytes)}），拆小一点再带`);
  }
  if (files.reduce((n, f) => n + f.size, 0) > config.intake.maxBatchBytes) throw bad(`一次带的文件太大（超过 ${mb(config.intake.maxBatchBytes)}），分几次带`);
}

/** 这节课带的文件（交资料那一次的每一份） */
export const intakeFiles = (intakeId: number | null) =>
  intakeId ? db.all<ItemRow>("SELECT * FROM kb_intake_items WHERE intake_id=? AND (method IS NULL OR method<>'archive') ORDER BY id", intakeId) : [];
const isRead = (i: ItemRow) => (i.status === 'done' || i.status === 'same') && !!i.text_hash;
const settled = (i: ItemRow) => !['uploading', 'waiting', 'reading'].includes(i.status);
/** 没用上的那份为什么：没传完、没读完、读不了的原因 */
const missedWhy = (i: ItemRow) => (i.status === 'uploading' ? '没传完' : !settled(i) ? '没读完' : i.reason || '没读出来');

/** 页面上的样子：在传、在读、读好了、没读出来（带原因） */
export function filesView(intakeId: number | null) {
  return intakeFiles(intakeId).map((i) => ({
    id: i.id,
    name: base(i.name),
    kind: i.kind,
    size: i.size,
    received: i.received,
    status: i.status === 'uploading' ? 'uploading' : !settled(i) ? 'reading' : isRead(i) ? 'read' : 'unread',
    reason: settled(i) && !isRead(i) ? missedWhy(i) : null,
  }));
}

/**
 * 等这节课带的文件传完、读完。一直没动静（比读一份文件最长的时候还多等一分钟，多半是传的页面关了）就不等了，
 * 没收到、没读完的不用。返回读的那一步怎么说：看了哪几份，哪几份没用上、为什么。
 */
export async function waitFiles(intakeId: number, signal: AbortSignal): Promise<string> {
  let mark = '';
  let since = Date.now();
  for (;;) {
    const items = intakeFiles(intakeId);
    const moved = JSON.stringify(items.map((i) => [i.status, i.received, i.updated_at]));
    if (moved !== mark) [mark, since] = [moved, Date.now()];
    if (items.every(settled) || Date.now() - since > config.intake.readTimeoutMs + 60_000) {
      const got = items.filter(isRead).map((i) => `《${stem(i.name)}》`);
      return [got.length ? `看了${got.join('')}` : '', ...items.filter((i) => !isRead(i)).map((i) => `《${stem(i.name)}》${missedWhy(i)}`)].filter(Boolean).join('；');
    }
    await new Promise((ok) => setTimeout(ok, 1000));
    signal.throwIfAborted();
  }
}
const stem = (name: string) => base(name).replace(/\.[^.]+$/, '');

/** 几份读出来的文字拼成一段材料：一份一节，一共不超过 max 字；短的整份给，剩下的几份平分，截掉的写明后面还有多少字 */
export function materialBlock(head: string, docs: { name: string; text: string }[], max = MATERIAL_CHARS): string {
  if (!docs.length) return '';
  const take = new Map<number, number>();
  let left = max;
  const order = [...docs.keys()].sort((a, b) => docs[a].text.length - docs[b].text.length);
  order.forEach((k, n) => {
    const t = Math.min(docs[k].text.length, Math.floor(left / (order.length - n)));
    take.set(k, t);
    left -= t;
  });
  return [
    head,
    ...docs.map((d, k) => {
      const n = take.get(k)!;
      return `《${base(d.name)}》\n${d.text.slice(0, n)}${n < d.text.length ? `\n……（后面还有 ${d.text.length - n} 字）` : ''}`;
    }),
  ].join('\n\n');
}

/** 这节课带的文件读出来的材料（给教案、课件、题目那几手） */
export const lessonMaterial = (intakeId: number | null) =>
  materialBlock(
    '老师这次给的材料：',
    intakeFiles(intakeId)
      .filter(isRead)
      .map((i) => ({ name: i.name, text: readBlobText(i.text_hash!).trim() })),
  );

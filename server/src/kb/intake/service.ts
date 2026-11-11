import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, statfsSync, statSync, writeSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { db, j, now } from '../../db/index.js';
import { bad, conflict, forbidden, notFound } from '../../lib/http.js';
import { identityHits, loadKb, writableKb } from '../access.js';
import { createChange, teacherAuthor } from '../changes.js';
import { enqueueTask, drainInbox, cancelIntakeRun, attachmentsRead, INTERRUPTED } from '../keeper.js';
import { addSource, hashBytes, manifest, readEntry, type FileOp } from '../repo.js';
import { documentName } from '../teacher-text.js';
import { kindFromExt, extOf, isSystemJunk, type Kind } from './kinds.js';
import { archiveChildPaths, assignPaths, cleanRelative, pastedTitle } from './naming.js';
import { ReaderPool, WorkerFailed } from './pool.js';
import type { ExpandResult, ReadResult } from './protocol.js';
import {
  announce,
  blobPath,
  intakeItems,
  loadIntake,
  publicIntake,
  readBlobText,
  releaseBlobs,
  setIntake,
  setItem,
  stageDir,
  storeFile,
  storeText,
  type Batch,
  type IntakeRow,
  type ItemRow,
} from './store.js';
import { normalizeNewlines } from './textcodec.js';
import { VisionUnavailable, readImage } from './vision.js';

/** 读法改了就换版本号：同一份原件按新读法重读一次，其余照旧沿用。r2：看图识字改成按两栏交。 */
export const READER_VERSION = 'r2';
export const CHUNK_SIZE = 8 * 1024 * 1024;
/** 一批交给整理助手的量：同一文件夹的放一起，超过就分批，每批都能读完再整理。 */
const BATCH_CHARS = 60_000;
const BATCH_DOCS = 8;

let pool: ReaderPool | null = null;
const readers = () => (pool ||= new ReaderPool(config.intake.workers, config.intake.workerMemoryMb));
const meaningful = (s: string) => (s.match(/[\p{L}\p{N}]/gu) || []).length;
const gb = (n: number) => (n >= 1024 ** 3 ? `${Math.round(n / 1024 ** 3 * 10) / 10} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export interface NewFile {
  name: string;
  size: number;
}

function freeBytes(): number {
  try {
    const s = statfsSync(config.dataDir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
/** 收资料前看磁盘：要给同一台服务器上的其他服务留够空间。 */
function ensureDisk(need: number) {
  if (freeBytes() - need < config.intake.reserveBytes) throw bad('服务器的存储空间不够了，这次交不了，请联系管理员');
}

export function createIntake(
  kbId: number,
  user: { id: number; name: string },
  input: { message?: string | null; text?: string | null; files: NewFile[]; route?: boolean; runId?: number },
) {
  writableKb(kbId);
  // 系统文件要按原名认（.DS_Store、._讲义.docx），清理名字时会去掉开头的点，清理后就认不出来了
  const files = input.files
    .filter((f) => !isSystemJunk(String(f.name || '').replace(/\\/g, '/')))
    .map((f) => ({ index: input.files.indexOf(f), name: cleanRelative(f.name), size: Math.max(0, Math.floor(Number(f.size) || 0)) }))
    .filter((f) => !isSystemJunk(f.name));
  /** 条目对应浏览器选中的第几个文件，页面按它上传，不靠名字对 */
  const indexOf = new Map<number, number>();
  const text = input.text ? normalizeNewlines(input.text) : '';
  if (!files.length && !text.trim()) throw bad(input.files.length ? '选的都是电脑自动生成的文件，没有资料' : '请选择要交的文件');
  if (files.length > 1000) throw bad('一次最多交 1000 个文件，请分几次交，或打成压缩包再交');
  const total = files.filter((f) => f.size <= config.intake.maxFileBytes).reduce((n, f) => n + f.size, 0);
  if (total > config.intake.maxBatchBytes) throw bad(`一次交的东西太大（超过 ${gb(config.intake.maxBatchBytes)}），请分几次交`);
  ensureDisk(total * 2);
  const t = now();
  const id = db.tx(() => {
    const id = db.insert('kb_intakes', {
      kb_id: kbId,
      created_by: user.id,
      message: input.message?.trim() || null,
      // 在最外层交的：先放在这个库的最外层，整理助手看内容再放到合适的库
      route: input.route ? 1 : 0,
      run_id: input.runId ?? null,
      status: 'uploading',
      created_at: t,
      updated_at: t,
    });
    if (text.trim()) {
      const hash = storeText(text);
      const size = Buffer.byteLength(text, 'utf8');
      db.insert('kb_intake_items', { intake_id: id, name: `${pastedTitle(text, t)}.txt`, kind: 'text', size, received: size, hash, status: 'waiting', created_at: t, updated_at: t });
    }
    for (const f of files) {
      const base = { intake_id: id, name: f.name, kind: kindFromExt(extOf(f.name)), size: f.size, created_at: t, updated_at: t };
      if (!f.size) db.insert('kb_intake_items', { ...base, status: 'failed', reason: '这是空文件', advice: '' });
      else if (f.size > config.intake.maxFileBytes)
        db.insert('kb_intake_items', { ...base, status: 'failed', reason: `这份文件太大（超过 ${gb(config.intake.maxFileBytes)}）`, advice: '请拆小或压缩后再交' });
      else indexOf.set(db.insert('kb_intake_items', { ...base, status: 'uploading' }), f.index);
    }
    return id;
  });
  mkdirSync(stageDir(id), { recursive: true });
  afterUpload(id);
  const row = loadIntake(id);
  return {
    intake: publicIntake(row),
    uploads: intakeItems(id)
      .filter((i) => i.status === 'uploading')
      .map((i) => ({ itemId: i.id, index: indexOf.get(i.id) ?? -1, name: i.name, size: i.size, received: i.received })),
    chunkSize: CHUNK_SIZE,
  };
}

/** 收完最后一份就开始读；没有要传的（只贴了文字、或者都是读不了的）立刻进入下一步。 */
function afterUpload(id: number) {
  const left = db.value<number>("SELECT count(*) FROM kb_intake_items WHERE intake_id=? AND status='uploading'", id) || 0;
  const row = loadIntake(id);
  if (!left && row.status === 'uploading') {
    setIntake(id, { status: 'reading' });
    announce(id, true);
    schedule();
    void maybePublish(id);
  } else announce(id);
}

const appending = new Map<number, Promise<unknown>>();
export async function receiveChunk(kbId: number, intakeId: number, itemId: number, offset: number, chunk: Uint8Array) {
  const intake = db.get<IntakeRow>('SELECT * FROM kb_intakes WHERE id=? AND kb_id=?', intakeId, kbId);
  if (!intake) throw notFound('这次交的资料不存在');
  if (intake.status === 'canceled') throw conflict('这次交资料已经取消');
  const run = async () => {
    const item = db.get<ItemRow>('SELECT * FROM kb_intake_items WHERE id=? AND intake_id=?', itemId, intakeId);
    if (!item) throw notFound('这份文件不在这次交的资料里');
    if (item.status !== 'uploading') return { received: item.received, complete: true };
    if (offset !== item.received) return { received: item.received, complete: false };
    if (chunk.length > CHUNK_SIZE || offset + chunk.length > item.size) throw bad('上传的数据和文件大小对不上，请重新交');
    if (chunk.length && freeBytes() - chunk.length < config.intake.reserveBytes) throw bad('服务器的存储空间不够了，这次交不了，请联系管理员');
    const part = join(stageDir(intakeId), `${itemId}.part`);
    mkdirSync(stageDir(intakeId), { recursive: true });
    const fd = openSync(part, existsSync(part) ? 'r+' : 'w');
    try {
      if (statSync(part).size !== offset) ftruncateSync(fd, offset);
      let written = 0;
      while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written, offset + written);
    } finally {
      closeSync(fd);
    }
    const received = offset + chunk.length;
    setItem(itemId, { received });
    if (received === item.size) {
      const hash = await storeFile(part);
      setItem(itemId, { hash, status: 'waiting' });
      afterUpload(intakeId);
      return { received, complete: true };
    }
    announce(intakeId);
    return { received, complete: false };
  };
  const prev = appending.get(itemId) || Promise.resolve();
  const next = prev.then(run, run);
  appending.set(
    itemId,
    next.catch(() => {}),
  );
  return next;
}

/** 旧页面一次性上传的文件：直接收下，读完再回答哪些读好了、哪些没读出来。 */
export async function intakeFromBuffers(
  kbId: number,
  user: { id: number; name: string },
  files: { name: string; data: Uint8Array }[],
  message?: string,
  route = false,
) {
  const created = createIntake(kbId, user, { message, files: files.map((f) => ({ name: f.name, size: f.data.length })), route });
  for (const u of created.uploads) {
    const f = files[u.index];
    if (f) await receiveChunk(kbId, created.intake.id, u.itemId, 0, f.data);
  }
  const id = created.intake.id;
  for (let waited = 0; waited < 15 * 60_000; waited += 300) {
    const row = loadIntake(id);
    if (!['uploading', 'reading'].includes(row.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return loadIntake(id);
}

// ---------------- 读 ----------------

const controllers = new Map<number, AbortController>();
const loops = { running: 0 };
export function schedule() {
  const max = config.intake.workers + 1;
  while (loops.running < max) {
    loops.running++;
    void loop().finally(() => loops.running--);
  }
}
async function loop() {
  for (;;) {
    const item = claim();
    if (!item) return;
    try {
      await readItem(item);
    } catch (err) {
      console.error('[intake] read failed', item.id, err);
      setItem(item.id, { status: 'failed', reason: '读的时候出了错，没读完', advice: '稍后点「接着读」', retryable: 1 });
    }
    announce(item.intake_id);
    await maybePublish(item.intake_id);
  }
}
/** 取下一份要读的：几次交资料同时在读时轮流来，一个大压缩包不会让别人的资料一直等。 */
function claim(): ItemRow | null {
  return db.tx(() => {
    const row = db.get<ItemRow>(
      `SELECT i.* FROM kb_intake_items i JOIN kb_intakes k ON k.id=i.intake_id
       WHERE i.status='waiting' AND k.status='reading'
       ORDER BY (SELECT count(*) FROM kb_intake_items r WHERE r.intake_id=i.intake_id AND r.status='reading'), i.intake_id, i.id LIMIT 1`,
    );
    if (!row) return null;
    setItem(row.id, { status: 'reading' });
    return row;
  });
}

function fail(item: ItemRow, d: { reason: string; advice?: string; kind?: string; retryable?: boolean; skip?: boolean }) {
  setItem(item.id, {
    status: d.skip ? 'skipped' : 'failed',
    reason: d.reason,
    advice: d.advice || '',
    retryable: d.retryable ? 1 : 0,
    ...(d.kind && d.kind !== 'unknown' ? { kind: d.kind } : {}),
  });
}

async function readItem(item: ItemRow) {
  const intake = loadIntake(item.intake_id);
  if (intake.status !== 'reading') return setItem(item.id, { status: 'waiting' });
  const file = blobPath(item.hash!);
  const cached = db.get<any>('SELECT * FROM kb_conversions WHERE original_hash=? AND version=?', item.hash, READER_VERSION);
  if (cached) return setItem(item.id, { status: 'done', kind: cached.kind, text_hash: cached.text_hash, method: cached.method, notes: cached.notes, progress: null });
  if (item.size > config.intake.maxDocBytes && kindFromExt(extOf(item.name)) !== 'archive')
    return fail(item, { reason: `这份文件太大（超过 ${gb(config.intake.maxDocBytes)}），读不了`, advice: '请拆成几份再交' });
  let result: ReadResult;
  try {
    result = (await readers().run({ op: 'read', name: item.name, file }, config.intake.readTimeoutMs)) as ReadResult;
  } catch (err) {
    if (err instanceof WorkerFailed)
      return fail(item, err.why === 'timeout' ? { reason: '读得太久，没能读完', advice: '请拆成几份再交' } : { reason: '文件太大或太复杂，没能读完', advice: '请拆成几份再交' });
    throw err;
  }
  if (result.type === 'archive') return expand(item, intake);
  if (result.type === 'cannot') return fail(item, { reason: result.reason, advice: result.advice, kind: result.kind });
  if (result.type === 'failed') return fail(item, { reason: result.reason, advice: result.advice, kind: result.kind, skip: result.skip });
  const images = result.blocks.filter((b) => b.t === 'img');
  const notes = [...result.notes];
  setItem(item.id, { kind: result.kind, progress: images.length ? JSON.stringify({ done: 0, total: images.length }) : null });
  const ctrl = controllers.get(intake.id) || new AbortController();
  controllers.set(intake.id, ctrl);
  let done = 0;
  const texts = new Map<number, string>();
  let unavailable: VisionUnavailable | null = null;
  await Promise.all(
    result.blocks.map(async (b, k) => {
      if (b.t !== 'img' || unavailable) return;
      try {
        const text = await readImage(b.image, b.key, { userId: intake.created_by, signal: ctrl.signal, concurrency: config.intake.visionConcurrency });
        texts.set(k, text);
        // 图里本来就没有字（装饰图、照片）是常事，不记；认出了一点又不成字才记
        if (text.trim() && !meaningful(text) && b.label) notes.push(`${b.label}没有认出字`);
        setItem(item.id, { progress: JSON.stringify({ done: ++done, total: images.length }) });
        announce(intake.id);
      } catch (err) {
        if (err instanceof VisionUnavailable) unavailable ||= err;
        else if (!ctrl.signal.aborted) unavailable ||= new VisionUnavailable('图片里的字暂时认不了：整理服务暂时连不上', '稍后点「接着读」');
      }
    }),
  );
  if (loadIntake(intake.id).status === 'canceled') return;
  const missed = unavailable as VisionUnavailable | null;
  if (missed) return fail(item, { reason: missed.reason, advice: missed.advice, kind: result.kind, retryable: true });
  const parts = result.blocks.map((b, k) => (b.t === 'md' ? b.text : texts.get(k) || '')).filter((s) => s.trim());
  const text = parts.join('\n\n').trim() + '\n';
  // 每张图都说没有字：是插画、照片这类，不算没读成
  if (!meaningful(text) && images.length && result.blocks.every((b, k) => b.t !== 'img' || !texts.get(k)) && !result.blocks.some((b) => b.t === 'md' && meaningful(b.text)))
    return fail(item, { reason: '图片里没有文字', kind: result.kind, skip: true });
  if (!meaningful(text)) return fail(item, { reason: images.length ? '图片里没有认出字' : '里面没有能读出的文字', advice: images.length ? '请确认图片清晰后再交' : '', kind: result.kind });
  const method = !images.length ? 'text' : result.blocks.some((b) => b.t === 'md' && meaningful(b.text.replace(/^##[^\n]*$/gm, '')) > 0) ? 'mixed' : 'vision';
  const textHash = storeText(text);
  const uniqueNotes = [...new Set(notes)];
  db.run(
    'INSERT OR REPLACE INTO kb_conversions(original_hash,version,kind,text_hash,method,notes,created_at) VALUES(?,?,?,?,?,?,?)',
    item.hash,
    READER_VERSION,
    result.kind,
    textHash,
    method,
    uniqueNotes.length ? JSON.stringify(uniqueNotes) : null,
    now(),
  );
  // 读的时候老师取消了：读好的结果留在缓存里（重交不再花钱），这一份照旧算「已取消」
  if (loadIntake(intake.id).status === 'canceled') return;
  setItem(item.id, { status: 'done', kind: result.kind, text_hash: textHash, method, notes: uniqueNotes.length ? JSON.stringify(uniqueNotes) : null, progress: null, retryable: 0, reason: null, advice: null });
}

async function expand(item: ItemRow, intake: IntakeRow) {
  if (item.depth >= 3) return fail(item, { reason: '压缩包里又套了好几层压缩包', advice: '请解开后再交', kind: 'archive' });
  const outDir = join(stageDir(intake.id), `x${item.id}`);
  rmSync(outDir, { recursive: true, force: true });
  const used = db.value<number>("SELECT count(*) FROM kb_intake_items WHERE intake_id=? AND (method IS NULL OR method<>'archive')", intake.id) || 0;
  const usedBytes = db.value<number>('SELECT coalesce(sum(size),0) FROM kb_intake_items WHERE intake_id=? AND depth>0', intake.id) || 0;
  const limits = {
    maxEntries: Math.max(1, config.intake.maxEntries - used),
    maxTotal: Math.max(1, config.intake.maxExpandBytes - usedBytes),
    maxEntry: config.intake.maxDocBytes,
  };
  let result: ExpandResult;
  try {
    // 解压结果先放在原件库旁边的临时目录里，7-Zip 要求两者在同一个目录下面
    result = (await readers().run({ op: 'expand', name: item.name, file: blobPath(item.hash!), outDir, limits }, config.intake.readTimeoutMs)) as ExpandResult;
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    if (err instanceof WorkerFailed) return fail(item, { reason: '压缩包太大或太复杂，没能解开', advice: '请分成几个压缩包再交', kind: 'archive' });
    throw err;
  }
  if (result.type === 'failed') {
    rmSync(outDir, { recursive: true, force: true });
    return fail(item, { reason: result.reason, advice: result.advice, kind: 'archive' });
  }
  try {
    ensureDisk(result.files.reduce((n, f) => n + f.size, 0));
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    return fail(item, { reason: (err as Error).message, kind: 'archive' });
  }
  const inner = [...result.files.map((f) => f.path), ...result.refused.map((r) => r.path)];
  const logical = archiveChildPaths(item.name, inner);
  const t = now();
  const children: { name: string; size: number; tmp?: string; refused?: { reason: string; advice: string } }[] = [
    ...result.files.map((f, k) => ({ name: logical[k], size: f.size, tmp: f.file })),
    ...result.refused.map((r, k) => ({ name: logical[result.files.length + k], size: r.size, refused: { reason: r.reason, advice: r.advice } })),
  ];
  for (const c of children) {
    const base = { intake_id: intake.id, parent_id: item.id, depth: item.depth + 1, name: c.name, kind: kindFromExt(extOf(c.name)), size: c.size, received: c.size, created_at: t, updated_at: t };
    if (c.refused) {
      db.insert('kb_intake_items', { ...base, status: 'failed', reason: c.refused.reason, advice: c.refused.advice });
      continue;
    }
    if (!c.size) {
      rmSync(c.tmp!, { force: true });
      db.insert('kb_intake_items', { ...base, status: 'failed', reason: '这是空文件', advice: '' });
      continue;
    }
    const hash = await storeFile(c.tmp!);
    db.insert('kb_intake_items', { ...base, hash, status: 'waiting' });
  }
  rmSync(outDir, { recursive: true, force: true });
  setItem(item.id, { status: 'done', kind: 'archive', method: 'archive', progress: null });
  schedule();
}

// ---------------- 放进知识库 ----------------

const publishing = new Set<number>();
async function maybePublish(id: number) {
  const row = loadIntake(id);
  if (row.status !== 'reading' || publishing.has(id)) return;
  const left = db.value<number>("SELECT count(*) FROM kb_intake_items WHERE intake_id=? AND status IN ('uploading','waiting','reading')", id) || 0;
  if (left) return;
  publishing.add(id);
  try {
    await publish(id);
  } catch (err) {
    console.error('[intake] publish failed', id, err);
    setIntake(id, { status: 'failed', error: '资料读好了，但放进知识库时出了错，请再试一次', finished_at: now() });
  } finally {
    publishing.delete(id);
    controllers.delete(id);
    cleanStage(id);
    releaseBlobs(id);
    announce(id, true);
  }
}

function cleanStage(id: number) {
  const row = db.get<IntakeRow>('SELECT * FROM kb_intakes WHERE id=?', id);
  if (row && !['uploading', 'reading'].includes(row.status)) rmSync(stageDir(id), { recursive: true, force: true });
}

async function publish(id: number) {
  const intake = loadIntake(id);
  // 跟整理助手说话带的文件：读完交给那句话的整理助手看，由它决定存不存、存哪
  if (intake.run_id) {
    setIntake(id, { status: 'done', finished_at: now() });
    attachmentsRead(intake.run_id, id);
    return;
  }
  const kb = loadKb(intake.kb_id);
  const user = db.get<{ id: number; name: string }>('SELECT id,name FROM users WHERE id=?', intake.created_by)!;
  const items = intakeItems(id);
  const docs = items.filter((i) => i.status === 'done' && i.text_hash && !i.source_id && i.method !== 'archive');
  if (kb.status === 'archived') {
    setIntake(id, { status: 'failed', error: '这个学期已经封存，资料没有放进去', finished_at: now() });
    return;
  }
  if (!docs.length) {
    const any = items.some((i) => i.status === 'done' && i.method !== 'archive');
    setIntake(id, { status: any ? 'done' : 'failed', error: any ? null : '这次交的东西都没能读出来', finished_at: now() });
    return;
  }
  const entries = manifest(kb.id);
  // 之前交过同名的资料（哪怕被整理助手挪了位置），这次就是它的新版本
  const previous = new Map<string, (typeof entries)[number]>();
  const names = new Map(
    db.all<{ id: string; name: string }>('SELECT id,name FROM kb_sources WHERE kb_id=?', kb.id).map((s) => [s.id, s.name.replace(/\\/g, '/').toLocaleLowerCase()]),
  );
  for (const e of entries) if (e.sourceId && names.has(e.sourceId)) previous.set(names.get(e.sourceId)!, e);
  const claimed = new Set<string>();
  const match = new Map<number, (typeof entries)[number]>();
  for (const d of docs) {
    const key = d.name.toLocaleLowerCase();
    const prev = previous.get(key);
    if (prev && !claimed.has(prev.id)) {
      claimed.add(prev.id);
      match.set(d.id, prev);
    }
  }
  const paths = assignPaths(
    docs.map((d) => ({ id: d.id, logical: d.name, kind: d.kind as Kind, existingPath: match.get(d.id)?.path })),
    new Set(entries.map((e) => e.path)),
  );
  const ops: FileOp[] = [];
  const placed: { item: ItemRow; path: string; sourceId: string; updated: boolean; students: ClassHit[] }[] = [];
  const same: ItemRow[] = [];
  for (const d of docs) {
    const text = readBlobText(d.text_hash!);
    const prev = match.get(d.id);
    const path = paths.get(d.id)!;
    let base: string | null = null;
    if (prev) {
      const current = readEntry(kb.id, prev);
      if (hashBytes(current) === d.text_hash) {
        same.push(d);
        continue;
      }
      base = hashBytes(current);
    }
    const sourceId = addSource(kb.id, { name: d.name, originalHash: d.hash!, text, kind: d.kind, method: d.method, notes: j<string[]>(d.notes, []) });
    ops.push({ path, content: text, base, ...(prev ? { baseEntryId: prev.id } : {}), sourceId, sourcePart: 'text' });
    placed.push({ item: d, path, sourceId, updated: !!prev, students: kb.kind === 'teacher' ? classesIn(kb.teacher_id, text) : [] });
  }
  for (const s of same) setItem(s.id, { status: 'same', path: match.get(s.id)!.path });
  if (!ops.length) {
    setIntake(id, { status: 'done', finished_at: now() });
    return;
  }
  const added = placed.filter((p) => !p.updated).length,
    updated = placed.length - added;
  const title =
    placed.length === 1
      ? `${updated ? '更新' : '交'}了「${documentName(placed[0].path)}」`
      : [added ? `交了 ${added} 份资料` : '', updated ? `${added ? '' : '更新了 '}${updated} 份${added ? '更新' : '资料'}` : ''].filter(Boolean).join('，');
  const change = await createChange({
    kbId: kb.id,
    title,
    author: 'teacher',
    authorName: user.name,
    kind: 'upload',
    ops,
    apply: { by: user.id, as: teacherAuthor(user) },
  });
  for (const p of placed)
    setItem(p.item.id, {
      path: p.path,
      source_id: p.sourceId,
      ...(p.students.length ? { students: JSON.stringify(p.students) } : {}),
      // 和知识库里已有的资料同名：替换了原来那份（历史里还能找回），让老师看得见，免得不小心撞名没察觉
      ...(p.updated ? { notes: JSON.stringify([...j<string[]>(p.item.notes, []), '替换了知识库里原来的同名资料']) } : {}),
    });
  const plan = planBatches(ops.map((o) => ({ path: o.path, chars: (o.content || '').length })));
  setIntake(id, { status: 'digesting', change_id: change.id, plan: JSON.stringify(plan), batch: 0, checkpoint: null, error: null });
  enqueueTask(kb.id, 'intake', `${id}:${change.id}`, title);
  queueMicrotask(() => drainInbox(kb.id));
}

type ClassHit = { kbId: number; name: string; count: number };
/** 资料里出现了哪些班的已登记学生（姓名、学号或别名），每班几个人 */
function classesIn(teacherId: number, text: string): ClassHit[] {
  const count = new Map<number, number>();
  for (const s of identityHits(teacherId, text)) count.set(s.kb_id, (count.get(s.kb_id) || 0) + 1);
  return [...count].map(([kbId, n]) => {
    const k = db.get<{ class_name: string | null; name: string }>('SELECT class_name,name FROM knowledge_bases WHERE id=?', kbId)!;
    return { kbId, name: k.class_name || k.name, count: n };
  });
}

/**
 * 交到长期库的资料里只有一个班的学生：改交到那个班。
 * 班级库收下这份原件重新读、交给它的整理助手；长期库里的这份原件移除（历史里还在）。
 */
export async function moveToClass(kbId: number, intakeId: number, itemId: number, classId: number, user: { id: number; name: string }) {
  const kb = writableKb(kbId);
  // 整理过程中挪走资料，后面几批会找不到它；整理完（或停了）再改交
  if (!['done', 'failed', 'canceled'].includes(loadIntake(intakeId).status)) throw conflict('这次交的资料还在整理，整理完再改交');
  const item = intakeItems(intakeId).find((i) => i.id === itemId);
  if (!item || !item.path || !item.hash || !item.source_id) throw notFound('这份资料不存在');
  const found = j<ClassHit[]>(item.students, []);
  if (found.length !== 1 || found[0].kbId !== classId) throw bad('这份资料里不只有这个班的学生，请分开后再交');
  const target = loadKb(classId);
  if (target.kind !== 'class' || target.teacher_id !== kb.teacher_id) throw forbidden();
  const entry = manifest(kb.id).find((e) => e.path === item.path && e.sourceId === item.source_id);
  if (!entry) throw conflict('这份资料已经不在长期库里了');
  if (!existsSync(blobPath(item.hash))) throw conflict('这份资料的原件已经清理掉了，请重新交给这个班');
  const data = readFileSync(blobPath(item.hash));
  // 班级封存了 createIntake 会拒绝；名字只取文件名，不把长期库里的文件夹带过去
  const created = createIntake(classId, user, { files: [{ name: item.name.split('/').pop() || item.name, size: data.length }] });
  const up = created.uploads[0];
  if (up) await receiveChunk(classId, created.intake.id, up.itemId, 0, data);
  await createChange({
    kbId: kb.id,
    title: `把「${documentName(item.path)}」改交到${found[0].name}`,
    author: 'teacher',
    authorName: user.name,
    kind: 'teacher',
    ops: [{ path: item.path, content: null, base: hashBytes(readEntry(kb.id, entry)), baseEntryId: entry.id }],
    apply: { by: user.id, as: teacherAuthor(user) },
  });
  setItem(item.id, { students: null, notes: JSON.stringify([...j<string[]>(item.notes, []), `已改交到${found[0].name}`]) });
  announce(intakeId, true);
  return { intake: publicIntake(loadIntake(intakeId)), moved: publicIntake(loadIntake(created.intake.id)) };
}

/** 按文件夹分批：同一文件夹的资料尽量放在同一批，一批不超过 BATCH_CHARS 字、BATCH_DOCS 份。 */
export function planBatches(docs: { path: string; chars: number }[]): Batch[] {
  const sorted = [...docs].sort((a, b) => a.path.localeCompare(b.path, 'zh', { numeric: true }));
  const folders = new Map<string, typeof sorted>();
  for (const d of sorted) {
    const dir = d.path.slice(0, d.path.lastIndexOf('/'));
    folders.set(dir, [...(folders.get(dir) || []), d]);
  }
  const batches: Batch[] = [];
  let cur: string[] = [],
    chars = 0;
  const push = () => {
    if (cur.length) batches.push({ paths: cur });
    cur = [];
    chars = 0;
  };
  for (const group of folders.values()) {
    const groupChars = group.reduce((n, d) => n + d.chars, 0);
    // 一个文件夹放得进一批时尽量不拆开；本来就要拆的大文件夹接着上一批的空位往下装，免得每个文件夹都剩一个零头单独成批
    const fitsOne = groupChars <= BATCH_CHARS && group.length <= BATCH_DOCS;
    if (fitsOne && cur.length && (chars + groupChars > BATCH_CHARS || cur.length + group.length > BATCH_DOCS)) push();
    for (const d of group) {
      if (cur.length && (chars + d.chars > BATCH_CHARS || cur.length >= BATCH_DOCS)) push();
      cur.push(d.path);
      chars += d.chars;
    }
  }
  push();
  return batches;
}

// ---------------- 老师的操作 ----------------

function ownIntake(kbId: number, id: number): IntakeRow {
  const row = db.get<IntakeRow>('SELECT * FROM kb_intakes WHERE id=? AND kb_id=?', id, kbId);
  if (!row) throw notFound('这次交的资料不存在');
  return row;
}

/** 接着来：没读出来的（暂时性原因）重新读，整理中断的从中断那一批接着整理。已经做完的不重做。 */
export function resumeIntake(kbId: number, id: number) {
  writableKb(kbId);
  const row = ownIntake(kbId, id);
  if (row.status === 'paused') {
    const job = db.get<{ id: number }>("SELECT id FROM kb_inbox WHERE kb_id=? AND sender='intake' AND source_id LIKE ? ORDER BY id DESC LIMIT 1", kbId, `${id}:%`);
    if (!job) throw conflict('找不到这次整理，请重新交资料');
    db.update('kb_inbox', job.id, { status: 'pending', error: null });
    setIntake(id, { status: 'digesting', error: null });
    announce(id, true);
    drainInbox(kbId);
    return publicIntake(loadIntake(id));
  }
  const retry = db.all<ItemRow>("SELECT * FROM kb_intake_items WHERE intake_id=? AND status='failed' AND retryable=1", id);
  if (!retry.length) throw conflict('没有需要接着做的');
  if (['uploading', 'reading', 'digesting'].includes(row.status)) throw conflict('还在处理中，请等这一步做完');
  db.tx(() => {
    for (const i of retry) setItem(i.id, { status: 'waiting', retryable: 0, reason: null, advice: null });
    setIntake(id, { status: 'reading', error: null, finished_at: null });
  });
  announce(id, true);
  schedule();
  return publicIntake(loadIntake(id));
}

/** 取消：还没放进知识库的资料都不放；已经进了知识库的不受影响。 */
export function cancelIntake(kbId: number, id: number) {
  const row = ownIntake(kbId, id);
  if (row.status === 'digesting') {
    cancelIntakeRun(kbId, id);
    return publicIntake(loadIntake(id));
  }
  if (!['uploading', 'reading'].includes(row.status)) throw conflict('这次交的资料已经处理完了');
  controllers.get(id)?.abort();
  db.tx(() => {
    db.run("UPDATE kb_intake_items SET status='skipped',reason='已取消',advice='',updated_at=? WHERE intake_id=? AND status IN ('uploading','waiting','reading')", now(), id);
    setIntake(id, { status: 'canceled', finished_at: now() });
  });
  controllers.delete(id);
  cleanStage(id);
  releaseBlobs(id, true);
  announce(id, true);
  return publicIntake(loadIntake(id));
}

/** 整理到一半停下时，老师可以先把已经整理好的交出来看，不再继续。 */
export async function finishIntake(kbId: number, id: number, user: { id: number; name: string }) {
  writableKb(kbId);
  const row = ownIntake(kbId, id);
  if (row.status !== 'paused') throw conflict('现在不能这样结束');
  const { commitCheckpoint } = await import('../keeper.js');
  await commitCheckpoint(kbId, id, user);
  return publicIntake(loadIntake(id));
}

/** 服务重启后：读到一半的接着读，整理到一半的接着整理（每批最多自动接两次，免得反复失败）。 */
export function recoverIntakes() {
  db.run("UPDATE kb_intake_items SET status='waiting' WHERE status='reading'");
  for (const row of db.all<IntakeRow>("SELECT * FROM kb_intakes WHERE status='digesting'")) {
    const job = db.get<{ id: number; status: string; run_id: number | null }>("SELECT id,status,run_id FROM kb_inbox WHERE kb_id=? AND sender='intake' AND source_id LIKE ? ORDER BY id DESC LIMIT 1", row.kb_id, `${row.id}:%`);
    if (!job || job.status === 'accepted') continue;
    if (job.status === 'error' || job.status === 'running') {
      if (row.resumes < 2) {
        db.update('kb_inbox', job.id, { status: 'pending', error: null });
        setIntake(row.id, { resumes: row.resumes + 1 });
        // 被打断的那条记录写着「可以重试」，其实会自动重来，不用老师动手
        if (job.run_id) db.run("UPDATE kb_runs SET error=? WHERE id=? AND error=?", '服务中断，这一批重新整理', job.run_id, INTERRUPTED);
      } else setIntake(row.id, { status: 'paused', error: '整理中断了，可以接着整理' });
    }
  }
  // 放回排队的（以及断电时本来就在排队的）整理要有人叫醒，不然会一直停在「整理中」；等服务起来再开始
  const waiting = db.all<{ kb_id: number }>("SELECT DISTINCT kb_id FROM kb_inbox WHERE sender='intake' AND status='pending'");
  if (waiting.length) setTimeout(() => waiting.forEach((w) => drainInbox(w.kb_id)), 0).unref();
  if (db.value<number>("SELECT count(*) FROM kb_intakes WHERE status='reading'")) schedule();
  for (const row of db.all<IntakeRow>("SELECT id FROM kb_intakes WHERE status='reading'")) void maybePublish(row.id);
  try {
    for (const dir of readdirSync(stageDir())) {
      const id = Number(dir);
      const row = Number.isInteger(id) ? db.get<IntakeRow>('SELECT status FROM kb_intakes WHERE id=?', id) : undefined;
      if (!row || !['uploading', 'reading'].includes(row.status)) rmSync(join(stageDir(), dir), { recursive: true, force: true });
    }
  } catch {}
}

export async function closeReaders() {
  await pool?.close();
  pool = null;
}

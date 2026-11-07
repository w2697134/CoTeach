import { parentPort, workerData } from 'node:worker_threads';
import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import SevenZip from '7z-wasm';
import { ArchiveError, expandArchive, sevenZipLoader } from './archive.js';
import { ReadError, readDocument, route } from './readers.js';
import type { Reply, Task, WorkerAssets, ReadResult, ExpandResult } from './protocol.js';

/** 读资料线程：只读传进来的文件路径，结果交回主线程；不连数据库、不调用模型。 */
const assets = workerData.assets as WorkerAssets;
const sevenZip = sevenZipLoader(assets.sevenZipWasm, SevenZip as any);

function head(file: string): Uint8Array {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const b = Buffer.alloc(Math.min(size, 8192));
    readSync(fd, b, 0, b.length, 0);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } finally {
    closeSync(fd);
  }
}

async function handle(task: Task): Promise<ReadResult | ExpandResult> {
  if (task.op === 'expand') {
    try {
      const r = await expandArchive(task.file, task.name, task.outDir, task.limits, sevenZip);
      return { type: 'expanded', files: r.files, refused: r.refused };
    } catch (err) {
      if (err instanceof ArchiveError) return { type: 'failed', reason: err.reason, advice: err.advice };
      return { type: 'failed', reason: '压缩包打不开，可能已经损坏或没有传完整', advice: '请重新打包后再交' };
    }
  }
  let bytes: Uint8Array | null = null;
  const all = async () => (bytes ||= new Uint8Array(readFileSync(task.file)));
  try {
    const r = await route(task.name, head(task.file), all);
    if (r.kind === 'archive' && !('format' in r) && !('cannot' in r)) return { type: 'archive' };
    if ('cannot' in r) return { type: 'cannot', kind: r.kind, reason: r.cannot.reason, advice: r.cannot.advice };
    const out = await readDocument(task.name, await all(), r as Parameters<typeof readDocument>[2], { pdfAssets: assets.pdf });
    return { type: 'document', kind: out.kind, blocks: out.blocks, notes: out.notes };
  } catch (err) {
    if (err instanceof ReadError) return { type: 'failed', kind: 'unknown', reason: err.reason, advice: err.advice, skip: err.skip };
    return { type: 'failed', kind: 'unknown', reason: '文件打不开，可能已经损坏', advice: '请重新保存一份再交', skip: false };
  }
}

parentPort!.on('message', async (msg: { id: number; task: Task }) => {
  let reply: Reply;
  try {
    const result = await handle(msg.task);
    reply = { id: msg.id, ok: true, result };
  } catch (err) {
    reply = { id: msg.id, ok: false, error: String((err as Error)?.message || err) };
  }
  const transfer =
    reply.ok && reply.result.type === 'document'
      ? reply.result.blocks.flatMap((b) => (b.t === 'img' && b.image.data.byteOffset === 0 && b.image.data.byteLength === b.image.data.buffer.byteLength ? [b.image.data.buffer as ArrayBuffer] : []))
      : [];
  parentPort!.postMessage(reply, [...new Set(transfer)]);
});

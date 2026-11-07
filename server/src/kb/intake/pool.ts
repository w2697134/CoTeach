import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Reply, Task, WorkerAssets, ReadResult, ExpandResult } from './protocol.js';

/**
 * 读资料线程池。线程卡住或内存用爆时只结束这个线程，这份资料记为没读完，服务本身不受影响。
 * 打包后：dist/intake-worker.mjs 和 dist/assets/；源码运行：worker.ts 和 node_modules 里的附带文件。
 */
const here = dirname(fileURLToPath(import.meta.url));
const bundled = existsSync(join(here, 'intake-worker.mjs'));
export function workerAssets(): WorkerAssets {
  if (bundled) {
    const a = join(here, 'assets');
    return {
      sevenZipWasm: join(a, '7zz.wasm'),
      pdf: { cMapUrl: join(a, 'pdf', 'cmaps') + '/', standardFontDataUrl: join(a, 'pdf', 'standard_fonts') + '/', wasmUrl: join(a, 'pdf', 'wasm') + '/' },
    };
  }
  const require = createRequire(import.meta.url);
  const pdf = dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    sevenZipWasm: join(dirname(require.resolve('7z-wasm/package.json')), '7zz.wasm'),
    pdf: { cMapUrl: join(pdf, 'cmaps') + '/', standardFontDataUrl: join(pdf, 'standard_fonts') + '/', wasmUrl: join(pdf, 'wasm') + '/' },
  };
}

export class WorkerFailed extends Error {
  constructor(public why: 'timeout' | 'crash') {
    super(why);
  }
}
interface Job {
  task: Task;
  timeoutMs: number;
  resolve: (r: ReadResult | ExpandResult) => void;
  reject: (e: Error) => void;
}
interface Slot {
  worker: Worker;
  job: (Job & { id: number; timer: NodeJS.Timeout }) | null;
  idle: NodeJS.Timeout | null;
}

export class ReaderPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private seq = 0;
  constructor(
    private size: number,
    private memoryMb: number,
  ) {}
  run(task: Task, timeoutMs: number): Promise<ReadResult | ExpandResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, timeoutMs, resolve, reject });
      this.pump();
    });
  }
  private spawn(): Slot {
    const assets = workerAssets();
    const worker = bundled
      ? new Worker(join(here, 'intake-worker.mjs'), { workerData: { assets }, resourceLimits: { maxOldGenerationSizeMb: this.memoryMb } })
      : new Worker(join(here, 'worker.ts'), { workerData: { assets }, execArgv: ['--import', 'tsx'], resourceLimits: { maxOldGenerationSizeMb: this.memoryMb } });
    const slot: Slot = { worker, job: null, idle: null };
    worker.on('message', (reply: Reply) => {
      const job = slot.job;
      if (!job || job.id !== reply.id) return;
      clearTimeout(job.timer);
      slot.job = null;
      slot.worker.unref();
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new Error(reply.error));
      this.rest(slot);
      this.pump();
    });
    const fail = () => {
      const job = slot.job;
      slot.job = null;
      this.slots = this.slots.filter((s) => s !== slot);
      if (job) {
        clearTimeout(job.timer);
        job.reject(new WorkerFailed('crash'));
      }
      this.pump();
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    worker.unref();
    this.slots.push(slot);
    return slot;
  }
  /** 闲着的线程两分钟后结束，服务器内存还给其他服务。 */
  private rest(slot: Slot) {
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => {
      if (!slot.job) {
        this.slots = this.slots.filter((s) => s !== slot);
        void slot.worker.terminate();
      }
    }, 120_000);
    slot.idle.unref();
  }
  private pump() {
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const job = this.queue.shift()!;
      if (slot.idle) clearTimeout(slot.idle);
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (slot!.job?.id !== id) return;
        slot!.job = null;
        this.slots = this.slots.filter((s) => s !== slot);
        void slot!.worker.terminate();
        job.reject(new WorkerFailed('timeout'));
        this.pump();
      }, job.timeoutMs);
      timer.unref();
      slot.job = { ...job, id, timer };
      slot.worker.ref();
      slot.worker.postMessage({ id, task: job.task });
    }
  }
  async close() {
    const slots = this.slots;
    this.slots = [];
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }
}

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { db, j, now } from '../../db/index.js';
import { bus } from '../../lib/bus.js';
import type { FileOp } from '../repo.js';

/** 交资料的记录：一次交的东西（intake）和其中每一份（item）。 */
export type IntakeStatus = 'uploading' | 'reading' | 'digesting' | 'paused' | 'done' | 'failed' | 'canceled';
export type ItemStatus = 'uploading' | 'waiting' | 'reading' | 'done' | 'same' | 'failed' | 'skipped';
export interface IntakeRow {
  id: number;
  kb_id: number;
  created_by: number;
  message: string | null;
  status: IntakeStatus;
  error: string | null;
  change_id: number | null;
  digest_change_id: number | null;
  plan: string | null;
  batch: number;
  checkpoint: string | null;
  resumes: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}
export interface ItemRow {
  id: number;
  intake_id: number;
  parent_id: number | null;
  depth: number;
  name: string;
  kind: string;
  size: number;
  received: number;
  hash: string | null;
  status: ItemStatus;
  retryable: number;
  reason: string | null;
  advice: string | null;
  progress: string | null;
  text_hash: string | null;
  method: string | null;
  notes: string | null;
  path: string | null;
  source_id: string | null;
  /** 交到长期库的资料里出现了哪些班的已登记学生：[{ kbId, name, count }] */
  students: string | null;
  created_at: number;
  updated_at: number;
}
export interface Checkpoint {
  baseSha: string | null;
  ops: FileOp[];
  notes: { title: string; reason: string }[];
}
export interface Batch {
  paths: string[];
}

export const stageDir = (intakeId?: number) => join(config.dataDir, '.intake', ...(intakeId ? [String(intakeId)] : []));
export const blobPath = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('资料指纹无效');
  return join(config.dataDir, 'sources', hash);
};

export function loadIntake(id: number): IntakeRow {
  const row = db.get<IntakeRow>('SELECT * FROM kb_intakes WHERE id=?', id);
  if (!row) throw new Error('交资料记录不存在');
  return row;
}
export function intakeItems(id: number): ItemRow[] {
  return db.all<ItemRow>('SELECT * FROM kb_intake_items WHERE intake_id=? ORDER BY id', id);
}
export function setIntake(id: number, data: Partial<Omit<IntakeRow, 'id'>>) {
  db.update('kb_intakes', id, { ...data, updated_at: now() });
}
export function setItem(id: number, data: Partial<Omit<ItemRow, 'id'>> & { progress?: string | null }) {
  db.update('kb_intake_items', id, { ...data, updated_at: now() });
}

/** 把临时文件按内容指纹存进原件库；同样的内容只存一份。 */
export async function storeFile(tmp: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(tmp)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  const digest = hash.digest('hex');
  const dest = blobPath(digest);
  mkdirSync(join(config.dataDir, 'sources'), { recursive: true });
  if (existsSync(dest)) rmSync(tmp, { force: true });
  else renameSync(tmp, dest);
  return digest;
}
export function storeText(text: string): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  const dest = blobPath(digest);
  mkdirSync(join(config.dataDir, 'sources'), { recursive: true });
  if (!existsSync(dest)) writeFileSync(dest, text, 'utf8');
  return digest;
}
export const readBlobText = (hash: string) => readFileSync(blobPath(hash), 'utf8');

/**
 * 这次交资料里用不着的原件从存储里删掉：读不了也没法再读的（视频、录音……）、跳过的、已经拆开的压缩包本体；
 * all 为真时（取消）这次收下的都算。原件库和知识库共用，知识库、读取缓存、其他还没结束的交资料在用的同一份内容不删；
 * 没读成但还能「接着读」的不删。不清理的话，演示老师反复交大文件会把共用的磁盘慢慢占满。
 */
export function releaseBlobs(intakeId: number, all = false) {
  const rows = db.all<{ hash: string }>(
    `SELECT DISTINCT hash FROM kb_intake_items WHERE intake_id=? AND hash IS NOT NULL AND NOT (status='failed' AND retryable=1)
       AND (${all ? '1=1' : "status IN ('failed','skipped') OR method='archive'"})`,
    intakeId,
  );
  for (const { hash } of rows) {
    const used = db.get(
      `SELECT 1 FROM kb_sources WHERE original_hash=? OR text_hash=?
       UNION ALL SELECT 1 FROM kb_conversions WHERE text_hash=?
       UNION ALL SELECT 1 FROM kb_intake_items i JOIN kb_intakes k ON k.id=i.intake_id
         WHERE i.hash=? AND i.intake_id<>? AND (k.status IN ('uploading','reading') OR (i.status='failed' AND i.retryable=1) OR (i.status IN ('waiting','reading','done') AND i.source_id IS NULL AND k.status<>'canceled'))
       LIMIT 1`,
      hash,
      hash,
      hash,
      hash,
      intakeId,
    );
    if (!used) rmSync(blobPath(hash), { force: true });
  }
}

const DOC_STATUSES: ItemStatus[] = ['uploading', 'waiting', 'reading', 'done', 'same', 'failed', 'skipped'];
export function publicItem(i: ItemRow) {
  return {
    id: i.id,
    parentId: i.parent_id,
    name: i.name,
    kind: i.kind,
    size: i.size,
    received: i.received,
    status: i.status,
    retryable: !!i.retryable,
    reason: i.reason,
    advice: i.advice,
    progress: j<{ done: number; total: number } | null>(i.progress, null),
    method: i.method,
    notes: j<string[]>(i.notes, []),
    path: i.path,
  };
}
export function publicIntake(row: IntakeRow, full = true) {
  const items = intakeItems(row.id);
  const counts = Object.fromEntries(DOC_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
  let size = 0,
    received = 0;
  for (const i of items) {
    if (i.method === 'archive') continue;
    counts[i.status]++;
  }
  for (const i of items)
    if (i.depth === 0) {
      size += i.size;
      received += i.received;
    }
  const plan = j<Batch[]>(row.plan, []);
  const reading = items.find((i) => i.status === 'reading' && i.method !== 'archive');
  // 资料很多时，列表只带需要老师留意的和前面一部分，展开时再取全部。
  const shown = full || items.length <= 60 ? items : [...items.filter((i) => i.status === 'failed' || i.status === 'reading'), ...items.filter((i) => i.status !== 'failed' && i.status !== 'reading').slice(0, 40)];
  return {
    id: row.id,
    kbId: row.kb_id,
    status: row.status,
    message: row.message,
    error: row.error,
    changeId: row.change_id,
    digestChangeId: row.digest_change_id,
    batch: row.batch,
    batches: plan.length,
    counts,
    total: items.filter((i) => i.method !== 'archive').length,
    upload: { size, received },
    current: reading ? { name: reading.name, progress: j<{ done: number; total: number } | null>(reading.progress, null) } : null,
    items: shown.map(publicItem),
    complete: shown.length === items.length,
    // 交到长期库、里面有学生信息的资料：卡片上不展开也看得到；班级封存了就不能再改交
    students: items
      .filter((i) => i.students && i.path)
      .map((i) => ({
        itemId: i.id,
        name: i.name,
        path: i.path,
        classes: j<{ kbId: number; name: string; count: number }[]>(i.students, []).map((c) => ({
          ...c,
          active: db.value<string>('SELECT status FROM knowledge_bases WHERE id=?', c.kbId) === 'active',
        })),
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

const lastSent = new Map<number, number>();
const timers = new Map<number, NodeJS.Timeout>();
/** 进度变化最多半秒推一次；状态变化立即推。 */
export function announce(intakeId: number, urgent = false) {
  const send = () => {
    timers.delete(intakeId);
    lastSent.set(intakeId, Date.now());
    const row = db.get<IntakeRow>('SELECT * FROM kb_intakes WHERE id=?', intakeId);
    if (row) bus.publish(`kb:${row.kb_id}`, 'intake', publicIntake(row, false));
  };
  const wait = 500 - (Date.now() - (lastSent.get(intakeId) || 0));
  if (urgent || wait <= 0) {
    clearTimeout(timers.get(intakeId));
    send();
  } else if (!timers.has(intakeId)) {
    const t = setTimeout(send, wait);
    t.unref();
    timers.set(intakeId, t);
  }
}

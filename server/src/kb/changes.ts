import { db, j, now } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { bad, conflict, notFound } from '../lib/http.js';
import { fileDiff, type FileDiff } from './diff.js';
import { checkOps, commitDiff, commitOps, hashText, readText, revertCommit, type Author, type FileOp } from './repo.js';

/**
 * 知识库的改动。整理助手提的改动先放着，老师确认了才写进仓库；
 * 老师自己改的、交的资料直接生效。每次生效都是一次 git 提交，提交信息里记着改动编号。
 */

export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'conflict' | 'reverted';
export type ChangeKind = 'teacher' | 'upload' | 'keeper' | 'tidy' | 'revert';

export interface ChangeRow {
  id: number;
  course_id: number;
  title: string;
  reason: string | null;
  author: string;
  author_name: string;
  kind: ChangeKind;
  status: ChangeStatus;
  ops: FileOp[];
  commit_sha: string | null;
  run_id: number | null;
  reverts: number | null;
  error: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: number | null;
}

export const KEEPER_AUTHOR: Author = { name: '整理助手', email: 'keeper@coteach.local' };
export const teacherAuthor = (u: { id: number; name: string }): Author => ({ name: u.name, email: `teacher-${u.id}@coteach.local` });

export function loadChange(id: number, courseId?: number): ChangeRow {
  const row = db.get<any>('SELECT * FROM kb_changes WHERE id = ?', id);
  if (!row || (courseId && row.course_id !== courseId)) throw notFound('这次改动不存在');
  return { ...row, ops: j(row.ops, []) };
}

function publish(courseId: number, id: number, status: ChangeStatus) {
  bus.publish(`kb:${courseId}`, 'change', { id, status });
  if (status === 'applied' || status === 'reverted') bus.publish(`kb:${courseId}`, 'tree', {});
}

const message = (c: { title: string; reason: string | null }, id: number) => `${c.title}\n\n${c.reason || ''}\n\nCoTeach-Change: ${id}`.replace(/\n{3,}/g, '\n\n');

/** 只是挪文件、改目录的改动算纯整理，直接生效；动了内容的都要老师确认 */
export function isTidy(courseId: number, ops: FileOp[]): boolean {
  const removed = new Map<string, number>();
  for (const op of ops) {
    if (op.content !== null) continue;
    const before = readText(courseId, op.path);
    if (before === null) return false;
    const h = hashText(before);
    removed.set(h, (removed.get(h) || 0) + 1);
  }
  for (const op of ops) {
    if (op.content === null || op.path === '目录.md') continue;
    const h = hashText(op.content);
    if (op.base !== null || !removed.get(h)) return false;
    removed.set(h, removed.get(h)! - 1);
  }
  return [...removed.values()].every(n => n === 0);
}

export async function createChange(d: {
  courseId: number;
  title: string;
  reason?: string | null;
  author: string;
  authorName: string;
  kind: ChangeKind;
  ops: FileOp[];
  runId?: number | null;
  /** 直接生效：老师自己的改动、纯整理 */
  apply?: { by: number | null; as: Author };
}): Promise<ChangeRow> {
  if (!d.ops.length) throw bad('没有要改的内容');
  const t = now();
  const id = db.insert('kb_changes', {
    course_id: d.courseId,
    title: d.title.slice(0, 120),
    reason: d.reason || null,
    author: d.author,
    author_name: d.authorName,
    kind: d.kind,
    status: 'pending',
    ops: d.ops,
    run_id: d.runId ?? null,
    created_at: t,
  });
  if (d.apply) {
    try {
      return await applyChange(d.courseId, id, d.apply.by, d.apply.as);
    } catch (err) {
      // 老师自己改没改成（内容过期），这次改动作废，不留在待确认里
      db.run('DELETE FROM kb_changes WHERE id = ?', id);
      publish(d.courseId, id, 'rejected');
      throw err;
    }
  }
  publish(d.courseId, id, 'pending');
  return loadChange(id);
}

export async function applyChange(courseId: number, id: number, by: number | null, as: Author): Promise<ChangeRow> {
  const c = loadChange(id, courseId);
  if (c.status !== 'pending' && c.status !== 'conflict') throw conflict('这次改动已经处理过了');
  try {
    const author = c.author === 'keeper' ? KEEPER_AUTHOR : as;
    const sha = await commitOps(courseId, c.ops, message(c, id), author, as);
    db.update('kb_changes', id, { status: 'applied', commit_sha: sha, error: null, decided_at: now(), decided_by: by });
    publish(courseId, id, 'applied');
  } catch (err) {
    db.update('kb_changes', id, { status: 'conflict', error: (err as Error).message });
    publish(courseId, id, 'conflict');
    throw err;
  }
  return loadChange(id);
}

export function rejectChange(courseId: number, id: number, by: number): ChangeRow {
  const c = loadChange(id, courseId);
  if (c.status !== 'pending' && c.status !== 'conflict') throw conflict('这次改动已经处理过了');
  db.update('kb_changes', id, { status: 'rejected', decided_at: now(), decided_by: by });
  publish(courseId, id, 'rejected');
  return loadChange(id);
}

/** 撤回已经生效的改动：git 生成反向提交，记成一次新的改动 */
export async function revertChange(courseId: number, id: number, by: { id: number; name: string }): Promise<ChangeRow> {
  const c = loadChange(id, courseId);
  if (c.status !== 'applied' || !c.commit_sha) throw conflict('只有已经生效的改动才能撤回');
  const t = now();
  const rid = db.insert('kb_changes', {
    course_id: courseId,
    title: `撤回：${c.title}`.slice(0, 120),
    reason: null,
    author: 'teacher',
    author_name: by.name,
    kind: 'revert',
    status: 'pending',
    ops: [],
    reverts: id,
    created_at: t,
  });
  try {
    const sha = await revertCommit(courseId, c.commit_sha, message({ title: `撤回：${c.title}`, reason: null }, rid), teacherAuthor(by));
    db.update('kb_changes', rid, { status: 'applied', commit_sha: sha, decided_at: now(), decided_by: by.id });
    db.update('kb_changes', id, { status: 'reverted' });
    publish(courseId, id, 'reverted');
    publish(courseId, rid, 'applied');
  } catch (err) {
    db.run('DELETE FROM kb_changes WHERE id = ?', rid);
    throw err;
  }
  return loadChange(rid);
}

/** 改动的对比：待确认的拿现在的文件比，已生效的看那次提交 */
export async function changeDiff(c: ChangeRow): Promise<{ files: FileDiff[]; stale: string[] }> {
  if (c.commit_sha) return { files: await commitDiff(c.course_id, c.commit_sha), stale: [] };
  const files = c.ops.map(op => fileDiff(op.path, readText(c.course_id, op.path), op.content));
  const stale = c.status === 'pending' || c.status === 'conflict' ? checkOps(c.course_id, c.ops) : [];
  return { files, stale };
}

export function publicChange(c: ChangeRow) {
  return {
    id: c.id,
    title: c.title,
    reason: c.reason,
    author: c.author,
    authorName: c.author_name,
    kind: c.kind,
    status: c.status,
    files: c.ops.map(op => ({ path: op.path, deleted: op.content === null, added: op.base === null && op.content !== null })),
    commit: c.commit_sha,
    runId: c.run_id,
    reverts: c.reverts,
    error: c.error,
    createdAt: c.created_at,
    decidedAt: c.decided_at,
  };
}

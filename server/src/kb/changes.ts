import { db, j, now } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { bad, conflict, notFound, HttpError } from '../lib/http.js';
import { checkIdentity, loadKb, writableKb } from './access.js';
import { fileDiff, type FileDiff } from './diff.js';
import {
  checkOps,
  commitDiff,
  hashText,
  hashBytes,
  readBinary,
  gitAt,
  archiveDir,
  isTextPath,
  isTextEntry,
  manifest,
  prepareCommit,
  publishCommit,
  readEntry,
  saveSource,
  sameEntryMetadata,
  settleRef,
  validateOps,
  withRepo,
  type Author,
  type FileOp,
} from './repo.js';

export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'conflict' | 'reverted';
export type ChangeKind = 'teacher' | 'upload' | 'keeper' | 'tidy' | 'revert';
export interface ChangeRow {
  id: number;
  kb_id: number;
  course_id: number | null;
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
  base_sha: string | null;
  request_key: string | null;
  commit_repo: 'legacy' | 'current';
}
export const KEEPER_AUTHOR: Author = {
  name: '整理助手',
  email: 'keeper@coteach.local',
};
export const teacherAuthor = (u: { id: number; name: string }): Author => ({
  name: u.name,
  email: `teacher-${u.id}@coteach.local`,
});
export function loadChange(id: number, kbId?: number): ChangeRow {
  const r = db.get<any>('SELECT * FROM kb_changes WHERE id=?', id);
  if (!r || (kbId !== undefined && r.kb_id !== kbId)) throw notFound('这次改动不存在');
  const prefix =
    r.commit_repo === 'legacy' ? db.get<any>('SELECT prefix FROM kb_imports WHERE course_id=?', r.course_id)?.prefix || '' : '';
  return {
    ...r,
    ops: j<FileOp[]>(r.ops, []).map((op) =>
      prefix
        ? {
            ...op,
            path: prefix + op.path,
            ...(op.from ? { from: prefix + op.from } : {}),
          }
        : op,
    ),
  };
}
function publish(kbId: number, id: number, status: ChangeStatus) {
  bus.publish(`kb:${kbId}`, 'change', { id, status });
  if (status === 'applied') {
    const change = loadChange(id, kbId);
    bus.publish(`kb:${kbId}`, 'tree', {
      operations: change.ops.map((op) => ({
        path: op.path,
        from: op.from,
        deleted: !op.from && op.content === null,
      })),
    });
  }
}
const message = (c: { title: string; reason: string | null }, id: number) => `${c.title}\n\n${c.reason || ''}\n\nCoTeach-Change: ${id}`;
/** 只认内容不变、权限不变的明确移动操作，目录文档不享有豁免。 */
export function isTidy(kbId: number, ops: FileOp[]): boolean {
  return ops.length > 0 && ops.every((op) => !!op.from && op.content === null && op.from !== op.path) && checkOps(kbId, ops).length === 0;
}
type Create = {
  kbId: number;
  title: string;
  reason?: string | null;
  author: string;
  authorName: string;
  kind: ChangeKind;
  ops: FileOp[];
  runId?: number | null;
  requestKey?: string;
  apply?: { by: number | null; as: Author };
  restore?: boolean;
};
export function checkMetadata(kbId: number, title: string, reason: string | null, ops: FileOp[]) {
  const entries = manifest(kbId);
  const original = (op: FileOp) => (op.from || op.base !== null ? entries.find((e) => e.path === (op.from || op.path)) : undefined);
  if (ops.every((op) => op.sourceId || original(op)?.sourceId)) return;
  const ids = new Set(ops.map((op) => original(op)?.studentId ?? op.studentId ?? null));
  try {
    checkIdentity(kbId, title + '\n' + (reason || ''), ids.size === 1 ? [...ids][0] : null);
  } catch (err) {
    // 记下是改动的标题和依据，整理助手才知道不是文件内容的问题
    if (err instanceof HttpError && err.code === 'student_identity') err.details = { ...err.details, field: '改动标题和依据' };
    throw err;
  }
}
function applyLocked(c: ChangeRow, by: number | null, as: Author, restore = false): ChangeRow {
  writableKb(c.kb_id);
  if (c.status === 'applied') return c;
  if (!['pending', 'conflict'].includes(c.status)) throw conflict('这次改动已经处理过了');
  validateOps(c.kb_id, c.ops, { sourceUpload: c.kind === 'upload', restore });
  if (c.kind !== 'upload') checkMetadata(c.kb_id, c.title, c.reason, c.ops);
  const base = loadKb(c.kb_id).head_sha;
  const { sha } = prepareCommit(c.kb_id, c.ops, message(c, c.id), c.author === 'keeper' ? KEEPER_AUTHOR : as, as);
  db.tx(() => {
    if (loadKb(c.kb_id).head_sha !== base) throw conflict('知识库刚有改动，再试一次');
    writableKb(c.kb_id);
    publishCommit(c.kb_id, sha);
    db.update('kb_changes', c.id, {
      status: 'applied',
      commit_sha: sha,
      commit_repo: 'current',
      ops: c.ops,
      base_sha: base,
      error: null,
      decided_at: now(),
      decided_by: by,
    });
    if (c.reverts) db.update('kb_changes', c.reverts, { status: 'reverted' });
  });
  // 已提交的数据以 SQLite 指针为准，ref 修复失败不能把成功的操作报告成失败。
  try {
    settleRef(c.kb_id);
  } catch (err) {
    console.error('[kb] ref will recover', c.kb_id, (err as Error).message);
  }
  publish(c.kb_id, c.id, 'applied');
  if (c.reverts) publish(c.kb_id, c.reverts, 'reverted');
  return loadChange(c.id);
}
export async function createChange(d: Create): Promise<ChangeRow> {
  return withRepo(d.kbId, async () => {
    writableKb(d.kbId);
    if (d.requestKey) {
      const old = db.get<{ id: number }>('SELECT id FROM kb_changes WHERE kb_id=? AND request_key=?', d.kbId, d.requestKey);
      if (old) return loadChange(old.id);
    }
    validateOps(d.kbId, d.ops, {
      sourceUpload: d.kind === 'upload',
      restore: d.restore,
    });
    if (d.kind !== 'upload') checkMetadata(d.kbId, d.title, d.reason || null, d.ops);
    const id = db.insert('kb_changes', {
      kb_id: d.kbId,
      course_id: null,
      title: d.title.slice(0, 120),
      reason: d.reason || null,
      author: d.author,
      author_name: d.authorName,
      kind: d.kind,
      status: 'pending',
      ops: d.ops,
      run_id: d.runId ?? null,
      created_at: now(),
      base_sha: loadKb(d.kbId).head_sha,
      request_key: d.requestKey || null,
    });
    if (d.apply) {
      try {
        return applyLocked(loadChange(id), d.apply.by, d.apply.as, !!d.restore);
      } catch (err) {
        db.update('kb_changes', id, {
          status: 'conflict',
          error: (err as Error).message,
        });
        throw err;
      }
    }
    publish(d.kbId, id, 'pending');
    return loadChange(id);
  });
}
export async function applyChange(kbId: number, id: number, by: number | null, as: Author): Promise<ChangeRow> {
  return withRepo(kbId, async () => {
    const c = loadChange(id, kbId);
    try {
      return applyLocked(c, by, as);
    } catch (err) {
      if (c.status === 'pending' || c.status === 'conflict') {
        db.update('kb_changes', id, {
          status: 'conflict',
          error: (err as Error).message,
        });
        publish(kbId, id, 'conflict');
      }
      throw err;
    }
  });
}
export function rejectChange(kbId: number, id: number, by: number): ChangeRow {
  writableKb(kbId);
  const c = loadChange(id, kbId);
  if (c.status === 'rejected') return c;
  if (!['pending', 'conflict'].includes(c.status)) throw conflict('这次改动已经处理过了');
  db.update('kb_changes', id, {
    status: 'rejected',
    decided_at: now(),
    decided_by: by,
  });
  publish(kbId, id, 'rejected');
  return loadChange(id);
}
/** 撤回一次已生效的改动：按 git 里改之前的样子再提交一次。老师点的记老师；整理助手照老师的话撤的记整理助手和那一轮 */
export async function revertChange(kbId: number, id: number, by: { id: number; name: string }, keeper?: { runId: number | null }): Promise<ChangeRow> {
  return withRepo(kbId, async () => {
    writableKb(kbId);
    const c = loadChange(id, kbId);
    if (c.status !== 'applied' || !c.commit_sha) throw conflict('只有已经生效的改动才能撤回');
    const current = manifest(kbId),
      ops: FileOp[] = [];
    if (c.commit_repo === 'legacy' && c.course_id) {
      for (const f of await commitDiff(kbId, c.commit_sha, c.course_id)) {
        const imp = db.get<any>('SELECT prefix FROM kb_imports WHERE course_id=?', c.course_id)!;
        const sourcePath = f.path.slice(imp.prefix.length),
          fromPath = (f.from || f.path).slice(imp.prefix.length);
        const before = f.status === 'added' ? null : gitAt(archiveDir(c.course_id), ['show', `${c.commit_sha}^:${fromPath}`]);
        const after = f.status === 'deleted' ? null : gitAt(archiveDir(c.course_id), ['show', `${c.commit_sha}:${sourcePath}`]);
        const e =
          current.find((e) => e.origin?.courseId === c.course_id && e.origin.path === sourcePath) || current.find((e) => e.path === f.path);
        const cur = e ? readBinary(kbId, e.path) : null;
        if (after === null ? cur !== null : cur === null || !after.equals(cur)) throw conflict('这次改动后内容又变了，不能直接撤回');
        if (f.status === 'renamed' && e && e.path !== f.path) throw conflict('文件后来又移动过，不能直接撤回这次移动');
        if (f.status === 'renamed' && before && after && before.equals(after)) {
          ops.push({
            from: e!.path,
            path: f.from!,
            content: null,
            base: hashBytes(cur!),
          });
          continue;
        }
        if (f.status === 'renamed' && e) ops.push({ path: e.path, content: null, base: hashBytes(cur!) });
        const op: FileOp = {
          path: f.status === 'renamed' ? f.from! : e?.path || f.path,
          content: before === null ? null : before.toString('utf8'),
          base: f.status === 'renamed' || cur === null ? null : hashBytes(cur),
          ...(e ? { entryId: e.id } : {}),
          origin: e?.origin || { courseId: c.course_id, path: sourcePath },
        };
        if ((e?.sourceId || sourcePath.startsWith('资料/') || f.binary) && before !== null) {
          op.sourceId = saveSource(kbId, f.path, before, isTextPath(f.path) ? before.toString('utf8') : '');
          op.sourcePart = isTextPath(f.path) ? 'text' : 'original';
        }
        ops.push(op);
      }
    } else {
      const before = manifest(kbId, c.base_sha),
        after = manifest(kbId, c.commit_sha);
      for (const fid of new Set([...before, ...after].map((e) => e.id))) {
        const a = before.find((e) => e.id === fid),
          b = after.find((e) => e.id === fid),
          cur = current.find((e) => e.id === fid);
        const av = a ? readEntry(kbId, a, c.base_sha) : null,
          bv = b ? readEntry(kbId, b, c.commit_sha) : null;
        if (a?.path === b?.path && av?.equals(bv || Buffer.alloc(0)) && sameEntryMetadata(a, b)) continue;
        const cv = cur ? readEntry(kbId, cur) : null;
        if (bv === null ? cv !== null : cv === null || !bv.equals(cv)) throw conflict('这次改动后内容又变了，不能直接撤回');
        if (b && cur && !sameEntryMetadata(b, cur)) throw conflict('原文件后来又更新了，不能直接撤回');
        if (a && b && a.path !== b.path) {
          if (cur?.path !== b.path) throw conflict('文件后来又移动过，不能直接撤回这次移动');
          ops.push({
            from: cur!.path,
            path: a.path,
            content: av!.equals(bv!) ? null : av!.toString('utf8'),
            base: hashBytes(cv!),
            baseEntryId: cur!.id,
            ...(a.sourceId ? { sourceId: a.sourceId, sourcePart: a.sourcePart } : {}),
          });
          continue;
        }
        const path = cur?.path || a!.path;
        ops.push({
          path,
          content: av?.toString('utf8') ?? null,
          base: cv === null ? null : hashBytes(cv),
          baseEntryId: cur?.id ?? null,
          entryId: fid,
          ...(a?.origin ? { origin: a.origin } : {}),
          ...(a?.studentId ? { studentId: a.studentId } : {}),
          ...(a?.sourceId ? { sourceId: a.sourceId, sourcePart: a.sourcePart } : {}),
        });
      }
    }
    if (!ops.length) throw bad('没有可以撤回的内容');
    validateOps(kbId, ops, { restore: true });
    const rid = db.insert('kb_changes', {
      kb_id: kbId,
      course_id: null,
      title: `撤回：${c.title}`.slice(0, 120),
      author: keeper ? 'keeper' : 'teacher',
      author_name: keeper ? KEEPER_AUTHOR.name : by.name,
      kind: 'revert',
      status: 'pending',
      ops,
      reverts: id,
      ...(keeper ? { run_id: keeper.runId } : {}),
      created_at: now(),
    });
    try {
      return applyLocked(loadChange(rid), keeper ? null : by.id, keeper ? KEEPER_AUTHOR : teacherAuthor(by), true);
    } catch (err) {
      db.update('kb_changes', rid, {
        status: 'conflict',
        error: (err as Error).message,
      });
      throw err;
    }
  });
}
export async function changeDiff(c: ChangeRow): Promise<{ files: FileDiff[]; stale: string[] }> {
  if (c.commit_sha)
    return {
      files: await commitDiff(c.kb_id, c.commit_sha, c.commit_repo === 'legacy' ? c.course_id : null),
      stale: [],
    };
  return {
    files: c.ops.map((op) => {
      const entry = op.from || op.base !== null ? manifest(c.kb_id, c.base_sha).find((e) => e.path === (op.from || op.path)) : undefined;
      const binary = !!entry && !isTextEntry(entry);
      const before = entry && !binary ? readEntry(c.kb_id, entry, c.base_sha).toString('utf8') : null;
      const after = binary ? null : op.from && op.content === null ? before : op.content;
      return fileDiff(op.path, before, after, {
        ...(op.from ? { status: 'renamed', from: op.from } : binary ? { status: op.content === null ? 'deleted' : 'modified' } : {}),
        ...(binary ? { binary: true } : {}),
      });
    }),
    stale: ['pending', 'conflict'].includes(c.status) ? checkOps(c.kb_id, c.ops) : [],
  };
}
/**
 * 整理助手一次动了好几个知识库，或者新建、挪动过知识库时，每个库那份改动的标题只说改了几份：
 * 那些新建、挪动已经生效，标题照它的总结写，老师会以为点「不要」能一起撤掉。
 * 以前这种标题列文件名，好几个学生交的都叫「作业2」，列出来像重复、数也对不上；
 * 那时存下的标题，读出来时也换成这个说法。
 */
export const countTitle = (files: number) => `改了 ${files} 份`;
const LISTED = /^改了「[^」]*」(?:、「[^」]*」)+(?: 等 \d+ 份)?$/;
export const shownTitle = (title: string, files: number) => (LISTED.test(title) ? countTitle(files) : title);

export function publicChange(c: ChangeRow) {
  const source = c.run_id
    ? db.get<any>(
        'SELECT k.id AS kbId,k.name,k.term FROM kb_runs r JOIN knowledge_bases k ON k.id=r.source_kb_id JOIN knowledge_bases target ON target.id=? WHERE r.id=? AND k.teacher_id=target.teacher_id',
        c.kb_id,
        c.run_id,
      )
    : null;
  return {
    id: c.id,
    title: shownTitle(c.title, c.ops.length),
    reason: c.reason,
    source: source || null,
    author: c.author,
    authorName: c.author_name,
    kind: c.kind,
    status: c.status === 'rejected' && c.decided_by === null && c.error?.includes('学期封存') ? 'canceled' : c.status,
    files: c.ops.map((op) => ({
      path: op.path,
      from: op.from,
      deleted: !op.from && op.content === null,
      added: op.base === null && op.content !== null,
    })),
    commit: c.commit_sha,
    runId: c.run_id,
    reverts: c.reverts,
    error: c.error,
    createdAt: c.created_at,
    decidedAt: c.decided_at,
  };
}

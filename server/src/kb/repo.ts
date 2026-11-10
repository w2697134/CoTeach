import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { bad, conflict, notFound, HttpError } from '../lib/http.js';
import { checkIdentity, loadKb, writableKb, registerSourceIdentities } from './access.js';
import { fileDiff, type FileDiff } from './diff.js';

export interface Entry {
  id: string;
  path: string;
  studentId?: number;
  sourceId?: string;
  sourcePart?: 'original' | 'text';
  origin?: { courseId: number; path: string };
}
export interface TreeFile extends Entry {
  text: boolean;
  protected: boolean;
}
export const sameEntryMetadata = (a?: Entry, b?: Entry) => a?.sourceId === b?.sourceId && a?.sourcePart === b?.sourcePart && a?.studentId === b?.studentId;
export interface Author {
  name: string;
  email: string;
}
export type FileOp = {
  path: string;
  content: string | null;
  base: string | null;
  /** 原条目身份；null 表示新文件，undefined 兼容迁移前记录。 */
  baseEntryId?: string | null;
  from?: string;
  studentId?: number;
  sourceId?: string;
  sourcePart?: 'original' | 'text';
  entryId?: string;
  origin?: Entry['origin'];
};
export interface CommitInfo {
  sha: string;
  author: string;
  email: string;
  committer: string;
  time: number;
  title: string;
  body: string;
  changeId: number | null;
  files: { status: string; path: string; from?: string }[];
  courseId?: number;
}
const MANIFEST = '.coteach.json';
export const repoDir = (id: number) => join(config.dataDir, 'knowledge', String(id));
export const archiveDir = (id: number) => join(config.dataDir, 'archives', String(id));
const locks = new Map<number, Promise<unknown>>();
export function withRepo<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(id, tail);
  void tail.finally(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return next;
}
export const hashText = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hashBytes = (s: Buffer | string) => createHash('sha256').update(s).digest('hex');
export const isTextPath = (s: string) => /\.(md|markdown|txt|py|c|cpp|h|java|js|ts|sql|go|json|csv)$/i.test(s);
export function isTextEntry(entry: Entry): boolean {
  if (entry.sourceId) {
    if (entry.sourcePart === 'text') return true;
    const source = db.get<{ name: string }>('SELECT name FROM kb_sources WHERE id=?', entry.sourceId);
    return !!source && isTextPath(source.name);
  }
  return isTextPath(entry.path);
}
export function cleanPath(value: string): string {
  const p = String(value || '')
    .replace(/\\/g, '/')
    .trim();
  if (
    !p ||
    p.length > 200 ||
    /[\x00-\x1f\x7f:*?"<>|]/.test(p) ||
    p.startsWith('/') ||
    p.split('/').some((s) => !s || s.startsWith('.') || /[ .]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))
  )
    throw bad('文件名或目录不合适，不能包含隐藏路径或上级目录');
  return p;
}
export function gitAt(dir: string, args: string[], input?: Buffer | string, env: NodeJS.ProcessEnv = {}): Buffer {
  return execFileSync(
    config.gitBin,
    [
      '-c',
      `safe.directory=${dir.replace(/\\/g, '/')}`,
      '-c',
      'core.quotepath=off',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.ignorecase=false',
      '-c',
      'core.hooksPath=',
      '-C',
      dir,
      ...args,
    ],
    {
      input,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}
export async function git(id: number, args: string[]): Promise<string> {
  return gitAt(repoDir(id), args).toString('utf8');
}
// 同一个版本的清单不会变，按版本记下原文，翻目录、打开每一页不用每次都起一次 git；每次都重新解析，调用方改了也不影响
const manifestCache = new Map<string, string>();
export function manifest(id: number, sha?: string | null): Entry[] {
  const rev = sha === undefined ? loadKb(id).head_sha : sha;
  if (!rev) return [];
  const key = `${id}:${rev}`;
  let text = manifestCache.get(key);
  if (text === undefined) {
    text = gitAt(repoDir(id), ['show', `${rev}:${MANIFEST}`]).toString('utf8');
    if (/^[0-9a-f]{40,64}$/.test(rev)) {
      manifestCache.set(key, text);
      if (manifestCache.size > 200) manifestCache.delete(manifestCache.keys().next().value!);
    }
  }
  return JSON.parse(text) as Entry[];
}
function entryAt(id: number, path: string, sha?: string | null) {
  return manifest(id, sha).find((e) => e.path === cleanPath(path));
}
export function sourceBytes(sourceId: string, part: 'original' | 'text' = 'text'): Buffer {
  const s = db.get<any>('SELECT * FROM kb_sources WHERE id=?', sourceId);
  if (!s) throw notFound('原始资料不存在');
  const hash = part === 'original' ? s.original_hash : s.text_hash;
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('原始资料指纹无效');
  const buf = readFileSync(join(config.dataDir, 'sources', hash));
  if (hashBytes(buf) !== hash) throw new Error('原始资料校验失败，已停止读取');
  return buf;
}
export function readEntry(id: number, e: Entry, sha?: string | null): Buffer {
  if (e.sourceId) return sourceBytes(e.sourceId, e.sourcePart);
  const rev = sha === undefined ? loadKb(id).head_sha : sha;
  if (!rev) throw notFound();
  return gitAt(repoDir(id), ['show', `${rev}:${e.path}`]);
}
export function readBinary(id: number, path: string, sha?: string | null): Buffer | null {
  const e = entryAt(id, path, sha);
  return e ? readEntry(id, e, sha) : null;
}
export function readText(id: number, path: string, sha?: string | null): string | null {
  const b = readBinary(id, path, sha);
  return b === null ? null : b.toString('utf8');
}
export async function listFiles(id: number): Promise<TreeFile[]> {
  return manifest(id).map((e) => ({ ...e, text: isTextEntry(e), protected: !!e.sourceId }));
}
export function saveSource(id: number, name: string, original: Buffer, text: string, sourceClass: string | null = null): string {
  const originalHash = hashBytes(original),
    textHash = hashBytes(text),
    dir = join(config.dataDir, 'sources');
  mkdirSync(dir, { recursive: true });
  for (const [hash, content] of [
    [originalHash, original],
    [textHash, Buffer.from(text)],
  ] as const) {
    const p = join(dir, hash);
    if (!existsSync(p)) writeFileSync(p, content, { flag: 'wx' });
    else if (hashBytes(readFileSync(p)) !== hash) throw new Error('原始资料存储校验失败');
  }
  const sid = randomUUID();
  db.insert('kb_sources', {
    id: sid,
    kb_id: id,
    name,
    original_hash: originalHash,
    text_hash: textHash,
    source_class: sourceClass,
    term: null,
    created_at: now(),
  });
  registerSourceIdentities(id, text, sid);
  return sid;
}
/** 原件已按内容指纹收好（交资料时边收边存）时，只存转换文字并登记来源。 */
export function addSource(
  id: number,
  d: { name: string; originalHash: string; text: string; kind?: string | null; method?: string | null; notes?: string[] | null },
): string {
  const dir = join(config.dataDir, 'sources');
  if (!/^[a-f0-9]{64}$/.test(d.originalHash) || !existsSync(join(dir, d.originalHash))) throw new Error('原件不在存储里');
  const textHash = hashBytes(d.text);
  const p = join(dir, textHash);
  if (!existsSync(p)) writeFileSync(p, d.text, { flag: 'wx' });
  else if (hashBytes(readFileSync(p)) !== textHash) throw new Error('原始资料存储校验失败');
  const sid = randomUUID();
  db.insert('kb_sources', {
    id: sid,
    kb_id: id,
    name: d.name,
    original_hash: d.originalHash,
    text_hash: textHash,
    source_class: null,
    term: null,
    kind: d.kind ?? null,
    method: d.method ?? null,
    notes: d.notes?.length ? d.notes : null,
    created_at: now(),
  });
  registerSourceIdentities(id, d.text, sid);
  return sid;
}
export function checkOps(id: number, ops: FileOp[]): string[] {
  const entries = manifest(id);
  const vacated = new Set(ops.filter((op) => op.from || op.content === null).map((op) => op.from || op.path));
  return ops
    .filter((op) => {
      const path = op.from || op.path;
      const e = entries.find((e) => e.path === path);
      // 新建文件可以占用本次明确腾出的路径，但不能把原文件当成新文件覆盖。
      if (!op.from && op.base === null) return (!!e && !vacated.has(path)) || op.baseEntryId != null;
      if (op.baseEntryId !== undefined && e?.id !== op.baseEntryId) return true;
      const b = e ? readEntry(id, e) : null;
      const fingerprint =
        b === null ? null : op.base?.length === 40 ? createHash('sha1').update(b.toString('utf8')).digest('hex') : hashBytes(b);
      return fingerprint !== op.base;
    })
    .map((op) => op.from || op.path);
}
export function validateOps(id: number, ops: FileOp[], opts: { sourceUpload?: boolean; restore?: boolean } = {}) {
  writableKb(id);
  if (!ops.length) throw bad('没有要改的内容');
  const entries = manifest(id),
    touched = new Set<string>(),
    targets: string[] = [];
  if (checkOps(id, ops).length) throw conflict('内容已被更新，请重新打开后再修改');
  for (const op of ops) {
    const p = cleanPath(op.path);
    if (p !== op.path || (op.from !== undefined && cleanPath(op.from) !== op.from))
      throw bad('文件名或目录不合适，不能包含隐藏路径或上级目录');
    if (op.from === p) throw bad('目标位置与原位置相同');
    const old = op.from || op.base !== null ? entries.find((e) => e.path === (op.from || p)) : undefined;
    if (op.from && !old) throw notFound('要移动的文件不存在');
    if (!op.from && op.content === null && !old) throw notFound('文件不存在');
    if (old) {
      if (touched.has(old.id)) throw bad('同一次改动中有重复文件');
      touched.add(old.id);
    }
    if (op.from || op.content !== null) targets.push(p);
    if (old?.sourceId && op.content !== null && !opts.sourceUpload && !opts.restore)
      throw bad('原件和转换文字不能改写，请上传新版本或另写一份笔记');
    if (op.sourceId) {
      if (!opts.sourceUpload && !opts.restore) throw bad('不能自行指定原件');
      const s = db.get<any>('SELECT kb_id FROM kb_sources WHERE id=?', op.sourceId);
      if (!s || s.kb_id !== id) throw bad('原件不属于这个知识库');
    }
    if (op.entryId && !opts.restore && !opts.sourceUpload && old && op.entryId !== old.id) throw bad('不能改变文件身份');
    if (old && op.studentId !== undefined && old.studentId !== op.studentId) throw bad('不能通过移动或编辑改变个人记录的归属');
    if (!op.sourceId && !old?.sourceId) {
      try {
        checkIdentity(id, p, old?.studentId ?? op.studentId);
        if (op.content !== null) checkIdentity(id, op.content, old?.studentId ?? op.studentId);
      } catch (err) {
        // 记下是哪份文件：整理助手据此知道该改哪里
        if (err instanceof HttpError && err.code === 'student_identity') err.details = { ...err.details, path: p };
        throw err;
      }
      if (op.content !== null && !isTextPath(p)) throw bad('只能新建或编辑文字文件');
    }
  }
  const finalPaths = entries
    .filter((e) => !touched.has(e.id))
    .map((e) => e.path)
    .concat(targets)
    .map((p) => p.toLocaleLowerCase());
  if (new Set(finalPaths).size !== finalPaths.length) throw conflict('目标位置已有同名文件');
  for (const p of finalPaths) if (finalPaths.some((q) => q !== p && q.startsWith(p + '/'))) throw conflict('文件与目录的位置冲突');
  const finalIds = entries
    .filter((e) => !touched.has(e.id))
    .map((e) => e.id)
    .concat(
      ops
        .filter((op) => op.from || op.content !== null)
        .map((op) => {
          const old = op.from || op.base !== null ? entries.find((e) => e.path === (op.from || op.path)) : undefined;
          return old?.id || op.entryId;
        })
        .filter((id): id is string => !!id),
    );
  if (new Set(finalIds).size !== finalIds.length) throw bad('不能改变文件身份');
}

/** 独立索引生成不可变提交；数据库发布指针是唯一生效点，不读取正在写入的工作区。 */
export function prepareCommit(
  id: number,
  ops: FileOp[],
  message: string,
  author: Author,
  committer = author,
  options: {
    initialEntries?: Entry[];
    initialFiles?: Map<string, Buffer>;
  } = {},
): { sha: string; entries: Entry[] } {
  const kb = loadKb(id),
    dir = repoDir(id);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'HEAD'))) gitAt(dir, ['init', '--bare', '-q']);
  const indexDir = join(config.dataDir, '.indexes');
  mkdirSync(indexDir, { recursive: true });
  const index = join(indexDir, randomUUID()),
    env = { GIT_INDEX_FILE: index };
  let entries = options.initialEntries ? [...options.initialEntries] : manifest(id);
  try {
    gitAt(dir, kb.head_sha ? ['read-tree', kb.head_sha] : ['read-tree', '--empty'], undefined, env);
    const write = (p: string, b: Buffer | string) => {
      const h = gitAt(dir, ['hash-object', '-w', '--stdin'], b).toString().trim();
      gitAt(dir, ['update-index', '--add', '--cacheinfo', `100644,${h},${p}`], undefined, env);
    };
    const remove = (p: string) => gitAt(dir, ['update-index', '-z', '--index-info'], `0 ${'0'.repeat(40)}\t${p}\0`, env);
    if (options.initialFiles) for (const [p, b] of options.initialFiles) write(p, b);
    const bound = ops.map((op) => ({
      op,
      old: op.from || op.base !== null ? entries.find((e) => e.path === (op.from || op.path)) : undefined,
    }));
    // 所有来源都从同一个已发布快照绑定，先腾空再写目标，交换路径不会覆盖来源。
    const removed = new Set(bound.flatMap(({ old }) => (old ? [old.id] : [])));
    for (const { old } of bound) if (old && !old.sourceId) remove(old.path);
    entries = entries.filter((e) => !removed.has(e.id));
    for (const { op, old } of bound) {
      if (!op.from && op.content === null) continue;
      if (op.from && !old) throw notFound();
      const entry: Entry = {
        ...(old || {}),
        id: old?.id || op.entryId || randomUUID(),
        path: op.path,
      };
      if (op.studentId !== undefined) entry.studentId = op.studentId;
      if (op.origin) entry.origin = op.origin;
      if (op.sourceId) {
        entry.sourceId = op.sourceId;
        entry.sourcePart = op.sourcePart || 'text';
      } else if (old?.sourceId && op.from) {
        // 原件移动只改引用位置，不能改变保护状态。
      } else {
        delete entry.sourceId;
        delete entry.sourcePart;
        write(op.path, op.content === null ? readEntry(id, old!, kb.head_sha) : op.content);
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
    write(MANIFEST, JSON.stringify(entries));
    const tree = gitAt(dir, ['write-tree'], undefined, env).toString().trim();
    const sha = gitAt(dir, ['commit-tree', tree, ...(kb.head_sha ? ['-p', kb.head_sha] : [])], message + '\n', {
      ...env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    })
      .toString()
      .trim();
    gitAt(dir, ['update-ref', 'refs/heads/prepared', sha]);
    return { sha, entries };
  } finally {
    rmSync(index, { force: true });
    rmSync(index + '.lock', { force: true });
  }
}
export function publishCommit(id: number, sha: string) {
  db.update('knowledge_bases', id, { head_sha: sha });
}
export function settleRef(id: number) {
  const sha = loadKb(id).head_sha;
  if (sha) {
    gitAt(repoDir(id), ['update-ref', 'refs/heads/main', sha]);
    gitAt(repoDir(id), ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  gitAt(repoDir(id), ['update-ref', '-d', 'refs/heads/prepared']);
}
export async function createKnowledgeBase(d: { teacherId: number; name: string; className?: string; term?: string }): Promise<number> {
  if (d.className && !d.term?.trim()) throw bad('请填写学期');
  const id = db.insert('knowledge_bases', {
    teacher_id: d.teacherId,
    kind: d.className ? 'class' : 'teacher',
    name: d.name,
    class_name: d.className || null,
    term: d.term || null,
    status: 'active',
    created_at: now(),
  });
  try {
    const { sha } = prepareCommit(id, [], '建立知识库', {
      name: 'CoTeach',
      email: 'system@coteach.local',
    });
    publishCommit(id, sha);
    settleRef(id);
    return id;
  } catch (err) {
    db.run('DELETE FROM knowledge_bases WHERE id=?', id);
    throw err;
  }
}
/** 老师最早建的那个知识库，一个都没有就建一个；登录后先打开它 */
export async function ensureTeacherKb(teacherId: number, _name?: string): Promise<number> {
  return (
    db.value<number>("SELECT id FROM knowledge_bases WHERE teacher_id=? AND kind='teacher' AND deleted_at IS NULL ORDER BY id LIMIT 1", teacherId) ??
    (await createKnowledgeBase({ teacherId, name: '我的知识库' }))
  );
}

const FIELD = '\x1f',
  REC = '\x1e';
function parseLog(out: string): CommitInfo[] {
  return out
    .split(REC)
    .map((s) => s.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [head, ...rest] = rec.split('\n' + FIELD + 'FILES\n'),
        [sha, author, email, committer, time, title, body] = head.split(FIELD);
      const files = (rest.join('') || '')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [s, a, b] = l.split('\t');
          return s.startsWith('R') ? { status: 'R', path: b, from: a } : { status: s[0], path: a };
        })
        .filter((f) => f.path !== MANIFEST);
      const m = (body || '').match(/CoTeach-Change:\s*(\d+)/);
      return {
        sha,
        author,
        email,
        committer,
        time: Number(time) * 1000,
        title,
        body: (body || '').replace(/\n*CoTeach-Change:\s*\d+\s*$/, '').trim(),
        changeId: m ? Number(m[1]) : null,
        files,
      };
    });
}
const LOG_FORMAT = `--format=${REC}%H${FIELD}%an${FIELD}%ae${FIELD}%cn${FIELD}%at${FIELD}%s${FIELD}%b%n${FIELD}FILES`;
export async function history(id: number, opts: { path?: string; limit?: number } = {}): Promise<CommitInfo[]> {
  const kb = loadKb(id),
    limit = opts.limit || 100,
    out: CommitInfo[] = [];
  if (kb.head_sha) {
    for (const c of parseLog(gitAt(repoDir(id), ['log', kb.head_sha, '-M', '--name-status', LOG_FORMAT, `-n${limit}`]).toString())) {
      const row = db.get<any>("SELECT id,ops FROM kb_changes WHERE kb_id=? AND commit_sha=? AND commit_repo='current'", id, c.sha);
      if (!row) continue; // 建库与迁移没有改写原文，不把程序标作内容作者。
      if (row) {
        c.changeId = row.id;
        c.files = (JSON.parse(row.ops) as FileOp[]).map((op) => ({
          status: op.from ? 'R' : op.content === null ? 'D' : op.base === null ? 'A' : 'M',
          path: op.path,
          ...(op.from ? { from: op.from } : {}),
        }));
      }
      if (!opts.path || c.files.some((f) => f.path === opts.path || f.from === opts.path)) out.push(c);
    }
  }
  const current = opts.path ? entryAt(id, opts.path) : null;
  for (const imp of db.all<any>('SELECT * FROM kb_imports WHERE kb_id=?', id)) {
    const origin = current?.origin;
    const path = opts.path
      ? origin && origin.courseId === imp.course_id
        ? origin.path
        : opts.path.startsWith(imp.prefix)
          ? opts.path.slice(imp.prefix.length)
          : null
      : null;
    if (opts.path && !path) continue;
    for (const c of parseLog(
      gitAt(archiveDir(imp.course_id), [
        'log',
        imp.source_head,
        '-M',
        '--name-status',
        LOG_FORMAT,
        `-n${limit}`,
        ...(path ? ['--follow', '--', path] : []),
      ]).toString(),
    )) {
      const row = db.get<any>('SELECT id FROM kb_changes WHERE kb_id=? AND course_id=? AND commit_sha=?', id, imp.course_id, c.sha);
      out.push({
        ...c,
        courseId: imp.course_id,
        changeId: row?.id ?? c.changeId,
        files: c.files.map((f) => ({
          ...f,
          path: imp.prefix + f.path,
          ...(f.from ? { from: imp.prefix + f.from } : {}),
        })),
      });
    }
  }
  return out.sort((a, b) => b.time - a.time).slice(0, limit);
}
export async function commitDiff(id: number, sha: string, courseId?: number | null): Promise<FileDiff[]> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw bad('版本编号无效');
  if (courseId) {
    const imp = db.get<any>('SELECT * FROM kb_imports WHERE course_id=? AND kb_id=?', courseId, id);
    if (!imp) throw notFound();
    const dir = archiveDir(courseId),
      parts = gitAt(dir, ['diff-tree', '-z', '-r', '-M', '--root', '--no-commit-id', '--name-status', sha]).toString().split('\0'),
      result: FileDiff[] = [];
    for (let i = 0; i < parts.length && parts[i];) {
      const code = parts[i++][0];
      let path = parts[i++],
        from: string | undefined;
      if (code === 'R') {
        from = path;
        path = parts[i++];
      }
      if (path.split('/').some((p) => p.startsWith('.'))) continue;
      const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
      if (!isTextPath(path)) {
        result.push(fileDiff(imp.prefix + path, null, null, { status, binary: true }));
        continue;
      }
      const before = code === 'A' ? null : gitAt(dir, ['show', `${sha}^:${from || path}`]).toString('utf8'),
        after = code === 'D' ? null : gitAt(dir, ['show', `${sha}:${path}`]).toString('utf8');
      result.push(
        fileDiff(imp.prefix + path, before, after, {
          status,
          ...(from ? { from: imp.prefix + from } : {}),
        }),
      );
    }
    return result;
  }
  const after = manifest(id, sha);
  let parent: string | null = null;
  try {
    parent = gitAt(repoDir(id), ['rev-parse', sha + '^'])
      .toString()
      .trim();
  } catch {}
  const before = manifest(id, parent),
    ids = new Set([...before, ...after].map((e) => e.id)),
    result: FileDiff[] = [];
  for (const fid of ids) {
    const a = before.find((e) => e.id === fid),
      b = after.find((e) => e.id === fid),
      av = a ? readEntry(id, a, parent) : null,
      bv = b ? readEntry(id, b, sha) : null;
    if (a?.path === b?.path && av?.equals(bv || Buffer.alloc(0)) && sameEntryMetadata(a, b)) continue;
    const path = (b || a)!.path,
      status = !a ? 'added' : !b ? 'deleted' : a.path !== b.path ? 'renamed' : 'modified',
      binary = !!((a && !isTextEntry(a)) || (b && !isTextEntry(b)));
    result.push(
      fileDiff(path, binary ? null : (av?.toString('utf8') ?? null), binary ? null : (bv?.toString('utf8') ?? null), {
        status,
        binary,
        ...(a && b && a.sourceId !== b.sourceId ? { sourceChanged: true } : {}),
        ...(a && b && a.path !== b.path ? { from: a.path } : {}),
      }),
    );
  }
  return result;
}

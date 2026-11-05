import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import { bad, conflict, HttpError } from '../lib/http.js';
import { fileDiff, type FileDiff } from './diff.js';

/**
 * 每门课的知识库是一个 git 仓库（data/kb/<课程 id>），正文是 Markdown 文件。
 * 改动都在仓库锁里做：写文件、git add、git commit，所以工作区始终和最新提交一致。
 */

export const FIXED_FILES = ['目录.md', '进度.md', '规矩.md'];
export const MATERIALS_DIR = '资料';
export const NOTES_DIR = '笔记';

const SKELETON: Record<string, string> = {
  '目录.md': '# 目录\n\n- 进度.md：课讲到哪了\n- 规矩.md：全课通用的规矩\n- 资料/：老师交的原件和转出来的文字\n- 笔记/：整理好的内容\n',
  '进度.md': '# 进度\n',
  '规矩.md': '# 规矩\n',
  '资料/.gitkeep': '',
  '笔记/.gitkeep': '',
};

export const repoDir = (courseId: number) => join(config.kbDir, String(courseId));

export const hashText = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex');

/* ---------------------------------------------------------------- 仓库锁 */
const locks = new Map<number, Promise<unknown>>();

/** 同一门课的仓库操作排队执行，避免两个改动同时写文件 */
export function withRepo<T>(courseId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(courseId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    courseId,
    next.catch(() => {}),
  );
  return next;
}

/* ---------------------------------------------------------------- git */
export function git(courseId: number, args: string[]): Promise<string> {
  const cwd = repoDir(courseId);
  return new Promise((resolvePromise, reject) => {
    execFile(
      config.gitBin,
      ['-c', 'core.quotepath=off', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'i18n.logOutputEncoding=utf-8', ...args],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(new Error(`git ${args[0]} 失败：${(stderr || err.message).trim()}`), { stderr, stdout }));
        else resolvePromise(stdout);
      },
    );
  });
}

export interface Author {
  name: string;
  email: string;
}

/**
 * 提交工作区里的全部改动，没有改动时返回 null。
 * 作者是写这些内容的人（整理助手或老师），提交人是让它生效的人（确认的老师）。
 */
async function commitAll(courseId: number, message: string, author: Author, committer: Author = author): Promise<string | null> {
  await git(courseId, ['add', '-A']);
  const staged = await git(courseId, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) return null;
  await git(courseId, [
    '-c',
    `user.name=${committer.name}`,
    '-c',
    `user.email=${committer.email}`,
    'commit',
    '-q',
    '--no-verify',
    `--author=${author.name} <${author.email}>`,
    '-m',
    message,
  ]);
  return (await git(courseId, ['rev-parse', 'HEAD'])).trim();
}

/* ---------------------------------------------------------------- 路径 */
/** 把前端或模型给的路径规范成仓库里的相对路径；越界、.git 一律拒绝 */
export function cleanPath(p: string): string {
  const s = String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
  if (!s || s.split('/').some(seg => seg === '..' || seg === '.' || seg === '') || s.startsWith('.git')) throw bad(`路径不对：${p}`);
  if (s.length > 200) throw bad('路径太长');
  return s;
}

function absPath(courseId: number, rel: string): string {
  const root = repoDir(courseId);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw bad('路径越界');
  return abs;
}

const TEXT_EXT = /\.(md|markdown|txt|py|c|cpp|h|java|js|ts|sql|go|json|csv)$/i;
export const isTextPath = (p: string) => TEXT_EXT.test(p);

/* ---------------------------------------------------------------- 读 */
export interface TreeFile {
  path: string;
  size: number;
  text: boolean;
}

export async function listFiles(courseId: number): Promise<TreeFile[]> {
  const out = await git(courseId, ['ls-files', '-z']);
  return out
    .split('\0')
    .filter(p => p && !p.split('/').pop()!.startsWith('.'))
    .map(path => {
      let size = 0;
      try {
        size = statSync(absPath(courseId, path)).size;
      } catch {
        /* 刚被删 */
      }
      return { path, size, text: isTextPath(path) };
    });
}

/** 读文字文件，不存在时返回 null */
export function readText(courseId: number, path: string): string | null {
  const abs = absPath(courseId, cleanPath(path));
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
  return readFileSync(abs, 'utf8');
}

export function readBinary(courseId: number, path: string): Buffer | null {
  const abs = absPath(courseId, cleanPath(path));
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
  return readFileSync(abs);
}

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
}

const SEP_FIELD = '\x1f';
const SEP_REC = '\x1e';

function parseLog(out: string): CommitInfo[] {
  return out
    .split(SEP_REC)
    .map(rec => rec.replace(/^\n+/, ''))
    .filter(Boolean)
    .map(rec => {
      const [head, ...rest] = rec.split('\n' + SEP_FIELD + 'FILES\n');
      const [sha, author, email, committer, time, title, body] = head.split(SEP_FIELD);
      const files = (rest.join('') || '')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [status, a, b] = line.split('\t');
          return status.startsWith('R') ? { status: 'R', path: b, from: a } : { status: status[0], path: a };
        });
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

const LOG_FORMAT = `--format=${SEP_REC}%H${SEP_FIELD}%an${SEP_FIELD}%ae${SEP_FIELD}%cn${SEP_FIELD}%at${SEP_FIELD}%s${SEP_FIELD}%b%n${SEP_FIELD}FILES`;

export async function history(courseId: number, opts: { path?: string; limit?: number } = {}): Promise<CommitInfo[]> {
  const args = ['log', '-M', '--name-status', LOG_FORMAT, `-n${opts.limit || 50}`];
  if (opts.path) args.push('--follow', '--', cleanPath(opts.path));
  return parseLog(await git(courseId, args));
}

/* ---------------------------------------------------------------- 写 */
export type FileOp = { path: string; content: string | null; base: string | null };

/**
 * 应用一组按文件的最终状态：content 为 null 表示删除。
 * base 是改动时这个文件内容的指纹（新文件为 null），和现在对不上说明别人先改过，拒绝应用。
 */
export function checkOps(courseId: number, ops: FileOp[]): string[] {
  const stale: string[] = [];
  for (const op of ops) {
    const cur = readText(courseId, op.path);
    const curHash = cur === null ? null : hashText(cur);
    if (curHash !== op.base) stale.push(op.path);
  }
  return stale;
}

function writeOps(courseId: number, ops: FileOp[]) {
  for (const op of ops) {
    const abs = absPath(courseId, cleanPath(op.path));
    if (op.content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, op.content, 'utf8');
    }
  }
}

export async function commitOps(courseId: number, ops: FileOp[], message: string, author: Author, committer: Author = author): Promise<string | null> {
  return withRepo(courseId, async () => {
    const stale = checkOps(courseId, ops);
    if (stale.length) throw conflict(`这些文件在这次改动之后又被改过：${stale.join('、')}`);
    writeOps(courseId, ops);
    try {
      return await commitAll(courseId, message, author, committer);
    } catch (err) {
      await git(courseId, ['reset', '-q', '--hard', 'HEAD']).catch(() => {});
      throw err;
    }
  });
}

/** 写入原样文件（老师交的资料原件可能是二进制） */
export async function commitFiles(courseId: number, files: { path: string; data: Buffer | string }[], message: string, author: Author) {
  return withRepo(courseId, async () => {
    for (const f of files) {
      const abs = absPath(courseId, cleanPath(f.path));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.data);
    }
    try {
      return await commitAll(courseId, message, author);
    } catch (err) {
      await git(courseId, ['reset', '-q', '--hard', 'HEAD']).catch(() => {});
      throw err;
    }
  });
}

/** 删除文件并提交（资料原件这类二进制文件用） */
export async function commitRemove(courseId: number, paths: string[], message: string, author: Author) {
  return withRepo(courseId, async () => {
    for (const p of paths) rmSync(absPath(courseId, cleanPath(p)), { force: true });
    try {
      return await commitAll(courseId, message, author);
    } catch (err) {
      await git(courseId, ['reset', '-q', '--hard', 'HEAD']).catch(() => {});
      throw err;
    }
  });
}

/** 撤回一次提交：生成一个反向的新提交，历史保留 */
export async function revertCommit(courseId: number, sha: string, message: string, author: Author): Promise<string | null> {
  return withRepo(courseId, async () => {
    try {
      await git(courseId, ['revert', '--no-edit', '--no-commit', sha]);
    } catch {
      await git(courseId, ['revert', '--abort']).catch(() => git(courseId, ['reset', '-q', '--hard', 'HEAD']));
      throw conflict('这次改动之后，同样的地方又被改过，没法直接撤回。可以让整理助手按现在的内容重新改。');
    }
    return commitAll(courseId, message, author);
  });
}

/** 一次提交改了哪些文件，每个文件给出改之前、改之后的全文 */
export async function commitDiff(courseId: number, sha: string): Promise<FileDiff[]> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw bad('提交编号不对');
  const out = await git(courseId, ['diff-tree', '-z', '-r', '-M', '--root', '--no-commit-id', '--name-status', sha]);
  const parts = out.split(' ');
  const entries: { status: FileDiff['status']; path: string; from?: string }[] = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const code = parts[i++][0];
    if (code === 'R') entries.push({ status: 'renamed', from: parts[i++], path: parts[i++] });
    else entries.push({ status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', path: parts[i++] });
  }
  const blob = (rev: string) => git(courseId, ['cat-file', 'blob', rev]);
  return Promise.all(
    entries
      .filter(e => !e.path.split('/').pop()!.startsWith('.'))
      .map(async ({ status, path, from }) => {
        const extra = from ? { status, from } : { status };
        if (!isTextPath(path)) return fileDiff(path, null, null, { ...extra, binary: true });
        const before = status === 'added' ? null : await blob(`${sha}^:${from ?? path}`);
        const after = status === 'deleted' ? null : await blob(`${sha}:${path}`);
        return fileDiff(path, before, after, extra);
      }),
  );
}

/* ---------------------------------------------------------------- 课程 */
export async function createCourse(d: { name: string; teacherId: number; teacherName: string; description?: string }): Promise<number> {
  const id = db.insert('courses', { name: d.name, description: d.description || null, teacher_id: d.teacherId, created_at: now() });
  const dir = repoDir(id);
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await git(id, ['init', '-q', '-b', 'main']);
    for (const [p, content] of Object.entries(SKELETON)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), content, 'utf8');
    }
    await commitAll(id, '建立知识库', { name: d.teacherName, email: `teacher-${d.teacherId}@coteach.local` });
  } catch (err) {
    db.run('DELETE FROM courses WHERE id = ?', id);
    throw new HttpError(500, `建立知识库失败：${(err as Error).message}`);
  }
  return id;
}

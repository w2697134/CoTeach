import { randomUUID } from 'node:crypto';
import { bad, conflict, notFound } from '../lib/http.js';
import { checkIdentity, loadKb, studentIn, writableKb } from './access.js';
import { cleanPath, hashBytes, isTextEntry, isTextPath, manifest, readEntry, type Entry, type FileOp } from './repo.js';

interface FileState {
  entry: Entry;
  original: boolean;
  path: string | null;
  content?: string;
}

/** 一次整理只读启动时的提交；暂存区按条目身份追踪移动、编辑和删除。 */
export class Workspace {
  readonly baseSha: string | null;
  /** 分批整理时，前几批已经暂存的改动；这一批是否另有改动以它为准 */
  carried: string | null = null;
  /** 这次已经直接改过知识库本身（新建、改名、挪走文件、删除），没有暂存改动也算做了事 */
  structural = false;
  private states = new Map<string, FileState>();
  private originals = new Map<string, Buffer>();
  constructor(
    readonly kbId: number,
    readonly readOnly = false,
    readonly includeSources = true,
    readonly studentId?: number,
    baseSha?: string | null,
  ) {
    this.baseSha = baseSha === undefined ? loadKb(kbId).head_sha : baseSha;
    for (const entry of manifest(kbId, this.baseSha)) this.states.set(entry.id, { entry, original: true, path: entry.path });
  }
  /**
   * 分批整理时，上一批暂存的改动按文件身份原样恢复（不重新校验路径，校验在最终提交时统一做）。
   * 每条改动的依据指纹必须和起点版本一致，对不上说明记录有误，直接拒绝。
   */
  static restore(kbId: number, baseSha: string | null, ops: FileOp[]): Workspace {
    const ws = new Workspace(kbId, false, true, undefined, baseSha);
    for (const op of ops) {
      if (op.baseEntryId) {
        const s = ws.states.get(op.baseEntryId);
        if (!s || hashBytes(ws.originalBytes(s)) !== op.base) throw conflict('暂存的整理记录和知识库对不上，请重新整理');
        if (!op.from && op.content === null) s.path = null;
        else {
          s.path = op.path;
          if (op.content !== null) s.content = op.content;
        }
      } else if (op.entryId && op.content !== null) {
        const entry: Entry = { id: op.entryId, path: op.path, ...(op.studentId !== undefined ? { studentId: op.studentId } : {}) };
        ws.states.set(entry.id, { entry, original: false, path: op.path, content: op.content });
      }
    }
    return ws;
  }
  private find(path: string) {
    return [...this.states.values()].find((s) => s.path === path);
  }
  private bytes(s: FileState) {
    return s.content === undefined ? this.originalBytes(s) : Buffer.from(s.content);
  }
  private originalBytes(s: FileState) {
    let bytes = this.originals.get(s.entry.id);
    if (!bytes) {
      bytes = readEntry(this.kbId, s.entry, this.baseSha);
      this.originals.set(s.entry.id, bytes);
    }
    return bytes;
  }
  private visible(s: FileState) {
    if (!this.includeSources && s.entry.sourceId) return false;
    if (this.studentId !== undefined) {
      if (s.entry.studentId !== undefined && s.entry.studentId !== this.studentId) return false;
      try {
        checkIdentity(this.kbId, s.path + '\n' + this.bytes(s).toString('utf8'), s.entry.studentId);
      } catch {
        return false;
      }
    }
    return true;
  }
  entry(path: string): Entry | null {
    const s = this.find(cleanPath(path));
    return s && this.visible(s) ? { ...s.entry, path: s.path! } : null;
  }
  read(path: string): string | null {
    const s = this.find(cleanPath(path));
    return s && this.visible(s) ? this.bytes(s).toString('utf8') : null;
  }
  /** 原样的字节（二进制原件用，按文字读会读坏） */
  bytesOf(path: string): Buffer | null {
    const s = this.find(cleanPath(path));
    return s && this.visible(s) ? this.bytes(s) : null;
  }
  private writable(s?: FileState) {
    if (this.readOnly) throw bad('来源档案只能读取');
    writableKb(this.kbId);
    if (s && this.studentId !== undefined && s.entry.studentId !== this.studentId) throw bad('本次只能更新指定学生的个人记录');
    if (s && !this.visible(s)) throw notFound('文件不存在');
  }
  write(path: string, content: string, studentId?: number) {
    path = cleanPath(path);
    const s = this.find(path);
    this.writable(s);
    if (!isTextPath(path)) throw bad('请使用文字文档');
    if (this.studentId !== undefined) {
      if (studentId !== undefined && studentId !== this.studentId) throw bad('不能改变本次任务的学生归属');
      studentId = this.studentId;
    }
    if (s?.entry.sourceId) throw bad('这是受保护的原件或转换文字，不能改写');
    if (s && studentId !== undefined && s.entry.studentId !== studentId) throw bad('不能改变个人记录的归属');
    if (studentId !== undefined) studentIn(this.kbId, studentId);
    const subject = s?.entry.studentId ?? studentId;
    checkIdentity(this.kbId, path + '\n' + content, subject);
    if (s) s.content = content;
    else {
      const entry: Entry = {
        id: randomUUID(),
        path,
        ...(subject !== undefined ? { studentId: subject } : {}),
      };
      this.states.set(entry.id, { entry, original: false, path, content });
    }
  }
  remove(path: string) {
    const s = this.find(cleanPath(path));
    this.writable(s);
    if (!s) throw notFound('文件不存在');
    if (s.original) s.path = null;
    else this.states.delete(s.entry.id);
  }
  move(from: string, to: string) {
    from = cleanPath(from);
    to = cleanPath(to);
    const s = this.find(from);
    this.writable(s);
    if (!s) throw notFound('文件不存在');
    if (from === to) throw bad('目标位置与原位置相同');
    if ([...this.states.values()].some((other) => other !== s && other.path?.toLocaleLowerCase() === to.toLocaleLowerCase()))
      throw conflict('目标位置已有文件');
    if (!s.entry.sourceId) checkIdentity(this.kbId, to, s.entry.studentId);
    s.path = to;
  }
  /** 这个文件（或文件夹里的文件）这次有没有还没提交的改动 */
  touched(path: string) {
    path = cleanPath(path);
    const under = (p: string | null) => !!p && (p === path || p.startsWith(path + '/'));
    return [...this.states.values()].some(
      (s) => (under(s.entry.path) || under(s.path)) && (!s.original || s.path !== s.entry.path || s.content !== undefined),
    );
  }
  /** 文件已经挪到别的知识库：这次不再看到它，提交时也不碰它 */
  forget(paths: string[]) {
    const gone = new Set(paths);
    for (const [id, s] of this.states) if (s.original && gone.has(s.entry.path)) this.states.delete(id);
  }
  async list() {
    return [...this.states.values()]
      .filter((s) => s.path !== null && this.visible(s))
      .map((s) => ({
        ...s.entry,
        path: s.path!,
        size: this.bytes(s).length,
        text: isTextEntry({ ...s.entry, path: s.path! }),
        protected: !!s.entry.sourceId,
        pending: !s.original || s.content !== undefined ? '待提交' : s.path !== s.entry.path ? '待移动' : '',
      }));
  }
  ops(): FileOp[] {
    const ops: FileOp[] = [];
    for (const s of this.states.values()) {
      if (s.original && s.path === s.entry.path && s.content === undefined) continue;
      const base = s.original ? this.originalBytes(s) : null;
      const binding = {
        base: base === null ? null : hashBytes(base),
        baseEntryId: s.original ? s.entry.id : null,
      };
      if (s.path === null) {
        ops.push({ path: s.entry.path, content: null, ...binding });
        continue;
      }
      const changed = s.content !== undefined && (base === null || !base.equals(Buffer.from(s.content)));
      if (!changed && s.path === s.entry.path) continue;
      ops.push({
        path: s.path,
        content: changed ? s.content! : null,
        ...binding,
        ...(s.original && s.path !== s.entry.path ? { from: s.entry.path } : {}),
        ...(s.original ? {} : { entryId: s.entry.id }),
        ...(s.entry.studentId !== undefined ? { studentId: s.entry.studentId } : {}),
      });
    }
    return ops;
  }
}

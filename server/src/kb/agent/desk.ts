/**
 * 老师的桌面：老师所有的知识库摆在一个目录里，一个知识库一个文件夹（像电脑里的 C 盘、D 盘），
 * 整理助手（Claude Code）就在这个目录里干活。
 *
 * 每个知识库背后照旧是一个 Workspace（按文件身份记移动、编辑、删除，原件受保护）。
 * 整理助手用自带工具直接读写文件；挪、删、动知识库本身走 ct 命令，那时同时改文件夹和 Workspace。
 * 提交时把文件夹和 Workspace 对一遍（sync），变成每个知识库各一份改动，校验照旧由 Workspace 和改动记录把关。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { bad, notFound } from '../../lib/http.js';
import { loadKb, type KnowledgeBase } from '../access.js';
import { listKbs } from '../bases.js';
import { cleanPath, type FileOp } from '../repo.js';
import { Workspace } from '../workspace.js';

export interface SpaceState {
  kbId: number;
  baseSha: string | null;
  ops: FileOp[];
}

export const agentDir = (teacherId: number) => join(config.dataDir, 'agent', String(teacherId));

/** 知识库的名字当文件夹名：系统不允许的字符换成相近的全角字符 */
function folderName(name: string) {
  const s = name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, (c) => ({ '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' })[c]!)
    .replace(/^\.+/, '')
    .replace(/[ .]+$/, '')
    .trim();
  return s || '未命名知识库';
}

/** 只读的原件先放开再动（Windows 上只读文件删不掉） */
function loosen(path: string) {
  try {
    chmodSync(path, 0o644);
  } catch {
    /* 没有这个文件 */
  }
}

/** 整个目录删掉：里面的只读原件先放开 */
export function wipe(dir: string) {
  if (!existsSync(dir)) return;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else loosen(p);
    }
  };
  walk(dir);
  rmSync(dir, { recursive: true, force: true });
}

function filesUnder(dir: string, base = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name),
      rel = base ? `${base}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, rel));
    else out.push(rel);
  }
  return out;
}

export class Desk {
  readonly root: string;
  /** 知识库编号 → 文件夹名 */
  readonly folders = new Map<number, string>();
  readonly spaces = new Map<number, Workspace>();
  /** 这次直接动过知识库本身（新建、改名、跨库挪、删除），没有暂存改动也算做了事 */
  structural = false;

  private constructor(readonly teacherId: number) {
    this.root = join(agentDir(teacherId), 'work');
  }

  /** 摆好桌面：每个知识库按现在的样子写成文件；分批整理时按上一批暂存的样子恢复 */
  static async open(teacherId: number, restore: SpaceState[] = []): Promise<Desk> {
    const desk = new Desk(teacherId);
    wipe(desk.root);
    mkdirSync(desk.root, { recursive: true });
    const restored = new Map(restore.map((s) => [s.kbId, s]));
    for (const kb of listKbs(teacherId).filter((k) => k.status === 'active')) {
      const r = restored.get(kb.id);
      desk.place(kb, r ? Workspace.restore(kb.id, r.baseSha, r.ops) : new Workspace(kb.id));
    }
    for (const kbId of desk.spaces.keys()) await desk.writeOut(kbId);
    return desk;
  }

  private place(kb: KnowledgeBase, ws: Workspace) {
    const taken = new Set([...this.folders.values()].map((f) => f.toLocaleLowerCase()));
    let name = folderName(kb.name);
    for (let k = 2; taken.has(name.toLocaleLowerCase()); k++) name = `${folderName(kb.name)}（${k}）`;
    this.folders.set(kb.id, name);
    this.spaces.set(kb.id, ws);
  }

  /** 把一个知识库现在的样子写进它的文件夹；原件设成只读 */
  private async writeOut(kbId: number) {
    const ws = this.spaces.get(kbId)!,
      dir = join(this.root, this.folders.get(kbId)!);
    mkdirSync(dir, { recursive: true });
    for (const f of await ws.list()) {
      const abs = join(dir, ...f.path.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, ws.bytesOf(f.path)!);
      if (f.protected) chmodSync(abs, 0o444);
    }
  }

  folderOf(kbId: number) {
    return this.folders.get(kbId)!;
  }

  /** 桌面上的路径（「知识库文件夹/里面的路径」）拆成知识库和库里的路径 */
  locate(raw: string): { kbId: number; path: string } {
    const p = String(raw ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+|\/+$/g, '')
      .trim();
    const [head, ...rest] = p.split('/');
    const kbId = [...this.folders].find(([, f]) => f === head)?.[0];
    if (kbId === undefined)
      throw notFound(`「${head}」不是知识库的文件夹。现在的知识库：${[...this.folders.values()].map((f) => `「${f}」`).join('、')}`);
    return { kbId, path: rest.length ? cleanPath(rest.join('/')) : '' };
  }

  abs(kbId: number, path: string) {
    return join(this.root, this.folderOf(kbId), ...(path ? path.split('/') : []));
  }

  /**
   * 把文件夹里的样子对回每个知识库：改了的、新写的记成暂存改动，删了的记成删除。
   * 有问题（改了原件、写在最外层、文件名或内容不合适）一条条列出来，交给整理助手改。
   */
  async sync(): Promise<string[]> {
    const problems: string[] = [];
    const known = new Set([...this.folders.values()]);
    for (const name of existsSync(this.root) ? readdirSync(this.root) : []) {
      if (name.startsWith('.') || known.has(name)) continue;
      problems.push(`「${name}」不在任何知识库里：最外层只放知识库的文件夹，要新建知识库用 ct 新建库`);
    }
    for (const [kbId, folder] of this.folders) {
      const ws = this.spaces.get(kbId)!;
      const listed = new Map((await ws.list()).map((f) => [f.path, f]));
      const onDisk = filesUnder(join(this.root, folder));
      const seen = new Set<string>();
      for (const rel of onDisk) {
        let path: string;
        try {
          path = cleanPath(rel);
        } catch (err) {
          problems.push(`「${folder}/${rel}」：${(err as Error).message}`);
          continue;
        }
        seen.add(path);
        const f = listed.get(path);
        if (f && !f.text) continue;
        const text = readFileSync(this.abs(kbId, path), 'utf8');
        if (ws.read(path) === text) continue;
        if (f?.protected) {
          problems.push(`「${folder}/${path}」是老师交的原件，内容不能改`);
          continue;
        }
        try {
          ws.write(path, text);
        } catch (err) {
          problems.push(`「${folder}/${path}」：${(err as Error).message}`);
        }
      }
      for (const path of listed.keys())
        if (!seen.has(path))
          try {
            ws.remove(path);
          } catch (err) {
            problems.push(`「${folder}/${path}」：${(err as Error).message}`);
          }
    }
    return problems;
  }

  /** 库里的一个文件或一个文件夹下的所有文件 */
  async pathsUnder(kbId: number, path: string): Promise<string[]> {
    const all = (await this.spaces.get(kbId)!.list()).map((f) => f.path);
    if (!path) return all;
    return all.filter((p) => p === path || p.startsWith(path + '/'));
  }

  /** 同一个知识库里挪（改名）：Workspace 记下身份，文件夹里跟着挪 */
  async moveWithin(kbId: number, from: string, to: string): Promise<string[]> {
    const ws = this.spaces.get(kbId)!;
    const paths = await this.pathsUnder(kbId, from);
    if (!paths.length) throw notFound(`没有「${this.folderOf(kbId)}/${from}」`);
    const moves = paths.map((p) => ({ from: p, to: p === from ? to : to + p.slice(from.length) }));
    for (const m of moves) ws.move(m.from, m.to);
    for (const m of moves) {
      const a = this.abs(kbId, m.from),
        b = this.abs(kbId, m.to);
      mkdirSync(dirname(b), { recursive: true });
      const ro = !(statSync(a).mode & 0o200);
      loosen(a);
      renameSync(a, b);
      if (ro) chmodSync(b, 0o444);
    }
    this.prune(kbId, from);
    return moves.map((m) => m.to);
  }

  /** 删掉：Workspace 记下删除，文件夹里跟着删 */
  async removeIn(kbId: number, path: string, keepOriginals: boolean): Promise<string[]> {
    const ws = this.spaces.get(kbId)!;
    const paths = await this.pathsUnder(kbId, path);
    if (!paths.length) throw notFound(`没有「${this.folderOf(kbId)}/${path}」`);
    if (keepOriginals) for (const p of paths) if (ws.entry(p)?.sourceId) throw bad(`「${p}」是这次交的原件，不能删，要换位置用 ct 挪`);
    for (const p of paths) ws.remove(p);
    for (const p of paths) {
      const a = this.abs(kbId, p);
      loosen(a);
      if (existsSync(a)) unlinkSync(a);
    }
    this.prune(kbId, path);
    return paths;
  }

  /** 挪空的文件夹一并去掉 */
  private prune(kbId: number, path: string) {
    let dir = dirname(this.abs(kbId, path));
    const top = this.abs(kbId, '');
    while (dir.length > top.length && existsSync(dir) && !readdirSync(dir).length) {
      rmSync(dir, { recursive: true, force: true });
      dir = dirname(dir);
    }
  }

  /** 跨库挪完以后：两边按新的版本重新起，暂存的改动照旧，文件从这个文件夹挪到那个文件夹 */
  rebase(kbId: number, keep: FileOp[]) {
    this.spaces.set(kbId, Workspace.restore(kbId, loadKb(kbId).head_sha, keep));
  }
  moveAcross(fromKb: number, toKb: number, paths: string[]) {
    for (const p of paths) {
      const a = this.abs(fromKb, p),
        b = this.abs(toKb, p);
      mkdirSync(dirname(b), { recursive: true });
      const ro = existsSync(a) && !(statSync(a).mode & 0o200);
      loosen(a);
      if (existsSync(a)) renameSync(a, b);
      if (ro) chmodSync(b, 0o444);
      this.prune(fromKb, p);
    }
  }

  /** 新建的知识库摆上桌面 */
  addBase(kbId: number) {
    this.place(loadKb(kbId), new Workspace(kbId));
    mkdirSync(this.abs(kbId, ''), { recursive: true });
  }
  renameBase(kbId: number) {
    const before = this.abs(kbId, '');
    this.folders.delete(kbId);
    const ws = this.spaces.get(kbId)!;
    this.spaces.delete(kbId);
    this.place(loadKb(kbId), ws);
    const after = this.abs(kbId, '');
    if (before !== after && existsSync(before)) renameSync(before, after);
  }
  dropBase(kbId: number) {
    wipe(this.abs(kbId, ''));
    this.folders.delete(kbId);
    this.spaces.delete(kbId);
  }

  /** 各个知识库这次暂存的改动（分批整理时记下来，断了从这里接着） */
  states(): SpaceState[] {
    return [...this.spaces].map(([kbId, ws]) => ({ kbId, baseSha: ws.baseSha, ops: ws.ops() })).filter((s) => s.ops.length);
  }
}

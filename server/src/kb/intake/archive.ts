import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isSystemJunk, kindFromExt, extOf } from './kinds.js';
import { extractZipEntry, listZip, ZipCorrupt, ZipUnsupported } from './zip.js';

/** 解压：zip 自己逐个解，其余格式（rar、7z、tar、gz 等）用 7-Zip。都有数量和大小上限，防止解出来塞满磁盘。 */
export interface ExpandLimits {
  maxEntries: number;
  maxTotal: number;
  maxEntry: number;
}
export interface ExpandedFile {
  /** 压缩包里的相对路径（文件夹/文件名） */
  path: string;
  size: number;
  /** 解出来的临时文件 */
  file: string;
}
export interface Refused {
  path: string;
  size: number;
  reason: string;
  advice: string;
}
export class ArchiveError extends Error {
  constructor(
    public reason: string,
    public advice: string,
  ) {
    super(reason);
  }
}
const ENCRYPTED = () => new ArchiveError('压缩包设了密码，打不开', '请解压后再交，或去掉密码重新打包');
const BROKEN = () => new ArchiveError('压缩包打不开，可能已经损坏或没有传完整', '请重新打包后再交');
const mb = (n: number) => (n >= 1024 * 1024 * 1024 ? `${Math.round(n / 1024 / 1024 / 102.4) / 10} GB` : `${Math.round(n / 1024 / 1024)} MB`);

export async function expandArchive(
  file: string,
  name: string,
  outDir: string,
  limits: ExpandLimits,
  sevenZip: () => Promise<SevenZip>,
): Promise<{ files: ExpandedFile[]; refused: Refused[] }> {
  mkdirSync(outDir, { recursive: true });
  const head = Buffer.alloc(8);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  if (head.readUInt32LE(0) === 0x04034b50 || head.readUInt32LE(0) === 0x06054b50) {
    try {
      return await expandZip(file, outDir, limits);
    } catch (err) {
      if (!(err instanceof ZipUnsupported) && !(err instanceof ZipCorrupt)) throw err;
    }
  }
  return expandWith7z(file, name, outDir, limits, await sevenZip());
}

function check<T extends { path: string; size: number; encrypted?: boolean }>(entries: T[], limits: ExpandLimits): T[] {
  const files = entries.filter((e) => !isSystemJunk(e.path));
  if (files.length && files.every((e) => e.encrypted)) throw ENCRYPTED();
  if (files.length > limits.maxEntries) throw new ArchiveError(`压缩包里的文件太多（超过 ${limits.maxEntries} 个）`, '请分成几个压缩包再交');
  const total = files.reduce((n, e) => n + e.size, 0);
  if (total > limits.maxTotal) throw new ArchiveError(`压缩包解开后太大（超过 ${mb(limits.maxTotal)}）`, '请分成几个压缩包再交');
  return files;
}
function tooBig(e: { path: string; size: number }, limits: ExpandLimits): Refused | null {
  const archive = kindFromExt(extOf(e.path)) === 'archive';
  if (e.size > (archive ? limits.maxTotal : limits.maxEntry))
    return { path: e.path, size: e.size, reason: `这份文件太大（超过 ${mb(archive ? limits.maxTotal : limits.maxEntry)}）`, advice: '请拆小后再交' };
  return null;
}

async function expandZip(file: string, outDir: string, limits: ExpandLimits) {
  const all = await listZip(file);
  const entries = check(
    all.filter((e) => !e.dir).map((e) => ({ ...e, path: e.name.replace(/^\/+/, '') })),
    limits,
  );
  if (entries.some((e) => !e.encrypted && e.method !== 0 && e.method !== 8)) throw new ZipUnsupported();
  const files: ExpandedFile[] = [];
  const refused: Refused[] = [];
  let k = 0;
  for (const e of entries) {
    if (e.encrypted) {
      refused.push({ path: e.path, size: e.size, reason: '这份文件设了密码，打不开', advice: '请去掉密码后再交' });
      continue;
    }
    const big = tooBig(e, limits);
    if (big) {
      refused.push(big);
      continue;
    }
    const out = join(outDir, `${k++}.bin`);
    try {
      await extractZipEntry(file, e, out);
      files.push({ path: e.path, size: e.size, file: out });
    } catch (err) {
      if (err instanceof ZipUnsupported) throw err;
      refused.push({ path: e.path, size: e.size, reason: '这份文件在压缩包里已经损坏', advice: '请重新打包后再交' });
    }
  }
  return { files, refused };
}

/** 7-Zip 的编译版：它是命令行程序，每次调用新开一个实例；编译好的代码只编译一次。 */
/** 运行环境自带的 WebAssembly；服务端类型库里没有声明它。 */
const WA = (globalThis as any).WebAssembly;
type WasmModule = object;
export interface SevenZip {
  module: WasmModule;
  factory: (opts: any) => Promise<any>;
}
export function sevenZipLoader(wasmPath: string, factory: (opts: any) => Promise<any>): () => Promise<SevenZip> {
  let loading: Promise<SevenZip> | null = null;
  return () => (loading ||= (WA.compile(readFileSync(wasmPath)) as Promise<WasmModule>).then((module) => ({ module, factory })));
}

/** 磁盘写满时 7-Zip 收到的错误码（wasm 版的 ENOSPC） */
const ENOSPC = 51;
/**
 * 跑一次 7-Zip：挂上真实目录，输出和错误都收下来。
 * writeLimit：这次最多往磁盘写多少字节。压缩包里报的大小可以造假，实际写出超过上限就当磁盘已满让它停下，
 * 免得一个谎报大小的压缩包写满同一台机器上大家共用的磁盘。
 */
export async function run7z(wasm: WasmModule, factory: (opts: any) => Promise<any>, args: string[], cwd: string, writeLimit = Infinity) {
  let out = '',
    err = '';
  const sz = await factory({
    instantiateWasm(imports: object, done: (instance: object) => void) {
      (WA.instantiate(wasm, imports) as Promise<object>).then((instance) => done(instance));
      return {};
    },
    print: (s: string) => (out += s + '\n'),
    printErr: (s: string) => (err += s + '\n'),
    stdin: () => null,
    noExitRuntime: false,
  });
  const ops = sz.NODEFS.stream_ops;
  const write = ops.write;
  let written = 0,
    overLimit = false;
  ops.write = function (this: unknown, stream: unknown, buffer: unknown, offset: number, length: number, position: number) {
    written += length;
    if (written > writeLimit) {
      overLimit = true;
      throw new sz.FS.ErrnoError(ENOSPC);
    }
    return write.call(this, stream, buffer, offset, length, position);
  };
  sz.FS.mkdir('/w');
  sz.FS.mount(sz.NODEFS, { root: resolve(cwd) }, '/w');
  sz.FS.chdir('/w');
  let code = 0;
  // 7-Zip 退出时会把所在进程（线程）的退出码改成它自己的，跑完改回去
  const exitCode = process.exitCode;
  try {
    sz.callMain(args);
  } catch (e: any) {
    code = typeof e?.status === 'number' ? e.status : 2;
    if (typeof e?.status !== 'number') err += '\n#exception';
  } finally {
    ops.write = write;
    process.exitCode = exitCode;
  }
  try {
    sz.FS.chdir('/');
    sz.FS.unmount('/w');
  } catch {}
  // 进度提示用退格符覆盖同一行，去掉免得粘在第一条记录前面
  return { out: out.replace(/[^\n]*\x08/g, ''), err, code, overLimit };
}

async function expandWith7z(file: string, name: string, outDir: string, limits: ExpandLimits, sz: SevenZip) {
  const { module, factory } = sz;
  // 7-Zip 只能看到挂进去的那个目录：挂原件和解压目录共同的上级
  const root = commonDir(resolve(file, '..'), resolve(outDir));
  const rel = relative(root, file).split(sep).join('/');
  const target = relative(root, resolve(outDir)).split(sep).join('/');
  const listing = await run7z(module, factory, ['l', '-slt', '-ba', '-bsp0', '-pcoteach-no-password', '-sccUTF-8', '/w/' + rel], root);
  if (listing.code !== 0 || /#exception/.test(listing.err)) {
    if (/password|encrypted|Wrong password/i.test(listing.err + listing.out) || looksEncrypted(file)) throw ENCRYPTED();
    throw BROKEN();
  }
  const entries: { path: string; size: number; dir: boolean; encrypted: boolean }[] = [];
  for (const block of listing.out.split(/\n\s*\n/)) {
    const field = (k: string) => block.match(new RegExp(`^${k} = (.*)$`, 'm'))?.[1];
    const path = field('Path');
    if (!path) continue;
    const attrs = field('Attributes') || '';
    entries.push({
      path: path.replace(/\\/g, '/').replace(/^\/+/, ''),
      size: Number(field('Size') || 0),
      dir: field('Folder') === '+' || /^D/.test(attrs),
      encrypted: field('Encrypted') === '+',
    });
  }
  // 单文件压缩（.gz、.bz2、.xz）没有记录原名时，用压缩包的名字去掉压缩后缀
  if (entries.length === 1 && !entries[0].dir && (!entries[0].path || entries[0].path === rel.split('/').pop())) entries[0].path = name.replace(/\.(gz|bz2|xz|z|lz|lzma)$/i, '');
  const files = check(entries.filter((e) => !e.dir), limits);
  const refused: Refused[] = [];
  const keep = new Set<string>();
  for (const e of files) {
    if (e.encrypted) refused.push({ path: e.path, size: e.size, reason: '这份文件设了密码，打不开', advice: '请去掉密码后再交' });
    else {
      const big = tooBig(e, limits);
      if (big) refused.push(big);
      else keep.add(e.path);
    }
  }
  if (!keep.size) return { files: [], refused };
  // 7-Zip 会把整个压缩包解出来（包括读不了的、系统文件），按列出来的全部大小给上限，留 1% 和 1MB 的余量
  const declared = entries.filter((e) => !e.dir).reduce((n, e) => n + e.size, 0);
  const extract = await run7z(
    module,
    factory,
    ['x', '-y', '-bsp0', '-pcoteach-no-password', '-sccUTF-8', '-snl-', `-o/w/${target}/x`, '/w/' + rel],
    root,
    declared + Math.ceil(declared / 100) + 1024 * 1024,
  );
  if (extract.overLimit) {
    rmSync(join(outDir, 'x'), { recursive: true, force: true });
    throw new ArchiveError('压缩包解开后比它标的大小大得多，可能已经损坏', '请重新打包后再交');
  }
  const broken = new Set<string>();
  for (const m of (extract.err + extract.out).matchAll(/(?:ERROR|CRC Failed|Data Error)[^:\n]*:\s*(.+)$/gm)) broken.add(m[1].trim().replace(/\\/g, '/'));
  const base = join(outDir, 'x');
  const found: ExpandedFile[] = [];
  const walk = (dir: string, prefix: string) => {
    let list: string[] = [];
    try {
      list = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of list) {
      const full = join(dir, n);
      // 不跟随符号链接：只收解出来的普通文件和文件夹（7-Zip 已经拒绝符号链接，这里再兜一层）
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      const path = prefix ? `${prefix}/${n}` : n;
      if (st.isDirectory()) walk(full, path);
      else if (st.isFile()) found.push({ path, size: st.size, file: full });
    }
  };
  walk(base, '');
  const byPath = new Map(found.map((f) => [f.path, f]));
  const result: ExpandedFile[] = [];
  for (const path of keep) {
    const f = byPath.get(path) || (keep.size === 1 && found.length === 1 ? found[0] : undefined);
    if (!f || broken.has(path)) {
      refused.push({ path, size: files.find((e) => e.path === path)?.size || 0, reason: '这份文件在压缩包里已经损坏', advice: '请重新打包后再交' });
      continue;
    }
    result.push({ ...f, path });
  }
  if (!result.length && extract.code !== 0 && /password/i.test(extract.err)) throw ENCRYPTED();
  return { files: result, refused };
}

function commonDir(a: string, b: string): string {
  const pa = a.split(sep),
    pb = b.split(sep);
  let k = 0;
  while (k < pa.length && k < pb.length && pa[k].toLowerCase() === pb[k].toLowerCase()) k++;
  return pa.slice(0, k).join(sep) || sep;
}

/** 7z、rar 把文件名也加密时，不输密码连目录都列不出来；按文件头的加密标记判断，免得说成「已损坏」。 */
function looksEncrypted(file: string): boolean {
  let b: Buffer;
  try {
    const st = statSync(file);
    const fd = openSync(file, 'r');
    try {
      b = Buffer.alloc(Math.min(st.size, 64));
      readSync(fd, b, 0, b.length, 0);
      if (b[0] === 0x37 && b[1] === 0x7a && st.size > 32) {
        const next = Number(b.readBigUInt64LE(12)) + 32,
          len = Number(b.readBigUInt64LE(20));
        if (next > 0 && len > 0 && next + len <= st.size && len < 1 << 20) {
          const tail = Buffer.alloc(len);
          readSync(fd, tail, 0, len, next);
          return tail.includes(Buffer.from([0x06, 0xf1, 0x07, 0x01]));
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  if (b.subarray(0, 7).equals(Buffer.from('Rar!\x1a\x07\x01', 'latin1'))) {
    let p = 12;
    while (p < b.length && b[p] & 0x80) p++;
    return b[p + 1] === 4;
  }
  if (b.subarray(0, 7).equals(Buffer.from('Rar!\x1a\x07\x00', 'latin1'))) return (b.readUInt16LE(10) & 0x0080) !== 0;
  return false;
}

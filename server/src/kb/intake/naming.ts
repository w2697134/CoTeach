import { KIND_LABEL, baseName, type Kind } from './kinds.js';

/**
 * 老师的文件夹、文件名原样带进知识库（先放在最外层，整理完跟着整理助手写的文档进文件夹）；系统不允许的字符换成相近的全角字符。
 * 同一文件夹里同名不同类型（「第1章」幻灯片和「第1章」PDF）各自加上类型，不会互相覆盖。
 */
const FULLWIDTH: Record<string, string> = { ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜', '\\': '＼' };
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_SEGMENT = 80;
const MAX_PATH = 190;

/** 按长度截断时不把一个字（比如表情符号）切成两半：切口落在一对代理字符中间就退一位 */
const cut = (s: string, n: number) => {
  const t = s.slice(0, n);
  const last = t.charCodeAt(t.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
};

export function cleanSegment(raw: string): string {
  let s = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|\\]/g, (c) => FULLWIDTH[c])
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[ .]+$/, '');
  if (RESERVED.test(s.split('.')[0])) s = '_' + s;
  if (s.length > MAX_SEGMENT) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = cut(s, MAX_SEGMENT - ext.length - 1) + '…' + ext;
  }
  return s || '未命名';
}

/** 上传时带的相对路径（文件夹/文件名）清理成合法的逻辑路径；「..」和空段直接去掉。 */
export function cleanRelative(raw: string): string {
  const parts = String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .map(cleanSegment);
  return parts.join('/') || '未命名';
}

/** 压缩包解开后放在哪：只有一个顶层文件夹就直接用它，只有一份文件就放在压缩包原来的位置，否则用压缩包的名字作文件夹。 */
export function archiveChildPaths(archiveLogical: string, inner: string[]): string[] {
  const dir = archiveLogical.includes('/') ? archiveLogical.slice(0, archiveLogical.lastIndexOf('/') + 1) : '';
  const cleaned = inner.map(cleanRelative);
  const tops = new Set(cleaned.map((p) => p.split('/')[0]));
  const allNested = cleaned.every((p) => p.includes('/'));
  if (cleaned.length === 1 && !cleaned[0].includes('/')) return [dir + cleaned[0]];
  if (tops.size === 1 && allNested) return cleaned.map((p) => dir + p);
  const folder = cleanSegment(baseName(archiveLogical));
  return cleaned.map((p) => dir + folder + '/' + p);
}

export interface PathRequest {
  id: number;
  logical: string;
  kind: Kind;
  /** 之前交过同名资料、整理助手挪过位置时，沿用它现在的位置 */
  existingPath?: string;
}

/** 给每份资料定知识库里的位置：同批重名加类型、再重名加序号；和已有的笔记重名也加序号。 */
export function assignPaths(requests: PathRequest[], taken: Set<string>): Map<number, string> {
  const result = new Map<number, string>();
  const lowerTaken = new Set([...taken].map((p) => p.toLocaleLowerCase()));
  const fresh: { id: number; dir: string; base: string; kind: Kind }[] = [];
  for (const r of requests) {
    if (r.existingPath) {
      result.set(r.id, r.existingPath);
      continue;
    }
    const logical = r.logical;
    const dir = logical.includes('/') ? logical.slice(0, logical.lastIndexOf('/')) : '';
    fresh.push({ id: r.id, dir, base: cleanSegment(baseName(logical)), kind: r.kind });
  }
  const groups = new Map<string, typeof fresh>();
  for (const f of fresh) {
    const key = `${f.dir}/${f.base}`.toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) || []), f]);
  }
  const used = new Set([...lowerTaken, ...[...result.values()].map((v) => v.toLocaleLowerCase())]);
  for (const group of groups.values()) {
    const kinds = new Map<Kind, number>();
    for (const f of group) kinds.set(f.kind, (kinds.get(f.kind) || 0) + 1);
    const seen = new Map<string, number>();
    for (const f of group) {
      let name = group.length > 1 && kinds.size > 1 ? `${f.base}（${KIND_LABEL[f.kind]}）` : f.base;
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name}（${n}）`;
      let path = fit(`${f.dir ? f.dir + '/' : ''}${name}.md`);
      for (let k = 2; used.has(path.toLocaleLowerCase()) || dirClash(path, used); k++) path = fit(`${f.dir ? f.dir + '/' : ''}${name}（${k}）.md`);
      used.add(path.toLocaleLowerCase());
      result.set(f.id, path);
    }
  }
  return result;
}

/** 新文件不能和已有文件夹同名，也不能放进已被文件占用的「文件夹」 */
function dirClash(path: string, used: Set<string>): boolean {
  const lower = path.toLocaleLowerCase();
  for (const u of used) if (u.startsWith(lower + '/') || lower.startsWith(u + '/')) return true;
  return false;
}

/** 路径太长时从中间的文件夹名开始缩短，首尾保留，老师认得出是哪一份。 */
export function fit(path: string): string {
  if (path.length <= MAX_PATH) return path;
  const parts = path.split('/');
  for (let k = 1; k < parts.length - 1 && parts.join('/').length > MAX_PATH; k++) if (parts[k].length > 12) parts[k] = cut(parts[k], 10) + '…';
  let out = parts.join('/');
  if (out.length > MAX_PATH) {
    const file = parts[parts.length - 1];
    const keep = MAX_PATH - (out.length - file.length);
    if (keep > 8) parts[parts.length - 1] = cut(file, keep - 4) + '….md';
    out = parts.join('/');
  }
  if (out.length > MAX_PATH) out = cut(out, MAX_PATH - 4) + '….md';
  return out;
}

/** 长文直接贴给整理助手时，用第一行做资料名。 */
export function pastedTitle(text: string, at: number): string {
  const first = text
    .split('\n')
    .map((l) => l.replace(/^[\s#>*\-+•·]+|[*_`]+|\s+$/g, '').trim())
    .find(Boolean);
  if (first && first.length >= 2 && first.length <= 40 && !/^https?:/i.test(first)) return cleanSegment(first.replace(/[。．.，,：:；;]+$/, ''));
  const d = new Date(at);
  return `贴的文字（${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}时${String(d.getMinutes()).padStart(2, '0')}分）`;
}

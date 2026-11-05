import { diffArrays, diffChars } from 'diff';

/**
 * 把一份 Markdown 的前后两版合成一份“修订稿”，像 Word 的修订模式：
 * 正文是新版，删掉的行和字插回原来的位置，再记下哪些位置是新加的、哪些是删掉的。
 * 排版交给 Markdown 渲染；渲染完按位置给文字套上 <ins>/<del>，没改的大段收起来。
 */

export type MarkKind = 'add' | 'del';

export interface Tracked {
  /** 合成后的 Markdown */
  source: string;
  lines: string[];
  lineStarts: number[];
  /** 每一行有没有标记 */
  lineChanged: boolean[];
  /** 按位置排好、互不重叠的标记 */
  marks: { start: number; end: number; kind: MarkKind }[];
}

type Role = 'text' | 'code' | 'fence' | 'blank' | 'rule';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** 行首的列表符号、标题井号、引用符号，只看后面的文字 */
const PREFIX = /^(?:[ \t]*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+|>[ \t]?))*/;
/** 链接、行内代码、网址、公式整个算一个词，不从中间拆开 */
const ATOM = /!?\[[^\]\n]*\]\([^)\n]*\)|`[^`\n]*`|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>()（）]+|\$[^$\n]+\$|\*\*|__|~~|\\./g;
/** 加粗、斜体的符号：删掉的这些不插回去，否则会把新版的字也变成粗体 */
const SYNTAX = /^(?:\*\*|__|~~|\*|_)$/;

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;

const toLines = (s: string) => {
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const isTableSep = (l: string) => l.includes('|') && l.includes('-') && /^[\s|:-]+$/.test(l);

function roles(lines: string[]): Role[] {
  const out: Role[] = [];
  let fence = '';
  for (const l of lines) {
    const m = FENCE.exec(l);
    if (fence) {
      const closes = m && m[1][0] === fence[0] && m[1].length >= fence.length && !l.slice(m[0].length).trim();
      out.push(closes ? 'fence' : 'code');
      if (closes) fence = '';
    } else if (m) {
      out.push('fence');
      fence = m[1];
    } else if (!l.trim()) out.push('blank');
    else if (HR.test(l) || isTableSep(l)) out.push('rule');
    else out.push('text');
  }
  return out;
}

function split(line: string, role: Role): [string, string] {
  if (role === 'code') return ['', line];
  const p = PREFIX.exec(line)![0];
  return [p, line.slice(p.length)];
}

function words(s: string): string[] {
  if (!s) return [];
  if (segmenter) return Array.from(segmenter.segment(s), x => x.segment);
  return s.match(/[㐀-鿿豈-﫿]|[A-Za-z0-9]+|\s+|[^]/gu) || [];
}

function tokenize(s: string, code: boolean): string[] {
  if (code) return s.match(/[A-Za-z0-9_]+|\s+|[^]/gu) || [];
  const out: string[] = [];
  let last = 0;
  for (const m of s.matchAll(ATOM)) {
    out.push(...words(s.slice(last, m.index)), m[0]);
    last = m.index! + m[0].length;
  }
  out.push(...words(s.slice(last)));
  return out;
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  let same = 0;
  for (const p of diffChars(a, b)) if (!p.added && !p.removed) same += p.value.length;
  return (2 * same) / (a.length + b.length);
}

type Op = { kind: 'eq' | MarkKind; toks: string[] };

/** 一行之内逐词比，一段连续的改动整理成先删后加 */
function inlineOps(a: string[], b: string[]): Op[] {
  const raw: Op[] = diffArrays(a, b).map(p => ({ kind: p.added ? 'add' : p.removed ? 'del' : 'eq', toks: p.value }));
  // 夹在两处改动中间、只剩一个字没改的，并进改动，免得改动碎成一截一截
  const ops = raw.flatMap((o, i): Op[] =>
    o.kind === 'eq' && i > 0 && i < raw.length - 1 && o.toks.join('').trim().length <= 1
      ? [
          { kind: 'del', toks: o.toks },
          { kind: 'add', toks: o.toks },
        ]
      : [o],
  );
  const out: Op[] = [];
  let del: string[] = [];
  let add: string[] = [];
  const flush = () => {
    if (del.length) out.push({ kind: 'del', toks: del });
    if (add.length) out.push({ kind: 'add', toks: add });
    del = [];
    add = [];
  };
  for (const o of ops) {
    if (o.kind === 'eq') {
      flush();
      out.push(o);
    } else (o.kind === 'del' ? del : add).push(...o.toks);
  }
  flush();
  return out;
}

export function buildTracked(before: string, after: string): Tracked {
  const a = toLines(before);
  const b = toLines(after);
  const ra = roles(a);
  const rb = roles(b);
  const out: { text: string; marks: [number, number, MarkKind][] }[] = [];

  const whole = (text: string, role: Role, kind: MarkKind) => {
    if (role !== 'text' && role !== 'code') return out.push({ text, marks: [] });
    const [p] = split(text, role);
    out.push({ text, marks: text.length > p.length ? [[p.length, text.length, kind]] : [] });
  };

  // 删掉的一段里，代码块的围栏成对才插回去，落单的会把后面的内容都吞进代码块；删掉的分隔线也不插回去
  const removed = (from: number, n: number) => {
    let fences = 0;
    for (let x = from; x < from + n; x++) if (ra[x] === 'fence') fences++;
    return (x: number) => {
      if (ra[x] === 'fence' && fences % 2) return;
      if (ra[x] === 'rule' && HR.test(a[x])) return;
      whole(a[x], ra[x], 'del');
    };
  };

  const modified = (x: number, y: number) => {
    const code = rb[y] === 'code';
    const [, oc] = split(a[x], ra[x]);
    const [np, nc] = split(b[y], rb[y]);
    let text = np;
    const marks: [number, number, MarkKind][] = [];
    for (const op of inlineOps(tokenize(oc, code), tokenize(nc, code))) {
      const s = op.kind === 'del' && !code ? op.toks.filter(t => !SYNTAX.test(t)).join('') : op.toks.join('');
      if (!s) continue;
      if (op.kind !== 'eq') marks.push([text.length, text.length + s.length, op.kind]);
      text += s;
    }
    out.push({ text, marks });
  };

  // 删掉几行又加了几行：意思相近的两行配成一对，逐词标出改了哪；配不上的整行算删、整行算加
  const replaced = (xa: number, na: number, yb: number, nb: number) => {
    const del = removed(xa, na);
    if (na * nb > 4000) {
      for (let x = xa; x < xa + na; x++) del(x);
      for (let y = yb; y < yb + nb; y++) whole(b[y], rb[y], 'add');
      return;
    }
    let y = yb;
    for (let x = xa; x < xa + na; x++) {
      let best = -1;
      let score = 0.45;
      for (let z = y; z < Math.min(yb + nb, y + 4); z++) {
        if (ra[x] !== rb[z] || (ra[x] !== 'text' && ra[x] !== 'code')) continue;
        const s = similarity(split(a[x], ra[x])[1], split(b[z], rb[z])[1]);
        if (s > score) {
          best = z;
          score = s;
        }
      }
      if (best < 0) {
        del(x);
        continue;
      }
      for (; y < best; y++) whole(b[y], rb[y], 'add');
      modified(x, y++);
    }
    for (; y < yb + nb; y++) whole(b[y], rb[y], 'add');
  };

  const parts = diffArrays(a, b);
  let xa = 0;
  let yb = 0;
  for (let k = 0; k < parts.length; ) {
    if (!parts[k].added && !parts[k].removed) {
      for (const l of parts[k].value) out.push({ text: l, marks: [] });
      xa += parts[k].value.length;
      yb += parts[k].value.length;
      k++;
      continue;
    }
    let na = 0;
    let nb = 0;
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++) {
      if (parts[k].removed) na += parts[k].value.length;
      else nb += parts[k].value.length;
    }
    replaced(xa, na, yb, nb);
    xa += na;
    yb += nb;
  }

  const t: Tracked = { source: '', lines: [], lineStarts: [], lineChanged: [], marks: [] };
  let off = 0;
  for (const o of out) {
    t.lines.push(o.text);
    t.lineStarts.push(off);
    t.lineChanged.push(o.marks.length > 0);
    for (const [s, e, kind] of o.marks) t.marks.push({ start: off + s, end: off + e, kind });
    off += o.text.length + 1;
  }
  t.source = t.lines.join('\n') + '\n';
  return t;
}

/* ---------------------------------------------------------------- 渲染后套标记 */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
}

function kindAt(t: Tracked, pos: number): MarkKind | null {
  let lo = 0;
  let hi = t.marks.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.marks[mid].start <= pos) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit >= 0 && pos < t.marks[hit].end ? t.marks[hit].kind : null;
}

/** 把一段文字按标记切开，改过的部分套上 <ins>/<del>；整段都没改时返回 null */
function wrap(t: Tracked, value: string, srcAt: (j: number) => number): HNode[] | null {
  const kinds = Array.from({ length: value.length }, (_, j) => {
    const p = srcAt(j);
    return p < 0 ? null : kindAt(t, p);
  });
  if (!kinds.some(Boolean)) return null;
  const out: HNode[] = [];
  for (let s = 0, j = 1; j <= value.length; j++) {
    if (j < value.length && kinds[j] === kinds[s]) continue;
    const text: HNode = { type: 'text', value: value.slice(s, j) };
    const k = kinds[s];
    out.push(k ? { type: 'element', tagName: k === 'add' ? 'ins' : 'del', properties: { className: [k === 'add' ? 'ct-ins' : 'ct-del'] }, children: [text] } : text);
    s = j;
  }
  return out;
}

/** 文字节点里每个字在合成稿里的位置。转义符、行首空格会被 Markdown 去掉，所以按字往后找 */
function textMap(t: Tracked, node: HNode): ((j: number) => number) | null {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  if (s === undefined || e === undefined) return null;
  const src = t.source.slice(s, e);
  const v = node.value!;
  if (src === v) return j => s + j;
  const map: number[] = [];
  for (let i = 0, j = 0; j < v.length; j++, i++) {
    while (i < src.length && src[i] !== v[j]) i++;
    if (i >= src.length) {
      // 对不上（比如 HTML 实体），整段的首尾标记一样就整段套上
      const k = kindAt(t, s);
      return k && kindAt(t, e - 1) === k ? () => s : null;
    }
    map.push(s + i);
  }
  return j => map[j];
}

/** 代码块里的文字没有位置信息，按行对回合成稿 */
function markCode(t: Tracked, pre: HNode) {
  const code = pre.children?.find(c => c.type === 'element' && c.tagName === 'code');
  const line = pre.position?.start.line;
  if (!code || !line) return;
  let full = '';
  const collect = (n: HNode) => n.children?.forEach(c => (c.type === 'text' ? (full += c.value) : collect(c)));
  collect(code);
  const first = FENCE.test(t.lines[line - 1] ?? '') ? line : line - 1;
  const map = new Int32Array(full.length).fill(-1);
  let g = 0;
  full.split('\n').forEach((cl, li) => {
    const idx = first + li;
    const src = t.lines[idx];
    if (src !== undefined) {
      const shift = Math.max(0, src.length - cl.length);
      for (let c = 0; c < cl.length; c++) map[g + c] = t.lineStarts[idx] + shift + c;
    }
    g += cl.length + 1;
  });
  let off = 0;
  const replace = (n: HNode) => {
    if (!n.children) return;
    n.children = n.children.flatMap(c => {
      if (c.type !== 'text') {
        replace(c);
        return [c];
      }
      const base = off;
      off += c.value!.length;
      return wrap(t, c.value!, j => map[base + j]) ?? [c];
    });
  };
  replace(code);
}

function markTree(t: Tracked, node: HNode) {
  if (!node.children) return;
  node.children = node.children.flatMap(c => {
    if (c.type === 'element') {
      if (c.tagName === 'pre') markCode(t, c);
      else markTree(t, c);
      return [c];
    }
    if (c.type !== 'text') return [c];
    const at = textMap(t, c);
    return (at && wrap(t, c.value!, at)) || [c];
  });
}

const hasMark = (n: HNode): boolean => n.tagName === 'ins' || n.tagName === 'del' || !!n.children?.some(hasMark);

function blockChanged(t: Tracked, n: HNode) {
  const p = n.position;
  if (p) for (let l = p.start.line; l <= p.end.line; l++) if (t.lineChanged[l - 1]) return true;
  return hasMark(n);
}

/** 没改的大段收起来：改过的段落、前后各一段、上面最近的标题留着，其余连着两段以上的收成一条 */
function fold(t: Tracked, root: HNode) {
  const kids = root.children || [];
  const blocks = kids.filter(k => k.type === 'element');
  if (blocks.length < 4) return;
  const changed = blocks.map(b => blockChanged(t, b));
  const show = [...changed];
  changed.forEach((c, i) => {
    if (!c) return;
    if (i > 0) show[i - 1] = true;
    if (i < blocks.length - 1) show[i + 1] = true;
    for (let h = i - 1; h >= 0; h--)
      if (/^h[1-6]$/.test(blocks[h].tagName!)) {
        show[h] = true;
        break;
      }
  });
  const out: HNode[] = [];
  let run: HNode[] = [];
  let count = 0;
  let seen = false;
  const flush = (end: boolean) => {
    if (count >= 2) out.push({ type: 'element', tagName: 'ct-fold', properties: { dataCount: count, dataPos: !seen ? 'start' : end ? 'end' : 'mid' }, children: run });
    else out.push(...run);
    run = [];
    count = 0;
  };
  let bi = 0;
  for (const k of kids) {
    if (k.type !== 'element') (count ? run : out).push(k);
    else if (show[bi++]) {
      flush(false);
      out.push(k);
      seen = true;
    } else {
      run.push(k);
      count++;
    }
  }
  flush(true);
  root.children = out;
}

/** rehype 插件：给渲染好的修订稿套上增删标记，再收起没改的大段 */
export const rehypeTracked = (t: Tracked) => (tree: HNode) => {
  markTree(t, tree);
  fold(t, tree);
};

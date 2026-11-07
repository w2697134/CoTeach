/** 读 Office、开放文档、电子书里的 XML：只取结构和文字，不执行任何外部引用。 */
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: (XNode | string)[];
}

const NAMED: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  shy: '­',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  pi: 'π',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  sigma: 'σ',
  omega: 'ω',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  rArr: '⇒',
  lArr: '⇐',
  hArr: '⇔',
  forall: '∀',
  exist: '∃',
  isin: '∈',
  notin: '∉',
  sub: '⊂',
  sup: '⊃',
  cap: '∩',
  cup: '∪',
  and: '∧',
  or: '∨',
  not: '¬',
  yen: '¥',
  euro: '€',
  sect: '§',
  para: '¶',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED, e) ? NAMED[e] : m;
  });
}

/** 严格程度足够读 Office 生成的 XML；遇到残缺的结尾标签就按已读到的结构收尾。 */
export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(stack[stack.length - 1], src.slice(i));
      break;
    }
    if (lt > i) pushText(stack[stack.length - 1], src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const text = src.slice(lt + 9, end < 0 ? n : end);
      stack[stack.length - 1].children.push(text);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const end = findTagEnd(src, lt + 1);
    if (end < 0) break;
    const body = src.slice(lt + 1, end);
    i = end + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      // 收到结尾标签时退回到同名的那一层；找不到同名就忽略它。
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = inner.match(/^\s*([^\s/>]+)/);
    if (!m) continue;
    const node: XNode = { name: m[1], attrs: parseAttrs(inner.slice(m[0].length)), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function findTagEnd(src: string, from: number): number {
  let quote = '';
  for (let k = from; k < src.length; k++) {
    const ch = src[k];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return k;
  }
  return -1;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of s.matchAll(/([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g))
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function pushText(node: XNode, raw: string) {
  if (!raw) return;
  node.children.push(decodeEntities(raw));
}

export const local = (name: string) => name.slice(name.indexOf(':') + 1);
export const isNode = (c: XNode | string): c is XNode => typeof c !== 'string';
export const elements = (node: XNode) => node.children.filter(isNode);
export function child(node: XNode, name: string): XNode | undefined {
  return elements(node).find((c) => c.name === name || local(c.name) === name);
}
export function childrenNamed(node: XNode, name: string): XNode[] {
  return elements(node).filter((c) => c.name === name || local(c.name) === name);
}
/** 深度优先找所有同名节点，不进入已经匹配的节点内部。 */
export function findAll(node: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of elements(node)) {
    if (c.name === name || local(c.name) === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}
export function findFirst(node: XNode, name: string): XNode | undefined {
  for (const c of elements(node)) {
    if (c.name === name || local(c.name) === name) return c;
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return undefined;
}
export function textContent(node: XNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textContent).join('');
}
export function attr(node: XNode, name: string): string | undefined {
  if (Object.hasOwn(node.attrs, name)) return node.attrs[name];
  const key = Object.keys(node.attrs).find((k) => local(k) === name);
  return key === undefined ? undefined : node.attrs[key];
}

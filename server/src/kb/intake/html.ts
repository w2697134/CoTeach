import { decodeEntities, type XNode } from './xml.js';

/** 网页、Word 转出来的网页、电子书章节 → 排版文字（标题、列表、表格保留）。 */
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr']);
const DROP = new Set(['script', 'style', 'head', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'select', 'button', 'nav']);
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'figure', 'figcaption', 'address', 'center',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'pre', 'blockquote', 'hr', 'body', 'html', 'form', 'fieldset',
]);
/** 遇到这些开始标签时，自动结束还没关上的同类标签（HTML 允许省略结尾）。 */
const AUTO_CLOSE: Record<string, string[]> = {
  p: ['p'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
};

/** 网页最多读这么长，再长的部分不读（交资料的单份资料本来也不会超过这个字数） */
const MAX_HTML = 3_000_000;
const OPENER = /<!--|<!\[cdata\[|<(script|style|noscript|template)\b/g;
/**
 * 去掉注释、脚本、样式这些整块内容，CDATA 只留里面的文字。逐段往后找结束标记，一遍扫完：
 * 原来用惰性正则，遇到大量没闭合的开头会退化成平方级，一份故意构造的网页能把读资料线程占满。
 * 没闭合的块按浏览器的做法，一直算到末尾。
 */
function stripBlocks(src: string): string {
  const lower = src.toLowerCase();
  let out = '',
    i = 0;
  for (;;) {
    OPENER.lastIndex = i;
    const m = OPENER.exec(lower);
    if (!m) return out + src.slice(i);
    out += src.slice(i, m.index);
    if (m[0] === '<!--') {
      const end = lower.indexOf('-->', m.index + 4);
      if (end < 0) return out;
      i = end + 3;
    } else if (m[0] === '<![cdata[') {
      const end = lower.indexOf(']]>', m.index + 9);
      if (end < 0) return out + src.slice(m.index + 9);
      out += src.slice(m.index + 9, end);
      i = end + 3;
    } else {
      const end = lower.indexOf(`</${m[1]}`, m.index + m[0].length);
      if (end < 0) return out;
      const close = lower.indexOf('>', end);
      if (close < 0) return out;
      i = close + 1;
    }
  }
}

export function parseHtml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const cleaned = stripBlocks(src.length > MAX_HTML ? src.slice(0, MAX_HTML) : src);
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const top = () => stack[stack.length - 1];
  while ((m = re.exec(cleaned))) {
    if (m.index > last) top().children.push(decodeEntities(cleaned.slice(last, m.index)));
    last = re.lastIndex;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase().replace(/^[a-z]+:/, '');
    if (closing) {
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      continue;
    }
    const auto = AUTO_CLOSE[name];
    if (auto) {
      for (let k = stack.length - 1; k > 0; k--) {
        const n = stack[k].name;
        if (auto.includes(n)) {
          stack.length = k;
          break;
        }
        if (['ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'div', 'blockquote', 'dl'].includes(n)) break;
      }
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g))
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const node: XNode = { name, attrs, children: [] };
    top().children.push(node);
    if (!VOID.has(name) && !m[3].trimEnd().endsWith('/')) stack.push(node);
  }
  if (last < cleaned.length) top().children.push(decodeEntities(cleaned.slice(last)));
  return root;
}

type Ctx = { listDepth: number; pre: boolean };
const inlineText = (s: string) => s.replace(/[\t\n\r\f ]+/g, ' ');
const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

export function htmlToMarkdown(src: string): string {
  return renderBlocks(parseHtml(src), { listDepth: 0, pre: false })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderBlocks(node: XNode, ctx: Ctx): string {
  const out: string[] = [];
  let inline = '';
  const flush = () => {
    const t = inline.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
    inline = '';
  };
  for (const c of node.children) {
    if (typeof c === 'string') {
      inline += ctx.pre ? c : inlineText(c);
      continue;
    }
    if (DROP.has(c.name)) continue;
    if (c.name === 'br') {
      inline += '\n';
      continue;
    }
    if (BLOCK.has(c.name) || c.name === 'tbody' || c.name === 'thead') {
      flush();
      const b = renderBlock(c, ctx);
      if (b.trim()) out.push(b);
      continue;
    }
    inline += renderInline(c, ctx);
  }
  flush();
  return out.join('\n\n');
}

function renderInline(node: XNode, ctx: Ctx): string {
  if (DROP.has(node.name)) return '';
  if (node.name === 'br') return '\n';
  if (node.name === 'img') {
    const alt = (node.attrs.alt || node.attrs.title || '').trim();
    return alt ? `［图：${alt}］` : '';
  }
  const inner = node.children
    .map((c) => (typeof c === 'string' ? (ctx.pre ? c : inlineText(c)) : BLOCK.has(c.name) ? ' ' + renderBlocks({ ...c, name: '#frag' }, ctx) + ' ' : renderInline(c, ctx)))
    .join('');
  const trimmed = inner.trim();
  if (!trimmed) return inner.replace(/\S/g, '');
  switch (node.name) {
    case 'strong':
    case 'b':
      return /\*\*/.test(trimmed) ? inner : ` **${trimmed}** `;
    case 'code':
    case 'kbd':
    case 'samp':
      return ctx.pre ? inner : '`' + trimmed.replace(/`/g, '') + '`';
    case 'sup':
      return /^\d+$/.test(trimmed) ? `^${trimmed}` : trimmed;
    case 'sub':
      return trimmed;
    default:
      return inner;
  }
}

function renderBlock(node: XNode, ctx: Ctx): string {
  const name = node.name;
  if (/^h[1-6]$/.test(name)) {
    const t = renderInlineChildren(node, ctx).replace(/\s+/g, ' ').trim();
    return t ? `${'#'.repeat(Number(name[1]))} ${t}` : '';
  }
  if (name === 'hr') return '---';
  if (name === 'pre') {
    const code = textOnly(node).replace(/\n$/, '');
    if (!code.trim()) return '';
    const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) || []).map((s) => s.length + 1)));
    return `${fence}\n${code}\n${fence}`;
  }
  if (name === 'ul' || name === 'ol') return renderList(node, ctx, name === 'ol');
  if (name === 'li') return '- ' + renderBlocks(node, ctx).replace(/\n/g, '\n  ');
  if (name === 'table') return renderTable(node, ctx);
  if (name === 'blockquote') {
    const inner = renderBlocks(node, ctx);
    return inner
      .split('\n')
      .map((l) => (l ? '> ' + l : '>'))
      .join('\n');
  }
  if (name === 'dt') return '**' + renderInlineChildren(node, ctx).trim() + '**';
  return renderBlocks(node, ctx);
}

function renderInlineChildren(node: XNode, ctx: Ctx) {
  return node.children.map((c) => (typeof c === 'string' ? inlineText(c) : renderInline(c, ctx))).join('');
}

function textOnly(node: XNode | string): string {
  if (typeof node === 'string') return node;
  if (node.name === 'br') return '\n';
  return node.children.map(textOnly).join('');
}

function renderList(node: XNode, ctx: Ctx, ordered: boolean): string {
  const items: string[] = [];
  let n = Number(node.attrs.start) || 1;
  for (const c of node.children) {
    if (typeof c === 'string') {
      if (c.trim()) items.push((ordered ? `${n++}. ` : '- ') + c.trim());
      continue;
    }
    if (c.name !== 'li') {
      const b = renderBlock(c, ctx);
      if (b.trim()) items.push(b);
      continue;
    }
    const body = renderBlocks(c, { ...ctx, listDepth: ctx.listDepth + 1 }).trim();
    const marker = ordered ? `${n++}. ` : '- ';
    items.push(marker + body.replace(/\n/g, '\n' + ' '.repeat(marker.length)));
  }
  return items.join('\n');
}

function renderTable(node: XNode, ctx: Ctx): string {
  const rows: string[][] = [];
  const walk = (n: XNode) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (c.name === 'tr') {
        const cells: string[] = [];
        for (const cell of c.children) {
          if (typeof cell === 'string' || (cell.name !== 'td' && cell.name !== 'th')) continue;
          const text = escapeCell(renderBlocks(cell, ctx));
          cells.push(text);
          for (let k = 1; k < Math.min(Number(cell.attrs.colspan) || 1, 20); k++) cells.push('');
        }
        if (cells.some((x) => x)) rows.push(cells);
      } else if (c.name !== 'table') walk(c);
    }
  };
  walk(node);
  return markdownTable(rows);
}

export function markdownTable(rows: string[][]): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  if (width === 1) return rows.map((r) => r[0]).filter(Boolean).join('\n\n');
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const line = (r: string[]) => '| ' + pad(r).map((c) => c || ' ').join(' | ') + ' |';
  return [line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
}

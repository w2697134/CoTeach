import { highlightLines, langLabel } from './code';

/**
 * 模型写的一页 HTML：显示前先收拾干净（不留脚本、事件、外部资源），再包好根元素、给代码上色。
 * 老师改完字，再把页面上的 HTML 收回来（代码块还原成原样的字，去掉上色用的标签）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ALLOWED = new Set(
  (
    'div span p br hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong b em i u s del ins mark small sub sup code pre kbd samp var ' +
    'blockquote q cite abbr time figure figcaption table thead tbody tfoot tr th td caption colgroup col img section article ' +
    'header footer aside main nav address wbr ruby rt rp a ' +
    'svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textpath lineargradient radialgradient stop ' +
    'marker pattern clippath mask title desc image filter fegaussianblur feoffset feblend feflood fecomposite femerge femergenode fedropshadow fecolormatrix'
  ).split(/\s+/),
);
/** 连里面的内容一起去掉 */
const DROP = new Set(
  (
    'script style link meta base iframe frame frameset object embed applet form input button select option optgroup textarea ' +
    'video audio source track canvas template noscript portal slot foreignobject head dialog param map area math'
  ).split(/\s+/),
);
const BAD_ATTR = new Set(['srcset', 'action', 'formaction', 'background', 'poster', 'ping', 'lowsrc', 'dynsrc', 'longdesc', 'manifest', 'codebase', 'data', 'target', 'contenteditable', 'autofocus', 'tabindex', 'accesskey', 'form']);
const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i;
const squash = (v: string) => v.replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase();

/** CSS 里只许 data: 图片和页内的 #引用，别的网址一律去掉 */
export function cleanCss(css: string) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, _q, u: string) => (DATA_IMG.test(u.trim()) || u.trim().startsWith('#') ? `url("${u.trim().replace(/"/g, '%22')}")` : 'none'))
    .replace(/expression\s*\(|javascript:|-moz-binding|behavior\s*:|@import/gi, '');
}

function cleanElement(el: Element) {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    const keep = (() => {
      if (name.startsWith('on')) return false;
      if (BAD_ATTR.has(name)) return false;
      if (name === 'id' && value.startsWith('sk-')) return false;
      if (name === 'href' || name === 'xlink:href') {
        if (value.trim().startsWith('#')) return true;
        return el.localName.toLowerCase() === 'image' && DATA_IMG.test(value.trim());
      }
      if (name === 'src') return el.localName.toLowerCase() === 'img' && DATA_IMG.test(value.trim());
      if (squash(value).includes('javascript:') || squash(value).includes('vbscript:')) return false;
      return true;
    })();
    if (!keep) el.removeAttribute(attr.name);
    else if (name === 'style') el.setAttribute('style', cleanCss(value));
    else if (/url\(/i.test(value) && name !== 'style') {
      const ok = value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, u: string) => (u.trim().startsWith('#') ? m : 'none'));
      el.setAttribute(attr.name, ok);
    }
  }
  if (el.localName.toLowerCase() === 'img' && !el.getAttribute('src')) el.remove();
}

function cleanTree(parent: Element) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      node.remove();
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    const svgTitle = tag === 'title' && el.namespaceURI === SVG_NS;
    if (DROP.has(tag) && !svgTitle) {
      el.remove();
      continue;
    }
    if (!ALLOWED.has(tag)) {
      cleanTree(el);
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    cleanElement(el);
    if (el.isConnected || el.parentNode) cleanTree(el);
  }
}

function parse(html: string) {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, 'text/html');
  cleanTree(doc.body);
  return doc;
}

/** 收拾干净以后的 HTML 字符串 */
export function sanitizeHtml(html: string): string {
  return parse(html).body.innerHTML;
}

const parseMarks = (v: string | null) => {
  const out = new Set<number>();
  for (const part of (v || '').split(/[,\s]+/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]),
      b = Number(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i - a < 200; i++) out.add(i);
  }
  return out;
};

/** 代码块里原样的字 */
function rawCode(pre: Element) {
  const lines = pre.querySelectorAll('.line');
  if (lines.length) return Array.from(lines, (l) => l.textContent || '').join('\n');
  return pre.textContent || '';
}

/** 代码块：分行、上色、标出要突出的行 */
function dressCode(pre: Element) {
  const d = pre.ownerDocument;
  pre.classList.add('code');
  const lang = pre.getAttribute('data-lang') || pre.querySelector('code')?.className.match(/language-([\w+#-]+)/)?.[1] || 'python';
  pre.setAttribute('data-lang', lang);
  pre.setAttribute('data-label', langLabel(lang));
  const text = rawCode(pre)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  const marks = parseMarks(pre.getAttribute('data-mark'));
  pre.classList.toggle('has-mark', marks.size > 0);
  const code = d.createElement('code');
  highlightLines(text, lang).forEach((toks, i) => {
    const line = d.createElement('span');
    line.className = marks.has(i + 1) ? 'line mark' : 'line';
    for (const t of toks) {
      const s = d.createElement('span');
      s.className = t.k ? `tk-${t.k}` : 'tk-x';
      s.textContent = t.t;
      line.appendChild(s);
    }
    if (!toks.length) line.appendChild(d.createElement('br'));
    code.appendChild(line);
  });
  pre.replaceChildren(code);
}

/** 显示用：收拾干净、保证只有一个 .slide 根、代码上色，拿到目标文档里 */
export function buildSlideNode(html: string, target: Document): HTMLElement {
  const doc = parse(html);
  const kids = Array.from(doc.body.childNodes).filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()));
  let root: Element;
  if (kids.length === 1 && kids[0].nodeType === Node.ELEMENT_NODE && (kids[0] as Element).classList.contains('slide')) root = kids[0] as Element;
  else {
    root = doc.createElement('div');
    root.className = 'slide';
    kids.forEach((k) => root.appendChild(k));
  }
  root.querySelectorAll('pre').forEach(dressCode);
  return target.importNode(root, true) as HTMLElement;
}

/** 编辑完收回来：代码块还原成原样的字，其余照样收拾一遍 */
export function serializeSlide(doc: Document): string {
  const live = doc.querySelector('#sk-root > .slide') as HTMLElement | null;
  if (!live) return '';
  const codes = Array.from(live.querySelectorAll('pre'), (pre) => (pre as HTMLElement).innerText.replace(/ /g, ' ').replace(/\n$/, ''));
  const clone = live.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('pre').forEach((pre, i) => {
    pre.classList.remove('has-mark');
    pre.removeAttribute('data-label');
    // 页面为了不折行临时缩的字，不存进去
    (pre as HTMLElement).style.removeProperty('--cfit');
    if (!pre.getAttribute('style')?.trim()) pre.removeAttribute('style');
    const code = pre.ownerDocument.createElement('code');
    code.textContent = codes[i] ?? '';
    pre.replaceChildren(code);
  });
  return sanitizeHtml(clone.outerHTML);
}

/** 这页有没有答案可以揭晓 */
export const htmlHasAnswer = (html: string) => /class\s*=\s*["'][^"']*\banswer\b/i.test(html);

/** 这页是不是封面、章节页（不显示页码） */
export const htmlKind = (html: string): 'cover' | 'section' | 'center' | '' => {
  const m = html.match(/class\s*=\s*["']([^"']*\bslide\b[^"']*)["']/i);
  const cls = m?.[1] || '';
  return /\bcover\b/.test(cls) ? 'cover' : /\bsection\b/.test(cls) ? 'section' : /\bcenter\b/.test(cls) ? 'center' : '';
};

/** 一页里最像标题的字 */
export function htmlTitle(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.querySelector('h1, .title, h2, .question, blockquote');
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** 一页的全部文字（没有排版），给搜索、无障碍、兜底用 */
export function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

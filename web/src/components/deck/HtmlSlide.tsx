import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '../ui/cn';
import { buildSlideNode, serializeSlide } from './html';
import { SLIDE_EDIT_CSS, SLIDE_KIT_CSS } from './kit';

/**
 * 一页 HTML 课件：放在 iframe 沙箱里（不给 allow-scripts，页面里的脚本一律不跑；只留 allow-same-origin，
 * 外面才能量尺寸、开「改字」、导出时读位置）。画布固定 1280×720，按给的宽度整体缩放。
 * 页面里还加了一道 CSP：只许行内样式和 data: 图片，别的外部资源一概不加载。
 */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
const SKELETON = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${SLIDE_KIT_CSS}\n${SLIDE_EDIT_CSS}</style></head><body><div id="sk-root"></div><div class="sk-pageno" contenteditable="false"></div></body></html>`;

export type HtmlCommand = 'bold' | 'mark' | 'addItem' | 'removeItem' | 'toggleAnswer' | 'addRow' | 'removeRow';
export interface HtmlHandle {
  doc: Document;
  run: (cmd: HtmlCommand) => void;
  focus: () => void;
}

export interface HtmlSlideProps {
  html: string;
  theme: string;
  width: number;
  /** 页码（从 0 数）；封面、章节页不显示 */
  index?: number;
  /** 练习页揭晓答案 */
  revealed?: boolean;
  /** 改字：页面里打开 designMode，老师直接点字改 */
  editable?: boolean;
  onEdit?: (html: string) => void;
  /** 页面里按的键交给外面（撤销、重做、放映） */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** 光标在哪种地方：html:li / html:option / html:cell / html:code / html:text */
  onContext?: (kind: string | null) => void;
  bind?: (h: HtmlHandle | null) => void;
  onOverflow?: (overflow: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

const MIN_FIT = 0.5;

function contextOf(doc: Document): string | null {
  const sel = doc.getSelection();
  if (!sel?.rangeCount) return null;
  const n = sel.anchorNode;
  const el = n ? (n.nodeType === 1 ? (n as Element) : n.parentElement) : null;
  if (!el || !doc.getElementById('sk-root')?.contains(el)) return null;
  if (el.closest('pre')) return 'html:code';
  if (el.closest('ol.options > li')) return 'html:option';
  if (el.closest('li')) return 'html:li';
  if (el.closest('td, th')) return 'html:cell';
  return 'html:text';
}

function selectAll(doc: Document, el: Element) {
  const sel = doc.getSelection();
  if (!sel) return;
  const r = doc.createRange();
  r.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(r);
}
function caretEnd(doc: Document, el: Element) {
  const sel = doc.getSelection();
  if (!sel) return;
  const r = doc.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

function runCommand(doc: Document, cmd: HtmlCommand) {
  const sel = doc.getSelection();
  const n = sel?.anchorNode;
  const el = n ? (n.nodeType === 1 ? (n as Element) : n.parentElement) : null;
  if (!el || !doc.getElementById('sk-root')?.contains(el)) return;
  switch (cmd) {
    case 'bold':
      doc.execCommand('bold');
      break;
    case 'mark': {
      const m = el.closest('mark');
      if (m) m.replaceWith(...Array.from(m.childNodes));
      else if (sel && !sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        const mk = doc.createElement('mark');
        mk.appendChild(r.extractContents());
        r.insertNode(mk);
        selectAll(doc, mk);
      }
      break;
    }
    case 'addItem': {
      const li = el.closest('li');
      if (!li) break;
      const item = doc.createElement('li');
      const cls = li.className.replace(/\banswer\b/, '').trim();
      if (cls) item.className = cls;
      item.textContent = '新的一条';
      li.after(item);
      selectAll(doc, item);
      break;
    }
    case 'removeItem': {
      const li = el.closest('li');
      if (!li?.parentElement || li.parentElement.children.length <= 1) break;
      const near = li.previousElementSibling || li.nextElementSibling;
      li.remove();
      if (near) caretEnd(doc, near);
      break;
    }
    case 'toggleAnswer':
      el.closest('ol.options > li')?.classList.toggle('answer');
      break;
    case 'addRow': {
      const tr = el.closest('tr');
      if (!tr) break;
      const row = tr.cloneNode(true) as HTMLTableRowElement;
      row.querySelectorAll('th').forEach((th) => {
        const td = doc.createElement('td');
        th.replaceWith(td);
      });
      row.querySelectorAll('td').forEach((c) => (c.textContent = ''));
      const body = tr.closest('table')?.querySelector('tbody');
      if (tr.parentElement?.localName === 'thead' && body) body.prepend(row);
      else tr.after(row);
      const first = row.querySelector('td');
      if (first) caretEnd(doc, first);
      break;
    }
    case 'removeRow': {
      const tr = el.closest('tbody tr');
      if (!tr?.parentElement || tr.parentElement.children.length <= 1) break;
      const near = tr.previousElementSibling || tr.nextElementSibling;
      tr.remove();
      const cell = near?.querySelector('td');
      if (cell) caretEnd(doc, cell);
      break;
    }
  }
}

export const HtmlSlide = memo(function HtmlSlide(props: HtmlSlideProps) {
  const { html, theme, width, index, revealed, editable, className, style } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  /** 页面上现在放着的那份 HTML（改字时页面就是最新的，不用再塞回去） */
  const shown = useRef<string | null>(null);
  const cbs = useRef(props);
  cbs.current = props;
  const overflowed = useRef(false);

  const attach = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (d?.getElementById('sk-root')) {
      shown.current = null;
      setDoc(d);
    }
  }, []);
  useEffect(() => {
    if (frame.current?.contentDocument?.readyState === 'complete') attach();
  }, [attach]);

  /** 字多了整页缩小：根元素按比例放大排版再缩回来，看着还是 1280×720 */
  const fit = useCallback(() => {
    const d = frame.current?.contentDocument;
    const el = d?.querySelector<HTMLElement>('#sk-root > .slide');
    if (!d || !el) return;
    const over = () => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    const put = (z: number) => d.body.style.setProperty('--fit', z.toFixed(4));
    put(1);
    let z = 1,
      overflow = false;
    if (over()) {
      put(MIN_FIT);
      if (over()) {
        z = MIN_FIT;
        overflow = true;
      } else {
        let lo = MIN_FIT,
          hi = 1;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          put(mid);
          if (over()) hi = mid;
          else lo = mid;
        }
        z = lo;
        put(lo);
      }
    }
    d.body.dataset.fit = String(z);
    if (overflow !== overflowed.current) {
      overflowed.current = overflow;
      cbs.current.onOverflow?.(overflow);
    }
  }, []);

  // 内容、主题、页码、揭晓
  useLayoutEffect(() => {
    if (!doc) return;
    const root = doc.getElementById('sk-root')!;
    if (html !== shown.current) {
      root.replaceChildren(buildSlideNode(html, doc));
      shown.current = html;
    }
    const slide = root.firstElementChild;
    const body = doc.body;
    body.className = `t-${theme}`;
    body.classList.toggle('reveal', !!revealed);
    body.classList.toggle('editing', !!editable);
    body.classList.toggle('no-num', index === undefined || !!slide?.matches('.cover, .section'));
    const num = doc.querySelector('.sk-pageno');
    if (num) num.textContent = index === undefined ? '' : String(index + 1).padStart(2, '0');
    fit();
    frame.current!.dataset.ready = '1';
  }, [doc, html, theme, revealed, index, editable, fit]);

  // 改字
  useEffect(() => {
    if (!doc) return;
    doc.designMode = editable ? 'on' : 'off';
    if (!editable) return;
    const win = doc.defaultView!;
    let raf = 0;
    const emit = () => {
      const out = serializeSlide(doc);
      shown.current = out;
      cbs.current.onEdit?.(out);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    };
    const onKey = (e: KeyboardEvent) => cbs.current.onKeyDown?.(e);
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const t = e.clipboardData?.getData('text/plain');
      if (t) doc.execCommand('insertText', false, t.replace(/\r/g, ''));
    };
    const stop = (e: Event) => e.preventDefault();
    const onSel = () => cbs.current.onContext?.(contextOf(doc));
    const onBlur = () => cbs.current.onContext?.(null);
    doc.addEventListener('input', emit);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('paste', onPaste);
    doc.addEventListener('drop', stop);
    doc.addEventListener('dragstart', stop);
    doc.addEventListener('selectionchange', onSel);
    win.addEventListener('blur', onBlur);
    cbs.current.bind?.({
      doc,
      run: (cmd) => {
        runCommand(doc, cmd);
        emit();
        onSel();
      },
      focus: () => frame.current?.focus(),
    });
    return () => {
      cancelAnimationFrame(raf);
      doc.removeEventListener('input', emit);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('paste', onPaste);
      doc.removeEventListener('drop', stop);
      doc.removeEventListener('dragstart', stop);
      doc.removeEventListener('selectionchange', onSel);
      win.removeEventListener('blur', onBlur);
      cbs.current.bind?.(null);
      doc.designMode = 'off';
    };
  }, [doc, editable, fit]);

  const scale = width / 1280;
  return (
    <div className={cn('dk-frame', className)} style={{ width, height: (width * 720) / 1280, ...style }}>
      <iframe
        ref={frame}
        title="课件"
        srcDoc={SKELETON}
        sandbox="allow-same-origin"
        onLoad={attach}
        tabIndex={editable ? 0 : -1}
        className="dk-html"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1280,
          height: 720,
          border: 0,
          transform: scale !== 1 ? `scale(${scale})` : undefined,
          transformOrigin: '0 0',
          pointerEvents: editable ? 'auto' : 'none',
        }}
      />
    </div>
  );
});

import { createContext, useContext, useLayoutEffect, useRef, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type MutableRefObject, type Ref } from 'react';
import { cn } from '../ui/cn';
import { hasMarks, richHtml, richToRaw } from './rich';
import type { HtmlHandle } from './HtmlSlide';
import type { Slide } from './types';

/* ---------------- 按路径改数据：'points.2'、'table.rows.1.0' ---------------- */
export function getIn(obj: unknown, path: string): any {
  return path.split('.').reduce<any>((o, k) => (o === null || o === undefined ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}
export function setIn<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const rec = (o: any, i: number): any => {
    const k = keys[i];
    const idx = /^\d+$/.test(k) ? Number(k) : k;
    const base = o === undefined || o === null ? (typeof idx === 'number' ? [] : {}) : Array.isArray(o) ? [...o] : { ...o };
    base[idx] = i === keys.length - 1 ? value : rec(o?.[idx], i + 1);
    return base;
  };
  return rec(obj, 0);
}
export const updateIn = <T,>(obj: T, path: string, fn: (v: any) => unknown): T => setIn(obj, path, fn(getIn(obj, path)));

/* ---------------- 编辑时页面和编辑器之间的约定 ---------------- */
export interface FocusRequest {
  key: string;
  caret: number | 'end';
}
export interface EditApi {
  /** 打字：同一处连续打的字合成一步撤销 */
  set: (path: string, value: unknown) => void;
  /** 加一条、删一条、换答案这类改动，每次单独一步 */
  patch: (fn: (s: Slide) => Slide) => void;
  /** 改完让某个格子拿到光标 */
  focus: (key: string, caret?: number | 'end') => void;
  /** 光标进了哪个格子（编辑器按它显示相应的工具） */
  onFocusField?: (key: string | null) => void;
  req: MutableRefObject<FocusRequest | null>;
  tick: number;
  /** HTML 页：页面里按的键交给编辑器（撤销、重做、放映） */
  onFrameKey?: (e: globalThis.KeyboardEvent) => void;
  /** HTML 页：编辑器拿到页面，工具栏的「加粗」「加一条」这些按钮直接改页面 */
  bindHtml?: (h: HtmlHandle | null) => void;
}
export const EditCtx = createContext<EditApi | null>(null);
export const useEdit = () => useContext(EditCtx);

/* ---------------- 光标 ---------------- */
export function caretOffset(el: HTMLElement): number | null {
  const sel = el.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = el.ownerDocument.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
export function placeCaret(el: HTMLElement, at: number | 'end') {
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  if (!sel) return;
  const r = doc.createRange();
  let placed = false;
  if (at !== 'end') {
    let remain = at;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length || 0;
      if (remain <= len) {
        r.setStart(node, remain);
        r.collapse(true);
        placed = true;
        break;
      }
      remain -= len;
    }
  }
  if (!placed) {
    r.selectNodeContents(el);
    r.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------------- 一个能直接点进去改的格子 ---------------- */
export interface FieldProps {
  /** 数据路径，也是这个格子的名字 */
  k: string;
  value: string;
  as?: 'div' | 'span' | 'p' | 'h1' | 'h2' | 'li';
  className?: string;
  style?: CSSProperties;
  /** 空着时的提示（只在编辑时显示） */
  ph?: string;
  multiline?: boolean;
  elRef?: Ref<HTMLElement>;
  onEnter?: (caret: number, text: string) => void;
  onBackspaceStart?: (text: string) => void;
  onTab?: (shift: boolean) => boolean;
  onPasteLines?: (lines: string[], caret: number, text: string) => void;
}

function assignRef<T>(ref: Ref<T> | undefined, v: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') ref(v);
  else (ref as MutableRefObject<T | null>).current = v;
}

export function Field(props: FieldProps) {
  const edit = useEdit();
  if (!edit) {
    const Tag = props.as || 'div';
    return (
      <Tag
        ref={(el: HTMLElement | null) => assignRef(props.elRef, el)}
        className={cn('dk-txt', props.className)}
        style={props.style}
        data-pp="text"
        dangerouslySetInnerHTML={{ __html: richHtml(props.value) }}
      />
    );
  }
  return <EditableField {...props} edit={edit} />;
}

function readText(el: HTMLElement, multiline?: boolean) {
  if (!el.textContent) return '';
  let t = el.innerText.replace(/\r/g, '');
  if (t.endsWith('\n') && !el.textContent.endsWith('\n')) t = t.slice(0, -1);
  return multiline ? t : t.replace(/\n/g, ' ');
}

function EditableField({ k, value, as: Tag = 'div', className, style, ph, multiline, elRef, onEnter, onBackspaceStart, onTab, onPasteLines, edit }: FieldProps & { edit: EditApi }) {
  const ref = useRef<HTMLElement | null>(null);
  const focused = useRef(false);
  /** 自己刚交出去的字：数据回来时是它就不动页面上的字，免得光标乱跳 */
  const mine = useRef<string | null>(null);
  const latest = useRef(value);
  latest.current = value;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (focused.current) {
      if (value !== mine.current) {
        el.textContent = value;
        mine.current = value;
        placeCaret(el, 'end');
      }
    } else el.innerHTML = richHtml(value);
  }, [value]);

  useLayoutEffect(() => {
    const r = edit.req.current;
    const el = ref.current;
    if (!r || r.key !== k || !el) return;
    edit.req.current = null;
    el.focus({ preventScroll: true });
    placeCaret(el, r.caret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.tick]);

  const onFocus = () => {
    const el = ref.current!;
    focused.current = true;
    const v = latest.current;
    mine.current = v;
    if (hasMarks(v)) {
      const off = caretOffset(el);
      el.textContent = v;
      placeCaret(el, off === null ? 'end' : (richToRaw(v)[off] ?? v.length));
    }
    edit.onFocusField?.(k);
  };
  const onBlur = () => {
    focused.current = false;
    mine.current = null;
    const el = ref.current;
    if (el) el.innerHTML = richHtml(latest.current);
    edit.onFocusField?.(null);
  };
  const onInput = () => {
    const t = readText(ref.current!, multiline);
    mine.current = t;
    edit.set(k, t);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const el = ref.current!;
    if (e.key === 'Enter') {
      if (multiline && e.shiftKey) return;
      if (onEnter) {
        e.preventDefault();
        const t = readText(el, multiline);
        onEnter(caretOffset(el) ?? t.length, t);
        return;
      }
      if (!multiline) e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' && onBackspaceStart) {
      const sel = el.ownerDocument.getSelection();
      if (sel?.isCollapsed && caretOffset(el) === 0) {
        e.preventDefault();
        onBackspaceStart(readText(el, multiline));
      }
      return;
    }
    if (e.key === 'Tab' && onTab) {
      if (onTab(e.shiftKey)) e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      el.blur();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const raw = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (!raw) return;
    const text = raw.replace(/\r/g, '').replace(/\t/g, '    ');
    const el = ref.current!;
    if (onPasteLines && text.includes('\n')) {
      const lines = text
        .split('\n')
        .map((x) => x.replace(/^\s*(?:[-*•·]|\d+[.、)])\s+/, '').trim())
        .filter(Boolean);
      if (lines.length > 1) {
        onPasteLines(lines, caretOffset(el) ?? 0, readText(el, multiline));
        return;
      }
    }
    el.ownerDocument.execCommand('insertText', false, multiline ? text : text.replace(/\s*\n\s*/g, ' '));
  };

  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        ref.current = el;
        assignRef(elRef, el);
      }}
      className={cn('dk-txt', className)}
      style={style}
      data-pp="text"
      data-field={k}
      data-ph={ph}
      data-empty={value === '' ? 'true' : undefined}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onFocus={onFocus}
      onBlur={onBlur}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDrop={(e) => e.preventDefault()}
    />
  );
}

/* ---------------- 一列字（要点、对比两边、选项）：回车加一条，删空就去掉，粘贴多行拆成多条 ---------------- */
export interface ListHooks {
  /** 列表变了以后顺带改别的（选项增删时答案跟着挪） */
  onInsert?: (s: Slide, at: number, count: number) => Slide;
  onRemove?: (s: Slide, at: number) => Slide;
}

export function ListField({
  path,
  i,
  value,
  ph,
  className,
  hooks,
  as,
}: {
  path: string;
  i: number;
  value: string;
  ph?: string;
  className?: string;
  hooks?: ListHooks;
  as?: FieldProps['as'];
}) {
  const edit = useEdit();
  const key = `${path}.${i}`;
  if (!edit) return <Field k={key} value={value} className={className} as={as} />;
  const list = (s: Slide): string[] => [...((getIn(s, path) as string[] | undefined) || [])];
  return (
    <Field
      k={key}
      value={value}
      ph={ph}
      as={as}
      className={className}
      onEnter={(caret, text) => {
        edit.patch((s) => {
          const a = list(s);
          while (a.length <= i) a.push('');
          a.splice(i, 1, text.slice(0, caret), text.slice(caret));
          const next = setIn(s, path, a);
          return hooks?.onInsert ? hooks.onInsert(next, i + 1, 1) : next;
        });
        edit.focus(`${path}.${i + 1}`, 0);
      }}
      onBackspaceStart={(text) => {
        let focusKey: string | null = null;
        let caret: number | 'end' = 'end';
        edit.patch((s) => {
          const a = list(s);
          if (i === 0) {
            if (text !== '' || a.length <= 1) return s;
            a.splice(0, 1);
            focusKey = `${path}.0`;
            caret = 0;
          } else {
            const prev = a[i - 1] ?? '';
            a.splice(i - 1, 2, prev + text);
            focusKey = `${path}.${i - 1}`;
            caret = prev.length;
          }
          const next = setIn(s, path, a);
          return hooks?.onRemove ? hooks.onRemove(next, i) : next;
        });
        if (focusKey) edit.focus(focusKey, caret);
      }}
      onPasteLines={(lines, caret, text) => {
        edit.patch((s) => {
          const a = list(s);
          while (a.length <= i) a.push('');
          const before = text.slice(0, caret),
            after = text.slice(caret);
          const add = lines.map((l, j) => (j === 0 ? before + l : l));
          add[add.length - 1] += after;
          a.splice(i, 1, ...add);
          const next = setIn(s, path, a);
          return hooks?.onInsert ? hooks.onInsert(next, i + 1, lines.length - 1) : next;
        });
        edit.focus(`${path}.${i + lines.length - 1}`, 'end');
      }}
    />
  );
}

/** 选项增删时，答案的序号跟着挪 */
export const quizHooks: ListHooks = {
  onInsert: (s, at, count) =>
    s.quiz ? { ...s, quiz: { ...s.quiz, answer: s.quiz.answer.map((a) => (a >= at ? a + count : a)) } } : s,
  onRemove: (s, at) =>
    s.quiz ? { ...s, quiz: { ...s.quiz, answer: s.quiz.answer.filter((a) => a !== at).map((a) => (a > at ? a - 1 : a)) } } : s,
};

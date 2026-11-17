import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  Bold,
  ArrowUp,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  Captions,
  Check,
  ChevronDown,
  Copy,
  Download,
  Ellipsis,
  FileDown,
  FileText,
  Highlighter,
  LayoutTemplate,
  ListPlus,
  LoaderCircle,
  MessageSquareText,
  MonitorPlay,
  Play,
  Plus,
  Presentation,
  Redo2,
  Sparkles,
  SquareCheck,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
} from 'lucide-react';
import { Button, IconButton, MenuItem, Popover } from '../ui';
import { cn } from '../ui/cn';
import { toast } from '../../lib/store';
import { getIn, quizHooks, setIn, type EditApi, type FocusRequest } from './Editable';
import { useDeckHistory } from './history';
import type { HtmlCommand, HtmlHandle } from './HtmlSlide';
import type { HtmlTemplate } from './kit';
import { adaptLayout, blankSlide, cloneSlide, deckTitle, hasAnswer, normalizeDeck, sectionNumbers, uid } from './model';
import { LayoutGrid, TemplateGrid, ThemeGrid } from './Pickers';
import { DeckShow } from './Show';
import { SlideView, useContainWidth } from './Slide';
import { CODE_LANGS } from './code';
import { downloadPptx, printDeck } from './exporting';
import { themeOf } from './themes';
import { LAYOUT_NAMES, type Deck, type Slide, type SlideLayout } from './types';

export interface DeckEditorProps {
  /** 课件内容。编辑器自己记撤销；外面换了新的（比如助教改完一页）也算一步，能撤回 */
  deck: Deck;
  /** 每改一下都会叫（存盘请自己节流） */
  onChange?: (deck: Deck) => void;
  /** 「让助教改这一页」，给的是第几页（从 0 数） */
  onAskAI?: (slideIndex: number) => void;
  /** 正在被助教改的页（slide.id），盖一层「在改」 */
  busy?: string[];
  /** 只看：不能改，能翻、能放映、能导出 */
  readOnly?: boolean;
  /** 导出文件名，默认用封面标题 */
  fileName?: string;
  initialSlide?: number;
  /** 工具栏最左边放的东西（比如返回、课件名） */
  toolbarStart?: ReactNode;
  className?: string;
}

export interface DeckEditorHandle {
  select: (index: number) => void;
  present: (from?: number, presenter?: boolean) => void;
  exportPptx: () => Promise<void>;
  exportPdf: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  getDeck: () => Deck;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 隐私模式 */
    }
  },
};

function useNarrow() {
  const q = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const fn = () => setNarrow(m.matches);
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, []);
  return narrow;
}

export const DeckEditor = forwardRef<DeckEditorHandle, DeckEditorProps>(function DeckEditor(
  { deck: deckProp, onChange, onAskAI, busy = [], readOnly = false, fileName, initialSlide = 0, toolbarStart, className },
  handle,
) {
  const hist = useDeckHistory(() => normalizeDeck(deckProp));
  const deck = hist.deck;
  const slides = deck.slides;
  const [selRaw, setSelRaw] = useState(() => clamp(initialSlide, 0, Math.max(0, slides.length - 1)));
  const sel = clamp(selRaw, 0, Math.max(0, slides.length - 1));
  const selRef = useRef(sel);
  selRef.current = sel;
  const cur: Slide | undefined = slides[sel];
  const narrow = useNarrow();

  /* ---------------- 改动：记进撤销，再告诉外面 ---------------- */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const emitted = useRef<Deck>(deckProp);
  const apply = useCallback(
    (next: Deck, key?: string, nextSel = selRef.current) => {
      if (hist.commit(next, nextSel, key)) {
        emitted.current = next;
        onChangeRef.current?.(next);
      }
    },
    [hist.commit],
  );
  // 外面换了新的课件（比如助教改完了），当作一步改动收进来
  useEffect(() => {
    if (deckProp === emitted.current) return;
    emitted.current = deckProp;
    hist.commit(normalizeDeck(deckProp), selRef.current);
  }, [deckProp, hist]);

  const select = useCallback(
    (i: number) => {
      const n = hist.get().slides.length;
      setSelRaw(clamp(i, 0, Math.max(0, n - 1)));
      hist.cut();
    },
    [hist],
  );
  const updateSlide = useCallback(
    (i: number, fn: (s: Slide) => Slide, key?: string) => {
      const d = hist.get();
      const s = d.slides[i];
      if (!s) return;
      const ns = fn(s);
      if (ns === s) return;
      apply({ ...d, slides: d.slides.map((x, j) => (j === i ? ns : x)) }, key ? `${s.id}:${key}` : undefined, i);
    },
    [apply, hist],
  );
  const setSlides = useCallback(
    (fn: (list: Slide[]) => Slide[], nextSel: number) => {
      const d = hist.get();
      const list = fn(d.slides);
      const s = clamp(nextSel, 0, Math.max(0, list.length - 1));
      setSelRaw(s);
      apply({ ...d, slides: list }, undefined, s);
    },
    [apply, hist],
  );

  /* ---------------- 页面操作 ---------------- */
  const req = useRef<FocusRequest | null>(null);
  const [tick, setTick] = useState(0);
  const focusField = useCallback((key: string, caret: number | 'end' = 'end') => {
    req.current = { key, caret };
    setTick((t) => t + 1);
  }, []);
  /** 新加一页 HTML（照选的样子） */
  const insertHtml = useCallback(
    (at: number, tpl: HtmlTemplate) => {
      const s: Slide = { id: uid(), layout: 'points', title: '', html: tpl.html };
      setSlides((list) => [...list.slice(0, at), s, ...list.slice(at)], at);
    },
    [setSlides],
  );
  const duplicate = useCallback((i: number) => setSlides((list) => [...list.slice(0, i + 1), cloneSlide(list[i]), ...list.slice(i + 1)], i + 1), [setSlides]);
  const remove = useCallback(
    (i: number) =>
      setSlides((list) => {
        const next = list.filter((_, j) => j !== i);
        return next.length ? next : [blankSlide('cover')];
      }, i >= hist.get().slides.length - 1 ? i - 1 : i),
    [setSlides, hist],
  );
  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      setSlides((list) => {
        const a = [...list];
        const [x] = a.splice(from, 1);
        a.splice(to, 0, x);
        return a;
      }, to);
    },
    [setSlides],
  );
  const setLayout = (l: SlideLayout) => cur && updateSlide(sel, (s) => adaptLayout(s, l));
  const setTheme = (id: string) => {
    const d = hist.get();
    if (d.theme !== id) apply({ ...d, theme: id });
  };

  /* ---------------- 编辑大图里的格子 ---------------- */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const blurTimer = useRef<number | undefined>(undefined);
  /** HTML 页：编辑大图里那一页（工具栏按钮直接改它） */
  const htmlPage = useRef<HtmlHandle | null>(null);
  /** 页面里按的键：撤销、重做、放映交给编辑器 */
  const frameKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  const editApi: EditApi = useMemo(
    () => ({
      set: (path, value) => updateSlide(selRef.current, (s) => (getIn(s, path) === value ? s : setIn(s, path, value)), path),
      patch: (fn) => updateSlide(selRef.current, fn),
      focus: focusField,
      onFocusField: (k) => {
        window.clearTimeout(blurTimer.current);
        if (k) setFocusKey(k);
        else blurTimer.current = window.setTimeout(() => setFocusKey(null), 120);
      },
      req,
      tick,
      onFrameKey: (e) => frameKeys.current(e),
      bindHtml: (h) => (htmlPage.current = h),
    }),
    [tick, updateSlide, focusField],
  );
  useEffect(() => setFocusKey(null), [sel]);

  /* ---------------- 练习页在编辑器里揭晓答案 ---------------- */
  const [revealId, setRevealId] = useState<string | null>(null);

  /* ---------------- 放映 ---------------- */
  const [show, setShow] = useState<{ from: number; presenter: boolean } | null>(null);
  const present = useCallback((from = selRef.current, presenter = false) => setShow({ from, presenter }), []);

  /* ---------------- 导出 ---------------- */
  const [answers, setAnswers] = useState(() => store.get('ct-deck-answers') !== '0');
  const [exporting, setExporting] = useState<'pptx' | 'pdf' | null>(null);
  const name = fileName || deckTitle(deck);
  const run = async (kind: 'pptx' | 'pdf') => {
    if (exporting) return;
    setExporting(kind);
    try {
      if (kind === 'pptx') await downloadPptx(hist.get(), { answers, fileName: name });
      else await printDeck(hist.get(), { answers, title: name });
    } catch (e) {
      toast.fromError(e, '导出没成功');
    } finally {
      setExporting(null);
    }
  };

  /* ---------------- 字太多的页 ---------------- */
  const [overflow, setOverflow] = useState<Record<string, boolean>>({});
  const reportOverflow = useCallback((id: string, o: boolean) => setOverflow((m) => (!!m[id] === o ? m : { ...m, [id]: o })), []);

  /* ---------------- 快捷键 ---------------- */
  const root = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  useEffect(() => {
    const down = (e: PointerEvent) => (active.current = !!root.current?.contains(e.target as Node));
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, []);
  const undo = useCallback(() => {
    const s = hist.undo();
    if (s) {
      setSelRaw(s.sel);
      emitted.current = s.deck;
      onChangeRef.current?.(s.deck);
    }
  }, [hist]);
  const redo = useCallback(() => {
    const s = hist.redo();
    if (s) {
      setSelRaw(s.sel);
      emitted.current = s.deck;
      onChangeRef.current?.(s.deck);
    }
  }, [hist]);
  frameKeys.current = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 'F5' || (mod && e.key === 'Enter')) {
      e.preventDefault();
      present(e.key === 'F5' && !e.shiftKey ? 0 : selRef.current);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      root.current?.focus();
    }
  };
  useEffect(() => {
    if (show) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const inside = root.current?.contains(t) || ((t === document.body || t === document.documentElement) && active.current);
      if (!inside || e.defaultPrevented) return;
      const typing = t.isContentEditable || /^(TEXTAREA|INPUT|SELECT)$/.test(t.tagName);
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (!readOnly && mod && !e.altKey && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (!readOnly && mod && k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'F5' || (mod && e.key === 'Enter')) {
        e.preventDefault();
        present(e.key === 'F5' && !e.shiftKey ? 0 : selRef.current);
        return;
      }
      if (typing) return;
      const n = hist.get().slides.length;
      if (!readOnly && mod && k === 'd') {
        e.preventDefault();
        duplicate(selRef.current);
      } else if (!readOnly && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const to = selRef.current + (e.key === 'ArrowUp' ? -1 : 1);
        if (to >= 0 && to < n) move(selRef.current, to);
      } else if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        select(selRef.current + 1);
      } else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        select(selRef.current - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        select(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        select(n - 1);
      } else if (!readOnly && (e.key === 'Delete' || e.key === 'Backspace') && strip.current?.contains(t)) {
        e.preventDefault();
        remove(selRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, readOnly, undo, redo, present, duplicate, move, select, remove, hist]);

  useImperativeHandle(
    handle,
    () => ({
      select,
      present,
      exportPptx: () => run('pptx'),
      exportPdf: () => run('pdf'),
      undo,
      redo,
      getDeck: () => hist.get(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [select, present, undo, redo, hist, answers, name],
  );

  const sections = useMemo(() => sectionNumbers(slides), [slides]);
  const busySet = useMemo(() => new Set(busy), [busy]);
  const theme = themeOf(deck.theme);

  return (
    <div ref={root} className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-surface text-ink', className)}>
      {/* ---------------- 工具栏 ---------------- */}
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line bg-surface px-2.5">
        {toolbarStart}
        {!readOnly && cur && (
          <>
            <IconButton label="撤销 Ctrl+Z" disabled={!hist.canUndo} onMouseDown={(e) => e.preventDefault()} onClick={undo}>
              <Undo2 className="size-[18px]" />
            </IconButton>
            <IconButton label="重做 Ctrl+Y" disabled={!hist.canRedo} onMouseDown={(e) => e.preventDefault()} onClick={redo}>
              <Redo2 className="size-[18px]" />
            </IconButton>
            <Sep />
            <Popover
              align="start"
              trigger={({ toggle, open }) => (
                <Button variant="ghost" size="sm" className={cn(open && 'bg-surface-3 text-ink')} icon={<Plus className="size-4" />} onClick={toggle}>
                  <span className="max-lg:hidden">新建</span>
                </Button>
              )}
            >
              {(close) => (
                <TemplateGrid
                  theme={deck.theme}
                  onPick={(t) => {
                    close();
                    insertHtml(sel + 1, t);
                  }}
                />
              )}
            </Popover>
            {typeof cur.html !== 'string' && (
              <Popover
                align="start"
                trigger={({ toggle, open }) => (
                  <Button variant="ghost" size="sm" className={cn(open && 'bg-surface-3 text-ink')} icon={<LayoutTemplate className="size-4" />} iconRight={<ChevronDown className="size-3.5 opacity-60" />} onClick={toggle}>
                    <span className="max-sm:hidden">{LAYOUT_NAMES[cur.layout]}</span>
                  </Button>
                )}
              >
                {(close) => (
                  <LayoutGrid
                    theme={deck.theme}
                    current={cur.layout}
                    onPick={(l) => {
                      close();
                      setLayout(l);
                    }}
                  />
                )}
              </Popover>
            )}
            <Popover
              align="start"
              trigger={({ toggle, open }) => (
                <Button variant="ghost" size="sm" className={cn(open && 'bg-surface-3 text-ink')} onClick={toggle} iconRight={<ChevronDown className="size-3.5 opacity-60" />}>
                  <span className="flex -space-x-1">
                    {theme.swatch.map((c, i) => (
                      <span key={i} className="size-3.5 rounded-full ring-2 ring-surface" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="max-sm:hidden">{theme.name}</span>
                </Button>
              )}
            >
              {(close) => (
                <ThemeGrid
                  slide={cur}
                  current={deck.theme}
                  onPick={(id) => {
                    close();
                    setTheme(id);
                  }}
                />
              )}
            </Popover>
            <Sep />
          </>
        )}
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {!readOnly && cur && typeof cur.html === 'string' && (
            <HtmlTools
              context={focusKey}
              run={(cmd) => htmlPage.current?.run(cmd)}
              quiz={hasAnswer(cur) || /\boptions\b/.test(cur.html)}
              revealed={revealId === cur.id}
              setRevealed={(v) => setRevealId(v ? cur.id : null)}
            />
          )}
          {!readOnly && cur && typeof cur.html !== 'string' && (
            <SlideTools
              slide={cur}
              focusKey={focusKey}
              patch={(fn) => updateSlide(sel, fn)}
              focus={focusField}
              revealed={revealId === cur.id}
              setRevealed={(v) => setRevealId(v ? cur.id : null)}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pl-1">
          {!readOnly && onAskAI && cur && (
            <Button variant="soft" size="sm" icon={<Sparkles className="size-4" />} onClick={() => onAskAI(sel)} disabled={busySet.has(cur.id)}>
              <span className="max-xl:hidden">让助教改这一页</span>
            </Button>
          )}
          <Popover
            trigger={({ toggle, open }) => (
              <Button
                variant="ghost"
                size="sm"
                className={cn(open && 'bg-surface-3 text-ink')}
                icon={exporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                onClick={toggle}
                disabled={!slides.length}
              >
                <span className="max-md:hidden">导出</span>
              </Button>
            )}
            width={220}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<FileDown />}
                  onClick={() => {
                    close();
                    run('pptx');
                  }}
                >
                  PowerPoint
                </MenuItem>
                <MenuItem
                  icon={<FileText />}
                  onClick={() => {
                    close();
                    run('pdf');
                  }}
                >
                  PDF
                </MenuItem>
                {slides.some((s) => s.layout === 'quiz') && (
                  <>
                    <div className="mx-2 my-1 h-px bg-line" />
                    <MenuItem
                      icon={answers ? <SquareCheck className="text-brand" /> : <span className="size-4 rounded-[4px] border-[1.5px] border-line-strong" />}
                      onClick={() => {
                        store.set('ct-deck-answers', answers ? '0' : '1');
                        setAnswers(!answers);
                      }}
                    >
                      练习附答案页
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Popover>
          <div className="flex">
            <Button variant="primary" size="sm" className="rounded-r-none" icon={<Play className="size-4 fill-current" />} onClick={() => present(sel)} disabled={!slides.length}>
              放映
            </Button>
            <Popover
              trigger={({ toggle }) => (
                <Button variant="primary" size="sm" className="rounded-l-none border-l border-white/25 px-1.5" onClick={toggle} aria-label="放映方式" disabled={!slides.length}>
                  <ChevronDown className="size-4" />
                </Button>
              )}
              width={200}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<Play />}
                    shortcut={<Hint>F5</Hint>}
                    onClick={() => {
                      close();
                      present(0);
                    }}
                  >
                    从头开始
                  </MenuItem>
                  <MenuItem
                    icon={<MonitorPlay />}
                    shortcut={<Hint>⇧F5</Hint>}
                    onClick={() => {
                      close();
                      present(sel);
                    }}
                  >
                    从这一页
                  </MenuItem>
                  <MenuItem
                    icon={<Presentation />}
                    onClick={() => {
                      close();
                      present(sel, true);
                    }}
                  >
                    演讲者视图
                  </MenuItem>
                </>
              )}
            </Popover>
          </div>
        </div>
      </div>

      {/* ---------------- 下面：缩略图 + 大图 + 讲稿 ---------------- */}
      <div className={cn('flex min-h-0 flex-1', narrow ? 'flex-col' : 'flex-row')}>
        <Filmstrip
          ref={strip}
          slides={slides}
          theme={deck.theme}
          sel={sel}
          sections={sections}
          busy={busySet}
          overflow={overflow}
          readOnly={readOnly}
          horizontal={narrow}
          onSelect={select}
          onMove={move}
          onInsert={insertHtml}
          onDuplicate={duplicate}
          onRemove={remove}
          onAskAI={onAskAI}
          reportOverflow={reportOverflow}
        />
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', narrow && 'order-first')}>
          <Canvas
            slide={cur}
            index={sel}
            theme={deck.theme}
            sectionNo={cur ? sections.get(cur.id) : undefined}
            edit={readOnly ? undefined : editApi}
            revealed={!!cur && revealId === cur.id}
            onReveal={(v) => cur && setRevealId(v ? cur.id : null)}
            busy={!!cur && busySet.has(cur.id)}
            overflow={!!cur && !!overflow[cur.id]}
            reportOverflow={reportOverflow}
          />
          {cur && <Notes slide={cur} readOnly={readOnly} onText={(t) => updateSlide(sel, (s) => ({ ...s, notes: t }), 'notes')} narrow={narrow} />}
        </div>
      </div>

      {show && (
        <DeckShow
          deck={deck}
          start={show.from}
          presenter={show.presenter}
          onClose={(i) => {
            setShow(null);
            select(i);
          }}
        />
      )}
    </div>
  );
});

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" />;
const Hint = ({ children }: { children: ReactNode }) => <span className="font-mono text-[12px] text-ink-3">{children}</span>;

/* ================================================================ 按这一页的版式给的小工具 */
function ToolButton({ icon, children, onClick, active, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; active?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-[14px] font-medium transition-colors [&>svg]:size-4',
        danger ? 'text-ink-2 hover:bg-bad-soft hover:text-bad' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        active && 'bg-brand-soft text-brand-ink hover:bg-brand-soft hover:text-brand-ink',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function SlideTools({
  slide: s,
  focusKey,
  patch,
  focus,
  revealed,
  setRevealed,
}: {
  slide: Slide;
  focusKey: string | null;
  patch: (fn: (s: Slide) => Slide) => void;
  focus: (key: string, caret?: number | 'end') => void;
  revealed: boolean;
  setRevealed: (v: boolean) => void;
}) {
  const fk = focusKey || '';
  const out: ReactNode[] = [];
  const subtitle = (
    <ToolButton
      key="sub"
      icon={<Type />}
      active={s.subtitle !== undefined}
      onClick={() => {
        if (s.subtitle === undefined) {
          patch((x) => ({ ...x, subtitle: '' }));
          focus('subtitle', 0);
        } else patch(({ subtitle: _drop, ...x }) => x as Slide);
      }}
    >
      副标题
    </ToolButton>
  );
  /** 往一列字里加一条：光标在哪条就加在它后面，不然加在最后 */
  const addTo = (path: string, at?: number, hooks?: typeof quizHooks) => {
    const list: string[] = getIn(s, path) || [];
    const i = at ?? list.length;
    patch((x) => {
      const a = [...((getIn(x, path) as string[]) || [])];
      a.splice(i, 0, '');
      const next = setIn(x, path, a);
      return hooks?.onInsert ? hooks.onInsert(next, i, 1) : next;
    });
    focus(`${path}.${i}`, 0);
  };
  const removeFrom = (path: string, i: number, hooks?: typeof quizHooks) => {
    patch((x) => {
      const a = [...((getIn(x, path) as string[]) || [])];
      if (a.length <= 1) return setIn(x, path, ['']);
      a.splice(i, 1);
      const next = setIn(x, path, a);
      return hooks?.onRemove ? hooks.onRemove(next, i) : next;
    });
    focus(`${path}.${Math.max(0, i - 1)}`, 'end');
  };
  const listAt = (prefix: string) => {
    const m = fk.match(new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.(\\d+)$`));
    return m ? Number(m[1]) : null;
  };

  switch (s.layout) {
    case 'cover':
    case 'section':
      out.push(subtitle);
      break;
    case 'points':
    case 'summary': {
      const at = listAt('points');
      out.push(
        <ToolButton key="add" icon={<ListPlus />} onClick={() => addTo('points', at === null ? undefined : at + 1)}>
          加一条
        </ToolButton>,
      );
      if (at !== null)
        out.push(
          <ToolButton key="del" icon={<Trash2 />} danger onClick={() => removeFrom('points', at)}>
            删除这条
          </ToolButton>,
        );
      out.push(subtitle);
      break;
    }
    case 'compare': {
      const m = fk.match(/^compare\.(left|right)\.(?:points\.(\d+)|head)$/);
      const side = (m?.[1] as 'left' | 'right') || 'left';
      const at = m?.[2] !== undefined ? Number(m[2]) : null;
      out.push(
        <ToolButton key="addl" icon={<ListPlus />} onClick={() => addTo(`compare.${side}.points`, at === null ? undefined : at + 1)}>
          加一条
        </ToolButton>,
      );
      if (at !== null)
        out.push(
          <ToolButton key="del" icon={<Trash2 />} danger onClick={() => removeFrom(`compare.${side}.points`, at)}>
            删除这条
          </ToolButton>,
        );
      out.push(subtitle);
      break;
    }
    case 'steps': {
      const m = fk.match(/^steps\.(\d+)\./);
      const at = m ? Number(m[1]) : null;
      const n = s.steps?.length || 0;
      out.push(
        <ToolButton
          key="add"
          icon={<Plus />}
          onClick={() => {
            const i = at === null ? n : at + 1;
            patch((x) => {
              const a = [...(x.steps || [])];
              a.splice(i, 0, { head: '' });
              return { ...x, steps: a };
            });
            focus(`steps.${i}.head`, 0);
          }}
        >
          加一步
        </ToolButton>,
      );
      if (at !== null && n > 1) {
        out.push(
          <ToolButton key="up" icon={<ArrowUp />} onClick={() => at > 0 && (patch((x) => ({ ...x, steps: swap(x.steps || [], at, at - 1) })), focus(`steps.${at - 1}.head`))}>
            上移
          </ToolButton>,
          <ToolButton key="down" icon={<ArrowDown />} onClick={() => at < n - 1 && (patch((x) => ({ ...x, steps: swap(x.steps || [], at, at + 1) })), focus(`steps.${at + 1}.head`))}>
            下移
          </ToolButton>,
          <ToolButton
            key="del"
            icon={<Trash2 />}
            danger
            onClick={() => {
              patch((x) => ({ ...x, steps: (x.steps || []).filter((_, j) => j !== at) }));
              focus(`steps.${Math.max(0, at - 1)}.head`);
            }}
          >
            删除这步
          </ToolButton>,
        );
      }
      out.push(subtitle);
      break;
    }
    case 'quiz': {
      const at = listAt('quiz.options');
      const right = at !== null && !!s.quiz?.answer.includes(at);
      out.push(
        <ToolButton key="add" icon={<ListPlus />} onClick={() => addTo('quiz.options', at === null ? undefined : at + 1, quizHooks)}>
          加选项
        </ToolButton>,
      );
      if (at !== null)
        out.push(
          <ToolButton
            key="ans"
            icon={<Check />}
            active={right}
            onClick={() =>
              patch((x) => {
                const cur = new Set(x.quiz?.answer || []);
                if (cur.has(at)) cur.delete(at);
                else cur.add(at);
                return setIn(x, 'quiz.answer', [...cur].sort((a, b) => a - b));
              })
            }
          >
            答案
          </ToolButton>,
          <ToolButton key="del" icon={<Trash2 />} danger onClick={() => removeFrom('quiz.options', at, quizHooks)}>
            删除选项
          </ToolButton>,
        );
      out.push(
        <ToolButton
          key="explain"
          icon={<MessageSquareText />}
          active={revealed}
          onClick={() => {
            if (revealed) setRevealed(false);
            else {
              setRevealed(true);
              focus('quiz.explain', 'end');
            }
          }}
        >
          解析
        </ToolButton>,
      );
      break;
    }
    case 'table': {
      const m = fk.match(/^table\.(?:rows\.(\d+)|head)\.(\d+)$/);
      const row = m ? (m[1] === undefined ? -1 : Number(m[1])) : null;
      const col = m ? Number(m[2]) : null;
      const cols = s.table?.head.length || 1;
      const rows = s.table?.rows.length || 0;
      out.push(
        <ToolButton
          key="row"
          icon={<BetweenHorizontalStart />}
          onClick={() => {
            const at = row === null ? rows : row + 1;
            patch((x) => {
              const r = [...(x.table?.rows || [])];
              r.splice(at, 0, Array(cols).fill(''));
              return { ...x, table: { head: x.table?.head || [''], rows: r } };
            });
            focus(`table.rows.${at}.${col ?? 0}`, 0);
          }}
        >
          加一行
        </ToolButton>,
        <ToolButton
          key="col"
          icon={<BetweenVerticalStart />}
          onClick={() => {
            const at = col === null ? cols : col + 1;
            patch((x) => {
              const t = x.table || { head: [''], rows: [] };
              const ins = (a: string[]) => [...a.slice(0, at), '', ...a.slice(at)];
              return { ...x, table: { head: ins(t.head), rows: t.rows.map(ins) } };
            });
            focus(row === null || row < 0 ? `table.head.${at}` : `table.rows.${row}.${at}`, 0);
          }}
        >
          加一列
        </ToolButton>,
      );
      if (row !== null && row >= 0 && rows > 1)
        out.push(
          <ToolButton
            key="drow"
            icon={<Trash2 />}
            danger
            onClick={() => {
              patch((x) => ({ ...x, table: { ...x.table!, rows: x.table!.rows.filter((_, j) => j !== row) } }));
              focus(`table.rows.${Math.max(0, row - 1)}.${col}`);
            }}
          >
            删这行
          </ToolButton>,
        );
      if (col !== null && cols > 1)
        out.push(
          <ToolButton
            key="dcol"
            icon={<Trash2 />}
            danger
            onClick={() => {
              patch((x) => {
                const t = x.table!;
                const cut = (a: string[]) => a.filter((_, j) => j !== col);
                return { ...x, table: { head: cut(t.head), rows: t.rows.map(cut) } };
              });
              focus(row === null || row < 0 ? `table.head.${Math.max(0, col - 1)}` : `table.rows.${row}.${Math.max(0, col - 1)}`);
            }}
          >
            删这列
          </ToolButton>,
        );
      out.push(subtitle);
      break;
    }
    case 'code': {
      const c = s.code || { lang: 'python', text: '' };
      out.push(
        <label key="lang" className="relative inline-flex h-8 shrink-0 items-center gap-1 rounded-sm px-2.5 text-[14px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink">
          {CODE_LANGS.find((l) => l.id === c.lang)?.label || c.lang}
          <ChevronDown className="size-3.5 opacity-60" />
          <select
            className="absolute inset-0 cursor-pointer opacity-0"
            value={CODE_LANGS.some((l) => l.id === c.lang) ? c.lang : 'text'}
            onChange={(e) => patch((x) => setIn(x, 'code.lang', e.target.value))}
            aria-label="语言"
          >
            {CODE_LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>,
        <ToolButton
          key="mark"
          icon={<Highlighter />}
          active={!!c.mark?.length}
          onClick={() => {
            const ta = document.activeElement as HTMLTextAreaElement | null;
            if (fk === 'code' && ta?.tagName === 'TEXTAREA') {
              const line = ta.value.slice(0, ta.selectionStart).split('\n').length;
              patch((x) => {
                const m = new Set(x.code?.mark || []);
                if (m.has(line)) m.delete(line);
                else m.add(line);
                const arr = [...m].sort((a, b) => a - b);
                return setIn(x, 'code.mark', arr.length ? arr : undefined);
              });
            } else if (c.mark?.length) patch((x) => setIn(x, 'code.mark', undefined));
          }}
        >
          {fk === 'code' ? '突出这行' : c.mark?.length ? '取消突出' : '突出行'}
        </ToolButton>,
        <ToolButton
          key="cap"
          icon={<Captions />}
          active={c.caption !== undefined}
          onClick={() => {
            if (c.caption === undefined) {
              patch((x) => setIn(x, 'code.caption', ''));
              focus('code.caption', 0);
            } else patch((x) => setIn(x, 'code.caption', undefined));
          }}
        >
          说明
        </ToolButton>,
        subtitle,
      );
      break;
    }
    case 'quote':
      break;
  }
  return <>{out}</>;
}

/** HTML 页的小工具：按光标在哪儿给（列表里能加减一条，选项能设答案，表格能加减行） */
function HtmlTools({
  context,
  run,
  quiz,
  revealed,
  setRevealed,
}: {
  context: string | null;
  run: (cmd: HtmlCommand) => void;
  quiz: boolean;
  revealed: boolean;
  setRevealed: (v: boolean) => void;
}) {
  const inText = !!context && context !== 'html:code';
  return (
    <>
      {inText && (
        <>
          <ToolButton icon={<Bold />} onClick={() => run('bold')}>
            加粗
          </ToolButton>
          <ToolButton icon={<Highlighter />} onClick={() => run('mark')}>
            标记
          </ToolButton>
        </>
      )}
      {(context === 'html:li' || context === 'html:option') && (
        <>
          <ToolButton icon={<ListPlus />} onClick={() => run('addItem')}>
            加一条
          </ToolButton>
          <ToolButton icon={<Trash2 />} danger onClick={() => run('removeItem')}>
            删除这条
          </ToolButton>
        </>
      )}
      {context === 'html:option' && (
        <ToolButton icon={<Check />} onClick={() => run('toggleAnswer')}>
          设为答案
        </ToolButton>
      )}
      {context === 'html:cell' && (
        <>
          <ToolButton icon={<BetweenHorizontalStart />} onClick={() => run('addRow')}>
            加一行
          </ToolButton>
          <ToolButton icon={<Trash2 />} danger onClick={() => run('removeRow')}>
            删这行
          </ToolButton>
        </>
      )}
      {quiz && (
        <ToolButton icon={<MessageSquareText />} active={revealed} onClick={() => setRevealed(!revealed)}>
          {revealed ? '收起答案' : '揭晓答案'}
        </ToolButton>
      )}
    </>
  );
}

function swap<T>(a: T[], i: number, j: number) {
  const b = [...a];
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}

/* ================================================================ 中间的大图 */
function Canvas({
  slide,
  index,
  theme,
  sectionNo,
  edit,
  revealed,
  onReveal,
  busy,
  overflow,
  reportOverflow,
}: {
  slide?: Slide;
  index: number;
  theme: string;
  sectionNo?: number;
  edit?: EditApi;
  revealed: boolean;
  onReveal: (v: boolean) => void;
  busy: boolean;
  overflow: boolean;
  reportOverflow: (id: string, o: boolean) => void;
}) {
  const [box, width] = useContainWidth(28);
  const id = slide?.id;
  const onOverflow = useCallback((o: boolean) => id && reportOverflow(id, o), [id, reportOverflow]);
  return (
    <div
      ref={box}
      className="relative min-h-0 flex-1 bg-[color-mix(in_srgb,var(--c-surface-3)_75%,var(--c-bg))]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) (document.activeElement as HTMLElement | null)?.blur?.();
      }}
    >
      {slide && width > 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto relative overflow-hidden rounded-[6px] shadow-lg ring-1 ring-black/5 dark:ring-white/10" style={{ width, height: (width * 9) / 16 }}>
            <SlideView
              key={slide.id}
              slide={slide}
              theme={theme}
              index={index}
              sectionNo={sectionNo}
              width={width}
              mode={edit ? 'edit' : 'view'}
              edit={edit}
              revealed={revealed}
              onReveal={onReveal}
              onOverflow={onOverflow}
            />
            {busy && <BusyCover big />}
          </div>
        </div>
      )}
      {overflow && (
        <span className="absolute left-4 top-3.5 inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-1 text-[13px] font-medium text-warn shadow-xs">
          <TriangleAlert className="size-3.5" />
          字太多
        </span>
      )}
    </div>
  );
}

function BusyCover({ big }: { big?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--c-surface)_55%,transparent)] backdrop-blur-[1.5px]">
      <div className="absolute inset-0 animate-shimmer bg-[linear-gradient(110deg,transparent_30%,color-mix(in_srgb,var(--c-primary)_14%,transparent)_50%,transparent_70%)] bg-[length:200%_100%]" />
      <span className={cn('relative inline-flex items-center gap-2 rounded-full bg-surface font-medium text-brand-ink shadow-md', big ? 'px-4 py-2 text-[14px]' : 'p-1.5')}>
        <LoaderCircle className={cn('animate-spin', big ? 'size-4' : 'size-3.5')} />
        {big && '助教在改这一页'}
      </span>
    </div>
  );
}

/* ================================================================ 讲稿 */
function Notes({ slide, readOnly, onText, narrow }: { slide: Slide; readOnly: boolean; onText: (t: string) => void; narrow: boolean }) {
  const [h, setH] = useState(() => clamp(Number(store.get('ct-deck-notes-h')) || 150, 72, 480));
  const drag = useRef<{ y: number; h: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const max = Math.max(120, window.innerHeight * 0.5);
    setH(clamp(drag.current.h + drag.current.y - e.clientY, 72, max));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    store.set('ct-deck-notes-h', String(Math.round(h)));
  };
  if (readOnly && !slide.notes?.trim()) return null;
  return (
    <div className="relative shrink-0 border-t border-line bg-surface" style={{ height: narrow ? 120 : h }}>
      {!narrow && (
        <div
          className="group absolute inset-x-0 -top-[5px] z-10 flex h-[9px] cursor-row-resize items-center justify-center"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <span className="h-1 w-10 rounded-full bg-line-strong opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      )}
      <div className="flex h-full flex-col px-5 pb-3 pt-2.5">
        <p className="mb-1 text-[13px] font-medium text-ink-3">讲稿</p>
        {readOnly ? (
          <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[15px] leading-7 text-ink-2">{slide.notes}</div>
        ) : (
          <textarea
            key={slide.id}
            className="min-h-0 flex-1 resize-none bg-transparent text-[15px] leading-7 text-ink outline-none placeholder:text-ink-3/70 focus-visible:shadow-none"
            placeholder="这一页要讲的话"
            value={slide.notes || ''}
            onChange={(e) => onText(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

/* ================================================================ 左边的缩略图 */
interface FilmstripProps {
  slides: Slide[];
  theme: string;
  sel: number;
  sections: Map<string, number>;
  busy: Set<string>;
  overflow: Record<string, boolean>;
  readOnly: boolean;
  horizontal: boolean;
  onSelect: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onInsert: (at: number, tpl: HtmlTemplate) => void;
  onDuplicate: (i: number) => void;
  onRemove: (i: number) => void;
  onAskAI?: (i: number) => void;
  reportOverflow: (id: string, o: boolean) => void;
}

const THUMB_W = 168;

const Filmstrip = forwardRef<HTMLDivElement, FilmstripProps>(function Filmstrip(p, outer) {
  const list = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number; x: number; y: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const start = useRef<{ i: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const justDragged = useRef(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [insertFor, setInsertFor] = useState<number | null>(null);
  const { horizontal, onMove } = p;

  // 选中的那页滚到看得见
  useLayoutEffect(() => {
    items.current[p.sel]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [p.sel]);

  const dropIndex = useCallback(
    (x: number, y: number) => {
      const els = items.current.slice(0, p.slides.length);
      for (let i = 0; i < els.length; i++) {
        const r = els[i]?.getBoundingClientRect();
        if (!r) continue;
        if (horizontal ? x < r.left + r.width / 2 : y < r.top + r.height / 2) return i;
      }
      return els.length;
    },
    [p.slides.length, horizontal],
  );

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const d = dragRef.current,
        el = list.current;
      if (d && el) {
        const r = el.getBoundingClientRect();
        const pos = horizontal ? pointer.current.x : pointer.current.y;
        const lo = horizontal ? r.left : r.top,
          hi = horizontal ? r.right : r.bottom;
        const edge = 48;
        const v = pos < lo + edge ? -Math.ceil((lo + edge - pos) / 4) : pos > hi - edge ? Math.ceil((pos - hi + edge) / 4) : 0;
        if (v) {
          if (horizontal) el.scrollLeft += v;
          else el.scrollTop += v;
          const to = dropIndex(pointer.current.x, pointer.current.y);
          if (to !== d.to) setDrag({ ...d, to });
        }
      }
      raf = requestAnimationFrame(loop);
    };
    const move = (e: PointerEvent) => {
      const st = start.current;
      if (!st) return;
      pointer.current = { x: e.clientX, y: e.clientY };
      if (!dragRef.current && Math.hypot(e.clientX - st.x, e.clientY - st.y) < 6) return;
      if (!dragRef.current) raf = requestAnimationFrame(loop);
      setDrag({ from: st.i, to: dropIndex(e.clientX, e.clientY), x: e.clientX - st.ox, y: e.clientY - st.oy });
    };
    const up = () => {
      const st = start.current;
      start.current = null;
      cancelAnimationFrame(raf);
      const d = dragRef.current;
      if (!st || !d) return;
      setDrag(null);
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      if (d.to !== d.from && d.to !== d.from + 1) onMove(d.from, d.to > d.from ? d.to - 1 : d.to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dropIndex, horizontal, onMove]);

  const thumbW = horizontal ? 132 : THUMB_W;
  const dragging = drag ? p.slides[drag.from] : null;

  return (
    <div
      ref={outer}
      className={cn(
        'flex shrink-0 bg-surface-2',
        horizontal ? 'h-[118px] flex-row border-t border-line' : 'w-[214px] flex-col border-r border-line',
      )}
    >
      <div
        ref={list}
        role="listbox"
        aria-label="幻灯片"
        tabIndex={0}
        className={cn('relative min-h-0 flex-1 outline-none', horizontal ? 'flex items-center gap-3 overflow-x-auto px-3' : 'overflow-y-auto px-3 pb-3 pt-3')}
      >
        {p.slides.map((s, i) => (
          <div key={s.id} ref={(el) => void (items.current[i] = el)} className={cn('relative', !horizontal && 'pb-3', horizontal && 'shrink-0')}>
            {drag && drag.to === i && <DropLine horizontal={horizontal} />}
            <Thumb
              slide={s}
              index={i}
              theme={p.theme}
              width={thumbW}
              sectionNo={p.sections.get(s.id)}
              selected={i === p.sel}
              busy={p.busy.has(s.id)}
              overflow={!!p.overflow[s.id]}
              faded={!!drag && drag.from === i}
              horizontal={horizontal}
              reportOverflow={p.reportOverflow}
              onPointerDown={(e) => {
                if (p.readOnly || e.button !== 0) return;
                const r = items.current[i]!.getBoundingClientRect();
                start.current = { i, x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top };
              }}
              onClick={() => !justDragged.current && p.onSelect(i)}
              onContextMenu={(e) => {
                if (p.readOnly) return;
                e.preventDefault();
                p.onSelect(i);
                setMenuFor(i);
              }}
              tools={
                !p.readOnly && (
                  <>
                    <Popover
                      open={menuFor === i}
                      onOpenChange={(v) => setMenuFor(v ? i : null)}
                      width={196}
                      align="start"
                      trigger={({ toggle, open }) => (
                        <button
                          type="button"
                          aria-label="更多"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle();
                          }}
                          className={cn(
                            'flex size-7 items-center justify-center rounded-md bg-surface/95 text-ink-2 shadow-sm ring-1 ring-line transition-opacity hover:text-ink',
                            open ? 'opacity-100' : 'opacity-0 group-hover/thumb:opacity-100 focus-visible:opacity-100',
                          )}
                        >
                          <Ellipsis className="size-4" />
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <MenuItem
                            icon={<Plus />}
                            onClick={() => {
                              close();
                              setInsertFor(i);
                            }}
                          >
                            在后面加一页
                          </MenuItem>
                          <MenuItem
                            icon={<Copy />}
                            shortcut={<Hint>Ctrl+D</Hint>}
                            onClick={() => {
                              close();
                              p.onDuplicate(i);
                            }}
                          >
                            复制
                          </MenuItem>
                          <MenuItem
                            icon={<ArrowUp />}
                            disabled={i === 0}
                            onClick={() => {
                              close();
                              p.onMove(i, i - 1);
                            }}
                          >
                            上移
                          </MenuItem>
                          <MenuItem
                            icon={<ArrowDown />}
                            disabled={i === p.slides.length - 1}
                            onClick={() => {
                              close();
                              p.onMove(i, i + 1);
                            }}
                          >
                            下移
                          </MenuItem>
                          {p.onAskAI && (
                            <MenuItem
                              icon={<Sparkles />}
                              disabled={p.busy.has(s.id)}
                              onClick={() => {
                                close();
                                p.onAskAI!(i);
                              }}
                            >
                              让助教改这一页
                            </MenuItem>
                          )}
                          <div className="mx-2 my-1 h-px bg-line" />
                          <MenuItem
                            icon={<Trash2 />}
                            danger
                            onClick={() => {
                              close();
                              p.onRemove(i);
                            }}
                          >
                            删除
                          </MenuItem>
                        </>
                      )}
                    </Popover>
                  </>
                )
              }
              insert={
                !p.readOnly && (
                  <Popover
                    open={insertFor === i}
                    onOpenChange={(v) => setInsertFor(v ? i : null)}
                    align={horizontal ? 'center' : 'start'}
                    trigger={({ toggle, open }) => (
                      <button
                        type="button"
                        aria-label="在后面加一页"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle();
                        }}
                        className={cn(
                          'flex size-6 items-center justify-center rounded-full bg-brand text-white shadow-md transition-[opacity,transform] hover:scale-110',
                          open ? 'opacity-100' : 'opacity-0 group-hover/thumb:opacity-100 focus-visible:opacity-100',
                        )}
                      >
                        <Plus className="size-3.5" strokeWidth={2.6} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <TemplateGrid
                        theme={p.theme}
                        onPick={(t) => {
                          close();
                          p.onInsert(i + 1, t);
                        }}
                      />
                    )}
                  </Popover>
                )
              }
            />
          </div>
        ))}
        {drag && drag.to === p.slides.length && (
          <div className="relative">
            <DropLine horizontal={horizontal} />
          </div>
        )}
        {!p.readOnly && !horizontal && (
          <Popover
            align="start"
            trigger={({ toggle, open }) => (
              <button
                type="button"
                onClick={toggle}
                className={cn(
                  'ml-[22px] flex h-[52px] w-[168px] items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-[14px] text-ink-3 transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand-ink',
                  open && 'border-brand bg-brand-soft text-brand-ink',
                )}
              >
                <Plus className="size-4" />
                新的一页
              </button>
            )}
          >
            {(close) => (
              <TemplateGrid
                theme={p.theme}
                onPick={(t) => {
                  close();
                  p.onInsert(p.slides.length, t);
                }}
              />
            )}
          </Popover>
        )}
      </div>
      {dragging &&
        drag &&
        createPortal(
          <div className="pointer-events-none fixed z-[120] rotate-[2.5deg] opacity-95" style={{ left: drag.x + (horizontal ? 0 : 22), top: drag.y }}>
            <SlideView slide={dragging} theme={p.theme} width={thumbW} sectionNo={p.sections.get(dragging.id)} className="rounded-[6px] shadow-lg ring-2 ring-brand" />
          </div>,
          document.body,
        )}
    </div>
  );
});

function DropLine({ horizontal }: { horizontal: boolean }) {
  return horizontal ? (
    <span className="absolute -left-[7.5px] top-1/2 z-10 h-[84px] w-[3px] -translate-y-1/2 rounded-full bg-brand" />
  ) : (
    <span className="absolute -top-[7.5px] left-[22px] right-0 z-10 h-[3px] rounded-full bg-brand" />
  );
}

const Thumb = memo(function Thumb({
  slide,
  index,
  theme,
  width,
  sectionNo,
  selected,
  busy,
  overflow,
  faded,
  horizontal,
  reportOverflow,
  onPointerDown,
  onClick,
  onContextMenu,
  tools,
  insert,
}: {
  slide: Slide;
  index: number;
  theme: string;
  width: number;
  sectionNo?: number;
  selected: boolean;
  busy: boolean;
  overflow: boolean;
  faded: boolean;
  horizontal: boolean;
  reportOverflow: (id: string, o: boolean) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  tools?: ReactNode;
  insert?: ReactNode;
}) {
  const onOverflow = useCallback((o: boolean) => reportOverflow(slide.id, o), [slide.id, reportOverflow]);
  return (
    <div className={cn('group/thumb relative flex select-none items-start gap-1.5', faded && 'opacity-35')}>
      {!horizontal && (
        <span className={cn('w-4 shrink-0 pt-0.5 text-right text-[12px] font-medium tabular-nums', selected ? 'text-brand' : 'text-ink-3')}>{index + 1}</span>
      )}
      <div
        role="option"
        aria-selected={selected}
        className={cn(
          'relative cursor-pointer overflow-hidden rounded-[6px] ring-1 transition-shadow',
          selected ? 'ring-[2.5px] ring-brand' : 'ring-line hover:ring-line-strong hover:shadow-sm',
        )}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <SlideView slide={slide} theme={theme} index={index} sectionNo={sectionNo} width={width} onOverflow={onOverflow} />
        {busy && <BusyCover />}
        {overflow && !busy && (
          <span className="absolute bottom-1 left-1 flex size-[18px] items-center justify-center rounded-full bg-warn text-white shadow-sm" title="字太多">
            <TriangleAlert className="size-3" />
          </span>
        )}
        {horizontal && <span className="absolute left-1 top-1 rounded bg-black/45 px-1 text-[11px] font-medium text-white tabular-nums">{index + 1}</span>}
      </div>
      {tools && <div className={cn('absolute top-1', horizontal ? 'right-1' : 'right-1')}>{tools}</div>}
      {insert && <div className={cn('absolute z-10', horizontal ? '-right-[15px] top-1/2 -translate-y-1/2' : '-bottom-[15px] left-[calc(50%+11px)] -translate-x-1/2')}>{insert}</div>}
    </div>
  );
});

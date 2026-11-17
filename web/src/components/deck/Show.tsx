import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AArrowDown, AArrowUp, ChevronLeft, ChevronRight, ExternalLink, Maximize, Minimize, Pause, Play, Presentation, RotateCcw, X } from 'lucide-react';
import { cn } from '../ui/cn';
import { deckTitle, hasAnswer, sectionNumbers } from './model';
import { SlideView, SLIDE_H, SLIDE_W } from './Slide';
import type { Deck } from './types';

export interface DeckShowProps {
  deck: Deck;
  /** 从第几页开始（从 0 数） */
  start?: number;
  /** 一开始就是演讲者视图 */
  presenter?: boolean;
  /** 退出时停在第几页 */
  onClose: (index: number) => void;
}

const fmt = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 隐私模式 */
    }
  },
};

/** 某个窗口里放得下的最大 16:9 */
function useWindowFit(win: Window | null, box?: { current: HTMLElement | null }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const w = win || window;
    const measure = () => {
      const el = box?.current;
      const r = el ? el.getBoundingClientRect() : { width: w.innerWidth, height: w.innerHeight };
      setSize({ w: r.width, h: r.height });
    };
    measure();
    w.addEventListener('resize', measure);
    const ro = box?.current ? new ResizeObserver(measure) : null;
    if (box?.current) ro!.observe(box.current);
    return () => {
      w.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [win, box]);
  return Math.floor(Math.min(size.w, (size.h * SLIDE_W) / SLIDE_H));
}

/**
 * 放映：全屏，← → 空格翻页，Esc 退出。练习页按「下一页」先揭晓答案再翻页。
 * B 黑屏、W 白屏、输入页码回车跳页、S 切换演讲者视图、A 揭晓/收起答案、F 全屏。
 * 演讲者视图：当前页、下一步、讲稿、计时；可以另开一个观众窗口拖到投影上。
 */
export function DeckShow({ deck, start = 0, presenter: presenterStart = false, onClose }: DeckShowProps) {
  const slides = deck.slides;
  const n = slides.length;
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, n - 1)));
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [blank, setBlank] = useState<null | 'black' | 'white'>(null);
  const [presenter, setPresenter] = useState(presenterStart);
  const [jump, setJump] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const cur = slides[index];
  const isRevealed = !!cur && revealed.has(cur.id);
  const sections = useMemo(() => sectionNumbers(slides), [slides]);
  const indexRef = useRef(index);
  indexRef.current = index;

  // 计时（paused 不是 0 就是停着的）
  const [clock, setClock] = useState(() => Date.now());
  const [timer, setTimer] = useState<{ base: number; paused: number; acc: number }>(() => ({ base: Date.now(), paused: 0, acc: 0 }));
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = timer.paused ? timer.acc : timer.acc + (clock - timer.base);

  /* ---------------- 翻页 ---------------- */
  const reveal = useCallback(
    (v: boolean) => {
      const s = slides[indexRef.current];
      if (!s) return;
      setRevealed((r) => {
        const next = new Set(r);
        if (v) next.add(s.id);
        else next.delete(s.id);
        return next;
      });
    },
    [slides],
  );
  const go = useCallback((i: number) => {
    setBlank(null);
    setIndex(Math.max(0, Math.min(n - 1, i)));
  }, [n]);
  const next = useCallback(() => {
    const s = slides[indexRef.current];
    setBlank(null);
    if (hasAnswer(s) && !revealedRef.current.has(s.id)) return reveal(true);
    go(indexRef.current + 1);
  }, [slides, go, reveal]);
  const prev = useCallback(() => go(indexRef.current - 1), [go]);
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;

  /* ---------------- 全屏 ---------------- */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [full, setFull] = useState(false);
  const wasFull = useRef(false);
  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    closeRef.current(indexRef.current);
  }, []);
  useEffect(() => {
    const el = root.current;
    el?.requestFullscreen?.().catch(() => {});
    const onChange = () => {
      const on = !!document.fullscreenElement;
      setFull(on);
      if (on) wasFull.current = true;
      // 按 Esc 退出全屏时，浏览器不把按键交给网页，这里当作退出放映
      else if (wasFull.current) closeRef.current(indexRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.body.style.overflow = prevOverflow;
    };
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) {
      wasFull.current = false;
      document.exitFullscreen().catch(() => {});
    } else root.current?.requestFullscreen?.().catch(() => {});
  };

  /* ---------------- 观众窗口（演讲者视图时另开，拖到投影上） ---------------- */
  const [popup, setPopup] = useState<{ win: Window; el: HTMLElement } | null>(null);
  const openAudience = () => {
    if (popup && !popup.win.closed) return popup.win.focus();
    const win = window.open('', 'coteach-deck-audience', 'popup=yes,width=1280,height=760');
    if (!win) return;
    const doc = win.document;
    doc.title = deckTitle(deck);
    doc.head.innerHTML = '<meta charset="utf-8">';
    document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => doc.head.appendChild(node.cloneNode(true)));
    doc.documentElement.dataset.theme = 'dark';
    doc.body.innerHTML = '';
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    win.addEventListener('pagehide', () => setPopup(null));
    setPopup({ win, el });
  };
  useEffect(() => () => popup?.win.close(), [popup]);

  /* ---------------- 按键 ---------------- */
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const k = e.key;
      if (/^\d$/.test(k)) {
        setJump((j) => (j + k).slice(-3));
        return;
      }
      if (k === 'Enter' && jumpRef.current) {
        e.preventDefault();
        go(Number(jumpRef.current) - 1);
        setJump('');
        return;
      }
      setJump('');
      const lower = k.toLowerCase();
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k) || lower === 'n') {
        e.preventDefault();
        next();
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k) || lower === 'p') {
        e.preventDefault();
        prev();
      } else if (k === 'Home') go(0);
      else if (k === 'End') go(n - 1);
      else if (lower === 'b' || k === '.') setBlank((b) => (b === 'black' ? null : 'black'));
      else if (lower === 'w' || k === ',') setBlank((b) => (b === 'white' ? null : 'white'));
      else if (lower === 's') setPresenter((v) => !v);
      else if (lower === 'a') reveal(!revealedRef.current.has(slides[indexRef.current]?.id));
      else if (lower === 'f') toggleFull();
      else if (k === 'Escape') {
        e.preventDefault();
        if (blank) setBlank(null);
        else exit();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [next, prev, go, n, reveal, exit, blank, slides],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    const pw = popup?.win;
    pw?.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      pw?.removeEventListener('keydown', onKey);
    };
  }, [onKey, popup]);

  const audienceProps = {
    deck,
    index,
    sections,
    revealed: isRevealed,
    onReveal: reveal,
    blank,
    next,
    prev,
    jump,
  };

  return createPortal(
    <div ref={root} className="fixed inset-0 z-[200] select-none bg-black text-white" data-theme="dark">
      {presenter ? (
        <PresenterView
          {...audienceProps}
          elapsed={elapsed}
          clock={clock}
          paused={!!timer.paused}
          onPause={() =>
            setTimer((t) => (t.paused ? { base: Date.now(), paused: 0, acc: t.acc } : { base: t.base, paused: Date.now(), acc: t.acc + (Date.now() - t.base) }))
          }
          onResetTimer={() => setTimer({ base: Date.now(), paused: 0, acc: 0 })}
          go={go}
          full={full}
          toggleFull={toggleFull}
          onAudience={openAudience}
          audienceOpen={!!popup}
          onExit={exit}
          onToggleView={() => setPresenter(false)}
        />
      ) : (
        <AudienceView {...audienceProps} win={null} controls={{ full, toggleFull, onExit: exit, onPresenter: () => setPresenter(true) }} />
      )}
      {popup &&
        createPortal(
          <div className="fixed inset-0 bg-black text-white">
            <AudienceView {...audienceProps} win={popup.win} controls={{ full: false, toggleFull: () => popup.el.ownerDocument.documentElement.requestFullscreen?.().catch(() => {}) }} />
          </div>,
          popup.el,
        )}
    </div>,
    document.body,
  );
}

interface AudienceProps {
  deck: Deck;
  index: number;
  sections: Map<string, number>;
  revealed: boolean;
  onReveal: (v: boolean) => void;
  blank: null | 'black' | 'white';
  next: () => void;
  prev: () => void;
  jump: string;
}

/** 观众看到的：只有这一页，鼠标一动才露出底下的小工具条 */
function AudienceView({
  deck,
  index,
  sections,
  revealed,
  onReveal,
  blank,
  next,
  prev,
  jump,
  win,
  controls,
}: AudienceProps & { win: Window | null; controls: { full: boolean; toggleFull: () => void; onExit?: () => void; onPresenter?: () => void } }) {
  const width = useWindowFit(win);
  const s = deck.slides[index];
  const [awake, setAwake] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  const w = win || window;
  const wake = () => {
    setAwake(true);
    w.clearTimeout(timer.current);
    timer.current = w.setTimeout(() => setAwake(false), 2200);
  };
  useEffect(() => {
    wake();
    return () => w.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ cursor: awake ? 'default' : 'none' }}
      onMouseMove={wake}
      onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY })}
      onPointerUp={(e) => {
        const st = swipe.current;
        swipe.current = null;
        if (!st || e.button !== 0) return;
        if ((e.target as HTMLElement).closest('button, a, select')) return;
        const dx = e.clientX - st.x;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - st.y)) return dx < 0 ? next() : prev();
        if (Math.abs(dx) < 8) next();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        prev();
      }}
    >
      <AnimatePresence initial={false}>
        {s && width > 0 && (
          <motion.div
            key={s.id}
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0, scale: 1.012 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <SlideView slide={s} theme={deck.theme} index={index} sectionNo={sections.get(s.id)} width={width} mode="show" revealed={revealed} onReveal={onReveal} />
          </motion.div>
        )}
      </AnimatePresence>
      {blank && <div className={cn('absolute inset-0', blank === 'black' ? 'bg-black' : 'bg-white')} />}
      {jump && (
        <div className="absolute left-1/2 top-8 -translate-x-1/2 rounded-xl bg-black/70 px-5 py-2.5 text-[28px] font-semibold tabular-nums text-white shadow-lg">{jump}</div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/5">
        <div className="h-full bg-[#7b7ff5] transition-[width] duration-300" style={{ width: `${((index + 1) / Math.max(1, deck.slides.length)) * 100}%` }} />
      </div>
      <div
        className={cn(
          'absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#14161d]/85 p-1.5 text-white shadow-lg ring-1 ring-white/10 backdrop-blur transition-opacity duration-300',
          awake ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <RoundBtn label="上一页" onClick={prev}>
          <ChevronLeft className="size-5" />
        </RoundBtn>
        <span className="min-w-[64px] text-center text-[14px] tabular-nums text-white/80">
          {index + 1} / {deck.slides.length}
        </span>
        <RoundBtn label="下一页" onClick={next}>
          <ChevronRight className="size-5" />
        </RoundBtn>
        {typeof s?.html === 'string' && hasAnswer(s) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReveal(!revealed);
            }}
            className={cn('ml-1 h-9 rounded-full px-3.5 text-[14px] font-medium transition-colors', revealed ? 'bg-emerald-500/90 text-white hover:bg-emerald-500' : 'text-white/85 hover:bg-white/12')}
          >
            {revealed ? '收起答案' : '揭晓答案'}
          </button>
        )}
        <span className="mx-1 h-5 w-px bg-white/15" />
        {controls.onPresenter && (
          <RoundBtn label="演讲者视图 S" onClick={controls.onPresenter}>
            <Presentation className="size-[18px]" />
          </RoundBtn>
        )}
        <RoundBtn label={controls.full ? '退出全屏 F' : '全屏 F'} onClick={controls.toggleFull}>
          {controls.full ? <Minimize className="size-[18px]" /> : <Maximize className="size-[18px]" />}
        </RoundBtn>
        {controls.onExit && (
          <RoundBtn label="退出 Esc" onClick={controls.onExit}>
            <X className="size-5" />
          </RoundBtn>
        )}
      </div>
    </div>
  );
}

function RoundBtn({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn('flex size-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/12 hover:text-white', active && 'bg-white/15 text-white')}
    >
      {children}
    </button>
  );
}

/** 演讲者视图：当前页大图、下一步、讲稿、计时、跳页 */
function PresenterView({
  deck,
  index,
  sections,
  revealed,
  onReveal,
  blank,
  next,
  prev,
  jump,
  elapsed,
  clock,
  paused,
  onPause,
  onResetTimer,
  go,
  full,
  toggleFull,
  onAudience,
  audienceOpen,
  onExit,
  onToggleView,
}: AudienceProps & {
  elapsed: number;
  clock: number;
  paused: boolean;
  onPause: () => void;
  onResetTimer: () => void;
  go: (i: number) => void;
  full: boolean;
  toggleFull: () => void;
  onAudience: () => void;
  audienceOpen: boolean;
  onExit: () => void;
  onToggleView: () => void;
}) {
  const slides = deck.slides;
  const s = slides[index];
  const pendingReveal = hasAnswer(s) && !revealed;
  const nextSlide = pendingReveal ? s : slides[index + 1];
  const mainBox = useRef<HTMLDivElement>(null);
  const nextBox = useRef<HTMLDivElement>(null);
  const mainW = useWindowFit(null, mainBox);
  const nextW = useWindowFit(null, nextBox);
  const [fs, setFs] = useState(() => Number(store.get('ct-deck-notes-fs')) || 22);
  const font = (d: number) => {
    const v = Math.max(14, Math.min(40, fs + d));
    setFs(v);
    store.set('ct-deck-notes-fs', String(v));
  };
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [index]);
  const time = new Date(clock);
  return (
    <div className="absolute inset-0 flex flex-col bg-[#0f1117] text-[#e8ebf3]">
      {/* 顶栏：计时、时钟、页码 */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.07] px-5">
        <div className="flex items-center gap-1.5">
          <span className={cn('min-w-[86px] text-[24px] font-semibold tabular-nums tracking-tight', paused && 'text-white/40')}>{fmt(elapsed)}</span>
          <RoundBtn label={paused ? '继续计时' : '暂停计时'} onClick={onPause}>
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </RoundBtn>
          <RoundBtn label="重新计时" onClick={onResetTimer}>
            <RotateCcw className="size-4" />
          </RoundBtn>
        </div>
        <span className="mx-auto text-[17px] tabular-nums text-white/55">
          {String(time.getHours()).padStart(2, '0')}:{String(time.getMinutes()).padStart(2, '0')}
        </span>
        <span className="text-[15px] tabular-nums text-white/70">
          {index + 1} / {slides.length}
        </span>
        {blank && <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[13px] text-white/80">{blank === 'black' ? '黑屏' : '白屏'}</span>}
        <span className="h-5 w-px bg-white/10" />
        <button
          type="button"
          onClick={onAudience}
          className={cn('flex h-9 items-center gap-1.5 rounded-lg px-3 text-[14px] text-white/80 transition-colors hover:bg-white/10 hover:text-white', audienceOpen && 'bg-white/10 text-white')}
        >
          <ExternalLink className="size-4" />
          观众窗口
        </button>
        <RoundBtn label="只看幻灯片 S" onClick={onToggleView}>
          <Presentation className="size-[18px]" />
        </RoundBtn>
        <RoundBtn label={full ? '退出全屏 F' : '全屏 F'} onClick={toggleFull}>
          {full ? <Minimize className="size-[18px]" /> : <Maximize className="size-[18px]" />}
        </RoundBtn>
        <RoundBtn label="退出 Esc" onClick={onExit}>
          <X className="size-5" />
        </RoundBtn>
      </div>

      {/* 中间：当前页 | 下一步 + 讲稿 */}
      <div className="flex min-h-0 flex-1 gap-5 p-5">
        <div className="flex min-w-0 flex-[1.65] flex-col">
          <p className="mb-2 flex items-center gap-2 text-[13px] font-medium text-white/45">
            当前
            {jump && <span className="rounded bg-white/10 px-1.5 text-white/90 tabular-nums">跳到 {jump}</span>}
          </p>
          <div ref={mainBox} className="relative min-h-0 flex-1">
            {s && mainW > 0 && (
              <div className="absolute inset-0 flex items-start justify-center">
                <div className="overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10">
                  <SlideView slide={s} theme={deck.theme} index={index} sectionNo={sections.get(s.id)} width={mainW} mode="show" revealed={revealed} onReveal={onReveal} />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex h-[38%] min-h-[150px] flex-col">
            <p className="mb-2 text-[13px] font-medium text-white/45">{pendingReveal ? '下一步 · 揭晓答案' : '下一页'}</p>
            <div ref={nextBox} className="relative min-h-0 flex-1">
              {nextSlide && nextW > 0 ? (
                <div className="absolute inset-0 flex items-start justify-start">
                  <div className="overflow-hidden rounded-md opacity-90 ring-1 ring-white/10">
                    <SlideView
                      slide={nextSlide}
                      theme={deck.theme}
                      index={pendingReveal ? index : index + 1}
                      sectionNo={sections.get(nextSlide.id)}
                      width={nextW}
                      revealed={pendingReveal}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center rounded-md border border-dashed border-white/15 text-[15px] text-white/40">结束</div>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-white/[0.04] ring-1 ring-white/[0.06]">
            <div className="flex items-center gap-1 px-4 pt-2.5">
              <p className="flex-1 text-[13px] font-medium text-white/45">讲稿</p>
              <RoundBtn label="字小一点" onClick={() => font(-2)}>
                <AArrowDown className="size-[18px]" />
              </RoundBtn>
              <RoundBtn label="字大一点" onClick={() => font(2)}>
                <AArrowUp className="size-[18px]" />
              </RoundBtn>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-4 pb-4 pt-1 leading-[1.7] text-white/90" style={{ fontSize: fs }}>
              {s?.notes?.trim() || <span className="text-white/30">—</span>}
            </div>
          </div>
        </div>
      </div>

      {/* 底下：翻页、揭晓、缩略图 */}
      <div className="flex h-[104px] shrink-0 items-center gap-3 border-t border-white/[0.07] px-5">
        <button type="button" onClick={prev} disabled={index === 0} className="flex h-12 items-center gap-1 rounded-xl bg-white/[0.06] pl-3 pr-4 text-[15px] transition-colors hover:bg-white/12 disabled:opacity-30">
          <ChevronLeft className="size-5" />
          上一页
        </button>
        <button
          type="button"
          onClick={next}
          disabled={index === slides.length - 1 && !pendingReveal}
          className="flex h-12 items-center gap-1 rounded-xl bg-[#6366f1] pl-4 pr-3 text-[15px] font-medium text-white transition-colors hover:bg-[#7174f6] disabled:opacity-30"
        >
          {pendingReveal ? '揭晓答案' : '下一页'}
          <ChevronRight className="size-5" />
        </button>
        {hasAnswer(s) && revealed && (
          <button type="button" onClick={() => onReveal(false)} className="h-12 rounded-xl px-3 text-[14px] text-white/60 hover:bg-white/10 hover:text-white">
            收起答案
          </button>
        )}
        <div ref={strip} className="no-scrollbar ml-2 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-2">
          {slides.map((x, i) => (
            <button
              key={x.id}
              type="button"
              data-i={i}
              onClick={() => go(i)}
              className={cn('relative shrink-0 overflow-hidden rounded-[4px] ring-1 transition', i === index ? 'ring-2 ring-[#818cf8]' : 'opacity-55 ring-white/10 hover:opacity-90')}
            >
              <SlideView slide={x} theme={deck.theme} index={i} sectionNo={sections.get(x.id)} width={112} />
              <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10.5px] tabular-nums text-white">{i + 1}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

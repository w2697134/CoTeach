import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '../../components/ui';
import { SlideThumb } from './Slides';
import type { Deck } from './data';

/**
 * 课件这一栏（课件组件接进来之前的样子）：左边一页页缩略图，中间是选中的那一页，下面是讲稿。
 */
export function DeckPane({ deck, page, onPage }: { deck: Deck; page: number; onPage: (i: number) => void; onChange?: (d: Deck) => Promise<void> }) {
  const s = deck.slides[Math.min(page, deck.slides.length - 1)];
  return (
    <div className="flex gap-4">
      <ol className="no-scrollbar hidden max-h-[calc(100vh-260px)] w-44 shrink-0 space-y-2.5 overflow-y-auto pr-1 md:block">
        {deck.slides.map((x, i) => (
          <li key={x.id}>
            <button type="button" onClick={() => onPage(i)} className="flex w-full gap-1.5 text-left">
              <span className="w-4 pt-1 text-right text-[11.5px] text-ink-3">{i + 1}</span>
              <span className={cn('aspect-video flex-1 overflow-hidden rounded-md border', page === i ? 'border-brand ring-2 ring-brand/20' : 'border-line')}>
                <SlideThumb slide={x} theme={deck.theme} />
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="min-w-0 flex-1">
        <div className="aspect-video overflow-hidden rounded-xl border border-line shadow-sm">{s && <SlideThumb slide={s} theme={deck.theme} />}</div>
        {s?.notes && (
          <div className="mt-3 rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-[12.5px] font-medium text-ink-3">讲稿</p>
            <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{s.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** 全屏放映：左右键、空格翻页，Esc 退出 */
export function Present({ deck, start, onClose }: { deck: Deck; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') setI((x) => Math.min(deck.slides.length - 1, x + 1));
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', on);
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      window.removeEventListener('keydown', on);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, [deck.slides.length, onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black">
      <div className="aspect-video w-full max-w-[calc(100vh*16/9)]">
        <SlideThumb slide={deck.slides[i]} theme={deck.theme} />
      </div>
      <div className="absolute bottom-4 right-4 flex items-center gap-2 text-white/70">
        <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={() => setI(Math.max(0, i - 1))} aria-label="上一页">
          <ChevronLeft className="size-5" />
        </button>
        <span className="text-[13px] tabular-nums">
          {i + 1} / {deck.slides.length}
        </span>
        <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={() => setI(Math.min(deck.slides.length - 1, i + 1))} aria-label="下一页">
          <ChevronRight className="size-5" />
        </button>
        <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={onClose} aria-label="退出放映">
          <X className="size-5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

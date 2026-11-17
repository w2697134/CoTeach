import { motion } from 'motion/react';
import { cn } from '../../components/ui';
import { SlideThumb } from './Slides';
import type { Slide } from './data';

/**
 * 还在备的时候，课件这一栏：写出来一页就摆一页（先按版式显示，淡一点），排好版的那一页换成幻灯片。
 * writing：课件内容还在写，最后一页正在写；pages：排好版还没存进课件的页（第几页 → HTML）。
 */
export function LiveDeck({ slides, theme, pages, writing }: { slides: Slide[]; theme?: string; pages?: Record<string, string>; writing: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 2xl:grid-cols-4">
      {slides.map((s, i) => {
        const html = s.html || pages?.[i];
        const now = writing && i === slides.length - 1;
        return (
          // 编号按第几页：同一页写着写着不会每次都当成新的；排好版换成幻灯片时重新淡入一次
          <motion.figure
            key={`${i}-${html ? 'made' : 'draft'}`}
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            <div
              className={cn(
                'relative aspect-video overflow-hidden rounded-lg border bg-surface shadow-xs transition-opacity',
                html ? 'border-line' : 'border-dashed border-line-strong opacity-75',
                now && 'ring-2 ring-brand/40',
              )}
            >
              <SlideThumb slide={html ? { ...s, html } : s} theme={theme} />
            </div>
            <figcaption className="mt-1.5 flex items-center gap-1.5 text-[13px]">
              <span className="tabular-nums text-ink-3">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2">{s.title}</span>
              {now && (
                <span className="flex shrink-0 items-center gap-1 text-brand-ink">
                  <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                  正在写这页
                </span>
              )}
            </figcaption>
          </motion.figure>
        );
      })}
    </div>
  );
}

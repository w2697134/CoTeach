import { cn } from '../../components/ui';
import type { Slide } from './data';

/**
 * 课件的一页缩成卡片封面。课件组件（components/deck）接进来以后换成那边的渲染。
 * 用容器的宽度算字号（cqw），多大都一个样子。
 */
export function SlideThumb({ slide, theme, className }: { slide: Slide; theme?: string; className?: string }) {
  const dark = theme === 'stage';
  return (
    <div
      className={cn('relative h-full w-full overflow-hidden [container-type:inline-size]', className)}
      style={{
        background: dark
          ? 'linear-gradient(135deg,#141a33 0%,#1f2550 100%)'
          : 'radial-gradient(circle at 92% 8%, rgba(124,108,255,.18) 0 18%, transparent 18.5%), linear-gradient(135deg,#ffffff 0%,#f4f1ff 55%,#eafaf7 100%)',
      }}
    >
      <div className="absolute inset-0 flex flex-col justify-center px-[8cqw]">
        {slide.layout === 'cover' || slide.layout === 'section' ? (
          <>
            <span className="mb-[2cqw] h-[0.9cqw] w-[9cqw] rounded-full bg-gradient-to-r from-[#6c5ce7] to-[#2ec4b0]" />
            <p className={cn('line-clamp-2 text-[6.6cqw] font-bold leading-tight', dark ? 'text-white' : 'text-[#1b1f3b]')}>{slide.title}</p>
            {slide.subtitle && <p className={cn('mt-[1.6cqw] line-clamp-1 text-[3cqw]', dark ? 'text-white/70' : 'text-[#5b6178]')}>{slide.subtitle}</p>}
          </>
        ) : (
          <>
            <p className={cn('line-clamp-1 text-[4.6cqw] font-bold', dark ? 'text-white' : 'text-[#1b1f3b]')}>{slide.title}</p>
            {(slide.points || []).slice(0, 4).map((p, i) => (
              <p key={i} className={cn('mt-[1.2cqw] line-clamp-1 text-[2.6cqw]', dark ? 'text-white/75' : 'text-[#4a5068]')}>
                · {p}
              </p>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

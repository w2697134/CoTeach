import { SlideView } from '../../components/deck';
import { useContainWidth } from '../../components/deck/Slide';
import type { Slide as DeckSlide } from '../../components/deck';
import { cn } from '../../components/ui';
import type { Slide } from './data';

/**
 * 课件的一页缩成卡片封面、课堂里的大图：用课件组件同一个渲染（有 HTML 的按 HTML，没有的按版式），按盒子大小缩放。
 */
export function SlideThumb({ slide, theme, className }: { slide: Slide; theme?: string; className?: string }) {
  const [ref, w] = useContainWidth();
  return (
    <div ref={ref} className={cn('flex h-full w-full items-center justify-center overflow-hidden', className)}>
      {w > 0 && <SlideView slide={slide as unknown as DeckSlide} theme={theme} width={w} />}
    </div>
  );
}

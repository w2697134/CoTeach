import { Check } from 'lucide-react';
import { cn } from '../../components/ui';
import { INK } from '../classes/tone';
import { optionText, type Bar } from './data';

/**
 * 作答的条形图（雨课堂的选项分布）：一行一个选项，条的长短是选它的人占答了的人的比例，后面写几个人。
 * mark：标出正确的那几行（老师自己看的一直标，学生和大屏公布了才标）。big 是大屏上用的大字；withText 在条上面写选项原文。
 */
export function Bars({ bars, answered, mark, big, withText, className }: { bars: Bar[]; answered: number; mark: boolean; big?: boolean; withText?: boolean; className?: string }) {
  const most = Math.max(1, answered);
  return (
    <ul className={cn(big ? 'space-y-[1.6vmin]' : withText ? 'space-y-2.5' : 'space-y-1.5', className)}>
      {bars.map((b, i) => {
        const right = mark && b.right;
        const share = b.count / most;
        return (
          <li key={i} className={cn('flex items-center', big ? 'gap-[1.6vmin]' : 'gap-2.5')}>
            <span
              className={cn(
                'flex shrink-0 items-center justify-center font-semibold',
                big ? 'size-[5vmin] min-h-9 min-w-9 rounded-[1.2vmin] text-[clamp(16px,2.6vmin,30px)]' : 'size-7 rounded-md text-[13px]',
                right ? 'bg-[#047857] text-white dark:bg-[#10b981]' : 'bg-surface-3 text-ink-2',
                b.label.length > 2 && 'w-auto px-2',
              )}
              title={b.text && optionText(b.text, b.label)}
            >
              {b.label.length > 8 ? `${b.label.slice(0, 8)}…` : b.label}
            </span>
            <div className="min-w-0 flex-1">
              {(big || withText) && b.text && (
                <p className={cn('truncate', big ? 'mb-[0.6vmin] text-[clamp(14px,2.2vmin,26px)] text-ink-2' : 'mb-1 text-[14px] text-ink')}>{optionText(b.text, b.label)}</p>
              )}
              <div className={cn('relative overflow-hidden rounded-full bg-surface-3', big ? 'h-[2.4vmin] min-h-3' : 'h-2.5')}>
                <div
                  className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out', right ? 'bg-[#10b981]' : 'bg-brand/75')}
                  style={{ width: `${Math.round(share * 100)}%` }}
                />
              </div>
            </div>
            <span className={cn('shrink-0 text-right tabular-nums', big ? 'w-[12vmin] text-[clamp(15px,2.4vmin,28px)]' : 'w-16 text-[14px]', right ? cn('font-semibold', INK.ok) : 'text-ink-2')}>
              {b.count}
              <span className={cn('text-ink-3', big ? 'ml-[0.8vmin] text-[0.75em]' : 'ml-1 text-[13px]')}>{answered ? `${Math.round(share * 100)}%` : ''}</span>
            </span>
            {right && !big && <Check className={cn('-ml-1 size-4 shrink-0', INK.ok)} />}
          </li>
        );
      })}
    </ul>
  );
}

import { Check, Circle, Loader2, X } from 'lucide-react';
import { cn } from '../../components/ui';
import { LANES, type Lane, type LaneKey } from './data';

/**
 * 助教备这节课的几手：学情 → 教案 → 课件 / 练习和作业（一起做）→ 核对。一手一格，做到哪、做出了什么写在格子里。
 */
export function Lanes({ lanes, className }: { lanes: Partial<Record<LaneKey, Lane>>; className?: string }) {
  return (
    <ol className={cn('grid grid-cols-5 gap-1.5 sm:gap-2', className)}>
      {LANES.map((l, i) => {
        const s = lanes[l.key];
        const status = s?.status ?? 'wait';
        return (
          <li
            key={l.key}
            className={cn(
              'relative flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-center transition-colors sm:flex-row sm:items-start sm:gap-2.5 sm:px-3 sm:py-2.5 sm:text-left',
              status === 'doing' ? 'border-brand/40 bg-brand-soft/60' : status === 'error' ? 'border-bad/30 bg-bad/5' : 'border-line bg-surface',
            )}
          >
            <span
              className={cn(
                'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full',
                status === 'done' ? 'bg-ok text-white' : status === 'doing' ? 'text-brand' : status === 'error' ? 'bg-bad text-white' : 'text-ink-3',
              )}
            >
              {status === 'done' ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : status === 'doing' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : status === 'error' ? (
                <X className="size-3.5" strokeWidth={3} />
              ) : (
                <Circle className="size-4" />
              )}
            </span>
            <div className="min-w-0">
              <p className={cn('text-[12.5px] font-medium leading-tight sm:text-[14px]', status === 'wait' ? 'text-ink-3' : 'text-ink')}>
                <span className="mr-1 hidden text-ink-3 sm:inline">{i + 1}</span>
                {l.name}
              </p>
              {status === 'error' ? (
                <p className="mt-0.5 text-[12px] leading-snug text-bad sm:text-[12.5px]" title={s?.note}>
                  没做成
                </p>
              ) : (
                s?.note && (
                  <div className="hidden sm:block">
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-3">{s.note}</p>
                  </div>
                )
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

import { Check, Circle, Loader2, X } from 'lucide-react';
import { cn } from '../../components/ui';
import { LANES, type Lane, type LaneKey } from './data';

/**
 * 助教备这节课的几手：学情 → 教案 → 课件 / 练习和作业（一起做）→ 核对。一手一格，做到哪、做出了什么写在格子里。
 */
export function Lanes({ lanes, className }: { lanes: Partial<Record<LaneKey, Lane>>; className?: string }) {
  return (
    <ol className={cn('grid gap-2 sm:grid-cols-5', className)}>
      {LANES.map((l, i) => {
        const s = lanes[l.key];
        const status = s?.status ?? 'wait';
        return (
          <li
            key={l.key}
            className={cn(
              'relative flex gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
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
              <p className={cn('text-[14px] font-medium', status === 'wait' ? 'text-ink-3' : 'text-ink')}>
                <span className="mr-1 text-ink-3">{i + 1}</span>
                {l.name}
              </p>
              {s?.note && <p className={cn('mt-0.5 line-clamp-2 text-[12.5px] leading-snug', status === 'error' ? 'text-bad' : 'text-ink-3')}>{s.note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

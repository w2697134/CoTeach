import { Check, Loader2, X } from 'lucide-react';
import { cn } from '../../components/ui';
import { LANES, type Lane, type LaneKey } from './data';

/**
 * 助教备这节课的几步：（带了文件先看）资料 → 学情 → 教案 → 课件 / 练习和作业（一起做）→ 核对。排成一行，做完的打勾，在做的转圈。
 * detail：备完以后点「备课过程」看，每一步下面写着做出了什么。
 */
export function Lanes({ lanes, detail, className }: { lanes: Partial<Record<LaneKey, Lane>>; detail?: boolean; className?: string }) {
  const icon = (status: Lane['status'] | 'wait') => (
    <span
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-full',
        status === 'done' ? 'bg-ok text-white' : status === 'doing' ? 'text-brand' : status === 'error' ? 'bg-bad text-white' : 'border-[1.5px] border-line-strong',
      )}
    >
      {status === 'done' ? (
        <Check className="size-3.5" strokeWidth={3} />
      ) : status === 'doing' ? (
        <Loader2 className="size-4 animate-spin" />
      ) : status === 'error' ? (
        <X className="size-3.5" strokeWidth={3} />
      ) : null}
    </span>
  );
  if (detail)
    return (
      <ol className={cn('space-y-2.5 rounded-xl border border-line bg-surface px-4 py-3.5', className)}>
        {LANES.map((l) => {
          const s = lanes[l.key];
          if (!s) return null;
          return (
            <li key={l.key} className="flex items-start gap-2.5">
              <span className="mt-px">{icon(s.status)}</span>
              <p className="min-w-0 text-[14px] leading-relaxed">
                <span className="font-medium text-ink">{l.name}</span>
                {s.note && <span className={cn('ml-2', s.status === 'error' ? 'text-bad' : 'text-ink-2')}>{s.note}</span>}
              </p>
            </li>
          );
        })}
      </ol>
    );
  return (
    <ol className={cn('flex flex-wrap items-center gap-y-2', className)}>
      {/* 「资料」那一步只有带了文件才有 */}
      {LANES.filter((l) => l.key !== 'read' || lanes.read).map((l, i) => {
        const status = lanes[l.key]?.status ?? 'wait';
        return (
          <li key={l.key} className="flex items-center" title={lanes[l.key]?.note}>
            {i > 0 && <span className={cn('mx-2 h-px w-4 sm:w-8', status === 'wait' ? 'bg-line-strong' : 'bg-brand/40')} />}
            {icon(status)}
            <span className={cn('ml-1.5 text-[14px]', status === 'wait' ? 'text-ink-3' : status === 'error' ? 'text-bad' : status === 'doing' ? 'font-medium text-ink' : 'text-ink-2')}>
              {l.name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

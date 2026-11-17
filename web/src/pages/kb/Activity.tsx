import { fromNow } from '../../lib/format';
import { cn } from '../../components/ui';
import { AuthorAvatar, useChangeActions } from './Changes';
import { STATUS_NOTE, type Activity, type Piece } from './insight';

export type KbActivity = Activity & { kbId: number; kbName?: string };

/** 一句话：提到的笔记、原件还在库里的，点了翻开 */
export function Sentence({ pieces, onOpenFile, className }: { pieces: Piece[]; onOpenFile: (path: string) => void; className?: string }) {
  return (
    <span className={className}>
      {pieces.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : p.path ? (
          <button
            key={i}
            type="button"
            onClick={() => onOpenFile(p.path!)}
            className="inline text-brand-ink transition-colors hover:text-brand hover:underline hover:underline-offset-4"
          >
            《{p.name}》
          </button>
        ) : (
          <span key={i}>《{p.name}》</span>
        ),
      )}
    </span>
  );
}

function Row({
  item,
  onOpenFile,
  onOpenChange,
}: {
  item: KbActivity;
  onOpenFile: (kbId: number, path: string) => void;
  onOpenChange: (kbId: number, id: number) => void;
}) {
  const { act, busy } = useChangeActions(item.kbId);
  const c = item.change;
  const note = STATUS_NOTE[c.status];
  const off = c.status === 'rejected' || c.status === 'reverted' || c.status === 'canceled';
  return (
    <li className="flex gap-3 py-2.5">
      <AuthorAvatar change={c} size={30} />
      <div className="min-w-0 flex-1">
        <p className={cn('max-w-[44em] break-words text-[15px] leading-6', off ? 'text-ink-2' : 'text-ink')}>
          <Sentence pieces={item.pieces} onOpenFile={(path) => onOpenFile(item.kbId, path)} />
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] leading-5 text-ink-3">
          {item.kbName && <span className="max-w-[12rem] truncate">{item.kbName}</span>}
          <span>{fromNow(item.at)}</span>
          {note && <span className={c.status === 'pending' ? 'font-medium text-brand-ink' : c.status === 'conflict' ? 'text-warn' : undefined}>{note}</span>}
          <button type="button" onClick={() => onOpenChange(item.kbId, c.id)} className="text-ink-2 transition-colors hover:text-ink hover:underline hover:underline-offset-4">
            看改动
          </button>
          {item.who === 'ta' && c.status === 'applied' && (
            <button
              type="button"
              disabled={busy === `${c.id}:revert`}
              onClick={() => act(c, 'revert')}
              className="text-ink-2 transition-colors hover:text-ink hover:underline hover:underline-offset-4 disabled:opacity-50"
            >
              撤回
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** 「最近」：助教和老师最近对这个库做了什么，一件一句话，新的在上面 */
export function ActivityList({
  items,
  limit = 4,
  onOpenFile,
  onOpenChange,
  onOpenAll,
  className,
}: {
  items: KbActivity[];
  limit?: number;
  onOpenFile: (kbId: number, path: string) => void;
  onOpenChange: (kbId: number, id: number) => void;
  /** 「全部改动」：这个库所有的改动 */
  onOpenAll?: () => void;
  className?: string;
}) {
  if (!items.length) return null;
  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[16px] font-semibold text-ink">最近</h2>
        {onOpenAll && (
          <button type="button" onClick={onOpenAll} className="text-[14px] text-brand-ink transition-colors hover:text-brand">
            全部改动
          </button>
        )}
      </div>
      <ul className="mt-1">
        {items.slice(0, limit).map((item) => (
          <Row key={`${item.kbId}:${item.change.id}`} item={item} onOpenFile={onOpenFile} onOpenChange={onOpenChange} />
        ))}
      </ul>
    </section>
  );
}

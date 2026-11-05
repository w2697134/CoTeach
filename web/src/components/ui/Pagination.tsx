import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { cn } from './cn';

export function Pagination({
  page,
  pageCount,
  total,
  setPage,
  className,
  label = '列表分页',
}: {
  page: number;
  pageCount: number;
  total: number;
  setPage: (page: number) => void;
  className?: string;
  label?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={label} className={cn('mt-4 flex flex-wrap items-center justify-between gap-3', className)}>
      <span className="text-[14px] text-ink-3">共 {total} 条</span>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={page <= 1} icon={<ChevronLeft className="size-4" />} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span className="text-[14px] text-ink-2 tabular" aria-live="polite">
          {page} / {pageCount}
        </span>
        <Button size="sm" disabled={page >= pageCount} iconRight={<ChevronRight className="size-4" />} onClick={() => setPage(page + 1)}>
          下一页
        </Button>
      </div>
    </nav>
  );
}

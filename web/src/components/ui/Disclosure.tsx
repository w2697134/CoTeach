import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

/** Secondary content stays available without competing with the current task. */
export function Disclosure({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={cn('group/disclosure min-w-0 rounded-lg border border-line bg-surface', className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-[14px] font-medium text-ink-2 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{title}</span>
        <ChevronDown className="size-4 shrink-0 transition-transform group-open/disclosure:rotate-180" />
      </summary>
      <div className="min-w-0 border-t border-line p-4">{children}</div>
    </details>
  );
}

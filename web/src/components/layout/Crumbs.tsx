import { Fragment, useLayoutEffect } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { create } from 'zustand';

export interface Crumb {
  label: string;
  to?: string;
}

const useStore = create<{ crumbs: Crumb[]; set: (c: Crumb[]) => void }>((set) => ({ crumbs: [], set: (crumbs) => set({ crumbs }) }));
export const useCurrentCrumbs = () => useStore((s) => s.crumbs);

/**
 * 页面告诉顶栏现在在哪：班级 › 一班 › 测试。照 Google Classroom、飞书，位置写在顶栏里，内容上面不再单放一个返回。
 * 名字还没加载出来的那一节先空着；离开页面就清掉。
 */
export function useCrumbs(list: { label?: string | null; to?: string }[]) {
  const set = useStore((s) => s.set);
  const key = JSON.stringify(list.map((c) => ({ label: c.label || '', to: c.to })));
  useLayoutEffect(() => set(JSON.parse(key)), [key, set]);
  useLayoutEffect(() => () => set([]), [set]);
}

/** 电脑上的顶栏：前面几节能点回去，最后一节是现在这页 */
export function CrumbTrail({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="现在的位置" className="flex min-w-0 items-center gap-0.5 text-[15px]">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />}
            {!c.label ? (
              <span className="mx-1.5 h-4 w-20 shrink-0 animate-pulse rounded bg-surface-3" />
            ) : !last && c.to ? (
              <Link to={c.to} className="min-w-0 max-w-[18rem] truncate rounded-md px-1.5 py-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink">
                {c.label}
              </Link>
            ) : (
              <span aria-current={last ? 'page' : undefined} className="min-w-0 truncate px-1.5 font-medium text-ink">
                {c.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Card, ErrorState, Skeleton, cn } from '../../components/ui';
import { EmptyArt, type Theme } from './look';
import { when } from './homework';

export interface InsightPoint {
  title: string;
  what: string;
  teach: string;
  lost: number;
  asked: number;
  homework: string[];
  reasons: string[];
  questions: string[];
}
export interface Insights {
  status: 'none' | 'writing' | 'ready' | 'error';
  points: InsightPoint[];
  basis: { homework: number; graded: number; asks: number } | null;
  error: string | null;
  updatedAt: number | null;
  stale: boolean;
}

export const useInsights = (classId: number) =>
  useQuery({
    queryKey: ['insights', classId],
    queryFn: () => get<Insights>(`/homework/class/${classId}/insights`),
    refetchInterval: (q) => (q.state.data?.status === 'writing' ? 3000 : false),
  });

/** 让助教再看一遍：后台看，页面上转圈 */
export function useLookAgain(classId: number) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['insights', classId], await post<Insights>(`/homework/class/${classId}/insights`));
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

/** 分栏那一行右边：重新看（看过以后又批了作业、又有人问，按钮变成主色） */
export function InsightsAction({ classId }: { classId: number }) {
  const q = useInsights(classId);
  const again = useLookAgain(classId);
  const d = q.data;
  if (!d || d.status === 'none') return null;
  const writing = d.status === 'writing';
  return (
    <span className="flex items-center gap-2.5">
      {d.updatedAt && !writing && <span className="hidden text-[13px] text-ink-3 sm:inline">{when(d.updatedAt)}</span>}
      <Button
        size="sm"
        variant={d.stale ? 'primary' : 'secondary'}
        loading={again.busy || writing}
        icon={<RefreshCw className="size-4" />}
        onClick={again.run}
      >
        {writing ? '在看' : '重新看'}
      </Button>
    </span>
  );
}

/**
 * 班级页「学情」栏：学生卡在哪几个知识点，丢分多的在前。每一条：知识点、卡在哪、几个人丢分、几个人问过学伴、出在哪几份作业、
 * 下节课怎么讲；扣分原因和学生问的原话收在「看例子」里。不出现谁丢分、谁问过。
 */
export function InsightsTab({ classId, theme }: { classId: number; theme: Theme }) {
  const q = useInsights(classId);
  const again = useLookAgain(classId);
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-48 rounded-lg" />;
  const d = q.data;
  if (!d.points.length) {
    if (d.status === 'writing')
      return (
        <Card className="flex items-center justify-center gap-2.5 py-14 text-[15px] text-ink-2">
          <Loader2 className="size-5 animate-spin" style={{ color: theme.ink }} />
          助教在看
        </Card>
      );
    return (
      <Card padded={false}>
        <EmptyArt
          src="/illustrations/entry-homework-v1.webp"
          title={d.status === 'error' && d.error ? d.error : '还没看过'}
          action={
            <Button variant="primary" loading={again.busy} icon={<RefreshCw className="size-4" />} onClick={again.run}>
              让助教看看
            </Button>
          }
        />
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {d.points.map((p, i) => (
        <Point key={p.title + i} p={p} n={i + 1} theme={theme} />
      ))}
    </div>
  );
}

function Point({ p, n, theme }: { p: InsightPoint; n: number; theme: Theme }) {
  const [open, setOpen] = useState(false);
  const examples = [...p.reasons.map((x) => ({ x, ask: false })), ...p.questions.map((x) => ({ x, ask: true }))];
  return (
    <Card padded={false} className="px-5 py-4 sm:px-6">
      <div className="flex items-start gap-3.5">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold"
          style={{ backgroundColor: `${theme.ink}1f`, color: theme.ink }}
        >
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="min-w-0 break-words text-[16px] font-semibold text-ink">{p.title}</h3>
            <span className="text-[13.5px] text-ink-3">
              {p.lost > 0 && (
                <>
                  <span className="font-medium tabular-nums text-ink">{p.lost}</span> 人丢分
                </>
              )}
              {p.lost > 0 && p.asked > 0 && ' · '}
              {p.asked > 0 && (
                <>
                  <span className="font-medium tabular-nums text-ink">{p.asked}</span> 人问过学伴
                </>
              )}
            </span>
          </div>
          {p.what && <p className="mt-1.5 break-words text-[14.5px] leading-relaxed text-ink-2">{p.what}</p>}
          {p.teach && (
            <p className="mt-2.5 break-words rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px] leading-relaxed text-ink-2">
              <span className="mr-2 font-medium" style={{ color: theme.ink }}>
                下节课
              </span>
              {p.teach}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {p.homework.map((h) => (
              <span key={h} className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[12.5px] text-ink-3">
                {h}
              </span>
            ))}
            {examples.length > 0 && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="inline-flex items-center gap-0.5 text-[13px] text-ink-3 transition-colors hover:text-ink"
              >
                <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
                看例子
              </button>
            )}
          </div>
          {open && (
            <ul className="mt-2.5 space-y-1.5 border-l-2 border-line pl-3.5">
              {examples.map((e, k) => (
                <li key={k} className="break-words text-[13.5px] leading-relaxed text-ink-3">
                  <span className="mr-1.5 text-ink-2">{e.ask ? '学生问' : '扣分'}</span>
                  {e.x}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

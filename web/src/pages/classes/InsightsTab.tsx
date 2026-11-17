import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { AgentAvatar, Button, Card, ErrorState, Skeleton, cn } from '../../components/ui';
import { TA } from '../kb/data';
import { EmptyArt, THEME_TEXT, inkVars, type Theme } from './look';
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
    <Button size="sm" variant={d.stale ? 'primary' : 'secondary'} loading={again.busy || writing} icon={<RefreshCw className="size-4" />} onClick={again.run}>
      {writing ? '在看' : d.stale ? '有新作业，再看一遍' : '重新看'}
    </Button>
  );
}

/** 顶上一句：助教看了哪些东西、什么时候看的（数是程序数的） */
function Basis({ d }: { d: Insights }) {
  const b = d.basis;
  return (
    <div className="flex items-center gap-3 px-1">
      <AgentAvatar agent={TA} size={36} status={d.status === 'writing' ? 'running' : null} />
      <p className="min-w-0 text-[15px] leading-relaxed text-ink-2">
        {d.status === 'writing' ? (
          '助教在重新看这个班'
        ) : b ? (
          <>
            助教翻了 <b className="font-semibold text-ink">{b.homework}</b> 份作业的 <b className="font-semibold text-ink">{b.graded}</b> 份批改
            {b.asks > 0 && (
              <>
                ，还有学生问学伴的 <b className="font-semibold text-ink">{b.asks}</b> 个问题
              </>
            )}
            {d.updatedAt && <span className="ml-2 whitespace-nowrap text-[14px] text-ink-3">{when(d.updatedAt)}</span>}
          </>
        ) : (
          d.updatedAt && `${when(d.updatedAt)} 看的`
        )}
      </p>
    </div>
  );
}

/**
 * 班级页「学情」栏：学生卡在哪几个知识点，丢分多的在前。每一条左边是卡在哪、下节课怎么讲（一行四十几个字），
 * 右边摆学生的原话和扣分的地方，看得到助教是照什么说的。不出现谁丢分、谁问过。
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
        <Card className="flex items-center justify-center gap-3 py-14 text-[15px] text-ink-2">
          <Loader2 className="size-5 animate-spin" style={{ color: theme.ink }} />
          助教在翻这个班的作业和问题，一两分钟
        </Card>
      );
    return (
      <Card padded={false}>
        <EmptyArt
          src="/illustrations/entry-homework-v1.webp"
          title={d.status === 'error' && d.error ? d.error : '还没看过这个班'}
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
    <div className="space-y-4">
      <Basis d={d} />
      {d.points.map((p, i) => (
        <Point key={p.title + i} p={p} n={i + 1} theme={theme} />
      ))}
    </div>
  );
}

function Point({ p, n, theme }: { p: InsightPoint; n: number; theme: Theme }) {
  const [all, setAll] = useState(false);
  // 先摆两条，学生问的在前（比扣分原因更像学生自己的话），其余点「还有几条」
  const asks = all ? p.questions : p.questions.slice(0, 2);
  const reasons = all ? p.reasons : p.reasons.slice(0, Math.max(0, 2 - asks.length));
  const more = p.questions.length + p.reasons.length - asks.length - reasons.length;
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="px-5 py-5 sm:px-6">
          <div className="flex items-start gap-3">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white"
              style={{ backgroundColor: theme.ink }}
            >
              {n}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h3 className="break-words text-[18px] font-semibold leading-snug text-ink">{p.title}</h3>
              <p className="mt-1 text-[14px] text-ink-2">
                {p.lost > 0 && (
                  <>
                    <b className="font-semibold text-ink">{p.lost}</b> 人在这儿丢了分
                  </>
                )}
                {p.lost > 0 && p.asked > 0 && <span className="mx-1.5 text-ink-3">·</span>}
                {p.asked > 0 && (
                  <>
                    <b className="font-semibold text-ink">{p.asked}</b> 人问过学伴
                  </>
                )}
              </p>
            </div>
          </div>
          {p.what && <p className="mt-3 max-w-[44em] break-words text-[15px] leading-relaxed text-ink">{p.what}</p>}
          {p.teach && (
            <div className="mt-4 max-w-[44em] rounded-lg border-l-[3px] bg-surface-2 py-3 pl-4 pr-4" style={{ borderColor: theme.ink }}>
              <p className={cn('text-[14px] font-semibold', THEME_TEXT)} style={inkVars(theme)}>
                下节课这么讲
              </p>
              <p className="mt-1 break-words text-[15px] leading-relaxed text-ink">{p.teach}</p>
            </div>
          )}
          {p.homework.length > 0 && (
            <p className="mt-3.5 flex flex-wrap gap-1.5">
              {p.homework.map((h) => (
                <span key={h} className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[13px] text-ink-2">
                  {h}
                </span>
              ))}
            </p>
          )}
        </div>
        {p.reasons.length + p.questions.length > 0 && (
          <aside className="space-y-4 border-t border-line bg-surface-2/70 px-5 py-5 sm:px-6 lg:border-l lg:border-t-0 lg:px-5">
            {asks.length > 0 && (
              <div>
                <p className="text-[14px] font-medium text-ink-2">学生问学伴</p>
                <ul className="mt-2 space-y-2">
                  {asks.map((x, k) => (
                    <li key={k} className="w-fit max-w-full rounded-2xl rounded-tl-md bg-surface px-3.5 py-2 text-[14px] leading-relaxed text-ink shadow-xs ring-1 ring-line">
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {reasons.length > 0 && (
              <div>
                <p className="text-[14px] font-medium text-ink-2">批改里扣分的原话</p>
                <ul className="mt-2 space-y-2.5">
                  {reasons.map((x, k) => (
                    <li key={k} className={cn('break-words border-l-2 border-line-strong pl-3 text-[14px] leading-relaxed text-ink', !all && 'line-clamp-4')}>
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(more > 0 || all) && p.reasons.length + p.questions.length > 2 && (
              <button
                type="button"
                onClick={() => setAll((v) => !v)}
                aria-expanded={all}
                className="inline-flex items-center gap-1 text-[14px] font-medium text-brand-ink hover:underline"
              >
                <ChevronDown className={cn('size-4 transition-transform', all && 'rotate-180')} />
                {all ? '收起' : `还有 ${more} 条`}
              </button>
            )}
          </aside>
        )}
      </div>
    </Card>
  );
}

import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, Download, Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Card, ErrorState, Skeleton, cn } from '../../components/ui';
import { num } from './homework';

interface ReviewStats {
  total: number;
  submitted: number;
  graded: number;
  avg: number | null;
  max: number | null;
  min: number | null;
  points: number;
  buckets: { label: string; n: number }[];
  items: { title: string; points: number; avg: number | null }[];
  missing: string[];
  similar: { names: [string, string]; ratio: number }[];
}
interface ReviewWrite {
  summary: string;
  errors: { title: string; item: number | null; students: string[]; why: string; teach: string; example: string }[];
  good: { student: string; why: string }[];
  next: string;
}
interface ReviewData {
  review: {
    status: 'writing' | 'ready' | 'error';
    stats: ReviewStats | null;
    write: ReviewWrite | null;
    error: string | null;
    sharedAt: number | null;
    updatedAt: number;
    gradedAtWrite: number;
  } | null;
  graded: number;
  title: string;
  className: string;
  classId: number;
  points: number;
}

/** 分数段：竖条，上面写人数 */
function Buckets({ buckets }: { buckets: ReviewStats['buckets'] }) {
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const shown = [...buckets].reverse();
  return (
    <div className="flex h-44 items-end gap-3 px-1">
      {shown.map((b) => (
        <div key={b.label} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
          <span className="text-[13px] font-medium tabular-nums text-ink-2">{b.n}</span>
          <div className="flex h-28 w-full items-end">
            <div
              className={cn('w-full rounded-t-[4px]', b.label === '不及格' ? 'bg-bad/75' : 'bg-brand/80')}
              style={{ height: `${b.n ? Math.max(4, (b.n / max) * 100) : 0}%` }}
              title={`${b.label}：${b.n} 人`}
            />
          </div>
          <span className="truncate text-[12.5px] text-ink-3">{b.label}</span>
        </div>
      ))}
    </div>
  );
}

/** 各项平均得分率：横条 */
function ItemRates({ items }: { items: ReviewStats['items'] }) {
  return (
    <ul className="space-y-3.5">
      {items.map((it, i) => {
        const rate = it.avg === null || !it.points ? null : Math.round((it.avg / it.points) * 100);
        return (
          <li key={i} className="space-y-1.5">
            <div className="flex items-baseline gap-3 text-[14px]">
              <span className="min-w-0 flex-1 truncate text-ink" title={it.title}>
                {it.title}
              </span>
              <span className="shrink-0 tabular-nums text-ink-3">
                平均 {it.avg === null ? '—' : num(it.avg)} / {num(it.points)}
                {rate !== null && <span className="ml-2 font-semibold text-ink">{rate}%</span>}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div
                className={cn('h-full rounded-full', rate === null ? '' : rate >= 85 ? 'bg-ok' : rate >= 60 ? 'bg-warn' : 'bg-bad')}
                style={{ width: `${rate ?? 0}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 一份作业的讲评（老师）：程序算的数（交了几个、平均分、分数段、各项得分率、没交的、很像的），助教写的（常见问题、做得好的、下节课）。
 * 能下载 Word；「发给学生」后学生在作业页看到不带名字的那一版，学伴也知道。
 */
export function ReviewPage() {
  const params = useParams();
  const classId = Number(params.id),
    id = Number(params.hid);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['homework', id, 'review'],
    queryFn: () => get<ReviewData>(`/homework/${id}/review`),
    refetchInterval: (x) => (x.state.data?.review?.status === 'writing' ? 2500 : false),
  });
  const [busy, setBusy] = useState<'write' | 'share' | null>(null);
  const d = q.data;
  useCrumbs([
    { label: '班级', to: '/classes' },
    { label: d?.className, to: `/classes/${classId}` },
    { label: d?.title, to: `/classes/${classId}/homework/${id}` },
    { label: '讲评' },
  ]);
  const write = async () => {
    setBusy('write');
    try {
      await post(`/homework/${id}/review`);
      await qc.invalidateQueries({ queryKey: ['homework', id, 'review'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  const share = async (on: boolean) => {
    setBusy('share');
    try {
      await post(`/homework/${id}/review/share`, { on });
      await qc.invalidateQueries({ queryKey: ['homework'] });
      toast.success(on ? '学生能在作业页看到讲评了' : '学生那边收回了');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <Skeleton className="h-96 rounded-xl" />;
  const r = d.review;
  const ready = r?.status === 'ready' && r.write && r.stats;
  const s = r?.stats,
    w = r?.write;
  const newer = ready && d.graded > (r!.gradedAtWrite || 0) ? d.graded - r!.gradedAtWrite : 0;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[24px] font-semibold tracking-tight text-ink">「{d.title}」讲评</h1>
          <p className="mt-0.5 text-[14px] text-ink-3">{d.className}</p>
        </div>
        {ready && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" icon={<RefreshCw className="size-4" />} loading={busy === 'write'} onClick={write}>
              重写
            </Button>
            <a href={`/api/homework/${id}/review/docx`} className="contents">
              <Button icon={<Download className="size-4" />}>下载 Word</Button>
            </a>
            {r!.sharedAt ? (
              <Button icon={<Check className="size-4" />} loading={busy === 'share'} onClick={() => share(false)}>
                已发给学生
              </Button>
            ) : (
              <Button variant="primary" icon={<Send className="size-4" />} loading={busy === 'share'} onClick={() => share(true)}>
                发给学生
              </Button>
            )}
          </div>
        )}
      </div>

      {!r || (r.status === 'error' && !ready) ? (
        <Card className="flex flex-col items-center gap-4 py-12 text-center">
          <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <Bot className="size-7" />
          </span>
          {r?.status === 'error' && <p className="text-[14px] text-bad">{r.error || '没写成'}</p>}
          <p className="text-[15px] text-ink-2">{d.graded ? `批好了 ${d.graded} 份` : '还没有批好的作业'}</p>
          {d.graded > 0 && (
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === 'write'} onClick={write}>
              让助教写讲评
            </Button>
          )}
        </Card>
      ) : r.status === 'writing' ? (
        <Card className="flex items-center gap-3 bg-brand-soft/40 py-6">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-white">
            <Bot className="size-5" />
          </span>
          <div>
            <p className="flex items-center gap-1.5 text-[15px] font-medium text-ink">
              CoT 助教在写讲评
              <Loader2 className="size-4 animate-spin text-brand" />
            </p>
            <p className="text-[13.5px] text-ink-3">一般一分钟以内</p>
          </div>
        </Card>
      ) : (
        ready && (
          <>
            {newer > 0 && (
              <p className="flex flex-wrap items-center gap-2 rounded-lg bg-info-soft px-4 py-2.5 text-[14px] text-info">
                写完以后又批了 {newer} 份
                <button type="button" onClick={write} className="font-medium underline underline-offset-2">
                  重写
                </button>
              </p>
            )}
            <Card className="space-y-4">
              {w!.summary && <p className="text-[16px] leading-relaxed text-ink">{w!.summary}</p>}
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-ink-3">
                <span>
                  交了 <b className="font-semibold text-ink">{s!.submitted}</b>/{s!.total} 人
                </span>
                <span>
                  平均 <b className="font-semibold text-ink">{s!.avg === null ? '—' : num(s!.avg)}</b>/{num(s!.points)}
                </span>
                <span>
                  最高 <b className="font-semibold text-ink">{s!.max === null ? '—' : num(s!.max)}</b>
                </span>
                <span>
                  最低 <b className="font-semibold text-ink">{s!.min === null ? '—' : num(s!.min)}</b>
                </span>
              </div>
            </Card>
            <div className="grid gap-5 md:grid-cols-2">
              <Card className="space-y-3">
                <h2 className="text-[16px] font-semibold text-ink">分数分布</h2>
                <Buckets buckets={s!.buckets} />
              </Card>
              {s!.items.length > 0 && (
                <Card className="space-y-4">
                  <h2 className="text-[16px] font-semibold text-ink">各项得分</h2>
                  <ItemRates items={s!.items} />
                </Card>
              )}
            </div>
            {w!.errors.length > 0 && (
              <Card className="space-y-4">
                <h2 className="text-[16px] font-semibold text-ink">常见问题</h2>
                <ol className="space-y-4">
                  {w!.errors.map((e, i) => (
                    <li key={i} className="space-y-2.5 rounded-xl border border-line p-4">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-bad-soft text-[13px] font-semibold text-bad">{i + 1}</span>
                        <span className="min-w-0 flex-1 text-[15.5px] font-semibold text-ink">{e.title}</span>
                        <span className="shrink-0 rounded-full bg-surface-3 px-2.5 py-0.5 text-[13px] text-ink-2">{e.students.length} 人</span>
                      </div>
                      {e.students.length > 0 && <p className="text-[13.5px] leading-relaxed text-ink-3">{e.students.join('、')}</p>}
                      {e.example && (
                        <pre className="whitespace-pre-wrap break-words rounded-lg bg-bad-soft/50 px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-ink">{e.example}</pre>
                      )}
                      {e.why && (
                        <p className="text-[14.5px] leading-relaxed text-ink">
                          <span className="font-medium text-ink-2">为什么会错：</span>
                          {e.why}
                        </p>
                      )}
                      {e.teach && (
                        <p className="text-[14.5px] leading-relaxed text-ink">
                          <span className="font-medium text-brand-ink">怎么讲：</span>
                          {e.teach}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              </Card>
            )}
            <div className="grid gap-5 md:grid-cols-2">
              {w!.next && (
                <Card className="space-y-2.5">
                  <h2 className="text-[16px] font-semibold text-ink">下节课</h2>
                  <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink">{w!.next}</p>
                </Card>
              )}
              {w!.good.length > 0 && (
                <Card className="space-y-3">
                  <h2 className="text-[16px] font-semibold text-ink">做得好的</h2>
                  <ul className="space-y-2.5">
                    {w!.good.map((g, i) => (
                      <li key={i} className="text-[14.5px] leading-relaxed text-ink">
                        <span className="font-medium text-ok">{g.student}</span>：{g.why}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
            {(s!.missing.length > 0 || s!.similar.length > 0) && (
              <div className="grid gap-5 md:grid-cols-2">
                {s!.missing.length > 0 && (
                  <Card className="space-y-2.5">
                    <h2 className="text-[16px] font-semibold text-ink">没交的（{s!.missing.length}）</h2>
                    <p className="text-[14.5px] leading-relaxed text-ink-2">{s!.missing.join('、')}</p>
                  </Card>
                )}
                {s!.similar.length > 0 && (
                  <Card className="space-y-2.5">
                    <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink">
                      <Copy className="size-4 text-info" />
                      这几份很像
                    </h2>
                    <ul className="space-y-1.5">
                      {s!.similar.map((x, i) => (
                        <li key={i} className="flex items-center gap-3 text-[14.5px] text-ink">
                          <span className="min-w-0 flex-1">{x.names.join('、')}</span>
                          <span className="shrink-0 tabular-nums text-info">相似 {x.ratio}%</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

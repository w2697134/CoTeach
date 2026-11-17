import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, Download, Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { AgentAvatar, Button, Card, ErrorState, Skeleton, cn } from '../../components/ui';
import { TA } from '../kb/data';
import { num } from './homework';
import { CHIP, INK, scoreInk } from './tone';

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
    <div className="flex h-40 items-end gap-2.5">
      {shown.map((b) => (
        <div key={b.label} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
          <span className="text-[14px] font-medium tabular-nums text-ink">{b.n}</span>
          <div className="flex h-24 w-full items-end">
            <div
              className={cn('w-full rounded-t-[4px]', b.label === '不及格' ? 'bg-[#ef4444]/80' : 'bg-brand/80')}
              style={{ height: `${b.n ? Math.max(4, (b.n / max) * 100) : 0}%` }}
              title={`${b.label}：${b.n} 人`}
            />
          </div>
          <span className="truncate text-[13px] text-ink-2">{b.label}</span>
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
                {it.title.replace(/^.*?[：:]\s*/, '') || it.title}
              </span>
              {rate !== null && <span className={cn('shrink-0 font-semibold tabular-nums', rate < 60 ? INK.bad : 'text-ink')}>{rate}%</span>}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full"
                style={{ width: `${rate ?? 0}%`, backgroundColor: rate === null ? undefined : rate >= 85 ? '#10b981' : rate >= 60 ? '#f59e0b' : '#ef4444' }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** 一类常见问题：标题、几个人、谁（长的先露两行）、学生写的样子、为什么会错、怎么讲 */
function ErrorItem({ e, n }: { e: ReviewWrite['errors'][number]; n: number }) {
  const [all, setAll] = useState(false);
  const many = e.students.length > 10;
  return (
    <li className="border-t border-line pt-6 first:border-0 first:pt-0">
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold', CHIP.bad)}>{n}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="min-w-0 flex-1 text-[16px] font-semibold leading-snug text-ink">{e.title}</h3>
            <span className="shrink-0 text-[14px] text-ink-2">{e.students.length} 人</span>
          </div>
          {e.students.length > 0 && (
            <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
              {all || !many ? e.students.join('、') : `${e.students.slice(0, 10).join('、')}……`}
              {many && (
                <button type="button" onClick={() => setAll(!all)} className="ml-1.5 inline-flex items-center gap-0.5 text-brand-ink hover:underline">
                  <ChevronDown className={cn('size-3.5 transition-transform', all && 'rotate-180')} />
                  {all ? '收起' : '全部'}
                </button>
              )}
            </p>
          )}
          {e.example && (
            <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 px-4 py-3 font-mono text-[14px] leading-relaxed text-ink">{e.example}</pre>
          )}
          {e.why && (
            <p className="mt-3 text-[15px] leading-relaxed text-ink">
              <span className="mr-1.5 font-semibold text-ink-2">为什么会错</span>
              {e.why}
            </p>
          )}
          {e.teach && (
            <p className="mt-2.5 rounded-lg bg-brand-soft/60 px-4 py-3 text-[15px] leading-relaxed text-ink">
              <span className="mr-1.5 font-semibold text-brand-ink">课上这么讲</span>
              {e.teach}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * 一份作业的讲评（老师）：左边是一篇讲评稿（一行四十几个字）：开头一段、常见问题（谁错了、学生写的样子、为什么、怎么讲）、
 * 下节课、做得好的；右边是程序算的数（交了几个、平均、分数段、各项得分率、没交的、很像的）。
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
    { label: '课程', to: '/classes' },
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
      toast.success(on ? '发了，学生在作业页能看到（不带名字）' : '学生那边收回了');
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
          <h1 className="text-balance text-[24px] font-semibold tracking-tight text-ink">「{d.title}」讲评</h1>
          <p className="mt-1 text-[14px] text-ink-2 empty:hidden">
            {r?.sharedAt ? <span className={cn('rounded-full px-2 py-0.5 text-[13px]', CHIP.ok)}>学生看得到了</span> : null}
          </p>
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
          <AgentAvatar agent={TA} size={64} />
          {r?.status === 'error' && <p className={cn('text-[14px]', INK.bad)}>{r.error || '上次没写成'}</p>}
          <p className="text-[16px] text-ink-2">{d.graded ? `批好了 ${d.graded} 份` : '还没有批好的作业'}</p>
          {d.graded > 0 && (
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === 'write'} onClick={write}>
              让助教写讲评
            </Button>
          )}
        </Card>
      ) : r.status === 'writing' ? (
        <Card className="flex items-center gap-4 bg-brand-soft/40 py-6">
          <AgentAvatar agent={TA} size={48} status="running" />
          <p className="flex items-center gap-2 text-[16px] font-medium text-ink">
            助教在翻这 {d.graded} 份批改写讲评，一分钟左右
            <Loader2 className="size-4 animate-spin text-brand" />
          </p>
        </Card>
      ) : (
        ready && (
          <>
            {newer > 0 && (
              <p className={cn('flex flex-wrap items-center gap-2 rounded-lg px-4 py-2.5 text-[15px]', CHIP.info)}>
                写完以后又批了 {newer} 份
                <button type="button" onClick={write} className="font-semibold underline underline-offset-2">
                  重写
                </button>
              </p>
            )}
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <Card className="min-w-0 space-y-8 px-6 py-7 sm:px-9 sm:py-8">
                {w!.summary && <p className="max-w-[44em] text-[16px] leading-[1.85] text-ink">{w!.summary}</p>}
                {w!.errors.length > 0 && (
                  <section>
                    <h2 className="mb-4 text-[18px] font-semibold text-ink">常见问题</h2>
                    <ol className="max-w-[46em] space-y-6">
                      {w!.errors.map((e, i) => (
                        <ErrorItem key={i} e={e} n={i + 1} />
                      ))}
                    </ol>
                  </section>
                )}
                {w!.next && (
                  <section>
                    <h2 className="mb-2.5 text-[18px] font-semibold text-ink">下节课</h2>
                    <p className="max-w-[44em] whitespace-pre-wrap text-[15px] leading-[1.85] text-ink">{w!.next}</p>
                  </section>
                )}
                {w!.good.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-[18px] font-semibold text-ink">做得好的</h2>
                    <ul className="max-w-[44em] space-y-3">
                      {w!.good.map((g, i) => (
                        <li key={i} className="text-[15px] leading-relaxed text-ink">
                          <span className="mr-1.5 font-semibold text-brand-ink">{g.student}</span>
                          {g.why}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </Card>
              <div className="space-y-5 lg:sticky lg:top-20">
                <Card className="space-y-4">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Num label="交了" value={`${s!.submitted}`} unit={`/ ${s!.total} 人`} />
                    <Num label="平均" value={s!.avg === null ? '—' : num(s!.avg)} unit={`/ ${num(s!.points)}`} tone={s!.avg !== null ? scoreInk(s!.avg, s!.points) : undefined} />
                    <Num label="最高" value={s!.max === null ? '—' : num(s!.max)} />
                    <Num label="最低" value={s!.min === null ? '—' : num(s!.min)} tone={s!.min !== null ? scoreInk(s!.min, s!.points) : undefined} />
                  </div>
                  <Buckets buckets={s!.buckets} />
                </Card>
                {s!.items.length > 0 && (
                  <Card className="space-y-4">
                    <h2 className="text-[16px] font-semibold text-ink">各项得分率</h2>
                    <ItemRates items={s!.items} />
                  </Card>
                )}
                {s!.missing.length > 0 && (
                  <Card className="space-y-2">
                    <h2 className="text-[16px] font-semibold text-ink">没交的 {s!.missing.length} 人</h2>
                    <p className="text-[15px] leading-relaxed text-ink-2">{s!.missing.join('、')}</p>
                  </Card>
                )}
                {s!.similar.length > 0 && (
                  <Card className="space-y-2.5">
                    <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink">
                      <Copy className={cn('size-4', INK.info)} />
                      这几份很像
                    </h2>
                    <ul className="space-y-1.5">
                      {s!.similar.map((x, i) => (
                        <li key={i} className="flex items-center gap-3 text-[15px] text-ink">
                          <span className="min-w-0 flex-1">{x.names.join('、')}</span>
                          <span className={cn('shrink-0 tabular-nums', INK.info)}>{x.ratio}%</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}

function Num({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: string }) {
  return (
    <div>
      <p className="text-[14px] text-ink-2">{label}</p>
      <p className="mt-0.5 leading-none">
        <span className={cn('text-[24px] font-semibold tabular-nums', tone || 'text-ink')}>{value}</span>
        {unit && <span className="ml-1 text-[14px] text-ink-2">{unit}</span>}
      </p>
    </div>
  );
}

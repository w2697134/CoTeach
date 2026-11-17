import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, MonitorPlay, MoreHorizontal, Play, Trash2, Zap } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { del, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Card, ErrorState, IconButton, Input, MenuItem, Popover, Select, Skeleton, cn, useConfirm } from '../../components/ui';
import { useClasses } from '../classes/data';
import { EmptyArt, ThemeBanner, themeBackground, themeOf } from '../classes/look';
import { INK } from '../classes/tone';
import { useLessons, type LessonCard } from '../prep/data';
import { SlideThumb } from '../prep/Slides';
import { lasted, percent, useLectures, type LectureCard } from './data';

const pad = (n: number) => String(n).padStart(2, '0');
function dayTime(t: number) {
  const d = new Date(t),
    now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (same(d, y)) return `昨天 ${hm}`;
  return `${d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 课堂（老师，2026-11-17）：正在上的课放最上面（回到课堂）；开始上课：挑班、挑一节备好的课（也可以不挑，只推题和点名）；
 * 下面是上过的课，一节一行：课题、班、日期、到了几个人、推了几道题、正确率。照雨课堂的「授课记录」。
 */
export function ClassroomPage() {
  useCrumbs([{ label: '课堂' }]);
  const q = useLectures();
  const live = q.data?.live || [];
  return (
    <div className="mx-auto w-full max-w-6xl space-y-7 px-4 py-5 sm:px-6 sm:py-7">
      {live.map((l) => (
        <LiveCard key={l.id} l={l} />
      ))}
      <Starter live={live} />
      <Past q={q} />
    </div>
  );
}

/** 正在上的一堂：班级的颜色和插图，大字课题，「回到课堂」 */
function LiveCard({ l }: { l: LectureCard }) {
  const navigate = useNavigate();
  const theme = themeOf(l.classId);
  return (
    <ThemeBanner theme={theme} className="rounded-2xl shadow-sm">
      <div className="flex min-h-[148px] flex-col justify-center gap-3 px-5 py-5 sm:px-8">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-[14px] font-medium">
          <span className="size-2 animate-pulse rounded-full bg-[#ff5d6c]" />
          上课中 · {lasted(l.startedAt, Date.now())}
        </span>
        <div>
          <h2 className="max-w-[min(560px,100%)] text-[24px] font-semibold leading-snug">{l.title}</h2>
          <p className="mt-1 text-[15px] text-white">
            {l.className} · 来了 {l.attended} 人{l.pushed ? ` · 推了 ${l.pushed} 道题` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate(`/classroom/${l.id}`)}
          className="inline-flex h-10 w-fit items-center gap-1.5 rounded-lg bg-white px-4 text-[15px] font-semibold shadow-sm transition-transform hover:-translate-y-px"
          style={{ color: theme.ink }}
        >
          回到课堂
          <ArrowRight className="size-4" />
        </button>
      </div>
    </ThemeBanner>
  );
}

/**
 * 开始上课：上面挑班（班级的颜色），下面挑课（课件第一页当封面；这个班备的在前，别的班备的也能用），
 * 也可以不挑课只推题点名。挑的班正在上课的，按钮换成「回到课堂」。
 */
function Starter({ live }: { live: LectureCard[] }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const classes = (useClasses().data?.classes || []).filter((k) => !k.archived);
  const lessons = (useLessons().data?.lessons || []).filter((l) => l.status !== 'making' && !l.making);
  const [classId, setClassId] = useState(0);
  const [lessonId, setLessonId] = useState<number | null | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // 默认挑最近备过课的那个班；网址带 ?class= 的挑那个
  useEffect(() => {
    if (classId || !classes.length) return;
    const want = Number(params.get('class'));
    setClassId(classes.find((k) => k.id === want)?.id || lessons[0]?.classId || classes[0].id);
  }, [classes, lessons, classId, params]);
  const mine = useMemo(() => {
    const own = lessons.filter((l) => l.classId === classId),
      others = lessons.filter((l) => l.classId !== classId);
    return [...own, ...others];
  }, [lessons, classId]);
  // 换了班，课默认挑这个班最近备的那节
  useEffect(() => {
    setLessonId(undefined);
  }, [classId]);
  const picked = lessonId === undefined ? (lessons.find((l) => l.classId === classId)?.id ?? null) : lessonId;
  const running = live.find((l) => l.classId === classId);
  const start = async () => {
    if (running) return navigate(`/classroom/${running.id}`);
    if (!classId || busy) return;
    setBusy(true);
    try {
      const r = await post<{ id: number }>('/classroom', { classId, lessonId: picked, title: picked ? null : title.trim() || null });
      qc.invalidateQueries({ queryKey: ['lectures'] });
      navigate(`/classroom/${r.id}`);
    } catch (e) {
      toast.fromError(e);
      setBusy(false);
    }
  };
  return (
    <Card padded={false} className="overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden px-5 pb-5 pt-6 sm:px-7" style={{ background: 'linear-gradient(100deg, var(--c-primary-soft) 0%, var(--c-surface) 85%)' }}>
        <img
          src="/illustrations/classroom-banner.webp"
          alt=""
          draggable={false}
          onError={(e) => (e.currentTarget.style.display = 'none')}
          className="pointer-events-none absolute inset-y-0 right-0 h-full w-auto max-w-none select-none max-md:opacity-25"
          style={{ maskImage: 'linear-gradient(to right, transparent, #000 40%)', WebkitMaskImage: 'linear-gradient(to right, transparent, #000 40%)' }}
        />
        <div className="relative">
          <h2 className="text-[22px] font-semibold tracking-tight text-ink">开始上课</h2>
          <div className="no-scrollbar -mx-5 mt-4 flex max-w-[680px] gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            {classes.map((k) => {
              const t = themeOf(k.id);
              const on = k.id === classId;
              const isLive = live.some((l) => l.classId === k.id);
              return (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setClassId(k.id)}
                  aria-pressed={on}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[15px] font-medium shadow-xs transition-colors',
                    on ? 'border-transparent text-white' : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink',
                  )}
                  style={on ? { background: `linear-gradient(135deg, ${t.from}, ${t.to})` } : undefined}
                >
                  {!on && <span className="size-2.5 rounded-full" style={{ background: t.from }} />}
                  {k.name}
                  {isLive && <span className={cn('size-2 animate-pulse rounded-full', on ? 'bg-white' : 'bg-bad')} />}
                </button>
              );
            })}
            {!classes.length && <p className="text-[15px] text-ink-2">还没有班级</p>}
          </div>
        </div>
      </div>
      <div className="px-5 pb-5 pt-4 sm:px-7">
        {running ? (
          <p className="py-3 text-[16px] text-ink-2">
            正在上「<span className="font-medium text-ink">{running.title}</span>」
          </p>
        ) : (
          <>
            <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 pb-1 pt-1">
              <LessonChoice on={picked === null} onClick={() => setLessonId(null)}>
                <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-line-strong bg-surface-2 text-ink-3">
                  <Zap className="size-6" />
                </div>
                <p className="mt-2 text-[14px] font-medium text-ink">只推题、点名</p>
              </LessonChoice>
              {mine.map((l) => (
                <LessonChoice key={l.id} on={picked === l.id} onClick={() => setLessonId(l.id)}>
                  <LessonCover l={l} />
                  <p className="mt-2 line-clamp-2 text-[14px] font-medium leading-snug text-ink">{l.title || l.request || '下一节课'}</p>
                  <p className="mt-0.5 truncate text-[13px] text-ink-2">
                    {[l.classId !== classId && l.className, l.counts.slides && `课件 ${l.counts.slides} 页`, l.counts.practice && `练习 ${l.counts.practice}`].filter(Boolean).join(' · ')}
                  </p>
                </LessonChoice>
              ))}
            </div>
            {picked === null && (
              <Input className="mt-3 max-w-sm" value={title} maxLength={80} placeholder="课题" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && start()} />
            )}
          </>
        )}
        <div className="mt-4 flex justify-end">
          <Button size="lg" variant="primary" icon={running ? <MonitorPlay className="size-5" /> : <Play className="size-5" />} loading={busy} disabled={!classId} onClick={start}>
            {running ? '回到课堂' : '开始上课'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function LessonChoice({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'relative w-[188px] shrink-0 rounded-xl border p-2 text-left transition-all',
        on ? 'border-brand bg-brand-soft/50 ring-2 ring-brand/20' : 'border-line bg-surface hover:border-line-strong',
      )}
    >
      {children}
      {on && (
        <span className="absolute right-3 top-3 grid size-5 place-items-center rounded-full bg-brand text-white shadow-sm">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

function LessonCover({ l }: { l: LessonCard }) {
  return (
    <div className="aspect-video overflow-hidden rounded-lg border border-line">
      {l.cover ? (
        <SlideThumb slide={l.cover.slide} theme={l.cover.theme} />
      ) : (
        <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-soft to-surface-2 px-3 text-center text-[14px] font-semibold text-brand-ink">
          {l.title || l.request || '下一节课'}
        </div>
      )}
    </div>
  );
}

/** 上过的课：一节一张卡片，封面是那节课课件的第一页（没带课件的用班级颜色），下面写哪天、来了几个、答对多少（班多的时候能只看一个班） */
function Past({ q }: { q: ReturnType<typeof useLectures> }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const lessons = useLessons().data?.lessons || [];
  const cover = new Map(lessons.map((l) => [l.id, l.cover]));
  const [only, setOnly] = useState(0);
  const past = q.data?.past || [];
  const used = [...new Map(past.map((l) => [l.classId, l.className])).entries()];
  const shown = only ? past.filter((l) => l.classId === only) : past;
  const remove = async (l: LectureCard) => {
    if (!(await confirm({ title: `删掉「${l.title}」这堂课的记录？`, okText: '删掉', danger: true }))) return;
    try {
      await del(`/classroom/${l.id}`);
      qc.invalidateQueries({ queryKey: ['lectures'] });
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <section>
      <div className="mb-3.5 flex items-center gap-3">
        <h2 className="text-[18px] font-semibold text-ink">上过的课</h2>
        {used.length > 1 && (
          <Select sizeVariant="sm" className="ml-auto w-auto" value={only} onChange={(e) => setOnly(Number(e.target.value))} aria-label="哪个班">
            <option value={0}>全部班级</option>
            {used.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : !shown.length ? (
        <Card padded={false}>
          <EmptyArt src="/illustrations/entry-tutor-v2.webp" title="还没有上过课" />
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((l) => {
            const c = l.lessonId ? cover.get(l.lessonId) : null;
            const t = themeOf(l.classId);
            return (
              <li key={l.id} className="group relative">
                <button
                  type="button"
                  onClick={() => navigate(`/classroom/${l.id}`)}
                  className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-surface text-left shadow-xs transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
                >
                  <div className="aspect-video w-full overflow-hidden border-b border-line">
                    {c ? (
                      <SlideThumb slide={c.slide} theme={c.theme} />
                    ) : (
                      <div className="flex h-full items-center justify-center px-6 text-center text-[16px] font-semibold text-white" style={themeBackground(t)}>
                        {l.title}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col px-4 pb-4 pt-3">
                    <p className="line-clamp-2 text-[15px] font-semibold leading-snug text-ink">{l.title}</p>
                    <p className="mt-1 truncate text-[13px] text-ink-3">
                      {l.className} · {dayTime(l.startedAt)}
                      {l.endedAt ? ` · ${lasted(l.startedAt, l.endedAt)}` : ''}
                    </p>
                    <p className="mt-auto pt-3 text-[14px] text-ink-2">
                      来了 <b className="font-semibold text-ink">{l.attended}</b> 人
                      {l.pushed > 0 && (
                        <>
                          <span className="mx-1.5 text-ink-3">·</span>
                          {l.pushed} 道题
                          {l.rate !== null && (
                            <>
                              ，答对 <b className={cn('font-semibold', l.rate < 0.6 ? INK.bad : INK.ok)}>{percent(l.rate)}</b>
                            </>
                          )}
                        </>
                      )}
                    </p>
                  </div>
                </button>
                <div className="absolute right-2 top-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                  <Popover
                    width={140}
                    trigger={({ toggle }) => (
                      <IconButton label="更多" onClick={toggle} className="rounded-full bg-surface/90 text-ink-2 shadow-xs hover:bg-surface">
                        <MoreHorizontal className="size-[18px]" />
                      </IconButton>
                    )}
                  >
                    {(close) => (
                      <MenuItem icon={<Trash2 />} danger onClick={() => (close(), remove(l))}>
                        删掉
                      </MenuItem>
                    )}
                  </Popover>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, ErrorState, Segmented, Select, Skeleton, Textarea, cn } from '../../components/ui';
import { useClasses } from '../classes/data';
import { EmptyArt } from '../classes/look';
import { when } from '../classes/homework';
import { SlideThumb } from './Slides';
import { doingNow, useLessons, type LessonCard } from './data';

/**
 * 备课（2026-11-17 重做）：上面说一句备哪节（挑班、多长），助教几手分头做出一整套；下面是备过的课，一节一张卡片，封面是课件第一页。
 */
export function PrepPage() {
  useCrumbs([{ label: '备课' }]);
  const navigate = useNavigate();
  const classes = (useClasses().data?.classes || []).filter((k) => !k.archived);
  const q = useLessons();
  const [params, setParams] = useSearchParams();
  const only = Number(params.get('class')) || 0;
  const all = q.data?.lessons || [];
  // 只列备过课的班，没备过的班不占位置
  const used = classes.filter((k) => all.some((l) => l.classId === k.id));
  const shown = only ? all.filter((l) => l.classId === only) : all;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-5 sm:px-6 sm:py-7">
      <Composer classes={classes} defaultClass={only || all[0]?.classId || classes[0]?.id || 0} onStarted={(id) => navigate(`/prep/${id}`)} />
      <section>
        <div className="mb-4 flex items-center gap-3">
          <h2 className="text-[18px] font-semibold text-ink">备好的课</h2>
          {used.length > 1 && (
            <Select
              sizeVariant="sm"
              className="ml-auto w-auto"
              value={only}
              onChange={(e) => setParams(Number(e.target.value) ? { class: e.target.value } : {})}
              aria-label="哪个班"
            >
              <option value={0}>全部班级</option>
              {used.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : shown.length ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((l) => (
              <LessonTile key={l.id} l={l} />
            ))}
          </div>
        ) : (
          <EmptyArt src="/agents/lesson.webp" title="还没有备过课" />
        )}
      </section>
    </div>
  );
}

/** 顶上一块：插图在右边淡进底色，左边一个输入框，说这节讲什么、挑班、多长 */
function Composer({ classes, defaultClass, onStarted }: { classes: { id: number; name: string }[]; defaultClass: number; onStarted: (id: number) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [classId, setClassId] = useState(defaultClass);
  const [minutes, setMinutes] = useState(90);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!classId && defaultClass) setClassId(defaultClass);
  }, [classId, defaultClass]);
  const start = async () => {
    if (!classId || busy) return;
    setBusy(true);
    try {
      const r = await post<{ id: number }>('/prep', { classId, request: text.trim() || null, minutes });
      qc.invalidateQueries({ queryKey: ['lessons'] });
      onStarted(r.id);
    } catch (e) {
      toast.fromError(e);
      setBusy(false);
    }
  };
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-line"
      style={{ background: 'linear-gradient(100deg, var(--c-primary-soft) 0%, var(--c-surface) 78%)' }}
    >
      <img
        src="/illustrations/prep-banner.webp"
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-y-0 right-0 h-full w-auto max-w-none select-none max-lg:opacity-25"
        style={{ maskImage: 'linear-gradient(to right, transparent, #000 42%)', WebkitMaskImage: 'linear-gradient(to right, transparent, #000 42%)' }}
      />
      <div className="relative px-4 py-6 sm:px-8 sm:py-9">
        <div className="w-full max-w-[560px] rounded-xl bg-surface p-3 shadow-md ring-1 ring-line">
          <Textarea
            autoGrow
            maxRows={5}
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && start()}
            placeholder="这节课讲什么？不写就按进度备下一节"
            className="min-h-[64px] resize-none border-0 bg-transparent px-1.5 text-[15px] shadow-none focus-visible:ring-0"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select sizeVariant="sm" className="w-auto max-w-[14rem]" value={classId} onChange={(e) => setClassId(Number(e.target.value))} aria-label="给哪个班备">
              {!classes.length && <option value={0}>还没有班级</option>}
              {classes.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
            <Segmented
              size="sm"
              value={minutes}
              onChange={setMinutes}
              options={[
                { value: 45, label: '45 分钟' },
                { value: 90, label: '90 分钟' },
              ]}
            />
            <Button className="ml-auto" variant="primary" icon={<Sparkles className="size-4" />} loading={busy} disabled={!classId} onClick={start}>
              备课
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 一节课一张卡片：封面是课件第一页；还在备的蒙一层，写着在做哪一手 */
function LessonTile({ l }: { l: LessonCard }) {
  const making = l.making || l.status === 'making';
  return (
    <Link
      to={`/prep/${l.id}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="relative aspect-video overflow-hidden border-b border-line bg-surface-2">
        {l.cover ? (
          <SlideThumb slide={l.cover.slide} theme={l.cover.theme} />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-soft to-surface-2 px-5 text-center text-[15px] font-semibold text-brand-ink">
            {l.title || l.request || '下一节课'}
          </div>
        )}
        {making && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/70">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-[13px] text-brand-ink shadow-sm ring-1 ring-line">
              <Loader2 className="size-3.5 animate-spin" />
              {doingNow(l.lanes)}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3.5">
        <p className="line-clamp-2 text-[15px] font-medium leading-snug text-ink">{l.title || l.request || '下一节课'}</p>
        <p className="mt-1 text-[13px] text-ink-3">
          {l.className} · {when(l.updatedAt)}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2.5 text-[13px] text-ink-3">
          {l.counts.slides > 0 && <span>课件 {l.counts.slides} 页</span>}
          {l.counts.practice > 0 && <span>练习 {l.counts.practice}</span>}
          {l.counts.homework > 0 && <span>作业 {l.counts.homework}</span>}
          {l.assignmentId && <span className="text-ok">已发作业</span>}
          {l.status === 'error' && !making && <span className={cn('text-bad')}>没备完</span>}
        </div>
      </div>
    </Link>
  );
}

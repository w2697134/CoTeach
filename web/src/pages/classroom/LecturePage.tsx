import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Maximize2, NotebookText, Plus, Power, Send, Shuffle, BarChart3 } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, ErrorState, IconButton, PageLoading, Popover, cn, useConfirm } from '../../components/ui';
import { SlideThumb } from '../prep/Slides';
import { Panel } from './Panel';
import { RollCall, type Called } from './RollCall';
import { NewQuestion } from './NewQuestion';
import { Fit, Projector, QuestionStage } from './Stage';
import { SummaryView } from './SummaryView';
import { useLecture, useLectureState, type LectureDetail } from './data';

/**
 * 上课（/classroom/:id，2026-11-17）：在上的课是上课的页面，下了课的是小结。
 */
export function LecturePage() {
  const id = Number(useParams().id);
  const q = useLecture(id);
  const d = q.data;
  useCrumbs([{ label: '课堂', to: '/classroom' }, { label: d ? d.lecture.title : null }]);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return <PageLoading />;
  if (d.lecture.status === 'ended') return <SummaryView d={d} />;
  return <Live d={d} />;
}

/**
 * 老师这边的值（翻到第几页、大屏放哪道题）存在服务器上：老师自己刚改过的先照自己的，
 * 改完、发出去、再过一轮轮询以后跟服务器走——老师拿手机翻页，大屏上开着的页面也跟着翻。
 */
function useShared<T>(server: T | undefined, tick: number, send: (v: T) => Promise<unknown>) {
  const [local, setLocal] = useState<{ v: T } | null>(null);
  const hold = useRef(0);
  const timer = useRef(0);
  useEffect(() => {
    if (server !== undefined && Date.now() > hold.current) setLocal({ v: server });
  }, [server, tick]);
  const set = useCallback(
    (v: T) => {
      setLocal({ v });
      hold.current = Number.POSITIVE_INFINITY;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        send(v)
          .catch((e) => toast.fromError(e))
          .finally(() => (hold.current = Date.now() + 2000));
      }, 180);
    },
    [send],
  );
  return [local ? local.v : server, set] as const;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 上课多久了：23:14、1:05:09 */
function Elapsed({ from }: { from: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  const h = Math.floor(s / 3600);
  return <span className="tabular-nums">{h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`}</span>;
}

function Live({ d }: { d: LectureDetail }) {
  const id = d.lecture.id;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const sq = useLectureState(id, true);
  const state = sq.data;
  const deck = d.deck;
  const pages = deck?.slides.length ?? 0;

  // 别的设备上点了下课：这边也换成小结
  useEffect(() => {
    if (state?.status === 'ended') qc.invalidateQueries({ queryKey: ['lecture', id], exact: true });
  }, [state?.status, qc, id]);

  const sendPage = useCallback((p: number) => post(`/classroom/${id}/page`, { page: p }), [id]);
  const sendScreen = useCallback((s: number | null) => post(`/classroom/${id}/screen`, { question: s }), [id]);
  const [rawPage, setPage] = useShared<number>(state?.page, sq.dataUpdatedAt, sendPage);
  const [screen, setScreen] = useShared<number | null>(state?.screen, sq.dataUpdatedAt, sendScreen);
  const page = Math.min(Math.max(rawPage ?? 0, 0), Math.max(pages - 1, 0));
  const go = useCallback((p: number) => pages && setPage(Math.min(Math.max(p, 0), pages - 1)), [pages, setPage]);

  const [busy, setBusy] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [notes, setNotes] = useState(false);
  const [writing, setWriting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['lecture', id, 'state'] });
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  const push = (source: string) => run(`push:${source}`, () => post(`/classroom/${id}/questions`, { source }));
  const pushNew = async (question: Record<string, unknown>) => {
    try {
      await post(`/classroom/${id}/questions`, { question });
      await refresh();
    } catch (e) {
      toast.fromError(e);
      throw e;
    }
  };
  const reveal = (qid: number) => run(`reveal:${qid}`, () => post(`/classroom/${id}/questions/${qid}/reveal`, {}));

  // 随机点名：点名的这台马上弹；大屏、手机开着同一堂课的，轮询看到新的一次也弹
  const [called, setCalled] = useState<Called | null>(null);
  const seenCall = useRef<number | null | undefined>(undefined);
  const callId = state?.call?.id ?? null;
  useEffect(() => {
    if (!state) return;
    if (seenCall.current === undefined) {
      seenCall.current = callId;
      return;
    }
    if (callId !== null && callId !== seenCall.current && state.call) {
      seenCall.current = callId;
      setCalled({ id: state.call.id, name: state.call.name });
    }
  }, [callId, state]);
  const call = async () => {
    setBusy('call');
    try {
      const r = await post<Called>(`/classroom/${id}/call`, {});
      seenCall.current = r.id;
      setCalled(r);
      refresh();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };

  const end = async () => {
    if (!(await confirm({ title: '下课？', okText: '下课' }))) return;
    try {
      await post(`/classroom/${id}/end`, {});
      setFull(false);
      await qc.invalidateQueries({ queryKey: ['lecture', id] });
      qc.invalidateQueries({ queryKey: ['lectures'] });
    } catch (e) {
      toast.fromError(e);
    }
  };

  // 左右键、空格、翻页键翻课件（正在打字、开着出题框的时候不翻）
  const focused = state?.questions.find((p) => p.id === screen) ?? null;
  useEffect(() => {
    if (!deck || focused || writing) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        go(page + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go(page - 1);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [deck, focused, writing, go, page]);

  if (sq.isError && !state) return <ErrorState error={sq.error} onRetry={() => sq.refetch()} />;
  if (!state) return <PageLoading />;

  const slide = deck?.slides[page];
  const quizPushed = slide?.quiz ? state.questions.find((p) => p.source === `slide:${slide.id}`) : undefined;
  // 没带课件：大块里放最近推的那道题（没推过就是出题、点名两个大按钮）
  const shownQuestion = focused ?? (!deck ? state.questions[state.questions.length - 1] ?? null : null);
  const here = state.attendance.count;
  const stage = shownQuestion ? (
    <QuestionStage
      p={shownQuestion}
      here={here}
      busy={busy === `reveal:${shownQuestion.id}`}
      onReveal={() => reveal(shownQuestion.id)}
      onBack={focused && deck ? () => setScreen(null) : undefined}
      className={full ? 'rounded-none border-0 shadow-none' : ''}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 max-lg:overflow-y-auto">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 pt-0.5">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-bad-soft px-2.5 py-1 text-[13px] font-medium text-bad">
          <span className="size-2 animate-pulse rounded-full bg-bad" />
          上课中
          <Elapsed from={d.lecture.startedAt} />
        </span>
        <h1 className="min-w-0 max-w-full truncate text-[18px] font-semibold text-ink">{d.lecture.title}</h1>
        <span className="shrink-0 text-[13.5px] text-ink-3">{d.lecture.className}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {(deck || shownQuestion) && (
            <Button variant="secondary" className="max-lg:hidden" icon={<Maximize2 className="size-4" />} onClick={() => setFull(true)}>
              全屏
            </Button>
          )}
          <Button variant="danger" icon={<Power className="size-4" />} onClick={end}>
            下课
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 max-lg:flex-col">
        <section className="flex min-w-0 flex-1 flex-col gap-2.5 lg:min-h-0">
          <div className="lg:min-h-0 lg:flex-1">
            {stage ? (
              <div className="h-full max-lg:min-h-[360px]">{stage}</div>
            ) : deck && slide ? (
              <Fit>
                <SlideThumb slide={slide} theme={deck.theme} />
              </Fit>
            ) : (
              <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
                <img src="/illustrations/entry-practice-v2.webp" alt="" className="w-40" draggable={false} />
                <div className="flex flex-wrap justify-center gap-3">
                  <Button size="lg" variant="primary" icon={<Plus className="size-5" />} onClick={() => setWriting(true)}>
                    出一道题
                  </Button>
                  <Button size="lg" variant="secondary" icon={<Shuffle className="size-5" />} loading={busy === 'call'} disabled={!here} onClick={call}>
                    随机点名
                  </Button>
                </div>
              </div>
            )}
          </div>
          {deck && !focused && (
            <SlideBar
              deck={deck}
              page={page}
              onPage={go}
              notes={notes}
              onNotes={() => setNotes(!notes)}
              quiz={
                slide?.quiz ? (
                  quizPushed ? (
                    <Button size="sm" variant="soft" icon={<BarChart3 className="size-4" />} onClick={() => setScreen(quizPushed.id)}>
                      看作答
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" icon={<Send className="size-4" />} loading={busy === `push:slide:${slide.id}`} onClick={() => push(`slide:${slide.id}`)}>
                      推送这道题
                    </Button>
                  )
                ) : null
              }
            />
          )}
          {deck && !focused && notes && slide?.notes && (
            <div className="max-h-40 shrink-0 overflow-y-auto rounded-xl border border-line bg-surface px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-2">{slide.notes}</div>
          )}
        </section>
        <Panel
          className="rounded-2xl border border-line bg-surface shadow-xs max-lg:min-h-[420px] lg:w-[330px] lg:shrink-0 xl:w-[380px]"
          deck={deck}
          practice={d.practice}
          state={state}
          screen={screen ?? null}
          busy={busy}
          onPush={push}
          onNew={() => setWriting(true)}
          onReveal={reveal}
          onScreen={setScreen}
          onCall={call}
        />
      </div>

      {full && (
        <Projector dark={!stage} page={page} pages={stage ? 0 : pages} onPage={go} onClose={() => setFull(false)}>
          {stage ?? (slide && deck ? <SlideThumb slide={slide} theme={deck.theme} /> : null)}
        </Projector>
      )}
      {called && (
        <RollCall
          called={called}
          names={state.attendance.people.map((p) => p.name)}
          busy={busy === 'call'}
          onAgain={call}
          onClose={() => setCalled(null)}
        />
      )}
      <NewQuestion open={writing} onClose={() => setWriting(false)} onPush={pushNew} />
    </div>
  );
}

/** 课件下面一条：上一页、第几页（点开挑一页）、下一页；小测页能推送；讲稿 */
function SlideBar({
  deck,
  page,
  onPage,
  notes,
  onNotes,
  quiz,
}: {
  deck: NonNullable<LectureDetail['deck']>;
  page: number;
  onPage: (i: number) => void;
  notes: boolean;
  onNotes: () => void;
  quiz: React.ReactNode;
}) {
  const pages = deck.slides.length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <div className="flex items-center rounded-lg border border-line bg-surface shadow-xs">
        <IconButton label="上一页" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <Popover
          width={520}
          align="start"
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className="min-w-16 rounded-md px-2 py-1 text-[14px] tabular-nums text-ink-2 hover:bg-surface-3">
              {page + 1} / {pages}
            </button>
          )}
        >
          {(close) => (
            <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto p-2 sm:grid-cols-4">
              {deck.slides.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onPage(i);
                    close();
                  }}
                  className={cn('relative aspect-video overflow-hidden rounded-md border', i === page ? 'border-brand ring-2 ring-brand/25' : 'border-line hover:border-line-strong')}
                >
                  <SlideThumb slide={s} theme={deck.theme} />
                  <span className="absolute bottom-0.5 left-1 text-[11px] text-ink-3">{i + 1}</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
        <IconButton label="下一页" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          <ChevronRight className="size-5" />
        </IconButton>
      </div>
      {quiz}
      {deck.slides[page]?.notes && (
        <Button size="sm" variant="ghost" className="ml-auto" icon={<NotebookText className="size-4" />} onClick={onNotes}>
          {notes ? '收起讲稿' : '讲稿'}
        </Button>
      )}
    </div>
  );
}


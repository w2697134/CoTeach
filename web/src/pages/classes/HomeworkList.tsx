import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { get } from '../../lib/api';
import { Button, Card, ErrorState, Skeleton, cn } from '../../components/ui';
import { num, useHomeworkList, when, type Homework, type HomeworkDetail } from './homework';
import { DateBlock, EmptyArt, type Theme } from './look';
import { CHIP, INK, scoreInk } from './tone';
import { practiceLink, shortItem, type Mistake } from '../cot/practice';

/** 「黄俊熙、于泽楷」，多了写「黄俊熙、于泽楷等 5 人」 */
export const names = (list: { name: string }[], max = 2, unit = '人') =>
  list.length <= max ? list.map((s) => s.name).join('、') : `${list.slice(0, max).map((s) => s.name).join('、')}等 ${list.length} ${unit}`;

/** 作业要求的第一句，卡片上露一行 */
export const firstLine = (body: string) => body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

const DAY = 86_400_000;
/** 离截止还有多久，说成人话：「还剩 3 天」「今天 23:59 截止」；过了的写「已截止」 */
export function dueWords(due: number | null, now = Date.now()) {
  if (!due) return '不设截止';
  if (due < now) return '已截止';
  const left = due - now;
  if (left < 2 * DAY) return `${when(due)} 截止`;
  return `还剩 ${Math.floor(left / DAY)} 天`;
}

type Dot = { id: number; tone: 'done' | 'low' | 'busy' | 'flag' | 'wait' | 'back' | 'miss' | 'todo'; title: string };
type Student = NonNullable<HomeworkDetail['students']>[number];

/** 一个学生一个小方块：批好了是这个班的颜色（不到六成的红），在批的闪，等你看的橙色带圈，没交的空心 */
function dotOf(s: Student, points: number): Dot {
  const t = (tone: Dot['tone'], what: string): Dot => ({ id: s.id, tone, title: `${s.name}：${what}` });
  if (s.status === 'graded' && s.score !== null) return t(s.score / points < 0.6 ? 'low' : 'done', `${num(s.score)} 分`);
  if (s.status === 'returned') return t('back', '退回重交');
  if (s.status === 'missing') return t('miss', '没交');
  if (s.status === 'todo' || !s.status) return t('todo', '还没交');
  if (s.ai && (s.ai.status === 'queued' || s.ai.status === 'running')) return t('busy', '助教在批');
  if (s.ai?.status === 'done' && s.ai.flag) return t('flag', '助教拿不准，等你看');
  return t('wait', '交了，等批');
}

export function Dots({ dots, theme, onPick }: { dots: Dot[]; theme: Theme; onPick?: (id: number) => void }) {
  return (
    <div className="flex flex-wrap gap-[3px]">
      {dots.map((d) => (
        <button
          key={d.id}
          type="button"
          title={d.title}
          aria-label={d.title}
          tabIndex={onPick ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation();
            onPick?.(d.id);
          }}
          className={cn(
            'size-[11px] shrink-0 rounded-[3px] transition-transform hover:scale-125',
            d.tone === 'low' && 'bg-[#ef4444]',
            d.tone === 'busy' && 'animate-pulse bg-brand/60',
            d.tone === 'flag' && 'bg-[#f59e0b] ring-2 ring-[#f59e0b]/35',
            d.tone === 'wait' && 'bg-[#f59e0b]/70',
            d.tone === 'back' && 'border-2 border-[#f59e0b]',
            d.tone === 'miss' && 'border-2 border-[#ef4444]/60',
            d.tone === 'todo' && 'border-2 border-line-strong',
          )}
          style={d.tone === 'done' ? { backgroundColor: theme.ink } : undefined}
        />
      ))}
    </div>
  );
}

/** 没取到每个人的时候，按人数排出同样的小方块（不带名字） */
const countDots = (h: Homework): Dot[] => {
  const total = h.total || 0,
    graded = h.graded || 0,
    inn = h.submitted || 0;
  const past = !!h.dueAt && h.dueAt < Date.now();
  return Array.from({ length: total }, (_, i) => ({
    id: -i - 1,
    tone: i < graded ? 'done' : i < inn ? 'wait' : past ? 'miss' : 'todo',
    title: i < graded ? '批好了' : i < inn ? '交了，等批' : '还没交',
  }));
};

interface Story {
  line: ReactNode;
  action?: { label: string; to: string; primary?: boolean };
  /** 学生：批了的分数，摆在标题右边 */
  score?: ReactNode;
}

/** 老师那张卡片上的一句话：先说要你做的（拿不准的、等你发的、等你批的），再说谁没交；用得上按钮的给一个 */
function teacherStory(h: Homework, d: HomeworkDetail | undefined, classId: number, now: number): Story {
  const base = `/classes/${classId}/homework/${h.id}`;
  if (h.publishAt > now) return { line: <>{when(h.publishAt)} 自动发给学生</> };
  if (!d?.students) {
    const wait = (h.submitted || 0) - (h.graded || 0);
    return { line: wait > 0 ? `交了 ${h.submitted} 人，${wait} 份还没批` : h.submitted ? `交了 ${h.submitted} 人，都批好了` : '还没人交' };
  }
  const joined = d.students.filter((s) => s.joined);
  const handedIn = (s: Student) => s.status === 'submitted' || s.status === 'late';
  const flagged = joined.filter((s) => handedIn(s) && s.score === null && s.ai?.status === 'done' && !!s.ai.flag);
  const drafts = joined.filter((s) => handedIn(s) && s.score === null && s.ai?.status === 'done' && !s.ai.flag && !s.ai.released);
  const manual = joined.filter((s) => handedIn(s) && s.score === null && (!s.ai || s.ai.status === 'error'));
  const graded = joined.filter((s) => s.status === 'graded' && s.score !== null);
  const missing = joined.filter((s) => s.status === 'missing');
  const todo = joined.filter((s) => s.status === 'todo');
  const running = d.grading || 0;
  const avg = graded.length ? graded.reduce((n, s) => n + (s.score || 0), 0) / graded.length : null;

  let first: ReactNode = null;
  let action: Story['action'];
  if (running) first = <span className="text-brand-ink">助教在批，还剩 {running} 份</span>;
  else if (flagged.length) {
    first = (
      <>
        <b className="font-medium">{names(flagged, 2, '份')}</b>
        {flagged.length === 1 ? '那份' : flagged.length === 2 ? '这两份' : ''}助教拿不准，等你看
      </>
    );
    action = { label: '去看看', to: `${base}?s=${flagged[0].id}`, primary: true };
  } else if (drafts.length) {
    first = `助教批好 ${drafts.length} 份，等你看过再发`;
    action = { label: '去发', to: base, primary: true };
  } else if (manual.length) {
    first = `${manual.length} 份等你批`;
    action = { label: '去批', to: `${base}?s=${manual[0].id}`, primary: true };
  } else if (graded.length) first = `批完了，平均 ${num(avg!)} 分`;
  else if (!todo.length && !missing.length) first = '还没人交';

  const who: ReactNode = todo.length ? (
    todo.length <= 3 ? `${names(todo, 3)}还没交` : `还有 ${todo.length} 人没交`
  ) : missing.length ? (
    <>
      <b className="font-medium">{names(missing)}</b>没交
    </>
  ) : joined.length && graded.length + flagged.length + drafts.length + manual.length > 0 ? (
    '全班都交了'
  ) : null;

  if (!action && graded.length && !running && !flagged.length && !drafts.length && !manual.length) {
    if (!d.review) action = { label: '写讲评', to: `${base}/review` };
    else if (d.review.status === 'ready' && !d.review.shared) action = { label: '讲评', to: `${base}/review` };
  }
  const review = d.review?.shared ? '讲评发了' : null;
  const parts = [first, who, review].filter(Boolean);
  return {
    line: parts.map((p, i) => (
      <span key={i}>
        {i > 0 && <span className="mx-1.5 text-ink-3">·</span>}
        {p}
      </span>
    )),
    action,
  };
}

/** 学生那张卡片：还没交的写还剩几天、给「去交」；批了的写分数和丢分最多的那一项；退回的给「重交」 */
function studentStory(h: Homework, now: number, lost: Mistake[] | undefined): Story {
  const s = h.status;
  if (s === 'graded' && h.score !== null && h.score !== undefined) {
    const worst = [...(lost || [])].sort((a, b) => b.max - b.got - (a.max - a.got))[0];
    return {
      line:
        h.score >= h.points ? (
          '满分'
        ) : worst ? (
          <>
            丢分最多的是<b className="font-medium">「{shortItem(worst.title)}」</b>，扣了 {num(worst.max - worst.got)} 分
          </>
        ) : (
          '批好了'
        ),
      ...(worst ? { action: { label: '练一练', to: practiceLink(h.title, worst) } } : {}),
      score: (
        <span className="shrink-0 text-right leading-none">
          <span className={cn('text-[24px] font-semibold tabular-nums', scoreInk(h.score, h.points))}>{num(h.score)}</span>
          <span className="ml-0.5 text-[14px] text-ink-2">/{num(h.points)}</span>
        </span>
      ),
    };
  }
  if (s === 'returned') return { line: <span className={INK.warn}>老师退回了，改好再交一次</span>, action: { label: '重交', to: '', primary: true } };
  if (s === 'missing') return { line: <span className={INK.bad}>过了截止，没交</span>, ...(h.allowLate ? { action: { label: '补交', to: '' } } : {}) };
  if (s === 'submitted' || s === 'late') return { line: s === 'late' ? '迟交了，等批改' : '交了，等批改' };
  return { line: h.dueAt && h.dueAt < now ? '还没交' : `还没交，${dueWords(h.dueAt, now)}`, action: { label: '去交', to: '', primary: true } };
}

/**
 * 班级页「作业」栏：一份作业一张卡片，新的在上面。左边是截止那天，右边是标题、要求的第一句；
 * 老师还看到一人一个小方块（谁交了、批了多少分，点一下打开那个人的），下面一句话说现在要你做什么、谁没交。
 */
export function HomeworkList({
  classId,
  theme,
  student,
  archived,
  createAbove = true,
}: {
  classId: number;
  theme: Theme;
  student: boolean;
  archived: boolean;
  /** 列表上面摆「布置作业」；班级页摆在分栏那一行，这里就不摆 */
  createAbove?: boolean;
}) {
  const navigate = useNavigate();
  const q = useHomeworkList(classId);
  const list = q.data?.homework || [];
  const now = Date.now();
  // 老师：最近发出去的 6 份把每个学生的情况也取来。跟作业页同一份数据，点进去不用再等
  const recent = student ? [] : list.filter((h) => h.publishAt <= now).slice(0, 6);
  const details = useQueries({
    queries: recent.map((h) => ({ queryKey: ['homework', h.id], queryFn: () => get<HomeworkDetail>(`/homework/${h.id}`), staleTime: 15_000 })),
  });
  const detail = new Map(recent.map((h, i) => [h.id, details[i]?.data]));
  // 学生：错题本那份数据（跟错题本页同一份），批好的作业写丢分最多的那一项
  const mistakes = useQuery({
    queryKey: ['mistakes'],
    queryFn: () => get<{ homework: { id: number; items: Mistake[] }[] }>('/cot/mistakes'),
    enabled: student,
    staleTime: 30_000,
  });
  const lostOf = new Map((mistakes.data?.homework || []).map((x) => [x.id, x.items]));
  const create = () => navigate(`/classes/${classId}/homework/new`);
  const canCreate = !student && !archived;
  return (
    <div className="space-y-3">
      {canCreate && createAbove && list.length > 0 && (
        <Button icon={<Plus className="size-4" />} onClick={create}>
          布置作业
        </Button>
      )}
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : !list.length ? (
        <Card padded={false}>
          <EmptyArt
            src="/illustrations/entry-homework-v1.webp"
            title={student ? '老师还没布置作业' : '还没有作业'}
            action={
              canCreate && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={create}>
                  布置作业
                </Button>
              )
            }
          />
        </Card>
      ) : (
        list.map((h) => {
          const open = (sid?: number) => navigate(`/classes/${classId}/homework/${h.id}${sid ? `?s=${sid}` : ''}`);
          const scheduled = h.publishAt > now;
          const past = !scheduled && !!h.dueAt && h.dueAt < now;
          const soon = !scheduled && !!h.dueAt && h.dueAt >= now && h.dueAt - now < 2 * DAY;
          const d = detail.get(h.id);
          const story = student ? studentStory(h, now, lostOf.get(h.id)) : teacherStory(h, d, classId, now);
          const dots = student || scheduled ? null : d?.students ? d.students.filter((s) => s.joined).map((s) => dotOf(s, h.points)) : countDots(h);
          const snippet = firstLine(h.body);
          return (
            <Card
              key={h.id}
              padded={false}
              role="link"
              tabIndex={0}
              onClick={() => open()}
              onKeyDown={(e) => e.key === 'Enter' && open()}
              className="group flex cursor-pointer gap-4 px-4 py-4 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md sm:gap-5 sm:px-5"
            >
              <DateBlock t={scheduled ? h.publishAt : h.dueAt} label={scheduled ? '发布' : '截止'} theme={theme} past={past} soon={soon} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-[16px] font-semibold leading-snug text-ink group-hover:text-brand-ink">{h.title}</h3>
                    <p className="mt-1 text-[14px] text-ink-2">
                      满分 {num(h.points)}
                      <span className="mx-1.5 text-ink-3">·</span>
                      {scheduled ? (h.dueAt ? `${when(h.dueAt)} 截止` : '不设截止') : dueWords(h.dueAt, now)}
                      {scheduled && <span className={cn('ml-2 whitespace-nowrap rounded-full px-2 py-0.5 text-[13px]', CHIP.gray)}>还没发</span>}
                    </p>
                  </div>
                  {story.score}
                  {!student && !scheduled && d?.students && (
                    <ChevronRight className="mt-1 size-5 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
                  )}
                </div>
                {snippet && <p className="mt-2 line-clamp-1 max-w-[44em] break-all text-[14px] text-ink-2">{snippet}</p>}
                {dots && dots.length > 0 && (
                  <div className="mt-3 flex items-center gap-3">
                    <Dots dots={dots} theme={theme} onPick={d?.students ? (sid) => open(sid) : undefined} />
                  </div>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2.5">
                  <p className="w-full min-w-0 text-[14px] leading-relaxed text-ink sm:w-auto sm:flex-1">{story.line}</p>
                  {story.action && !archived && (
                    <Button
                      size="sm"
                      variant={story.action.primary ? 'primary' : 'secondary'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (story.action!.to) navigate(story.action!.to);
                        else open();
                      }}
                    >
                      {story.action.label}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}

/** 学生那一行右边：批了的写分数，别的写状态（成绩栏用） */
export function StudentMark({ h }: { h: { status?: Homework['status']; score?: number | null; points: number } }) {
  if (!h.status) return null;
  if (h.status === 'graded' && h.score !== null && h.score !== undefined)
    return (
      <span className="shrink-0 text-[14px] tabular-nums text-ink-2">
        <span className={cn('text-[16px] font-semibold', scoreInk(h.score, h.points))}>{num(h.score)}</span>/{num(h.points)}
      </span>
    );
  const s = STATUS_WORD[h.status];
  return <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-[13px]', s.tone)}>{s.label}</span>;
}

const STATUS_WORD: Record<NonNullable<Homework['status']>, { label: string; tone: string }> = {
  todo: { label: '还没交', tone: CHIP.gray },
  missing: { label: '没交', tone: CHIP.bad },
  submitted: { label: '等批改', tone: CHIP.info },
  late: { label: '迟交了', tone: CHIP.warn },
  graded: { label: '批好了', tone: CHIP.ok },
  returned: { label: '退回重交', tone: CHIP.warn },
};

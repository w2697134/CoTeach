import { useNavigate } from 'react-router';
import { ClipboardList, Plus } from 'lucide-react';
import { Card, ErrorState, Skeleton, cn } from '../../components/ui';
import { STATUS, num, useHomeworkList, when, type Homework } from './homework';
import { EmptyArt, type Theme } from './look';

/** 班级页「作业」栏：照 Google Classroom 的「课堂作业」，新的在上面，一行一份 */
export function HomeworkList({ classId, theme, student, archived }: { classId: number; theme: Theme; student: boolean; archived: boolean }) {
  const navigate = useNavigate();
  const q = useHomeworkList(classId);
  const list = q.data?.homework || [];
  const create = () => navigate(`/classes/${classId}/homework/new`);
  const canCreate = !student && !archived;
  return (
    <div className="space-y-4">
      {canCreate && list.length > 0 && (
        <button
          type="button"
          onClick={create}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-4 text-[14px] text-ink-2 shadow-xs transition-colors hover:border-brand/50 hover:text-brand"
        >
          <Plus className="size-4" />
          布置作业
        </button>
      )}
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : !list.length ? (
        <Card padded={false}>
          <EmptyArt
            src="/illustrations/entry-homework-v1.webp"
            title="还没有作业"
            action={
              canCreate && (
                <button
                  type="button"
                  onClick={create}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand px-4 text-[14.5px] font-medium text-white shadow-xs transition-colors hover:bg-brand-hover"
                >
                  <Plus className="size-4" />
                  布置作业
                </button>
              )
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <ul>
            {list.map((h) => (
              <li key={h.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => navigate(`/classes/${classId}/homework/${h.id}`)}
                  className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-surface-2 sm:px-6"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${theme.ink}1f`, color: theme.ink }}>
                    <ClipboardList className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-ink">{h.title}</span>
                    <span className="mt-0.5 block truncate text-[13px] text-ink-3">{meta(h)}</span>
                  </span>
                  {student ? <StudentMark h={h} /> : <TeacherMark h={h} />}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const meta = (h: Homework) => [h.dueAt ? `截止 ${when(h.dueAt)}` : '不设截止', `满分 ${num(h.points)}`].join(' · ');

/** 老师那一行右边：没到发布时间的写什么时候发；发了的写交了几个、还有几个没批 */
function TeacherMark({ h }: { h: Homework }) {
  if (h.publishAt > Date.now()) return <span className="shrink-0 rounded-full bg-surface-3 px-2.5 py-0.5 text-[12.5px] text-ink-2">{when(h.publishAt)} 发布</span>;
  const waiting = (h.submitted || 0) - (h.graded || 0);
  return (
    <span className="flex shrink-0 items-center gap-3 text-[13px] text-ink-3">
      <span>
        已交 <span className="font-medium tabular-nums text-ink">{h.submitted}</span>/{h.total}
      </span>
      {waiting > 0 && <span className="rounded-full bg-info-soft px-2 py-0.5 text-[12.5px] text-info">待批 {waiting}</span>}
    </span>
  );
}

/** 学生那一行右边：批了的写分数，别的写状态 */
export function StudentMark({ h }: { h: { status?: Homework['status']; score?: number | null; points: number } }) {
  if (!h.status) return null;
  if (h.status === 'graded' && h.score !== null && h.score !== undefined)
    return (
      <span className="shrink-0 text-[14px] tabular-nums text-ink-3">
        <span className={cn('text-[16px] font-semibold', h.score / h.points >= 0.6 ? 'text-ok' : 'text-bad')}>{num(h.score)}</span>/{num(h.points)}
      </span>
    );
  const s = STATUS[h.status];
  return <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-[12.5px]', s.tone)}>{s.label}</span>;
}

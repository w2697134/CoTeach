import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useCrumbs } from '../../components/layout/Crumbs';
import { get } from '../../lib/api';
import { Avatar, Empty, ErrorState, Skeleton } from '../../components/ui';
import { useClass } from './data';
import { BuddyRunBlock } from '../cot/Thread';
import type { StuRun } from '../cot/data';

/**
 * 老师看一个学生跟 CoT 学伴说了什么（2026-11-16，照 Khanmigo、MagicSchool）：只能看。
 * 学生还在别的老师的班里时，只看得到说这个老师的班的那几轮。
 */
export function StudentChatPage() {
  const { id, sid } = useParams();
  const classId = Number(id),
    csid = Number(sid);
  const k = useClass(classId);
  const q = useQuery({
    queryKey: ['student-cot', classId, csid],
    queryFn: () => get<{ name: string; studentNo: string; joined: boolean; runs: StuRun[] }>(`/cot/students/${csid}?class=${classId}`),
  });
  useCrumbs([{ label: '课程', to: '/classes' }, { label: k.data?.name, to: `/classes/${classId}?tab=people` }, { label: q.data?.name }]);
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-64" />;
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center gap-3">
        <Avatar name={q.data.name} seed={csid} size={40} />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[18px] font-semibold text-ink">{q.data.name}</p>
          <p className="mt-0.5 text-[14px] tabular-nums text-ink-2">{q.data.studentNo} · 跟学伴说的</p>
        </div>
      </div>
      {!q.data.runs.length ? (
        <Empty compact title="还没有跟学伴说过话" />
      ) : (
        <div className="space-y-6">
          {q.data.runs.map((run) => (
            <BuddyRunBlock key={run.id} run={run} live={null} />
          ))}
        </div>
      )}
    </div>
  );
}

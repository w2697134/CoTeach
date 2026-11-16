import { useNavigate } from 'react-router';
import { Download } from 'lucide-react';
import { Button, Card, Empty, ErrorState, Skeleton, cn } from '../../components/ui';
import { STATUS, num, useGrades, type Grades } from './homework';
import { StudentMark } from './HomeworkList';
import type { Theme } from './look';

/** 一格：批了写分数，没批的写状态（缺交红、待批蓝），还没到截止的空着 */
function Cell({ cell }: { cell: Grades['rows'][number]['cells'][number] | undefined }) {
  if (!cell) return null;
  if (cell.score !== null) return <span className="font-medium tabular-nums text-ink">{num(cell.score)}</span>;
  if (!cell.status || cell.status === 'todo') return <span className="text-ink-3">—</span>;
  const s = STATUS[cell.status];
  const word = cell.status === 'submitted' || cell.status === 'late' ? '待批' : s.label;
  return <span className={cn('rounded-full px-2 py-0.5 text-[12px]', s.tone)}>{word}</span>;
}

/**
 * 班级页「成绩」栏（照 Google Classroom 的成绩表）：老师看一行一个学生、一列一份作业，最后一列平均分（百分制），能导出 Excel；
 * 学生只看到自己的。平均分：批了的按分数算，过了截止没交的算 0，还没批的不算。
 */
export function GradesTab({
  classId,
  theme,
  student,
  exportAbove = true,
}: {
  classId: number;
  theme: Theme;
  student: boolean;
  /** 表上面摆「导出 Excel」；班级页摆在分栏那一行，这里就不摆 */
  exportAbove?: boolean;
}) {
  const navigate = useNavigate();
  const q = useGrades(classId);
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-48 rounded-lg" />;
  const g = q.data;
  if (!g.homework.length)
    return (
      <Card padded={false}>
        <Empty title="还没有发布的作业" />
      </Card>
    );
  if (student) {
    const me = g.rows[0];
    return (
      <Card padded={false}>
        <div className="flex items-baseline gap-2 border-b border-line px-5 py-5 sm:px-6">
          <span className="text-[14px] text-ink-3">平均分</span>
          <span className="text-[30px] font-semibold tabular-nums leading-none" style={{ color: theme.ink }}>
            {me?.average !== null && me?.average !== undefined ? num(me.average) : '—'}
          </span>
          <span className="text-[13px] text-ink-3">百分制</span>
        </div>
        <ul>
          {g.homework.map((h) => {
            const cell = me?.cells[h.id];
            return (
              <li key={h.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => navigate(`/classes/${classId}/homework/${h.id}`)}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2 sm:px-6"
                >
                  <span className="min-w-0 flex-1 truncate text-[14.5px] text-ink">{h.title}</span>
                  <StudentMark h={{ status: cell?.status ?? undefined, score: cell?.score, points: h.points }} />
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    );
  }
  const exportGrades = () => {
    const a = document.createElement('a');
    a.href = `/api/homework/class/${classId}/grades/export`;
    a.click();
  };
  const stick = 'sticky left-0 z-[1] bg-surface';
  return (
    <div className="space-y-3">
      {exportAbove && (
        <div className="flex justify-end">
          <Button size="sm" icon={<Download className="size-4" />} onClick={exportGrades}>
            导出 Excel
          </Button>
        </div>
      )}
      <Card padded={false} className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-line text-left align-bottom">
                <th className={cn(stick, 'min-w-[150px] px-5 py-3 font-medium text-ink-2 sm:px-6')}>学生</th>
                {g.homework.map((h) => (
                  <th key={h.id} className="min-w-[110px] max-w-[160px] px-3 py-3 font-normal">
                    <button
                      type="button"
                      onClick={() => navigate(`/classes/${classId}/homework/${h.id}`)}
                      className="line-clamp-2 text-left font-medium text-ink hover:underline"
                      title={h.title}
                    >
                      {h.title}
                    </button>
                    <span className="mt-0.5 block text-[12.5px] text-ink-3">满分 {num(h.points)}</span>
                  </th>
                ))}
                <th className="min-w-[90px] px-5 py-3 text-right font-medium" style={{ color: theme.ink }}>
                  平均分
                </th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.id} className="group border-b border-line last:border-0 hover:bg-surface-2">
                  <td className={cn(stick, 'px-5 py-2.5 group-hover:bg-surface-2 sm:px-6')}>
                    <span className={cn('block truncate font-medium', r.joined ? 'text-ink' : 'text-ink-3')}>{r.name}</span>
                    <span className="block text-[12.5px] tabular-nums text-ink-3">
                      {r.studentNo}
                      {!r.joined && ' · 还没加入'}
                    </span>
                  </td>
                  {g.homework.map((h) => (
                    <td key={h.id} className="px-3 py-2.5">
                      <Cell cell={r.cells[h.id]} />
                    </td>
                  ))}
                  <td className="px-5 py-2.5 text-right font-semibold tabular-nums" style={{ color: theme.ink }}>
                    {r.average !== null ? num(r.average) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

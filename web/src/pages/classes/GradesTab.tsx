import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import { Button, Card, Empty, ErrorState, Skeleton, cn } from '../../components/ui';
import { STATUS, num, useGrades, when, type Grades } from './homework';
import { StudentMark } from './HomeworkList';
import { THEME_TEXT, inkVars, type Theme } from './look';
import { CHIP, INK, scoreInk } from './tone';

type Cell = Grades['rows'][number]['cells'][number];

/** 一格：批了写分数（不到六成红的），没批的写状态（没交、待批），还没到截止的写一道横线 */
function CellView({ cell, points }: { cell: Cell | undefined; points: number }) {
  if (!cell) return null;
  if (cell.score !== null) return <span className={cn('text-[15px] tabular-nums', cell.score / points < 0.6 ? cn('font-semibold', INK.bad) : 'text-ink')}>{num(cell.score)}</span>;
  if (!cell.status || cell.status === 'todo') return <span className="text-ink-3">—</span>;
  const word = cell.status === 'submitted' || cell.status === 'late' ? '待批' : cell.status === 'missing' ? '没交' : STATUS[cell.status].label;
  const tone = cell.status === 'missing' ? CHIP.bad : cell.status === 'returned' ? CHIP.warn : CHIP.info;
  return <span className={cn('rounded-full px-2 py-0.5 text-[13px]', tone)}>{word}</span>;
}

/** 平均分：数字前面一根短条，扫一眼就看出谁高谁低 */
function Average({ v, theme }: { v: number | null; theme: Theme }) {
  if (v === null) return <span className="text-ink-3">—</span>;
  return (
    <span className="inline-flex items-center justify-end gap-2.5">
      <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-surface-3 sm:block">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, v))}%`, backgroundColor: v < 60 ? '#ef4444' : theme.ink }} />
      </span>
      <span className={cn('w-10 text-[15px] font-semibold tabular-nums', scoreInk(v, 100))}>{num(v)}</span>
    </span>
  );
}

type Sort = 'no' | 'down' | 'up';

/**
 * 班级页「成绩」栏（照 Google Classroom 的成绩表）：老师看一行一个学生、一列一份作业，最后一列平均分（百分制），能导出 Excel；
 * 表头写每份作业全班平均，点「平均分」能按高低排。学生只看到自己的。平均分：批了的按分数算，过了截止没交的算 0，还没批的不算。
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
  const [sort, setSort] = useState<Sort>('no');
  const g = q.data;
  // 每份作业全班平均（只算批了的）
  const avgOf = useMemo(() => {
    const m = new Map<number, number | null>();
    for (const h of g?.homework || []) {
      const got = (g?.rows || []).map((r) => r.cells[h.id]?.score).filter((x): x is number => x !== null && x !== undefined);
      m.set(h.id, got.length ? got.reduce((a, b) => a + b, 0) / got.length : null);
    }
    return m;
  }, [g]);
  const rows = useMemo(() => {
    const list = [...(g?.rows || [])];
    if (sort === 'no') return list;
    const v = (r: (typeof list)[number]) => (r.average === null ? (sort === 'down' ? -1 : 1e9) : r.average);
    return list.sort((a, b) => (sort === 'down' ? v(b) - v(a) : v(a) - v(b)));
  }, [g, sort]);
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!g) return <Skeleton className="h-48 rounded-lg" />;
  if (!g.homework.length)
    return (
      <Card padded={false}>
        <Empty title="还没有发布的作业" />
      </Card>
    );
  if (student) {
    const me = g.rows[0];
    const avg = me?.average ?? null;
    return (
      <Card padded={false}>
        <div className="flex items-baseline gap-2 border-b border-line px-5 py-5 sm:px-6">
          <span className="text-[15px] text-ink-2">我的平均分</span>
          <span className={cn('text-[24px] font-semibold leading-none tabular-nums', avg !== null && avg < 60 ? INK.bad : THEME_TEXT)} style={inkVars(theme)}>
            {avg !== null ? num(avg) : '—'}
          </span>
          <span className="text-[14px] text-ink-2">百分制</span>
        </div>
        <ul>
          {g.homework.map((h) => {
            const cell = me?.cells[h.id];
            const pct = cell?.score !== null && cell?.score !== undefined ? (cell.score / h.points) * 100 : null;
            return (
              <li key={h.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => navigate(`/classes/${classId}/homework/${h.id}`)}
                  className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-surface-2 sm:px-6"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-ink">{h.title}</span>
                    {h.dueAt && <span className="mt-0.5 block text-[13px] text-ink-3">{when(h.dueAt)} 截止</span>}
                  </span>
                  {pct !== null && (
                    <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-surface-3 sm:block">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(3, pct)}%`, backgroundColor: pct < 60 ? '#ef4444' : theme.ink }} />
                    </span>
                  )}
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
  const all = g.rows.map((r) => r.average).filter((x): x is number => x !== null);
  const classAvg = all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
  const stick = 'sticky left-0 z-[1]';
  const nextSort = () => setSort((s) => (s === 'no' ? 'down' : s === 'down' ? 'up' : 'no'));
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
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr className="border-b border-line-strong text-left align-bottom">
                <th className={cn(stick, 'min-w-[160px] bg-surface px-5 py-3.5 sm:px-6')}>
                  <button type="button" onClick={() => setSort('no')} title="按学号排" className={cn('text-[14px] font-medium', sort === 'no' ? 'text-ink' : 'text-ink-2 hover:text-ink')}>
                    学生
                  </button>
                </th>
                {g.homework.map((h) => {
                  const avg = avgOf.get(h.id);
                  return (
                    <th key={h.id} className="min-w-[128px] max-w-[180px] px-3 py-3.5 font-normal">
                      <button
                        type="button"
                        onClick={() => navigate(`/classes/${classId}/homework/${h.id}`)}
                        className="line-clamp-2 text-left text-[14px] font-medium leading-snug text-ink hover:text-brand-ink hover:underline"
                        title={h.title}
                      >
                        {h.title}
                      </button>
                      <span className="mt-1 block text-[13px] text-ink-2">
                        满分 {num(h.points)}
                        {avg !== null && avg !== undefined && <> · 平均 {num(avg)}</>}
                      </span>
                    </th>
                  );
                })}
                <th className="min-w-[120px] px-5 py-3.5 text-right sm:px-6">
                  <button
                    type="button"
                    onClick={nextSort}
                    className={cn('inline-flex items-center gap-1 text-[14px] font-semibold', THEME_TEXT)}
                    style={inkVars(theme)}
                    title="按平均分排"
                  >
                    平均分
                    {sort === 'down' ? <ArrowDown className="size-4" /> : sort === 'up' ? <ArrowUp className="size-4" /> : null}
                  </button>
                  {classAvg !== null && <span className="mt-1 block text-[13px] font-normal text-ink-2">全班 {num(classAvg)}</span>}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const zebra = i % 2 === 1;
                return (
                  <tr key={r.id} className={cn('group border-b border-line last:border-0', zebra && 'bg-surface-2')}>
                    <td className={cn(stick, 'px-5 py-2.5 sm:px-6', zebra ? 'bg-surface-2' : 'bg-surface', 'group-hover:bg-brand-soft')}>
                      <span className={cn('block truncate text-[15px] font-medium', r.joined ? 'text-ink' : 'text-ink-2')}>{r.name}</span>
                      <span className="block text-[13px] tabular-nums text-ink-3">
                        {r.studentNo}
                        {!r.joined && ' · 还没加入'}
                      </span>
                    </td>
                    {g.homework.map((h) => (
                      <td key={h.id} className="px-3 py-2.5 group-hover:bg-brand-soft">
                        <CellView cell={r.cells[h.id]} points={h.points} />
                      </td>
                    ))}
                    <td className="px-5 py-2.5 text-right group-hover:bg-brand-soft sm:px-6">
                      <Average v={r.average} theme={theme} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

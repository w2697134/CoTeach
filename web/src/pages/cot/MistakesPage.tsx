import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Dumbbell } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { get } from '../../lib/api';
import { Button, Card, ErrorState, Skeleton, cn } from '../../components/ui';
import { EmptyArt } from '../classes/look';
import { num, when } from '../classes/homework';
import { CHIP, INK, scoreInk } from '../classes/tone';
import { practiceLink, shortItem, type Mistake } from './practice';

interface MistakeHomework {
  id: number;
  title: string;
  classId: number;
  className: string;
  score: number;
  points: number;
  gradedAt: number | null;
  items: Mistake[];
}

/** 「第3题（40分）之二：九九乘法表输出格式」前面那截（第几题、几分）单独小字写 */
const prefix = (t: string) => {
  const m = t.match(/^(.*?)[：:]/);
  return m ? m[1] : '';
};

/** 一项丢了分的：短名字、扣了几分、为什么（一行四十几个字，长的先露四行），「练一练」 */
function Item({ h, m }: { h: MistakeHomework; m: Mistake }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const lost = m.max - m.got;
  const long = m.why.length > 135;
  return (
    <li className="flex flex-col rounded-xl border border-line bg-surface px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[16px] font-semibold leading-snug text-ink">{shortItem(m.title)}</p>
          {prefix(m.title) && <p className="mt-0.5 text-[13px] text-ink-3">{prefix(m.title)}</p>}
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-[14px] font-medium', CHIP.bad)}>扣 {num(lost)} 分</span>
      </div>
      <p className={cn('mt-2.5 max-w-[44em] break-words text-[15px] leading-relaxed text-ink-2', !open && 'line-clamp-4')}>{m.why}</p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 inline-flex w-fit items-center gap-1 text-[14px] text-brand-ink hover:underline">
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
          {open ? '收起' : '看全'}
        </button>
      )}
      <div className="mt-auto flex items-center gap-3 pt-3.5">
        <span className="text-[14px] tabular-nums text-ink-2">
          得 <b className={cn('font-semibold', m.got <= 0 ? INK.bad : 'text-ink')}>{num(m.got)}</b> / {num(m.max)}
        </span>
        <Button size="sm" variant="soft" className="ml-auto" icon={<Dumbbell className="size-4" />} onClick={() => navigate(practiceLink(h.title, m))}>
          练一练
        </Button>
      </div>
    </li>
  );
}

/**
 * 学生的错题本（2026-11-16，左侧栏）：各个班批好的作业里丢了分的那几项，新的在前，一份作业一组，一项一张卡片。
 * 每项写扣了几分和扣分原因；「练一练」把这一项带到学伴那里，学伴出一道类似的新题，做完帮着判。
 */
export function MistakesPage() {
  const navigate = useNavigate();
  useCrumbs([{ label: '错题本' }]);
  const q = useQuery({ queryKey: ['mistakes'], queryFn: () => get<{ homework: MistakeHomework[] }>('/cot/mistakes') });
  const [only, setOnly] = useState(0);
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-60 rounded-lg" />;
  const list = q.data.homework;
  if (!list.length)
    return (
      <Card padded={false}>
        <EmptyArt src="/illustrations/entry-practice-v2.webp" title="批好的作业里还没有扣分的题" />
      </Card>
    );
  const classes = [...new Map(list.map((h) => [h.classId, h.className])).entries()];
  const shown = only ? list.filter((h) => h.classId === only) : list;
  const total = shown.reduce((n, h) => n + h.items.length, 0);
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">错题本</h1>
          <p className="mt-1.5 text-[15px] text-ink-2">
            {shown.length} 份作业里扣分的 {total} 处
          </p>
          {classes.length > 1 && (
            <div className="mt-3.5 flex flex-wrap gap-1.5">
              {[[0, '全部'] as [number, string], ...classes].map(([id, name]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setOnly(id)}
                  aria-pressed={only === id}
                  className={cn(
                    'h-8 rounded-full px-3.5 text-[14px] font-medium transition-colors',
                    only === id ? 'bg-ink text-surface' : 'bg-surface text-ink-2 ring-1 ring-line hover:text-ink hover:ring-line-strong',
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
        <img src="/illustrations/entry-practice-v2.webp" alt="" draggable={false} className="hidden w-32 shrink-0 select-none sm:block" />
      </div>
      {shown.map((h) => (
        <section key={h.id}>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <button type="button" onClick={() => navigate(`/classes/${h.classId}/homework/${h.id}`)} className="min-w-0 text-left">
              <h2 className="break-words text-[18px] font-semibold text-ink hover:text-brand-ink">{h.title}</h2>
            </button>
            <span className="text-[14px] text-ink-2">
              {classes.length > 1 && `${h.className} · `}
              {h.gradedAt ? `${when(h.gradedAt)} 批的` : ''}
            </span>
            <span className="ml-auto text-[15px] tabular-nums text-ink-2">
              <b className={cn('text-[18px] font-semibold', scoreInk(h.score, h.points))}>{num(h.score)}</b> / {num(h.points)}
            </span>
          </div>
          <ul className="grid gap-3 lg:grid-cols-2">
            {h.items.map((m) => (
              <Item key={m.no} h={h} m={m} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

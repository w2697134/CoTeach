import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Dumbbell } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { get } from '../../lib/api';
import { Button, Card, ErrorState, Skeleton } from '../../components/ui';
import { EmptyArt } from '../classes/look';
import { num, when } from '../classes/homework';

interface Mistake {
  no: number;
  title: string;
  got: number;
  max: number;
  why: string;
}
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

/** 点「练一练」带到学伴那里的话：哪份作业哪一项、丢了几分、为什么，让它出一道类似的新题 */
const practice = (h: MistakeHomework, m: Mistake) =>
  `练一练：「${h.title}」的${m.title}我丢了 ${num(m.max - m.got)} 分，${m.why.replace(/\s+/g, ' ').slice(0, 200)}\n照这个出一道类似的新题给我练，我做完你帮我看对不对。`;

/**
 * 学生的错题本（2026-11-16，左侧栏）：各个班批好的作业里丢了分的那几项，新的在前，一份作业一张卡片。
 * 每项写得分和扣分原因；「练一练」把这一项带到学伴那里，学伴出一道类似的新题，做完帮着判。
 */
export function MistakesPage() {
  const navigate = useNavigate();
  useCrumbs([{ label: '错题本' }]);
  const q = useQuery({ queryKey: ['mistakes'], queryFn: () => get<{ homework: MistakeHomework[] }>('/cot/mistakes') });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-60 rounded-lg" />;
  const list = q.data.homework;
  if (!list.length)
    return (
      <Card padded={false}>
        <EmptyArt src="/illustrations/entry-homework-v1.webp" title="还没有扣分的题" />
      </Card>
    );
  const many = new Set(list.map((h) => h.classId)).size > 1;
  return (
    <div className="space-y-4">
      {list.map((h) => (
        <Card key={h.id} padded={false} className="overflow-hidden">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-5 py-3.5 sm:px-6">
            <button type="button" onClick={() => navigate(`/classes/${h.classId}/homework/${h.id}`)} className="min-w-0 text-left">
              <h3 className="break-words text-[16px] font-semibold text-ink hover:text-brand">{h.title}</h3>
            </button>
            <span className="text-[13px] text-ink-3">
              {many && `${h.className} · `}
              {h.gradedAt ? `${when(h.gradedAt)} 批` : ''}
            </span>
            <span className="ml-auto text-[14px] tabular-nums text-ink-3">
              <span className="text-[17px] font-semibold text-ink">{num(h.score)}</span>/{num(h.points)}
            </span>
          </div>
          <ul>
            {h.items.map((m) => (
              <li key={m.no} className="flex items-start gap-4 border-b border-line px-5 py-3.5 last:border-0 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="break-words text-[15px] font-medium text-ink">{m.title}</span>
                    <span className="text-[13.5px] tabular-nums text-ink-3">
                      <span className="font-semibold text-bad">{num(m.got)}</span>/{num(m.max)}
                    </span>
                  </p>
                  <p className="mt-1 line-clamp-3 break-words text-[14px] leading-relaxed text-ink-2">{m.why}</p>
                </div>
                <Button size="sm" icon={<Dumbbell className="size-4" />} className="mt-0.5 shrink-0" onClick={() => navigate(`/cot?ask=${encodeURIComponent(practice(h, m))}`)}>
                  练一练
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

import { useNavigate } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../components/ui';
import { teacherTitle } from '../cot/data';
import { themeBackground, themeOf } from '../classes/look';
import { useLiveLectures, type LiveItem } from './data';

/**
 * 学生的 CoT 学伴页顶上：自己班正在上课时一张卡片「某某老师正在上课：课题」，点了进课堂。五秒查一次。
 */
export function LiveBanner({ className }: { className?: string }) {
  const navigate = useNavigate();
  const live = useLiveLectures<LiveItem>(true, 5000).data?.live || [];
  if (!live.length) return null;
  return (
    <div className={cn('space-y-2', className)}>
      {live.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => navigate(`/live/${l.id}`)}
          className="group flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-white shadow-sm transition-transform hover:-translate-y-px sm:px-5"
          style={themeBackground(themeOf(l.classId))}
        >
          <span className="relative flex size-2.5 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/80" />
            <span className="relative inline-flex size-2.5 rounded-full bg-white" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold">
              {teacherTitle(l.teacher)}正在上课：{l.title}
            </span>
            <span className="block truncate text-[14px] text-white/90">{l.className}</span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-white/20 py-1 pl-3 pr-2 text-[14px] font-medium transition-colors group-hover:bg-white/30">
            进课堂
            <ChevronRight className="size-4" />
          </span>
        </button>
      ))}
    </div>
  );
}

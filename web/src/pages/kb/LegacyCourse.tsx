import { Navigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { ErrorState, PageLoading } from '../../components/ui';

/** 旧的课程链接转到老师自己的知识库，原来的页面位置照样打开 */
export function LegacyCoursePage() {
  const id = Number(useParams().id),
    [params] = useSearchParams();
  const q = useQuery({
    queryKey: ['course-link', id],
    queryFn: () => get<{ kbId: number | null; legacyPrefix: string }>(`/courses/${id}`),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoading />;
  // 知识库全删了：回到最外层
  if (!q.data.kbId) return <Navigate replace to="/knowledge" />;
  const target = new URLSearchParams(params);
  if (target.has('f')) target.set('f', q.data.legacyPrefix + target.get('f'));
  return <Navigate replace to={`/knowledge/${q.data.kbId}${target.size ? '?' + target.toString() : ''}`} />;
}

import { useQueries, useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import type { ClassItem } from '../classes/data';
import type { Homework } from '../classes/homework';
import { shortItem, type Mistake } from './practice';

/** 「张浩然」叫「浩然」，两个字的名字照叫 */
export const given = (name: string) => (name.length >= 3 ? name.slice(-2) : name);

/**
 * 学伴首页下面那几句能直接问的话：照这个学生自己的作业和错题出（快截止没交的、退回来的、丢分最多的那项），
 * 点了放进输入框，学生自己点发送。
 */
export function useBuddyStarters(): string[] {
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => get<{ classes: ClassItem[] }>('/classes') });
  const live = (classes.data?.classes || []).filter((k) => !k.archived);
  const lists = useQueries({
    queries: live.map((k) => ({ queryKey: ['homework', 'class', k.id], queryFn: () => get<{ homework: Homework[] }>(`/homework/class/${k.id}`), staleTime: 30_000 })),
  });
  const mistakes = useQuery({ queryKey: ['mistakes'], queryFn: () => get<{ homework: { id: number; title: string; score: number; points: number; gradedAt: number | null; items: Mistake[] }[] }>('/cot/mistakes'), staleTime: 30_000 });
  const now = Date.now();
  const all = lists.flatMap((l) => l.data?.homework || []);
  const todo = all.filter((h) => h.status === 'todo' && h.dueAt && h.dueAt > now).sort((a, b) => a.dueAt! - b.dueAt!)[0];
  const back = all.find((h) => h.status === 'returned');
  const latest = mistakes.data?.homework[0];
  const worst = latest ? [...latest.items].sort((a, b) => b.max - b.got - (a.max - a.got))[0] : undefined;
  return [
    back && `「${back.title}」被退回来了，帮我看看哪儿要改`,
    todo && `「${todo.title}」第 1 题从哪儿下手？`,
    worst && `「${shortItem(worst.title)}」我没弄懂，换个说法再讲一遍`,
    worst ? `照我错的「${shortItem(worst.title)}」出一道题给我练` : '我最近哪次作业分最低？为什么？',
    !todo && '这周有哪些作业要交？',
  ]
    .filter((x): x is string => !!x)
    .slice(0, 3);
}

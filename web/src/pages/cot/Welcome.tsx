import { useQueries, useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/store';
import type { ClassItem } from '../classes/data';
import { num, when, type Homework } from '../classes/homework';
import { shortItem, type Mistake } from './practice';

/** 「张浩然」叫「浩然」，两个字的名字照叫 */
const given = (name: string) => (name.length >= 3 ? name.slice(-2) : name);

function hello(now = new Date()) {
  const h = now.getHours();
  return h >= 5 && h < 11 ? '早上好' : h >= 11 && h < 13 ? '中午好' : h >= 13 && h < 18 ? '下午好' : '晚上好';
}

/**
 * 学伴页还没说过话时：一个挥手的学伴，一句招呼，一句眼下最要紧的事（快截止没交的作业，或者刚批好、丢分最多的那项），
 * 下面三个能直接问的话（照这个学生自己的作业和错题出，点了放进输入框，学生自己点发送）。
 */
export function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const me = useAuth((s) => s.user);
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

  let line: string | null = null;
  if (back) line = `「${back.title}」老师退回来了，改哪儿拿不准可以先贴给我看。`;
  else if (todo) {
    const days = Math.floor((todo.dueAt! - now) / 86_400_000);
    line = days < 2 ? `「${todo.title}」${when(todo.dueAt!)} 截止，还没交。` : `「${todo.title}」还有 ${days} 天截止，哪题卡住了直接贴过来。`;
  } else if (latest && worst) line = `「${latest.title}」批好了，${num(latest.score)} 分，扣得最多的是「${shortItem(worst.title)}」。`;

  const picks = [
    worst && `「${shortItem(worst.title)}」我没弄懂，换个说法再讲一遍`,
    todo && `「${todo.title}」第 1 题从哪儿下手？`,
    worst ? `照我错的「${shortItem(worst.title)}」出一道题给我练` : '我最近哪次作业分最低？为什么？',
    !todo && '这周有哪些作业要交？',
  ].filter((x): x is string => !!x).slice(0, 3);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-2 pt-[4vh] text-center">
      <img src="/illustrations/cot-buddy.webp" alt="" draggable={false} className="w-32 select-none animate-float sm:w-36" />
      <p className="mt-4 text-[24px] font-semibold tracking-tight text-ink">
        {me?.name ? `${given(me.name)}，${hello()}` : hello()}
      </p>
      <p className="mt-2 max-w-[30em] text-[16px] leading-relaxed text-ink-2">{line || '我是 CoT 学伴，作业、截止时间、课上没听懂的，都可以问我。'}</p>
      {picks.length > 0 && (
        <div className="mt-6 flex w-full flex-col items-stretch gap-2 sm:items-center">
          {picks.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onPick(t)}
              className="rounded-2xl border border-line bg-surface px-4 py-2.5 text-left text-[15px] text-ink shadow-xs transition-colors hover:border-brand/50 hover:text-brand-ink sm:rounded-full sm:text-center"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, IconButton, Popover, cn, useConfirm } from '../../components/ui';
import { when } from '../kb/presentation';

export interface SpecialistInfo {
  id: number;
  name: string;
  duty: string;
  guide: string;
  avatar: string;
  uses: number;
  lastUsedAt: number | null;
  createdAt: number;
  homework: { id: number; title: string; classId: number; className: string }[];
  recent: { what: string; result: string | null; status: string; at: number }[];
}

export function useSpecialists() {
  return useQuery({
    queryKey: ['specialists'],
    queryFn: () => get<{ specialists: SpecialistInfo[] }>('/keeper/specialists'),
    refetchInterval: 20_000,
    staleTime: 5_000,
  });
}

/** 一个专门助手：头像、名字、办过几次、管什么、批哪几份作业、最近办的；做法点开看 */
function Row({ s, onRetire }: { s: SpecialistInfo; onRetire: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-3 px-4 py-3">
      <img src={s.avatar} alt="" className="size-10 shrink-0 rounded-full bg-surface-3" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] font-medium text-ink">{s.name}</span>
          <span className="shrink-0 text-[12.5px] text-ink-3">办过 {s.uses} 次</span>
        </div>
        <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2">{s.duty}</p>
        {s.homework.length > 0 && <p className="mt-1 text-[13px] text-ink-3">批：{s.homework.map((h) => `${h.className}「${h.title}」`).join('、')}</p>}
        {s.recent[0] && (
          <p className="mt-1 line-clamp-2 text-[13px] text-ink-3">
            最近：{s.recent[0].what}
            {s.lastUsedAt ? ` · ${when(s.lastUsedAt)}` : ''}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-3">
          {s.guide && (
            <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-0.5 text-[13px] text-brand-ink hover:underline">
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              做法
            </button>
          )}
          <button type="button" onClick={onRetire} className="text-[13px] text-ink-3 hover:text-danger">
            停用
          </button>
        </div>
        {open && <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink-2">{s.guide}</p>}
      </div>
    </div>
  );
}

/**
 * 助教分出来的专门助手：顶栏一个按钮，点开看有哪几个、各管什么、办过几次、批哪几份作业。
 * 一个都没有就不显示（老师只看到一个助教）。
 */
export function SpecialistsButton({ compact }: { compact: boolean }) {
  const q = useSpecialists();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = q.data?.specialists || [];
  if (!list.length) return null;
  const retire = async (s: SpecialistInfo) => {
    if (!(await confirm({ title: `停用「${s.name}」？`, desc: s.homework.length ? '它批的作业改回助教自己批。' : '以后这类活助教自己办。', okText: '停用', danger: true }))) return;
    try {
      await post(`/keeper/specialists/${s.id}/retire`, {});
      qc.invalidateQueries({ queryKey: ['specialists'] });
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <Popover
      width={380}
      trigger={({ toggle }) =>
        compact ? (
          <IconButton label="专门助手" onClick={toggle}>
            <Users className="size-[18px]" />
          </IconButton>
        ) : (
          <Button size="sm" variant="ghost" icon={<Users className="size-4" />} onClick={toggle}>
            专门助手 {list.length}
          </Button>
        )
      }
    >
      {() => (
        <div className="max-h-[70vh] overflow-y-auto py-1.5">
          <p className="px-4 pb-1 pt-1 text-[12.5px] text-ink-3">助教分出来的专门助手</p>
          <div className={cn('divide-y divide-line')}>
            {list.map((s) => (
              <Row key={s.id} s={s} onRetire={() => retire(s)} />
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

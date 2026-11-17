import { useEffect, useRef, useState } from 'react';
import { FilePlus, FolderOpen } from 'lucide-react';
import { Button, cn } from '../../components/ui';
import { useKeeperRuns, useKnowledgeBases, type Run } from './data';
import { pickedFromDrop, pickedFromList, type Picked } from './intake';
import { readableError, stepLines } from './presentation';

/** 助教在后台整理时每一步的说法：读、写、改、挪…… */
const DOING: Record<string, string> = {
  阅读: '在读',
  整理: '在写',
  修改: '在改',
  移动: '在挪',
  移除: '在删',
  查找: '在找',
  查看目录: '在翻目录',
  看全部知识库: '在翻目录',
  存进知识库: '在存原件',
  提交改动: '快好了',
  完成: '快好了',
};

export type HandIn =
  | { state: 'idle' }
  | { state: 'busy'; text: string }
  | { state: 'done'; kbId: number | null; changeId: number | null }
  | { state: 'error'; text: string };

const RECENT = 3 * 60_000;
const WRITES = new Set(['write_file', 'edit_file']);

/**
 * 后台整理这会儿正在写、正在改的笔记：哪个库、库里的位置。
 * 新的整理助手写的位置打头是库名（「王建国的知识库/笔记/…」），老的直接是库里的位置（算派活的那个库）。
 */
function touchingOf(job: Run | undefined, bases: { id: number; name: string }[]) {
  if (!job) return [];
  const out: { kbId: number | null; path: string }[] = [];
  for (const e of job.events) {
    const d = e.data || {};
    if (e.type !== 'tool' || d.error || !WRITES.has(String(d.name)) || typeof d.path !== 'string') continue;
    let path = d.path.replace(/^\/+/, '');
    const head = path.split('/')[0];
    const base = path.includes('/') ? bases.find((b) => b.name === head) : undefined;
    if (base) path = path.slice(head.length + 1);
    const kbId = base ? base.id : (job.kbId ?? null);
    if (!out.some((x) => x.kbId === kbId && x.path === path)) out.push({ kbId, path });
  }
  return out;
}

/**
 * 刚交的那批资料走到哪了：传、读、助教看、排队、整理（读哪份、写哪份），整理好了能点开看改了什么。
 * 数据就是右边对话里那一轮（老师带着文件说的那句话，和助教派出去的后台整理）。
 * touching：后台整理这会儿正在写、正在改的笔记，页面上给它们摆「在写」的空卡片、标「在改」。
 */
export function useHandIn(kbId: number | null): HandIn & { touching: { kbId: number | null; path: string }[] } {
  const runs = useKeeperRuns('kb').data?.runs || [];
  const bases = useKnowledgeBases().data?.knowledgeBases || [];
  const [, tick] = useState(0);
  // 整理好了的提示过三分钟收起来
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const mine = (r: Run) => kbId === null || r.kbId === kbId || (r.jobs || []).some((j) => j.kbId === kbId || j.changes?.some((c) => c.kbId === kbId));
  const own = runs.filter(mine);
  const jobs = own.flatMap((r) => r.jobs || []);
  const running = jobs.find((j) => j.status === 'running');
  const touching = touchingOf(running, bases).filter((t) => kbId === null || t.kbId === kbId || t.kbId === null);
  // 1. 文件还在传、在读
  const receiving = own.find((r) => r.receiving)?.receiving;
  if (receiving)
    return {
      state: 'busy',
      text: receiving.status === 'uploading' ? `正在传 ${receiving.total} 份` : `正在读第 ${Math.min(receiving.done + 1, receiving.total)} 份，一共 ${receiving.total} 份`,
      touching,
    };
  // 2. 后台在整理（交资料派的，或者老师在右边交代的）：这会儿在读哪份、写哪份
  if (running) {
    const step = stepLines(running.events)
      .filter((l) => l.kind === 'tool')
      .pop();
    const verb = step ? DOING[step.label] : null;
    return { state: 'busy', text: step && verb ? (step.text && verb !== '快好了' ? `${verb}：${step.text}` : verb) : '在整理', touching };
  }
  if (jobs.some((j) => j.status === 'queued')) return { state: 'busy', text: '排上了，一会儿就整理', touching };
  // 3. 刚交的那句话，助教还在看、在问老师
  const run = [...own].reverse().find((r) => !!r.attachments?.length);
  if (run?.status === 'running') return { state: 'busy', text: '在看你发来的资料', touching };
  if (run?.status === 'waiting') return { state: 'busy', text: '助教在右边问你一句', touching };
  // 4. 最近三分钟里整理完的、没整理完的
  const last = [...jobs].filter((j) => j.finishedAt).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)).pop();
  if (last && Date.now() - (last.finishedAt ?? 0) < RECENT) {
    if (last.status === 'error') return { state: 'error', text: readableError(last.error), touching };
    if (last.status === 'done') {
      const change = (last.changes || []).filter((c) => kbId === null || c.kbId === kbId).pop();
      if (change) return { state: 'done', kbId: change.kbId, changeId: change.id, touching };
    }
  }
  if (run?.status === 'error' && Date.now() - (run.finishedAt ?? 0) < RECENT) return { state: 'error', text: readableError(run.error), touching };
  return { state: 'idle', touching };
}

/**
 * 整页都能把文件拖进来：拖着的时候盖一层「松手就交给助教整理」，松手交给 onDrop。
 * 松手在交资料框或者右边输入框上（它们自己接住、不往外传），整页这层也要收起来：在 window 上听松手和拖拽结束。
 */
export function usePageDrop(onDrop: (files: Picked[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(0);
  useEffect(() => {
    const reset = () => setDragging(0);
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset, true);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset, true);
    };
  }, []);
  const files = (e: React.DragEvent) => enabled && e.dataTransfer.types.includes('Files');
  return {
    dragging: dragging > 0,
    handlers: {
      onDragEnter: (e: React.DragEvent) => files(e) && setDragging((n) => n + 1),
      onDragLeave: (e: React.DragEvent) => files(e) && setDragging((n) => Math.max(0, n - 1)),
      onDragOver: (e: React.DragEvent) => files(e) && e.preventDefault(),
      onDrop: (e: React.DragEvent) => {
        if (!files(e)) return;
        e.preventDefault();
        setDragging(0);
        void pickedFromDrop(e.dataTransfer).then((picked) => picked.length && onDrop(picked));
      },
    },
  };
}

/** 整页拖着文件时盖的那一层 */
export function DropCover() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand/60 bg-brand-soft/80">
      <div className="flex flex-col items-center gap-3">
        <img src="/illustrations/kb/drop.webp" alt="" className="h-32 w-auto" draggable={false} />
        <p className="text-[18px] font-semibold text-brand-ink">松手就交给助教整理</p>
      </div>
    </div>
  );
}

/** 两个藏起来的选文件框：选文件、选整个文件夹 */
function usePickers(onPick: (files: Picked[]) => void) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const pick = (list: FileList | null, el: HTMLInputElement | null) => {
    const files = pickedFromList(list || []);
    if (el) el.value = '';
    if (files.length) onPick(files);
  };
  const inputs = (
    <>
      <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => pick(e.target.files, e.target)} />
      <input
        ref={(el) => {
          // 选整个文件夹：React 不认识这个属性，直接设到元素上
          folderInput.current = el;
          el?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => pick(e.target.files, e.target)}
      />
    </>
  );
  return { inputs, pickFiles: () => fileInput.current?.click(), pickFolder: () => folderInput.current?.click() };
}

/**
 * 交资料的地方：一个虚线框，机器人抱着收纳盒。拖进来、点「选文件」「选文件夹」都行，交了就开始整理，
 * 下面一行跟着显示走到哪了。big：知识库还空着的时候摆在正中间。
 */
export function DropTray({
  onPick,
  status,
  onOpenChange,
  big = false,
  className,
}: {
  onPick: (files: Picked[]) => void;
  status: HandIn;
  onOpenChange?: (kbId: number, id: number) => void;
  big?: boolean;
  className?: string;
}) {
  const [over, setOver] = useState(0);
  const { inputs, pickFiles, pickFolder } = usePickers(onPick);
  const files = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  const line =
    status.state === 'busy' ? (
      <span className="flex min-w-0 items-center gap-2 text-brand-ink">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-brand" />
        <span className="min-w-0 truncate">{status.text}</span>
      </span>
    ) : status.state === 'done' ? (
      <span className="flex min-w-0 items-center gap-2 text-emerald-700 dark:text-emerald-300">
        <span className="size-2 shrink-0 rounded-full bg-ok" />
        <span className="shrink-0">整理好了</span>
        {status.changeId && status.kbId && onOpenChange && (
          <button type="button" onClick={() => onOpenChange(status.kbId!, status.changeId!)} className="shrink-0 text-brand-ink hover:underline hover:underline-offset-4">
            看改动
          </button>
        )}
      </span>
    ) : status.state === 'error' ? (
      <span className="flex min-w-0 items-center gap-2 text-red-700 dark:text-red-300">
        <span className="size-2 shrink-0 rounded-full bg-bad" />
        <span className="min-w-0 truncate">没整理完：{status.text}</span>
      </span>
    ) : null;
  const buttons = (
    <div className={cn('flex shrink-0 items-center gap-2', big && 'justify-center')}>
      <Button size={big ? 'md' : 'sm'} variant="primary" icon={<FilePlus className="size-4" />} onClick={pickFiles}>
        选文件
      </Button>
      <Button size={big ? 'md' : 'sm'} icon={<FolderOpen className="size-4" />} onClick={pickFolder}>
        选文件夹
      </Button>
    </div>
  );
  return (
    <div
      onDragEnter={(e) => files(e) && setOver((n) => n + 1)}
      onDragLeave={(e) => files(e) && setOver((n) => Math.max(0, n - 1))}
      onDragOver={(e) => files(e) && e.preventDefault()}
      onDrop={(e) => {
        if (!files(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(0);
        void pickedFromDrop(e.dataTransfer).then((picked) => picked.length && onPick(picked));
      }}
      className={cn(
        'relative rounded-2xl border-2 border-dashed transition-colors',
        over ? 'border-brand bg-brand-soft' : 'border-brand/25 bg-brand-soft/40',
        big ? 'flex flex-col items-center px-6 pb-8 pt-6 text-center' : 'flex min-h-[92px] items-center gap-4 py-3 pl-[104px] pr-4 max-sm:flex-wrap max-sm:pl-[84px]',
        className,
      )}
    >
      {inputs}
      {/* 机器人抱着收纳盒，头探出虚线框一点 */}
      <img
        src="/illustrations/kb/drop.webp"
        alt=""
        draggable={false}
        className={cn(
          'pointer-events-none shrink-0 select-none object-contain transition-transform duration-200',
          big ? 'h-44 w-auto' : 'absolute bottom-1.5 left-3 h-[108px] w-auto max-sm:h-[84px]',
          over && 'scale-105',
        )}
      />
      <div className={cn('min-w-0', big ? 'mt-4' : 'flex-1')}>
        <p className={cn('font-semibold text-ink', big ? 'text-[18px]' : 'text-[16px]')}>
          {over ? (
            '松手就交给助教整理'
          ) : big ? (
            '这里还空着'
          ) : (
            <>
              <span className="max-sm:hidden">教案、课件、讲义，拖到这里就行</span>
              <span className="sm:hidden">教案、课件、讲义，选好发过来</span>
            </>
          )}
        </p>
        {big && !over && (
          <p className="mt-1.5 text-[15px] text-ink-2">
            <span className="max-sm:hidden">教案、课件、讲义，拖到这里就行</span>
            <span className="sm:hidden">教案、课件、讲义，选好发过来</span>
          </p>
        )}
        {line && <div className={cn('text-[14px] leading-6', big ? 'mt-2 flex justify-center' : 'mt-1')}>{line}</div>}
      </div>
      <div className={cn(big ? 'mt-5' : 'max-sm:w-full')}>{buttons}</div>
    </div>
  );
}

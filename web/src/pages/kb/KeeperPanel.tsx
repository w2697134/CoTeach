import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, BookOpen, Check, ChevronDown, FilePlus, FolderOpen, FolderSearch, MoveRight, OctagonX, PenLine, Search, Send, Trash2, Upload, X } from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { AgentAvatar, Alert, Avatar, Badge, Button, IconButton, MenuItem, Popover, Skeleton, Textarea, cn } from '../../components/ui';
import { changedPages, useChangeActions } from './Changes';
import { IntakeCard } from './IntakeCard';
import { handIn, pastedFiles, pickedFromDrop, pickedFromList, uploadingHere, useIntakes, type Intake, type Picked } from './intake';
import { readableError, toolPresentation, when } from './presentation';
import { KEEPER, STATUS_TEXT, STATUS_TONE, plainText, useChanges, useRuns, useCourse, type Run, type RunEvent } from './data';

const TOOL_ICON: Record<string, typeof BookOpen> = {
  list_files: FolderSearch,
  read_file: BookOpen,
  search: Search,
  write_file: PenLine,
  delete_file: Trash2,
  move_file: MoveRight,
  finish: Send,
  done: Check,
  list_knowledge_bases: FolderSearch,
  create_knowledge_base: FilePlus,
  rename_knowledge_base: PenLine,
  move_to_knowledge_base: MoveRight,
  delete_knowledge_base: Trash2,
};

function ToolLine({ e }: { e: RunEvent }) {
  const d = e.data || {};
  const Icon = typeof d.name === 'string' && Object.hasOwn(TOOL_ICON, d.name) ? TOOL_ICON[d.name] : BookOpen;
  const view = toolPresentation(d);
  return (
    <div className={cn('flex items-start gap-2 text-[13px] leading-5', d.error ? 'text-bad' : 'text-ink-2')}>
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', d.error ? 'text-bad' : 'text-ink-3')} />
      <span className="min-w-0 break-all">
        <span className="font-medium text-ink">{view.label}</span> {view.target}
        {view.error && <span>：{view.error}</span>}
      </span>
    </div>
  );
}

/** 整理助手交上来的一次改动：改了哪几页，看一眼再确认 */
function ChangeCard({ cid, changeId, title, onOpen }: { cid: number; changeId: number; title?: string; onOpen: (id: number) => void }) {
  const changes = useChanges(cid);
  const c = changes.data?.changes.find((x) => x.id === changeId);
  const { act, busy } = useChangeActions(cid);
  const status = c?.status;
  const open = c && (status === 'pending' || status === 'conflict');
  if (!c && changes.isPending) return <Skeleton className="h-[104px] rounded-2xl" />;
  return (
    <div className={cn('rounded-2xl border p-3.5', open ? 'border-brand/30 bg-brand-soft/50' : 'border-line bg-surface-2')}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink">{plainText(c?.title || title || '')}</p>
        {status && <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>}
      </div>
      {c && changedPages(c) && <p className="mt-1 text-[13px] leading-5 text-ink-3">{changedPages(c)}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => onOpen(changeId)}>
          看改动
        </Button>
        {open && (
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<Check className="size-3.5" />}
              loading={busy === `${c.id}:apply`}
              disabled={status === 'conflict'}
              onClick={() => act(c, 'apply')}
            >
              确认生效
            </Button>
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={busy === `${c.id}:reject`} onClick={() => act(c, 'reject')}>
              不要
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function RunBlock({ cid, run, live, onOpenChange }: { cid: number; run: Run; live: string | null; onOpenChange: (id: number) => void }) {
  const user = useAuth((s) => s.user);
  const running = run.status === 'running';
  const [expanded, setExpanded] = useState(false);
  const steps = run.events.filter((e) => e.type === 'tool' || e.type === 'say');
  const showAll = running || expanded;
  const changeEvent = run.events.find((e) => e.type === 'change');
  const changeId: number | null = changeEvent?.data.changeId ?? run.changeId;
  const errorEvent = run.events.find((e) => e.type === 'error');
  return (
    <div className="space-y-3">
      {run.kind === 'chat' ? (
        <div className="flex justify-end gap-2">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-white">
            {plainText(run.request)}
          </div>
          <Avatar name={user?.name} seed={user?.id} size={28} className="mt-0.5" />
        </div>
      ) : (
        <div className="text-center text-[12.5px] leading-5 text-ink-3">
          <p>
            {run.task?.label || (run.kind === 'summary' ? '学期提炼' : run.kind === 'observation' ? '其他助手提交的记录' : '整理交来的资料')} · {when(run.createdAt)}
          </p>
          {/* 整理交来的资料时，交了什么上面那张卡片已经写了 */}
          {run.task?.detail && run.kind !== 'materials' && <p className="mx-auto mt-0.5 max-w-[90%] text-ink-2">{plainText(run.task.detail)}</p>}
        </div>
      )}
      <div className="flex gap-2.5">
        <AgentAvatar agent={KEEPER} size={28} active={running} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2.5">
          {steps.length > 0 && (
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
              {!running && (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  className="flex w-full items-center gap-1.5 text-left text-[13px] font-medium text-ink-2 hover:text-ink"
                >
                  <ChevronDown className={cn('size-3.5 transition-transform', !expanded && '-rotate-90')} />
                  工作记录 · {steps.filter((e) => e.type === 'tool').length} 步
                </button>
              )}
              {showAll && (
                <div className={cn('space-y-1.5', !running && 'mt-2')}>
                  {steps.map((e) =>
                    e.type === 'say' ? (
                      <p key={e.id} className="text-[13px] leading-5 text-ink-3">
                        {plainText(e.data.text)}
                      </p>
                    ) : (
                      <ToolLine key={e.id} e={e} />
                    ),
                  )}
                </div>
              )}
            </div>
          )}
          {running && (
            <div className="flex items-start gap-2 text-[13px] text-ink-3">
              <span className="mt-1.5 flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand/60" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
              {live && <span className="min-w-0 whitespace-pre-wrap">{plainText(live)}</span>}
            </div>
          )}
          {!running && run.reply && !run.changeId && (
            <div className="rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5">
              <Markdown compact>{plainText(run.reply)}</Markdown>
            </div>
          )}
          {changeId && <ChangeCard cid={cid} changeId={changeId} title={changeEvent?.data.title} onOpen={onOpenChange} />}
          {run.status === 'done' && !run.changeId && !run.reply && <p className="text-[13px] text-ink-3">这次没有改知识库</p>}
          {(errorEvent || run.error) && run.status !== 'canceled' && (
            <p role="alert" className="text-[13px] text-bad">
              {readableError(run.error || errorEvent?.data.message)}
            </p>
          )}
          {run.status === 'canceled' && <p className="text-[13px] text-ink-3">已停止</p>}
        </div>
      </div>
    </div>
  );
}

/** 交资料的按钮：选文件或者选整个文件夹 */
export function HandInButton({ onPick, disabled, size = 'sm', variant = 'ghost' }: { onPick: (files: Picked[]) => void; disabled?: boolean; size?: 'sm' | 'md'; variant?: 'ghost' | 'primary' }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const pick = (list: FileList | null, el: HTMLInputElement | null) => {
    const files = pickedFromList(list || []);
    if (el) el.value = '';
    if (files.length) onPick(files);
  };
  return (
    <>
      <Popover
        align="start"
        width={160}
        trigger={({ toggle }) => (
          <Button size={size} variant={variant} icon={<Upload className="size-4" />} disabled={disabled} onClick={toggle}>
            交资料
          </Button>
        )}
      >
        {(close) => (
          <div onClick={close}>
            <MenuItem icon={<FilePlus />} onClick={() => fileInput.current?.click()}>
              选文件
            </MenuItem>
            <MenuItem icon={<FolderOpen />} onClick={() => folderInput.current?.click()}>
              选文件夹
            </MenuItem>
          </div>
        )}
      </Popover>
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
}

/** 整理助手现在在干什么，一句话 */
function statusLine(intakes: Intake[], run: Run | undefined, pending: number, archived: boolean) {
  if (archived) return '已封存';
  const busy = [...intakes].reverse().find((i) => i.status === 'uploading' || i.status === 'reading' || i.status === 'digesting');
  if (busy?.status === 'uploading' && uploadingHere(busy.id))
    return `正在上传 ${busy.upload.size ? Math.floor((busy.upload.received / busy.upload.size) * 100) : 0}%`;
  if (busy?.status === 'reading') {
    const c = busy.counts;
    return `正在读第 ${Math.min(c.done + c.same + c.failed + c.skipped + 1, busy.total)}/${busy.total} 份`;
  }
  if (busy?.status === 'digesting') return busy.batches > 1 ? `正在整理第 ${Math.min(busy.batch + 1, busy.batches)}/${busy.batches} 批` : '正在整理';
  if (run) return run.kind === 'chat' ? '正在处理' : '正在整理';
  if (pending) return `有 ${pending} 处改动等你确认`;
  return '';
}

export interface KeeperHandle {
  /** 拖到页面上的资料也从这里交，输入框里写了话就一起带上 */
  handIn: (files: Picked[]) => void;
}

export const KeeperPanel = forwardRef<
  KeeperHandle,
  {
    cid: number;
    live: { runId: number; text: string } | null;
    onOpenChange: (id: number) => void;
    onOpenChanges: () => void;
  }
>(function KeeperPanel({ cid, live, onOpenChange, onOpenChanges }, ref) {
  const q = useRuns(cid);
  const archived = useCourse(cid).data?.knowledgeBase.status === 'archived';
  const pending = useChanges(cid, 'pending').data?.changes.length ?? 0;
  const inbox = useQuery({
    queryKey: ['kb-inbox', cid],
    queryFn: () =>
      get<{
        items: { id: number; status: string; error: string | null; content: string; task?: { label: string; detail: string } }[];
      }>(`/knowledge/${cid}/inbox`),
    refetchInterval: 5000,
  });
  const qc = useQueryClient();
  const intakes = useIntakes(cid);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const runs = q.data?.runs || [];
  const intakeList = intakes.data?.intakes || [];
  // 交资料和整理记录按时间排在一起
  const timeline = [
    ...runs.map((run) => ({ at: run.createdAt, key: `r${run.id}`, run })),
    ...intakeList.map((intake) => ({ at: intake.createdAt, key: `i${intake.id}`, intake })),
  ].sort((a, b) => a.at - b.at);
  const activeId = q.data?.activeRunId ?? null;
  const activeRun = runs.find((r) => r.status === 'running');
  const busy = !!activeId || !!activeRun;
  const status = statusLine(intakeList, activeRun, pending, !!archived);

  // 停在最新的一条：内容变长（新的一步、卡片加载出来）时跟着到底；老师往上翻着看的时候不打扰
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current,
      box = content.current;
    if (!el || !box) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    const follow = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    el.addEventListener('scroll', onScroll, { passive: true });
    follow.observe(box);
    return () => {
      el.removeEventListener('scroll', onScroll);
      follow.disconnect();
    };
  }, []);

  // 交资料：输入框里写的话跟着资料一起交，交完清空，并回到最新的一条
  const give = (files: Picked[]) => {
    if (!files.length || archived) return;
    const message = text.trim();
    setText('');
    stick.current = true;
    void handIn(qc, cid, files, message);
  };
  useImperativeHandle(ref, () => ({ handIn: give }));

  const send = async () => {
    const msg = text.trim();
    if (!msg || archived || busy) return;
    setSending(true);
    try {
      // 很长的一段（教案、讲稿）服务器会按一份资料收下再消化
      const r = await post<{ runId?: number; intakeId?: number }>(`/knowledge/${cid}/kb/runs`, { message: msg });
      setText('');
      qc.invalidateQueries({ queryKey: [r.intakeId ? 'kb-intakes' : 'kb-runs', cid] });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!activeId) return;
    await post(`/knowledge/${cid}/kb/runs/${activeId}/cancel`, {}).catch((err) => toast.fromError(err));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line bg-gradient-to-r from-brand-soft/80 via-brand-soft/30 to-transparent px-4">
        <AgentAvatar agent={KEEPER} size={38} status={busy ? 'running' : null} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[15px] font-semibold text-ink">{KEEPER.name}</p>
          {status && (
            <p className={cn('mt-0.5 truncate text-[12.5px]', !busy && pending && !archived ? 'text-brand-ink' : 'text-ink-3')}>{status}</p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onOpenChanges} className="shrink-0">
          改动
          {pending > 0 && (
            <Badge tone="brand" className="ml-1">
              {pending}
            </Badge>
          )}
        </Button>
        {busy && activeId && (
          <IconButton label="让它停下" onClick={stop} className="shrink-0">
            <OctagonX className="size-[18px]" />
          </IconButton>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div ref={content} className="space-y-6">
          {inbox.data?.items
            .filter((item) => item.status !== 'running')
            .map((item) => (
              <div key={item.id} className="rounded-xl border border-line bg-surface-2 p-3 text-[13px] leading-relaxed">
                <p className="text-ink-2">
                  {item.task?.label || '整理任务'} · {item.status === 'error' ? '未完成' : '排队中'}
                </p>
                {item.task?.detail && <p className="mt-1 text-ink-2">{plainText(item.task.detail)}</p>}
                {item.error && <p className="mt-1 text-bad">{readableError(item.error)}</p>}
                {!archived && item.status === 'error' && (
                  <Button
                    size="sm"
                    className="mt-2"
                    onClick={async () => {
                      try {
                        await post(`/knowledge/${cid}/inbox/${item.id}/process`, {});
                        await inbox.refetch();
                        qc.invalidateQueries({ queryKey: ['kb-runs', cid] });
                      } catch (e) {
                        toast.fromError(e);
                      }
                    }}
                  >
                    重试
                  </Button>
                )}
              </div>
            ))}
          {q.error && (
            <Alert tone="bad">
              工作记录加载失败。
              <Button size="sm" onClick={() => q.refetch()}>
                重试
              </Button>
            </Alert>
          )}
          {!q.data && !q.error && <Skeleton className="h-32" />}
          {q.data && intakes.data && !timeline.length && archived && <p className="py-16 text-center text-[14px] text-ink-3">这个学期还没有整理记录</p>}
          {timeline.map((t) =>
            'run' in t && t.run ? (
              <RunBlock key={t.key} cid={cid} run={t.run} live={live && live.runId === t.run.id ? live.text : null} onOpenChange={onOpenChange} />
            ) : 'intake' in t && t.intake ? (
              <IntakeCard key={t.key} cid={cid} intake={t.intake} />
            ) : null,
          )}
        </div>
      </div>
      <div
        className="shrink-0 p-3"
        onDragOver={(e) => {
          if (archived || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
        }}
        onDrop={(e) => {
          if (archived || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
          void pickedFromDrop(e.dataTransfer).then(give);
        }}
      >
        <div className="rounded-2xl border border-line bg-surface shadow-xs transition-colors focus-within:border-brand/50">
          <Textarea
            autoGrow
            maxRows={8}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // 截图、复制的文件直接粘贴进来，当资料交
              if (archived || !e.clipboardData.files.length) return;
              e.preventDefault();
              give(pastedFiles(e.clipboardData.files));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={archived ? '学期已封存，只能查阅' : busy ? '整理助手正在忙…' : '跟整理助手说'}
            disabled={busy || archived}
            className="min-h-0 resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 shadow-none! focus:ring-0"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            {archived ? <span /> : <HandInButton onPick={give} />}
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || busy || sending || archived}
              aria-label="发送"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

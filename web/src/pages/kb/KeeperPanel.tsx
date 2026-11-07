import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  FolderSearch,
  MoveRight,
  OctagonX,
  Paperclip,
  PenLine,
  Search,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { AgentAvatar, Alert, Avatar, Badge, Button, IconButton, Skeleton, Textarea, cn } from '../../components/ui';
import { useChangeActions } from './Changes';
import { IntakeCard } from './IntakeCard';
import { handIn, pastedFiles, pickedFromDrop, pickedFromList, useIntakes, type Picked } from './intake';
import { readableError, toolPresentation } from './presentation';
import { KEEPER, STATUS_TEXT, STATUS_TONE, fileTitle, plainText, useChanges, useRuns, useCourse, type Run, type RunEvent } from './data';

const TOOL_ICON: Record<string, typeof BookOpen> = {
  list_files: FolderSearch,
  read_file: BookOpen,
  search: Search,
  write_file: PenLine,
  delete_file: Trash2,
  move_file: MoveRight,
  finish: Send,
  done: Check,
};

function ToolLine({ e }: { e: RunEvent }) {
  const d = e.data || {};
  const Icon = typeof d.name === 'string' && Object.hasOwn(TOOL_ICON,d.name) ? TOOL_ICON[d.name] : BookOpen;
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

function ChangeCard({ cid, changeId, title, onOpen }: { cid: number; changeId: number; title?: string; onOpen: (id: number) => void }) {
  const changes = useChanges(cid);
  const c = changes.data?.changes.find((x) => x.id === changeId);
  const { act, busy } = useChangeActions(cid);
  const status = c?.status;
  return (
    <div className="rounded-xl border border-brand/25 bg-brand-soft/40 p-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink">{plainText(c?.title || title || '')}</p>
        {status && <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => onOpen(changeId)}>
          看改动{c ? ` · ${c.files.length} 个文件` : ''}
        </Button>
        {c && (status === 'pending' || status === 'conflict') && (
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
            <Button
              size="sm"
              variant="ghost"
              icon={<X className="size-3.5" />}
              loading={busy === `${c.id}:reject`}
              onClick={() => act(c, 'reject')}
            >
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
        <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
          <p>
            {run.task?.label ||
              (run.kind === 'summary' ? '学期提炼' : run.kind === 'observation' ? '其他助手提交的记录' : '上传资料后的整理')}{' '}
            · {new Date(run.createdAt).toLocaleString('zh-CN')}
          </p>
          {run.task?.detail && <p className="mt-1">{plainText(run.task.detail)}</p>}
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

export function KeeperPanel({
  cid,
  live,
  onOpenChange,
  onUpload,
}: {
  cid: number;
  live: { runId: number; text: string } | null;
  onOpenChange: (id: number) => void;
  onUpload: () => void;
}) {
  const q = useRuns(cid);
  const archived = useCourse(cid).data?.knowledgeBase.status === 'archived';
  const inbox = useQuery({
    queryKey: ['kb-inbox', cid],
    queryFn: () =>
      get<{
        items: {
          id: number;
          status: string;
          error: string | null;
          content: string;
          task?: { label: string; detail: string };
        }[];
      }>(`/knowledge/${cid}/inbox`),
    refetchInterval: 5000,
  });
  const qc = useQueryClient();
  const intakes = useIntakes(cid);
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<Picked[]>([]);
  const [sending, setSending] = useState(false);
  const attachInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const runs = q.data?.runs || [];
  const intakeList = intakes.data?.intakes || [];
  // 交资料和整理记录按时间排在一起
  const timeline = [
    ...runs.map((run) => ({ at: run.createdAt, key: `r${run.id}`, run })),
    ...intakeList.map((intake) => ({ at: intake.createdAt, key: `i${intake.id}`, intake })),
  ].sort((a, b) => a.at - b.at);
  const activeId = q.data?.activeRunId ?? null;
  const busy = !!activeId || runs.some((r) => r.status === 'running');
  const lastLen =
    runs.reduce((n, r) => n + r.events.length, 0) + (live?.text.length || 0) + intakeList.reduce((n, i) => n + i.items.length + 1, 0);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTo({ top: el.scrollHeight });
  }, [lastLen, runs.length]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [q.data !== undefined]);

  const send = async () => {
    const msg = text.trim();
    if ((!msg && !attached.length) || archived || (busy && !attached.length)) return;
    setSending(true);
    try {
      if (attached.length) {
        // 带着文件说的话，和文件一起交给整理助手
        const files = attached;
        setAttached([]);
        setText('');
        await handIn(qc, cid, files, msg);
      } else {
        // 很长的一段（教案、讲稿）服务器会按一份资料收下再消化
        const r = await post<{ runId?: number; intakeId?: number }>(`/knowledge/${cid}/kb/runs`, { message: msg });
        setText('');
        qc.invalidateQueries({ queryKey: [r.intakeId ? 'kb-intakes' : 'kb-runs', cid] });
      }
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSending(false);
    }
  };
  const attach = (files: Picked[]) => files.length && setAttached((prev) => [...prev, ...files]);

  const stop = async () => {
    if (!activeId) return;
    await post(`/knowledge/${cid}/kb/runs/${activeId}/cancel`, {}).catch((err) => toast.fromError(err));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <AgentAvatar agent={KEEPER} size={32} status={busy ? 'running' : null} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[15px] font-semibold text-ink">{KEEPER.name}</p>
          {(archived || busy) && <p className="text-[12.5px] text-ink-3">{archived ? '已封存' : '正在整理'}</p>}
        </div>
        {busy && activeId && (
          <IconButton label="让它停下" onClick={stop}>
            <OctagonX className="size-[18px]" />
          </IconButton>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {inbox.data?.items
          .filter((item) => item.status !== 'running')
          .map((item) => (
            <div key={item.id} className="rounded-lg border border-line bg-surface-2 p-3 text-[13px] leading-relaxed">
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
        {q.data && intakes.data && !timeline.length && (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <AgentAvatar agent={KEEPER} size={88} />
            {!archived && (
              <Button variant="primary" icon={<Upload className="size-4" />} onClick={onUpload}>
                交资料
              </Button>
            )}
            {archived && <p className="text-[14px] text-ink-3">这个学期还没有整理记录</p>}
          </div>
        )}
        {timeline.map((t) =>
          'run' in t && t.run ? (
            <RunBlock key={t.key} cid={cid} run={t.run} live={live && live.runId === t.run.id ? live.text : null} onOpenChange={onOpenChange} />
          ) : 'intake' in t && t.intake ? (
            <IntakeCard key={t.key} cid={cid} intake={t.intake} />
          ) : null,
        )}
      </div>
      <div
        className="shrink-0 border-t border-line p-3"
        onDragOver={(e) => {
          if (archived || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          if (archived || !e.dataTransfer.types.includes('Files')) return;
          // 拖到输入框上的文件先放着，和要说的话一起交
          e.preventDefault();
          e.stopPropagation();
          void pickedFromDrop(e.dataTransfer).then(attach);
        }}
      >
        {attached.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attached.slice(0, attached.length > 6 ? 5 : 6).map((p, i) => (
              <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-surface-3 py-1 pl-2 pr-1 text-[12.5px] text-ink-2">
                <span className="truncate">{fileTitle(p.path) || '资料'}</span>
                <button
                  type="button"
                  aria-label={`不交「${fileTitle(p.path)}」`}
                  onClick={() => setAttached(attached.filter((_, j) => j !== i))}
                  className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {attached.length > 6 && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-surface-3 py-1 pl-2 pr-1 text-[12.5px] text-ink-2">
                还有 {attached.length - 5} 份
                <button type="button" aria-label="都不交" onClick={() => setAttached([])} className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink">
                  <X className="size-3" />
                </button>
              </span>
            )}
          </div>
        )}
        <div className="flex items-end gap-1 rounded-2xl border border-line bg-surface p-1.5 focus-within:border-brand/50">
          <IconButton label="附件" onClick={() => attachInput.current?.click()} disabled={archived} className="shrink-0">
            <Paperclip className="size-[18px]" />
          </IconButton>
          <input
            ref={attachInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              attach(pickedFromList(e.target.files || []));
              e.target.value = '';
            }}
          />
          <Textarea
            autoGrow
            maxRows={6}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // 截图、复制的文件直接粘贴进来，当附件
              if (archived || !e.clipboardData.files.length) return;
              e.preventDefault();
              attach(pastedFiles(e.clipboardData.files));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={archived ? '学期已封存，只能查阅' : busy ? '整理助手正在忙…' : '跟整理助手说'}
            disabled={busy || archived}
            className="min-h-0 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 shadow-none! focus:ring-0"
          />
          <button
            type="button"
            onClick={send}
            disabled={(!text.trim() && !attached.length) || (busy && !attached.length) || sending || archived}
            aria-label="发送"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, BookOpen, Check, ChevronDown, FolderSearch, MoveRight, OctagonX, PenLine, Search, Send, Trash2, Upload, X } from 'lucide-react';
import { post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { AgentAvatar, Avatar, Badge, Button, IconButton, Textarea, cn } from '../../components/ui';
import { useChangeActions } from './Changes';
import { KEEPER, STATUS_TEXT, STATUS_TONE, plainPath, plainText, useChanges, useRuns, type Run, type RunEvent } from './data';

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
  const d = e.data;
  const Icon = TOOL_ICON[d.name] || BookOpen;
  let what: ReactNode = d.path ? plainPath(d.path) : '';
  if (d.name === 'search') what = `「${d.text}」${d.hits !== undefined ? `，找到 ${d.hits} 处` : ''}`;
  if (d.name === 'move_file') what = `${plainPath(d.from)} → ${plainPath(d.to)}`;
  if (d.name === 'write_file') what = `${plainPath(d.path)}（${d.isNew ? '新建' : '改写'}，${d.chars} 字）`;
  if (d.name === 'read_file' && d.lines && d.total && d.lines !== `1-${d.total}`) what = `${plainPath(d.path)} 第 ${d.lines} 行`;
  if (d.name === 'finish') what = plainText(d.title);
  if (d.name === 'list_files') what = '';
  return (
    <div className={cn('flex items-start gap-2 text-[13px] leading-5', d.error ? 'text-bad' : 'text-ink-2')}>
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', d.error ? 'text-bad' : 'text-ink-3')} />
      <span className="min-w-0 break-all">
        <span className="font-medium text-ink">{d.label}</span> {what}
        {d.error && <span>：{plainText(d.error)}</span>}
      </span>
    </div>
  );
}

function ChangeCard({ cid, changeId, title, onOpen }: { cid: number; changeId: number; title?: string; onOpen: (id: number) => void }) {
  const changes = useChanges(cid);
  const c = changes.data?.changes.find(x => x.id === changeId);
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
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={busy === `${c.id}:apply`} disabled={status === 'conflict'} onClick={() => act(c, 'apply')}>
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
  const user = useAuth(s => s.user);
  const running = run.status === 'running';
  const [expanded, setExpanded] = useState(false);
  const steps = run.events.filter(e => e.type === 'tool' || e.type === 'say');
  const showAll = running || expanded;
  const changeEvent = run.events.find(e => e.type === 'change');
  const changeId: number | null = changeEvent?.data.changeId ?? run.changeId;
  const errorEvent = run.events.find(e => e.type === 'error');
  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-2">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-white">{plainText(run.request)}</div>
        <Avatar name={user?.name} seed={user?.id} size={28} className="mt-0.5" />
      </div>
      <div className="flex gap-2.5">
        <AgentAvatar agent={KEEPER} size={28} active={running} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2.5">
          {steps.length > 0 && (
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
              {!running && (
                <button type="button" onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-1.5 text-left text-[13px] font-medium text-ink-2 hover:text-ink">
                  <ChevronDown className={cn('size-3.5 transition-transform', !expanded && '-rotate-90')} />
                  工作记录 · {steps.filter(e => e.type === 'tool').length} 步
                </button>
              )}
              {showAll && (
                <div className={cn('space-y-1.5', !running && 'mt-2')}>
                  {steps.map(e =>
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
                {[0, 1, 2].map(i => (
                  <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand/60" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
              {live && <span className="min-w-0 whitespace-pre-wrap">{live}</span>}
            </div>
          )}
          {!running && run.reply && !run.changeId && (
            <div className="rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5">
              <Markdown compact>{plainText(run.reply)}</Markdown>
            </div>
          )}
          {changeId && <ChangeCard cid={cid} changeId={changeId} title={changeEvent?.data.title} onOpen={onOpenChange} />}
          {run.status === 'done' && !run.changeId && !run.reply && <p className="text-[13px] text-ink-3">这次没有改知识库</p>}
          {errorEvent && <p className="text-[13px] text-bad">{errorEvent.data.message}</p>}
        </div>
      </div>
    </div>
  );
}

export function KeeperPanel({ cid, live, onOpenChange, onUpload }: { cid: number; live: { runId: number; text: string } | null; onOpenChange: (id: number) => void; onUpload: () => void }) {
  const q = useRuns(cid);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const runs = q.data?.runs || [];
  const activeId = q.data?.activeRunId ?? null;
  const busy = !!activeId || runs.some(r => r.status === 'running');
  const lastLen = runs.reduce((n, r) => n + r.events.length, 0) + (live?.text.length || 0);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTo({ top: el.scrollHeight });
  }, [lastLen, runs.length]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [q.data !== undefined]);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setSending(true);
    try {
      await post(`/courses/${cid}/kb/runs`, { message: msg });
      setText('');
      qc.invalidateQueries({ queryKey: ['kb-runs', cid] });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!activeId) return;
    await post(`/courses/${cid}/kb/runs/${activeId}/cancel`, {}).catch(err => toast.fromError(err));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <AgentAvatar agent={KEEPER} size={32} status={busy ? 'running' : null} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[15px] font-semibold text-ink">{KEEPER.name}</p>
          <p className="text-[12.5px] text-ink-3">{busy ? '正在干活' : '空闲'}</p>
        </div>
        {busy && activeId && (
          <IconButton label="让它停下" onClick={stop}>
            <OctagonX className="size-[18px]" />
          </IconButton>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {q.data && !runs.length && (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <AgentAvatar agent={KEEPER} size={88} />
            <Button variant="primary" icon={<Upload className="size-4" />} onClick={onUpload}>
              交资料
            </Button>
          </div>
        )}
        {runs.map(r => (
          <RunBlock key={r.id} cid={cid} run={r} live={live && live.runId === r.id ? live.text : null} onOpenChange={onOpenChange} />
        ))}
      </div>
      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 pl-3 focus-within:border-brand/50">
          <Textarea
            autoGrow
            maxRows={6}
            rows={1}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={busy ? '整理助手正在忙…' : '跟整理助手说'}
            disabled={busy}
            className="min-h-0 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none! focus:ring-0"
          />
          <button
            type="button"
            onClick={send}
            disabled={!text.trim() || busy || sending}
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

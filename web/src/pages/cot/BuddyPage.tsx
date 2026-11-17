import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, History, Square, SquarePen } from 'lucide-react';
import { post } from '../../lib/api';
import { toast } from '../../lib/store';
import { AgentAvatar, Alert, Button, IconButton, Popover, Skeleton, Textarea, cn } from '../../components/ui';
import { BUDDY } from '../kb/data';
import { when } from '../kb/presentation';
import { useStuRuns, useStuSession, useStuSessions, useStuStream } from './data';
import { BuddyRunBlock } from './Thread';
import { given, useBuddyStarters } from './Welcome';
import { motion } from 'motion/react';
import { HomeStage, greeting } from '../../components/HomeStage';
import { useAuth } from '../../lib/store';

/** 开启新会话、翻以前的会话（跟老师那边的助教一样，照 DeepSeek、豆包） */
function SessionButtons({ compact, disabled }: { compact: boolean; disabled: boolean }) {
  const qc = useQueryClient();
  const view = useStuSession((s) => s.view);
  const setView = useStuSession((s) => s.set);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useStuSessions(open);
  const shown = view === 'current' ? list.data?.current : view;
  const startNew = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: number }>('/cot/sessions', {});
      setView(r.id);
      qc.invalidateQueries({ queryKey: ['stu-sessions'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {compact ? (
        <IconButton label="开启新会话" onClick={startNew} disabled={disabled || busy}>
          <SquarePen className="size-[18px]" />
        </IconButton>
      ) : (
        <Button size="sm" variant="ghost" icon={<SquarePen className="size-4" />} loading={busy} disabled={disabled} onClick={startNew}>
          开启新会话
        </Button>
      )}
      <Popover
        width={300}
        onOpenChange={setOpen}
        trigger={({ toggle }) => (
          <IconButton label="历史会话" onClick={toggle}>
            <History className="size-[18px]" />
          </IconButton>
        )}
      >
        {(close) => (
          <div className="max-h-[60vh] overflow-y-auto py-1">
            <p className="px-3 pb-1.5 pt-1 text-[13px] text-ink-2">历史会话</p>
            {!list.data ? (
              <Skeleton className="mx-3 my-2 h-16" />
            ) : !list.data.sessions.length ? (
              <p className="px-3 py-3 text-[14px] text-ink-2">还没有</p>
            ) : (
              list.data.sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setView(s.id === list.data!.current ? 'current' : s.id);
                    close();
                  }}
                  className={cn('flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-surface-3', s.id === shown && 'bg-brand-soft/60')}
                >
                  <span className="line-clamp-1 w-full text-[14px] text-ink">{s.title}</span>
                  <span className="text-[13px] text-ink-3">{when(s.updatedAt)}</span>
                </button>
              ))
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

/**
 * 学生的 CoT 学伴页（2026-11-16）：学生进来先到这里。问作业、截止、分数、课上的知识；
 * 学伴照班级资料包答，拿不准去问老师的助教；老师那边的回复、通知也送到这里。
 */
export function BuddyPage() {
  const q = useStuRuns();
  const input = useRef<HTMLTextAreaElement>(null);
  const live = useStuStream();
  const qc = useQueryClient();
  // 从别的页面带着一句话过来（比如作业页的「问 CoT 学伴」）：放进输入框，学生自己点发送
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(() => params.get('ask') || '');
  useEffect(() => {
    if (params.get('ask')) setParams({}, { replace: true });
  }, [params, setParams]);
  const [sending, setSending] = useState(false);
  const runs = q.data?.runs || [];
  const activeId = q.data?.activeRunId ?? null;
  const busy = !!activeId || runs.some((r) => r.status === 'running');
  const running = runs.find((r) => r.status === 'running');
  const asking = running?.events.some((e) => e.type === 'tool' && e.data?.name === 'stu_ask');
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById('top-actions')), []);
  // 首页（2026-11-18，跟老师的助教一样）：进来先看到问候和大输入框，发出去就接着这段会话聊
  const me = useAuth((s) => s.user);
  const starters = useBuddyStarters();
  const [home, setHome] = useState(true);
  useEffect(() => {
    if (busy) setHome(false);
  }, [busy]);
  useEffect(() => {
    if (q.data && !q.data.runs.length) setHome(true);
  }, [q.data?.session]); // eslint-disable-line react-hooks/exhaustive-deps

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shownSession = q.data?.session;
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shownSession]);
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

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy || sending) return;
    setSending(true);
    setHome(false);
    stick.current = true;
    try {
      await post('/cot/messages', { message: msg, session: q.data?.session });
      setText('');
      qc.invalidateQueries({ queryKey: ['stu-runs'] });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    if (activeId) await post(`/cot/runs/${activeId}/cancel`, {}).catch((err) => toast.fromError(err));
  };

  // 输入框：首页摆在中间，聊着的时候在底下
  const composerArea = (
    <div className={home ? 'w-full' : 'w-full shrink-0 px-3 pb-1 pt-3 lg:px-6'}>
      <motion.div
        layoutId="buddy-composer"
        transition={{ type: 'spring', stiffness: 260, damping: 32 }}
        className={cn('border border-line bg-surface transition-colors focus-within:border-brand/50', home ? 'rounded-[28px] shadow-lg' : 'rounded-2xl shadow-xs')}
      >
        <Textarea
          ref={input}
          autoGrow
          maxRows={8}
          rows={home ? 3 : 2}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={busy ? 'CoT 学伴正在回复…' : home ? '想问点什么？' : '问 CoT 学伴'}
          disabled={busy}
          className={cn('min-h-0 resize-none border-0 bg-transparent px-4 pb-1 pt-3 text-[15px] shadow-none! focus:ring-0', home && 'px-5 pt-4 text-[16px]')}
        />
        <div className="flex items-center justify-end gap-2 px-2 pb-2">
          {busy && activeId ? (
            <button
              type="button"
              onClick={stop}
              aria-label="让它停下"
              title="让它停下"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink text-surface transition-colors hover:bg-ink/85"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || busy || sending}
              aria-label="发送"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('hidden w-full shrink-0 items-center gap-3 px-3 pb-3 pt-1 lg:flex', !home && 'border-b border-line')}>
        <AgentAvatar agent={BUDDY} size={38} status={busy ? 'running' : null} className={cn(home && 'invisible')} />
        <div className={cn('min-w-0 flex-1 leading-tight', home && 'invisible')}>
          <p className="truncate text-[15px] font-semibold text-ink">{BUDDY.name}</p>
          {busy && <p className="mt-0.5 truncate text-[13px] text-ink-2">{asking ? '在问老师的助教' : '在写回复'}</p>}
        </div>
        <SessionButtons compact={false} disabled={busy} />
      </div>
      {slot && createPortal(<SessionButtons compact disabled={busy} />, slot)}
      {home && (
        <HomeStage
          agent={BUDDY}
          hello={greeting(me?.name ? given(me.name) : '')}
          composer={composerArea}
          chips={starters}
          onPick={(t) => {
            setText(t);
            requestAnimationFrame(() => input.current?.focus());
          }}
          onHistory={runs.length ? () => setHome(false) : undefined}
        />
      )}
      <div ref={scroller} className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-5 lg:px-6', home && 'hidden')}>
        <div ref={content} className="space-y-6">
          {q.error && (
            <Alert tone="bad">
              对话加载失败。
              <Button size="sm" onClick={() => q.refetch()}>
                重试
              </Button>
            </Alert>
          )}
          {!q.data && !q.error && <Skeleton className="h-32" />}
          {runs.map((run) => (
            <BuddyRunBlock key={run.id} run={run} live={live && live.runId === run.id ? live.text : null} />
          ))}
        </div>
      </div>
      {!home && composerArea}
    </div>
  );
}

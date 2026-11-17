import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, X } from 'lucide-react';
import { post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, IconButton, Textarea, cn } from '../../components/ui';
import { PART_NAME, type Ask, type Lesson, type Part } from './data';

export interface Focus {
  part: Part | 'brief';
  page?: number;
  number?: number;
}
const FOCUS_NAME: Record<string, string> = { ...PART_NAME, brief: '学情' };
/** 还没说过话时摆几句能直接点的（点了填进输入框，不直接发） */
const SUGGEST: Record<string, string[]> = {
  deck: ['这一页换个例子', '这一页后面加一页课堂提问', '整套课件再精简一些'],
  plan: ['教学过程压到 45 分钟', '开头补讲再短一点'],
  practice: ['再出两道', '这道题换个说法'],
  homework: ['再出一道编程题', '这道题的给分说细一点'],
  brief: [],
};
export const focusLabel = (f: Focus | null) => (f ? `${FOCUS_NAME[f.part]}${f.page ? ` · 第 ${f.page} 页` : ''}${f.number ? ` · 第 ${f.number} 题` : ''}` : '');

/**
 * 跟助教说着改这节课：右边一栏（手机上是底下弹出来的），一句一句往下排；助教改了哪份写在回话下面，最近那次能撤回。
 * 老师正看着哪一份、哪一页，跟着这句话一起带过去。
 */
export function AskRail({ lesson, focus, onClearFocus, className }: { lesson: Lesson; focus: Focus | null; onClearFocus: () => void; className?: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const busy = lesson.asking || lesson.making;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lesson.asks.length, lesson.asks[lesson.asks.length - 1]?.status]);
  const send = async () => {
    const msg = text.trim();
    if (!msg || busy || sending) return;
    setSending(true);
    try {
      await post(`/prep/${lesson.id}/ask`, { message: msg, focus: focus ? { part: focus.part, page: focus.page, number: focus.number } : null });
      setText('');
      await qc.invalidateQueries({ queryKey: ['lesson', lesson.id] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setSending(false);
    }
  };
  // 最近一次是助教改的那几份，才能直接撤回（老师后来又改过的就不摆）
  const last = [...lesson.asks].reverse().find((a) => a.status === 'done' && a.changed.length);
  const undoable = last && last.changed.every((p) => lesson.versions[p]?.lastBy === 'ta' && (lesson.versions[p]?.count ?? 0) > 1) ? last.id : null;
  const undo = async (a: Ask) => {
    try {
      for (const part of a.changed) await post(`/prep/${lesson.id}/undo`, { part });
      await qc.invalidateQueries({ queryKey: ['lesson', lesson.id] });
      toast.success('撤回了');
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface', className)}>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <img src="/illustrations/cot-v1.webp" alt="" className="size-8 shrink-0 rounded-full bg-brand-soft object-contain p-0.5" />
        <p className="text-[15px] font-medium text-ink">CoT 助教</p>
        {lesson.asking && <span className="ml-auto text-[12.5px] text-brand-ink">在改…</span>}
      </div>
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {!lesson.asks.length && !lesson.making && (SUGGEST[focus?.part ?? 'plan'] || []).length > 0 && (
          <div className="flex flex-col items-start gap-1.5 pt-1">
            {(SUGGEST[focus?.part ?? 'plan'] || []).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setText(t)}
                className="rounded-full border border-line-strong px-3 py-1 text-[13px] text-ink-2 transition-colors hover:border-brand/50 hover:text-ink"
              >
                {t}
              </button>
            ))}
          </div>
        )}
        {lesson.asks.map((a) => (
          <div key={a.id} className="space-y-2">
            <div className="ml-auto w-fit max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-white">{a.message}</div>
            {a.status === 'running' ? (
              <span className="flex gap-1 pl-1 pt-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand/60" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
            ) : a.status === 'error' ? (
              <p className="text-[13px] text-bad">{a.error || '没改成'}</p>
            ) : (
              <div className="w-fit max-w-[92%] rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2 text-[14px] leading-relaxed text-ink">
                <p className="whitespace-pre-wrap">{a.reply}</p>
                {a.changed.length > 0 && (
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
                    改了{a.changed.map((p) => PART_NAME[p]).join('、')}
                    {undoable === a.id && (
                      <button type="button" className="text-brand-ink hover:underline" onClick={() => undo(a)}>
                        撤回
                      </button>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-line p-3">
        {focus && (
          <div className="mb-2 flex items-center gap-1">
            <span className="rounded-md bg-brand-soft px-2 py-0.5 text-[12.5px] text-brand-ink">{focusLabel(focus)}</span>
            <IconButton label="不带这一处" className="size-6" onClick={onClearFocus}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            autoGrow
            maxRows={6}
            value={text}
            disabled={lesson.making}
            data-ask-input
            placeholder={lesson.making ? '备好了再改' : '要怎么改？'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), send())}
            className="min-h-[40px] flex-1 resize-none"
          />
          <Button variant="primary" size="md" className="size-10 shrink-0 rounded-full p-0" loading={sending} disabled={!text.trim() || busy} onClick={send} aria-label="发给助教">
            {!sending && <ArrowUp className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

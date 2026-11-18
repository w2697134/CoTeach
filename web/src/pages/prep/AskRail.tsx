import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Loader2, X } from 'lucide-react';
import { VoiceButton } from '../../components/VoiceButton';
import { api, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, IconButton, Textarea, cn } from '../../components/ui';
import { openFile } from '../classes/HwFiles';
import { FileCard, formatSize, typeLabel } from '../kb/FileCard';
import { pastedFiles, pickedFromDrop, type Picked } from '../kb/intake';
import { AttachedRow, ClipButton, keepUsable, keyOf, toAttached, type Attached } from './Attach';
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
 * 老师正看着哪一份、哪一页，跟着这句话一起带过去。可以带文件（「照这个改第 3 页」）：选了就先传上来（跟作业附件一样，一份最大 50 MB），
 * 跟着这句话交给助教，只给这一句用。
 */
export function AskRail({ lesson, focus, onClearFocus, className }: { lesson: Lesson; focus: Focus | null; onClearFocus: () => void; className?: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<(Attached & { fileId?: number })[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((f) => f.url && URL.revokeObjectURL(f.url)), []);
  const list = useRef<HTMLDivElement>(null);
  const busy = lesson.asking || lesson.making;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lesson.asks.length, lesson.asks[lesson.asks.length - 1]?.status]);
  const drop = (key: string) =>
    setFiles((prev) => {
      const f = prev.find((x) => x.key === key);
      if (f?.url) URL.revokeObjectURL(f.url);
      return prev.filter((x) => x.key !== key);
    });
  const attach = (picked: Picked[]) => {
    const have = new Set(files.map((f) => f.key));
    for (const p of keepUsable(
      picked.filter((x) => !have.has(keyOf(x))),
      files,
      50 * 1024 * 1024,
    )) {
      const a = { ...toAttached(p), busy: true };
      setFiles((prev) => [...prev, a]);
      void api<{ id: number }>(`/homework/files?name=${encodeURIComponent(a.name)}`, { method: 'POST', body: p.file })
        .then((r) => setFiles((prev) => prev.map((x) => (x.key === a.key ? { ...x, busy: false, fileId: r.id } : x))))
        .catch((e) => {
          toast.fromError(e);
          drop(a.key);
        });
    }
  };
  const uploading = files.some((f) => f.busy);
  const send = async () => {
    const msg = text.trim();
    if (!msg || busy || sending || uploading) return;
    setSending(true);
    try {
      await post(`/prep/${lesson.id}/ask`, {
        message: msg,
        focus: focus ? { part: focus.part, page: focus.page, number: focus.number } : null,
        fileIds: files.map((f) => f.fileId).filter(Boolean),
      });
      setText('');
      files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
      setFiles([]);
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
        {lesson.asking && <span className="ml-auto text-[13px] text-brand-ink">在改…</span>}
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
            {/* 这句话带的文件摆在气泡上面（照微信、CoT 助教），点开看或下载 */}
            {a.files.length > 0 && (
              <div className="ml-auto flex w-fit max-w-[88%] flex-col items-end gap-1.5">
                {a.files.map((f) => (
                  <FileCard key={f.id} compact name={f.name} meta={[typeLabel(f.name), formatSize(f.size)].filter(Boolean).join(' · ')} onClick={() => openFile(f)} />
                ))}
              </div>
            )}
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
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-3">
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
      <div
        className="border-t border-line p-3"
        onDragOver={(e) => {
          if (lesson.making || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
        }}
        onDrop={(e) => {
          if (lesson.making || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          void pickedFromDrop(e.dataTransfer).then(attach);
        }}
      >
        {focus && (
          <div className="mb-2 flex items-center gap-1">
            <span className="rounded-md bg-brand-soft px-2 py-0.5 text-[13px] text-brand-ink">{focusLabel(focus)}</span>
            <IconButton label="不带这一处" className="size-6" onClick={onClearFocus}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        )}
        <AttachedRow list={files} onRemove={drop} />
        {/* 跟 CoT 助教的输入框一个样子：一个圆角框，上面打字，底下左边带文件，右边说话、发送 */}
        <div className="rounded-2xl border border-line bg-surface shadow-xs transition-colors focus-within:border-brand/50">
          <Textarea
            autoGrow
            rows={2}
            maxRows={6}
            value={text}
            disabled={lesson.making}
            data-ask-input
            placeholder={lesson.making ? '备好了再改' : '要怎么改？'}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              if (lesson.making || !e.clipboardData.files.length) return;
              e.preventDefault();
              attach(pastedFiles(e.clipboardData.files));
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), send())}
            className="min-h-0 resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 text-[15px] shadow-none! hover:border-0 focus:ring-0"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <ClipButton onPick={attach} disabled={lesson.making} />
            <span className="flex-1" />
            <VoiceButton disabled={lesson.making} onText={(t) => setText((x) => x + t)} />
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || busy || uploading || sending}
              aria-label="发给助教"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

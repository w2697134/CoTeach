import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, IconButton, Modal, Textarea, cn } from '../../components/ui';
import { useClasses } from '../classes/data';
import { themeOf } from '../classes/look';
import { uploadFile } from '../classes/homework';
import type { FileRef } from './data';

/**
 * 发通知：挑一门或几门课（从课程群里点开的，默认是这门），写几句，可以带附件。
 * 发出去每门课的群里出一张通知卡，每个学生的收件箱也来一条。
 */
export function NewNotice({ open, onClose, classId, onSent }: { open: boolean; onClose: () => void; classId?: number | null; onSent?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const classes = (useClasses().data?.classes || []).filter((k) => !k.archived);
  const [picked, setPicked] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setPicked(classId ? [classId] : []);
    setText('');
    setFiles([]);
  }, [open, classId]);
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const add = async (list: FileList | null) => {
    setUploading(true);
    for (const f of Array.from(list || []))
      try {
        const up = await uploadFile(f);
        setFiles((x) => [...x, up]);
      } catch (e) {
        toast.fromError(e);
      }
    setUploading(false);
    if (input.current) input.current.value = '';
  };
  const send = async () => {
    setBusy(true);
    try {
      await post('/messages/notices', { classIds: picked, text: text.trim(), fileIds: files.map((f) => f.id) });
      toast.success(`通知发到了${picked.length > 1 ? ` ${picked.length} 门课` : '课程群'}`);
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['chat'] });
      onClose();
      if (onSent) onSent();
      else if (picked.length === 1) {
        const r = await get<{ chats: { id: number; classId: number | null }[] }>('/messages');
        const g = r.chats.find((c) => c.classId === picked[0]);
        if (g) navigate(`/messages/${g.id}`);
      }
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="发通知"
      width={520}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!picked.length || !text.trim() || uploading} onClick={send}>
            发出去
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="flex flex-wrap gap-1.5">
          {classes.map((k) => {
            const on = picked.includes(k.id);
            const t = themeOf(k.id);
            return (
              <button
                key={k.id}
                type="button"
                onClick={() => toggle(k.id)}
                aria-pressed={on}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[14px] transition-colors',
                  on ? 'border-transparent text-white' : 'border-line text-ink-2 hover:border-line-strong',
                )}
                style={on ? { background: `linear-gradient(135deg, ${t.from}, ${t.to})` } : undefined}
              >
                {!on && <span className="size-2 rounded-full" style={{ background: t.from }} />}
                {k.name}
              </button>
            );
          })}
          {!classes.length && <p className="text-[14px] text-ink-3">还没有课程</p>}
        </div>
        <Textarea autoFocus autoGrow rows={4} maxRows={12} value={text} maxLength={4000} placeholder="通知的内容" onChange={(e) => setText(e.target.value)} />
        {files.length > 0 && (
          <div className="space-y-1.5">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[14px] text-ink">
                <Paperclip className="size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <IconButton size="sm" label="不带这个" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                  <X className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <Button size="sm" variant="ghost" icon={<Paperclip className="size-4" />} loading={uploading} onClick={() => input.current?.click()}>
          加附件
        </Button>
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => add(e.target.files)} />
      </div>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { Button, IconButton, Input, Modal, Segmented, Textarea, cn } from '../../components/ui';
import { QTYPE_NAME, type QType } from '../prep/data';
import { isChoice, letter } from './data';

interface Draft {
  type: QType;
  stem: string;
  code: string;
  options: string[];
  choice: number[];
  answer: string;
  explain: string;
}
const fresh = (): Draft => ({ type: 'single', stem: '', code: '', options: ['', '', '', ''], choice: [], answer: '', explain: '' });

/**
 * 当堂出一道题（没带备好的课，或者临时想问一句）：题型、题干、选项和答案、解析，写完直接推给学生。
 * 选择题点字母标答案；判断题点对错；填空写答案（学生交的照它比对）；简答、编程只收不判。
 */
export function NewQuestion({ open, onClose, onPush }: { open: boolean; onClose: () => void; onPush: (q: Record<string, unknown>) => Promise<void> }) {
  const [d, setD] = useState<Draft>(fresh);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setD(fresh());
  }, [open]);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const filled = d.options.map((o, i) => [o.trim(), i] as const).filter(([o]) => o);
  const ok =
    !!d.stem.trim() &&
    (isChoice(d.type) ? filled.length >= 2 && d.choice.some((i) => d.options[i]?.trim()) : d.type === 'judge' ? !!d.answer : d.type === 'blank' ? !!d.answer.trim() : true);
  const toggle = (i: number) => set({ choice: d.type === 'single' ? [i] : d.choice.includes(i) ? d.choice.filter((x) => x !== i) : [...d.choice, i].sort() });
  const push = async () => {
    if (!ok || busy) return;
    // 空着的选项去掉，答案的序号跟着挪
    const at = new Map(filled.map(([, i], k) => [i, k]));
    const q: Record<string, unknown> = { type: d.type, stem: d.stem.trim(), explain: d.explain.trim() || undefined, code: d.code.trim() ? d.code : undefined };
    if (isChoice(d.type)) {
      q.options = filled.map(([o]) => o);
      q.choice = d.choice.filter((i) => at.has(i)).map((i) => at.get(i)!);
    } else q.answer = d.answer.trim();
    setBusy(true);
    try {
      await onPush(q);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="出一道题"
      width={560}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon={<Send className="size-4" />} loading={busy} disabled={!ok} onClick={push}>
            推送
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="no-scrollbar -mx-1 overflow-x-auto px-1">
          <Segmented
            size="sm"
            value={d.type}
            onChange={(type) => set({ type, choice: type === 'single' ? d.choice.slice(0, 1) : d.choice, answer: type === 'judge' ? '对' : d.type === 'judge' ? '' : d.answer })}
            options={(Object.keys(QTYPE_NAME) as QType[]).map((t) => ({ value: t, label: QTYPE_NAME[t] }))}
          />
        </div>
        <Textarea autoFocus autoGrow value={d.stem} maxLength={1500} placeholder="题干" onChange={(e) => set({ stem: e.target.value })} />
        <Textarea autoGrow rows={1} className="font-mono text-[13px]" value={d.code} placeholder="题目里给的代码" onChange={(e) => set({ code: e.target.value })} />
        {isChoice(d.type) ? (
          <div className="space-y-2">
            {d.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  aria-label={`${letter(i)} 是答案`}
                  aria-pressed={d.choice.includes(i)}
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-md border text-[14px] font-semibold transition-colors',
                    d.choice.includes(i) ? 'border-ok bg-ok text-white' : 'border-line-strong text-ink-3 hover:border-ok/60',
                  )}
                >
                  {letter(i)}
                </button>
                <Input className="flex-1" value={o} maxLength={300} onChange={(e) => set({ options: d.options.map((x, k) => (k === i ? e.target.value : x)) })} />
                <IconButton
                  label="删掉这个选项"
                  disabled={d.options.length <= 2}
                  onClick={() =>
                    set({
                      options: d.options.filter((_, k) => k !== i),
                      choice: d.choice.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)),
                    })
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ))}
            {d.options.length < 6 && (
              <Button size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ options: [...d.options, ''] })}>
                加一个选项
              </Button>
            )}
          </div>
        ) : d.type === 'judge' ? (
          <div className="flex gap-2">
            {['对', '错'].map((x) => (
              <Button key={x} variant={d.answer === x ? 'primary' : 'secondary'} className="w-20" onClick={() => set({ answer: x })}>
                {x}
              </Button>
            ))}
          </div>
        ) : d.type === 'blank' ? (
          <Input value={d.answer} maxLength={200} placeholder="答案" onChange={(e) => set({ answer: e.target.value })} />
        ) : (
          <Textarea autoGrow className={d.type === 'code' ? 'font-mono text-[13px]' : ''} value={d.answer} placeholder="参考答案" onChange={(e) => set({ answer: e.target.value })} />
        )}
        <Textarea autoGrow value={d.explain} maxLength={1500} placeholder="解析" onChange={(e) => set({ explain: e.target.value })} />
      </div>
    </Modal>
  );
}

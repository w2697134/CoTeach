import { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { Button, IconButton, Input, Select, Textarea, cn, useConfirm } from '../../components/ui';
import { QTYPE_NAME, type QType, type Question } from './data';

const letter = (n: number) => String.fromCharCode(65 + n);
/** 以前存下的选项前面带着「A.」的，显示时去掉（页面上另外标字母） */
const bare = (s: string) => s.replace(/^\s*[（(]?[A-Ha-h][)）.．、:：]\s*/, '');
const isChoice = (t: QType) => t === 'single' || t === 'multi';
const blank = (homework: boolean): Question => ({ id: '', type: 'single', stem: '', options: ['', ''], answer: '', choice: [0], ...(homework ? { points: 10 } : {}) });

/**
 * 课堂练习、课后作业：一题一张卡片，老师看得到答案和解析；就地改、加、删、挪位置，每次存整份（能撤回）。
 * selected：老师点中的那一题（跟助教说「这道题」时带上）。
 */
export function QuestionsView({
  list,
  homework,
  selected,
  onSelect,
  onSave,
  head,
  live,
  readOnly,
}: {
  list: Question[];
  homework: boolean;
  selected: number | null;
  onSelect: (i: number | null) => void;
  onSave: (next: Question[]) => Promise<void>;
  head?: React.ReactNode;
  /** 还在出题（边出边显示）：不能改，出好一道淡入一道 */
  live?: boolean;
  /** 还在备的时候出好了的题：先看，备完再改 */
  readOnly?: boolean;
}) {
  const locked = live || readOnly;
  const confirm = useConfirm();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (next: Question[]) => {
    setSaving(true);
    try {
      await onSave(next);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    const [q] = next.splice(i, 1);
    next.splice(i + d, 0, q);
    void save(next);
  };
  const total = list.reduce((n, q) => n + (q.points ?? 0), 0);
  return (
    <div className="mx-auto max-w-[860px]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="text-[14px] text-ink-3">
          {list.length} 道{homework && total ? ` · 共 ${total} 分` : ''}
        </p>
        <div className="ml-auto flex items-center gap-2">
          {head}
          {!locked && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              加一道
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {list.map((q, i) =>
          editing === i ? (
            <QuestionEditor key={q.id || i} q={q} n={i + 1} homework={homework} saving={saving} onCancel={() => setEditing(null)} onSave={(x) => save(list.map((y, k) => (k === i ? x : y)))} />
          ) : (
            <motion.div key={q.id || i} initial={live ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
            <QuestionCard
              q={q}
              n={i + 1}
              homework={homework}
              active={selected === i}
              onClick={() => onSelect(selected === i ? null : i)}
              actions={
                locked ? null : (
                <>
                  <IconButton label="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-4" />
                  </IconButton>
                  <IconButton label="下移" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-4" />
                  </IconButton>
                  <IconButton label="改这一题" onClick={() => setEditing(i)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton
                    label="删掉这一题"
                    onClick={async () => {
                      if (await confirm({ title: `删掉第 ${i + 1} 题？`, okText: '删掉', danger: true })) void save(list.filter((_, k) => k !== i));
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </>
                )
              }
            />
            </motion.div>
          ),
        )}
        {live && (
          <p className="flex items-center gap-2 px-1 text-[14px] text-ink-3">
            <span className="size-2 animate-pulse rounded-full bg-brand" />
            我还在出题
          </p>
        )}
        {editing === 'new' && (
          <QuestionEditor q={blank(homework)} n={list.length + 1} homework={homework} saving={saving} onCancel={() => setEditing(null)} onSave={(x) => save([...list, x])} />
        )}
        {!list.length && editing !== 'new' && !live && <p className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center text-[14px] text-ink-3">还没有题</p>}
      </div>
    </div>
  );
}

function QuestionCard({ q, n, homework, active, onClick, actions }: { q: Question; n: number; homework: boolean; active: boolean; onClick: () => void; actions: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const choice = new Set(q.choice ?? []);
  return (
    <div
      onClick={onClick}
      className={cn(
        'group cursor-pointer rounded-xl border bg-surface px-4 py-3.5 shadow-xs transition-colors sm:px-5',
        active ? 'border-brand ring-2 ring-brand/15' : 'border-line hover:border-line-strong',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-semibold text-ink">第 {n} 题</span>
        <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[13px] font-medium text-brand-ink">{QTYPE_NAME[q.type]}</span>
        {homework && q.points !== undefined && <span className="text-[13px] text-ink-3">{q.points} 分</span>}
        <div className="ml-auto flex items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      </div>
      <div className="mt-2 text-[15px] leading-relaxed text-ink">
        <Markdown compact>{q.stem}</Markdown>
      </div>
      {q.code && <pre className="mt-2.5 overflow-x-auto rounded-lg bg-[#1e2233] px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-[#e6e9f5]">{q.code}</pre>}
      {q.options?.length ? (
        <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
          {q.options.map((o, i) => (
            <li
              key={i}
              className={cn(
                'flex items-start gap-2 rounded-lg border px-3 py-2 text-[14px]',
                choice.has(i) ? 'border-ok/40 bg-ok/8 text-ink' : 'border-line text-ink-2',
              )}
            >
              <span className={cn('font-semibold', choice.has(i) ? 'text-ok' : 'text-ink-3')}>{letter(i)}</span>
              <span className="min-w-0 flex-1">{bare(o)}</span>
              {choice.has(i) && <Check className="mt-0.5 size-4 shrink-0 text-ok" />}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2.5 rounded-lg bg-ok/8 px-3 py-2 text-[14px] text-ink">
          <span className="mr-2 font-medium text-ok">参考答案</span>
          {q.type === 'code' || /\n/.test(q.answer) ? <pre className="mt-1 whitespace-pre-wrap font-mono text-[13px]">{q.answer}</pre> : q.answer}
        </div>
      )}
      {(q.explain || (homework && q.rubric)) && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="text-[13px] text-brand-ink hover:underline" onClick={() => setOpen(!open)}>
            {open ? '收起' : homework && q.rubric ? '解析和给分' : '解析'}
          </button>
          {open && (
            <div className="mt-1.5 space-y-1.5 text-[14px] leading-relaxed text-ink-2">
              {q.explain && <p>{q.explain}</p>}
              {homework && q.rubric && <p className="text-ink-3">给分：{q.rubric}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionEditor({ q, n, homework, saving, onSave, onCancel }: { q: Question; n: number; homework: boolean; saving: boolean; onSave: (q: Question) => void; onCancel: () => void }) {
  const [d, setD] = useState<Question>(() => ({ ...q, options: q.options ? [...q.options] : isChoice(q.type) ? ['', ''] : undefined }));
  const set = (patch: Partial<Question>) => setD((x) => ({ ...x, ...patch }));
  const choice = new Set(d.choice ?? []);
  const toggle = (i: number) => {
    const next = d.type === 'single' ? [i] : choice.has(i) ? [...choice].filter((x) => x !== i) : [...choice, i].sort();
    set({ choice: next, answer: next.map(letter).join('') });
  };
  const ok = d.stem.trim() && (!isChoice(d.type) || ((d.options || []).filter((o) => o.trim()).length >= 2 && (d.choice || []).length > 0)) && (isChoice(d.type) || d.answer.trim());
  return (
    <div className="space-y-3 rounded-xl border border-brand/30 bg-surface px-4 py-4 shadow-xs ring-2 ring-brand/10 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold text-ink">第 {n} 题</span>
        <Select
          sizeVariant="sm"
          className="w-auto"
          value={d.type}
          onChange={(e) => {
            const type = e.target.value as QType;
            set({ type, ...(isChoice(type) && !d.options?.length ? { options: ['', ''], choice: [0] } : {}), ...(type === 'judge' ? { answer: '对' } : {}) });
          }}
        >
          {(Object.keys(QTYPE_NAME) as QType[]).map((t) => (
            <option key={t} value={t}>
              {QTYPE_NAME[t]}
            </option>
          ))}
        </Select>
        {homework && (
          <label className="ml-auto flex items-center gap-1.5 text-[14px] text-ink-2">
            <Input className="w-20" type="number" min={0.5} step={0.5} value={d.points ?? ''} onChange={(e) => set({ points: e.target.value ? Number(e.target.value) : undefined })} />分
          </label>
        )}
      </div>
      <Textarea autoGrow value={d.stem} placeholder="题干" onChange={(e) => set({ stem: e.target.value })} />
      <Textarea autoGrow className="font-mono text-[13px]" value={d.code || ''} placeholder="题目里给的代码（没有就空着）" onChange={(e) => set({ code: e.target.value || undefined })} />
      {isChoice(d.type) ? (
        <div className="space-y-1.5">
          {(d.options || []).map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggle(i)}
                className={cn('grid size-7 shrink-0 place-items-center rounded-md border text-[13px] font-semibold', choice.has(i) ? 'border-ok bg-ok text-white' : 'border-line-strong text-ink-3')}
                aria-label={`${letter(i)} 是答案`}
              >
                {letter(i)}
              </button>
              <Input className="flex-1" value={o} onChange={(e) => set({ options: d.options!.map((x, k) => (k === i ? e.target.value : x)) })} />
              <IconButton
                label="删掉这个选项"
                disabled={(d.options || []).length <= 2}
                onClick={() => {
                  const options = d.options!.filter((_, k) => k !== i);
                  const next = [...choice].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
                  set({ options, choice: next, answer: next.map(letter).join('') });
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          {(d.options || []).length < 6 && (
            <Button size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ options: [...(d.options || []), ''] })}>
              加一个选项
            </Button>
          )}
        </div>
      ) : d.type === 'judge' ? (
        <div className="flex gap-2">
          {['对', '错'].map((x) => (
            <Button key={x} size="sm" variant={d.answer === x ? 'primary' : 'secondary'} onClick={() => set({ answer: x })}>
              {x}
            </Button>
          ))}
        </div>
      ) : (
        <Textarea autoGrow className={d.type === 'code' ? 'font-mono text-[13px]' : ''} value={d.answer} placeholder="参考答案" onChange={(e) => set({ answer: e.target.value })} />
      )}
      <Textarea autoGrow value={d.explain || ''} placeholder="解析" onChange={(e) => set({ explain: e.target.value || undefined })} />
      {homework && <Textarea autoGrow value={d.rubric || ''} placeholder="怎么给分" onChange={(e) => set({ rubric: e.target.value || undefined })} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={!ok}
          onClick={() => {
            if (!isChoice(d.type)) return onSave({ ...d, options: undefined, choice: undefined });
            // 空着的选项去掉，答案的序号跟着挪
            const keep = (d.options || []).map((o, i) => [o.trim(), i] as const).filter(([o]) => o);
            const at = new Map(keep.map(([, i], k) => [i, k]));
            const picked = (d.choice || []).filter((i) => at.has(i)).map((i) => at.get(i)!);
            onSave({ ...d, options: keep.map(([o]) => o), choice: picked, answer: picked.map(letter).join('') });
          }}
        >
          保存
        </Button>
      </div>
    </div>
  );
}

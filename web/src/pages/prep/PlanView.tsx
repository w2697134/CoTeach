import { useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Trash2 } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { Button, IconButton, Input, Textarea, cn } from '../../components/ui';
import type { Plan, PlanStep } from './data';

/**
 * 一段里挤在一起的「1) … 2) … 3) …」拆成一条一条（要从 1 起、挨着往下数的才算，代码里的「5)」不算）；
 * 开头的【讲授+提问】这种摘出来当小标签。只改显示，存的还是原文。
 */
export function splitSteps(text: string): { tag: string | null; head: string; items: string[] } {
  let t = text.trim();
  const m = t.match(/^【([^】]{1,12})】\s*/);
  const tag = m ? m[1] : null;
  if (m) t = t.slice(m[0].length);
  const marks: { at: number; len: number }[] = [];
  const re = /(^|[：:；;。，,\s])([1-9])[)）]\s*/g;
  let want = 1;
  for (let x = re.exec(t); x; x = re.exec(t)) {
    if (Number(x[2]) !== want) continue;
    marks.push({ at: x.index + x[1].length, len: x[0].length - x[1].length });
    want++;
  }
  if (marks.length < 2) return { tag, head: t, items: [] };
  const head = t.slice(0, marks[0].at).trim();
  const items = marks.map((k, i) => t.slice(k.at + k.len, i + 1 < marks.length ? marks[i + 1].at : undefined).trim().replace(/[；;，,]$/, ''));
  return { tag, head, items };
}

function StepText({ text }: { text: string }) {
  const { tag, head, items } = splitSteps(text);
  return (
    <>
      {tag && <span className="mb-1 mr-1.5 inline-block rounded-md bg-surface-3 px-1.5 py-0.5 text-[13px] font-medium text-ink-2">{tag}</span>}
      {head && <Markdown compact>{head}</Markdown>}
      {items.length > 0 && (
        <ol className="mt-1 list-decimal space-y-1 pl-5 marker:text-ink-3">
          {items.map((x, i) => (
            <li key={i}>
              <Markdown compact>{x}</Markdown>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/**
 * 教案：排成一页文档（像 Word 里的教案），老师点「编辑」就地改，存一版（能撤回）。
 * live：还在写（边写边显示）：不能改，新写出来的一段淡入，最后一行写着「还在写」。
 */
export function PlanView({ plan, meta, onSave, live }: { plan: Plan; meta: string; onSave?: (p: Plan) => Promise<void>; live?: boolean }) {
  const [draft, setDraft] = useState<Plan | null>(null);
  const [saving, setSaving] = useState(false);
  if (draft)
    return (
      <PlanEditor
        plan={draft}
        onChange={setDraft}
        saving={saving}
        onCancel={() => setDraft(null)}
        onSave={async () => {
          setSaving(true);
          try {
            await onSave?.(draft);
            setDraft(null);
          } finally {
            setSaving(false);
          }
        }}
      />
    );
  const total = plan.steps.reduce((n, s) => n + (s.minutes || 0), 0);
  return (
    <article className="relative mx-auto max-w-[820px] rounded-xl border border-line bg-surface px-5 py-6 shadow-xs sm:px-12 sm:py-10">
      {!live && onSave && (
        <Button size="sm" variant="secondary" className="absolute right-4 top-4 sm:right-6 sm:top-6" onClick={() => setDraft(structuredClone(plan))}>
          编辑
        </Button>
      )}
      <header className="border-b border-line pb-5 pr-16">
        <h2 className="text-[24px] font-bold leading-snug text-ink">{plan.title}</h2>
        <p className="mt-1.5 text-[14px] text-ink-3">{meta}</p>
      </header>
      {plan.goals.length > 0 && (
        <Section live={live} title="教学目标">
          <ol className="space-y-1.5">
            {plan.goals.map((g, i) => (
              <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed text-ink">
                <span className="mt-[3px] grid size-5 shrink-0 place-items-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand-ink">{i + 1}</span>
                <span className="min-w-0">{g}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {(plan.focus || plan.hard) && (
        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          {plan.focus && <Note title="教学重点" text={plan.focus} tone="brand" />}
          {plan.hard && <Note title="教学难点" text={plan.hard} tone="warn" />}
        </div>
      )}
      {plan.review && (
        <Section live={live} title="开头补讲">
          <div className="rounded-lg bg-surface-2 px-4 py-3 text-[15px] leading-relaxed text-ink">
            <Markdown compact>{plan.review}</Markdown>
          </div>
        </Section>
      )}
      {plan.steps.length > 0 && (
        <Section live={live} title="教学过程" end={total ? `共 ${total} 分钟` : undefined}>
          <ol className="relative space-y-0">
            {plan.steps.map((s, i) => (
              <motion.li key={i} initial={live ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="relative flex gap-4 pb-6 last:pb-0">
                {i < plan.steps.length - 1 && <span className="absolute bottom-0 left-[27px] top-9 w-px bg-line" />}
                <span className="relative mt-0.5 grid h-7 w-14 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand-ink">
                  {s.minutes ? `${s.minutes} 分` : '—'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold text-ink">{s.name}</p>
                  <div className="mt-1 text-[15px] leading-relaxed text-ink-2">
                    <StepText text={s.content} />
                  </div>
                </div>
              </motion.li>
            ))}
          </ol>
        </Section>
      )}
      {plan.board && (
        <Section live={live} title="板书设计">
          <pre className="whitespace-pre-wrap rounded-lg border border-dashed border-line-strong bg-surface-2 px-4 py-3 font-sans text-[15px] leading-relaxed text-ink">{plan.board}</pre>
        </Section>
      )}
      {plan.sources.length > 0 && (
        <Section live={live} title="用到的资料">
          <div className="flex flex-wrap gap-1.5">
            {plan.sources.map((s) => (
              <span key={s} className="rounded-md bg-surface-3 px-2 py-1 text-[13px] text-ink-2">
                {s.replace(/\.md$/i, '')}
              </span>
            ))}
          </div>
        </Section>
      )}
      {live && (
        <p className="mt-7 flex items-center gap-2 text-[14px] text-ink-3">
          <span className="size-2 animate-pulse rounded-full bg-brand" />
          我还在往下写
        </p>
      )}
    </article>
  );
}

function Section({ title, end, live, children }: { title: string; end?: string; live?: boolean; children: React.ReactNode }) {
  return (
    <motion.section initial={live ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="mt-7">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-4 w-1 rounded-full bg-brand" />
        <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
        {end && <span className="ml-auto text-[13px] text-ink-3">{end}</span>}
      </div>
      {children}
    </motion.section>
  );
}

function Note({ title, text, tone }: { title: string; text: string; tone: 'brand' | 'warn' }) {
  return (
    <div className={cn('rounded-lg px-4 py-3', tone === 'brand' ? 'bg-brand-soft/60' : 'bg-warn/10')}>
      <p className={cn('text-[14px] font-semibold', tone === 'brand' ? 'text-brand-ink' : 'text-warn')}>{title}</p>
      <div className="mt-1 text-[15px] leading-relaxed text-ink">
        <Markdown compact>{text}</Markdown>
      </div>
    </div>
  );
}

/** 就地改教案：每一栏一个框，教学过程一行一个环节 */
function PlanEditor({
  plan,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  plan: Plan;
  onChange: (p: Plan) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const set = (patch: Partial<Plan>) => onChange({ ...plan, ...patch });
  const setStep = (i: number, patch: Partial<PlanStep>) => set({ steps: plan.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const field = (label: string, node: React.ReactNode) => (
    <label className="block">
      <span className="mb-1.5 block text-[14px] font-medium text-ink-2">{label}</span>
      {node}
    </label>
  );
  return (
    <div className="mx-auto max-w-[820px] space-y-5 rounded-xl border border-brand/30 bg-surface px-5 py-6 shadow-xs ring-2 ring-brand/10 sm:px-10">
      {field('课题', <Input value={plan.title} onChange={(e) => set({ title: e.target.value })} />)}
      {field(
        '教学目标（一行一条）',
        <Textarea autoGrow value={plan.goals.join('\n')} onChange={(e) => set({ goals: e.target.value.split('\n') })} />,
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {field('教学重点', <Textarea autoGrow value={plan.focus} onChange={(e) => set({ focus: e.target.value })} />)}
        {field('教学难点', <Textarea autoGrow value={plan.hard} onChange={(e) => set({ hard: e.target.value })} />)}
      </div>
      {field('开头补讲', <Textarea autoGrow value={plan.review} onChange={(e) => set({ review: e.target.value })} />)}
      <div>
        <span className="mb-1.5 block text-[14px] font-medium text-ink-2">教学过程</span>
        <div className="space-y-2.5">
          {plan.steps.map((s, i) => (
            <div key={i} className="rounded-lg border border-line p-2.5">
              <div className="flex items-center gap-2">
                <Input className="flex-1" value={s.name} placeholder="环节" onChange={(e) => setStep(i, { name: e.target.value })} />
                <Input
                  className="w-20"
                  type="number"
                  min={0}
                  value={s.minutes ?? ''}
                  placeholder="分钟"
                  onChange={(e) => setStep(i, { minutes: e.target.value ? Number(e.target.value) : null })}
                />
                <IconButton label="删掉这个环节" onClick={() => set({ steps: plan.steps.filter((_, k) => k !== i) })}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
              <Textarea autoGrow className="mt-2" value={s.content} placeholder="做什么、讲什么" onChange={(e) => setStep(i, { content: e.target.value })} />
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="size-4" />} onClick={() => set({ steps: [...plan.steps, { name: '', minutes: null, content: '' }] })}>
          加一个环节
        </Button>
      </div>
      {field('板书设计', <Textarea autoGrow value={plan.board || ''} onChange={(e) => set({ board: e.target.value })} />)}
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" loading={saving} onClick={onSave}>
          保存
        </Button>
      </div>
    </div>
  );
}

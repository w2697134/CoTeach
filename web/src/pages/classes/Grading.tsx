import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronDown, FileText, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { api, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { AgentAvatar, Button, Card, IconButton, Input, Modal, Textarea, cn, useConfirm } from '../../components/ui';
import { TA } from '../kb/data';
import { num, type GradeItem, type HomeworkDetail, type Mark, type RubricItem } from './homework';
import { CHIP, INK } from './tone';

/* ---------------- 批改稿：交上来的文字，划出批注 ---------------- */

/** 批注编号：在原文里的按先后排，找不到原文的排在后面 */
export function numbered(marks: Mark[]) {
  return marks.map((m, i) => ({ ...m, n: i + 1 }));
}

/** 看着像代码的用等宽字（缩进、括号、关键字多） */
const looksLikeCode = (text: string) => {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return false;
  const code = lines.filter((l) => /^\s{2,}\S|[=(){}[\];]|^\s*(def|for|while|if|elif|else|print|import|class|return|int|public|#include)\b/.test(l)).length;
  return code / lines.length >= 0.35;
};

const TONE = {
  wrong: { mark: 'bg-bad-soft decoration-[#ef4444]/70', chip: 'bg-[#dc2626] text-white' },
  good: { mark: 'bg-ok-soft decoration-[#10b981]/70', chip: 'bg-[#047857] text-white' },
};

/** 批改稿：原文照排，批注的地方底色加波浪线，后面一个小号码，跟旁边的批注对上 */
export function MarkedText({ text, marks, active, onPick }: { text: string; marks: Mark[]; active?: number | null; onPick?: (n: number) => void }) {
  const list = numbered(marks);
  const parts = useMemo(() => {
    const placed = list.filter((m) => m.start >= 0 && m.end > m.start).sort((a, b) => a.start - b.start);
    const out: { text: string; m?: (typeof list)[number] }[] = [];
    let at = 0;
    for (const m of placed) {
      if (m.start < at) continue; // 跟前一条重叠的不再划
      if (m.start > at) out.push({ text: text.slice(at, m.start) });
      out.push({ text: text.slice(m.start, m.end), m });
      at = m.end;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }, [text, list]);
  const code = looksLikeCode(text);
  return (
    <div
      className={cn(
        'whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2/60 px-4 py-3.5 leading-[1.95] text-ink',
        code ? 'font-mono text-[14px] [tab-size:4]' : 'text-[15px]',
      )}
    >
      {parts.map((p, i) =>
        p.m ? (
          <span key={i}>
            <mark
              onClick={() => onPick?.(p.m!.n)}
              className={cn(
                'cursor-pointer rounded-[3px] px-0.5 text-inherit underline decoration-wavy decoration-[1.5px] underline-offset-[5px] transition-shadow',
                TONE[p.m.kind].mark,
                active === p.m.n && 'ring-2 ring-brand/40',
              )}
            >
              {p.text}
            </mark>
            <sup
              onClick={() => onPick?.(p.m!.n)}
              className={cn(
                'ml-0.5 inline-flex size-5 -translate-y-0.5 cursor-pointer items-center justify-center rounded-full font-sans text-[13px] font-semibold not-italic leading-none',
                TONE[p.m.kind].chip,
              )}
            >
              {p.m.n}
            </sup>
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}

/** 批注列表：号码、划的原文、说了什么（一行四十几个字） */
export function MarkList({ marks, active, onPick }: { marks: Mark[]; active?: number | null; onPick?: (n: number) => void }) {
  const list = numbered(marks);
  if (!list.length) return null;
  return (
    <ol className="space-y-1.5">
      {list.map((m) => (
        <li
          key={m.n}
          onClick={() => onPick?.(m.n)}
          className={cn('flex max-w-[46em] cursor-default gap-3 rounded-lg px-2 py-2 transition-colors', active === m.n ? 'bg-brand-soft/70' : 'hover:bg-surface-2')}
        >
          <span className={cn('mt-0.5 inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-[13px] font-semibold', TONE[m.kind].chip)}>{m.n}</span>
          <div className="min-w-0 text-[15px] leading-relaxed">
            {m.start < 0 && <span className="mr-1.5 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[13px] text-ink-2">{m.quote.slice(0, 60)}</span>}
            <span className="text-ink">{m.note}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------------- 每项得分 ---------------- */

const barColor = (got: number, max: number) => (got >= max ? '#10b981' : got <= 0 ? '#ef4444' : '#f59e0b');

/** 每项得分（只看）：名字、几分、一根条、为什么 */
export function ItemBars({ items }: { items: GradeItem[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-4">
      {items.map((it, i) => (
        <li key={i} className="space-y-1.5">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 text-[15px] font-medium text-ink">{it.title}</span>
            <span className={cn('shrink-0 text-[14px] tabular-nums text-ink-2', it.got < it.max && 'font-medium')}>
              <span className={cn('text-[16px] font-semibold', it.got >= it.max ? INK.ok : it.got <= 0 ? INK.bad : 'text-ink')}>{num(it.got)}</span> / {num(it.max)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full" style={{ width: `${it.max ? Math.max(2, (it.got / it.max) * 100) : 0}%`, backgroundColor: barColor(it.got, it.max) }} />
          </div>
          {it.why && <p className="max-w-[44em] text-[14px] leading-relaxed text-ink-2">{it.why}</p>}
        </li>
      ))}
    </ul>
  );
}

/** 每项得分（老师改）：分数能改，总分跟着加 */
export function ItemEditor({ items, base, onChange }: { items: GradeItem[]; base?: GradeItem[]; onChange: (items: GradeItem[]) => void }) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {items.map((it, i) => {
        const changed = base && base[i] && Math.abs(base[i].got - it.got) > 0.01;
        return (
          <li key={i} className={cn('space-y-1.5 px-3.5 py-3', changed && 'bg-brand-soft/40')}>
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-ink">{it.title}</span>
              {changed && <span className="shrink-0 text-[13px] text-ink-2 line-through">{num(base![i].got)}</span>}
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                max={it.max}
                step="0.5"
                className="w-[72px] text-right"
                value={String(it.got)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onChange(items.map((x, k) => (k === i ? { ...x, got: Number.isFinite(v) ? Math.min(x.max, Math.max(0, v)) : 0 } : x)));
                }}
              />
              <span className="w-10 shrink-0 text-[14px] tabular-nums text-ink-2">/ {num(it.max)}</span>
            </div>
            {it.why && <p className="text-[14px] leading-relaxed text-ink-2">{it.why}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export const sumItems = (items: GradeItem[]) => Math.round(items.reduce((n, x) => n + x.got, 0) * 10) / 10;

/** 谁批的：CoT 助教 / 老师 */
export function GradedBy({ by }: { by?: 'ai' | 'teacher' | null }) {
  if (!by) return null;
  return by === 'ai' ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-[13px] font-medium text-brand-ink">
      <Bot className="size-4" />
      CoT 助教批的
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2.5 py-0.5 text-[13px] font-medium text-ink-2">
      <Check className="size-4" />
      老师批的
    </span>
  );
}

/* ---------------- 评分标准（老师） ---------------- */

const blank = (): RubricItem => ({ title: '', points: 10, criteria: '', answer: '' });

/** 评分标准：助教拟的，老师能看能改；学生看不到 */
export function RubricCard({ h }: { h: HomeworkDetail }) {
  const qc = useQueryClient(),
    confirm = useConfirm();
  const r = h.rubric;
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<RubricItem[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (h.aiMode === 'off' && !r) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['homework', h.id] });
  const drafting = r?.status === 'drafting';
  const sum = editing ? Math.round(editing.reduce((n, x) => n + (Number(x.points) || 0), 0) * 10) / 10 : 0;
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      await api(`/homework/${h.id}/rubric`, { method: 'PUT', body: { items: editing.map((x) => ({ ...x, points: Number(x.points) })) } });
      await refresh();
      setEditing(null);
      toast.success('评分标准改好了');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const redraft = async () => {
    if (r?.source === 'teacher' && !(await confirm({ title: '让助教重拟？', desc: '你改过的评分标准会被换掉。', okText: '重拟' }))) return;
    try {
      await post(`/homework/${h.id}/rubric/draft`);
      await refresh();
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <Card padded={false}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-5 py-4 text-left sm:px-6">
        <h2 className="shrink-0 text-[16px] font-semibold text-ink">评分标准</h2>
        {drafting ? (
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-[14px] text-brand-ink">
            <Loader2 className="size-4 animate-spin" />
            助教在照知识库拟
          </span>
        ) : r?.items.length ? (
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink-2">
            {r.items.length} 项：{r.items.map((x) => `${x.title.replace(/^.*?[：:]\s*/, '')} ${num(x.points)}`).join('、')}
          </span>
        ) : r?.status === 'error' ? (
          <span className={cn('min-w-0 flex-1 text-[14px]', INK.bad)}>没拟出来</span>
        ) : (
          <span className="min-w-0 flex-1 text-[14px] text-ink-2">还没有</span>
        )}
        <span className="inline-flex shrink-0 items-center gap-1 text-[14px] text-ink-2">
          <span className="max-sm:hidden">{r?.items.length ? (r.source === 'teacher' ? '你改过' : '助教拟的') : ''}</span>
          <ChevronDown className={cn('size-[18px] text-ink-3 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-5 pb-5 pt-4 sm:px-6">
          {editing ? (
            <>
              <ul className="space-y-3">
                {editing.map((x, i) => (
                  <li key={i} className="space-y-2 rounded-lg border border-line p-3">
                    <div className="flex items-center gap-2">
                      <Input value={x.title} placeholder="这一项是什么" maxLength={80} onChange={(e) => setEditing(editing.map((y, k) => (k === i ? { ...y, title: e.target.value } : y)))} />
                      <Input
                        type="number"
                        min={0.5}
                        step="0.5"
                        className="w-24 shrink-0 text-right"
                        value={String(x.points)}
                        onChange={(e) => setEditing(editing.map((y, k) => (k === i ? { ...y, points: Number(e.target.value) } : y)))}
                      />
                      <span className="shrink-0 text-[14px] text-ink-2">分</span>
                      <IconButton label="删掉这一项" size="sm" disabled={editing.length <= 1} onClick={() => setEditing(editing.filter((_, k) => k !== i))}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                    <Textarea autoGrow maxRows={8} placeholder="怎么给分" value={x.criteria} onChange={(e) => setEditing(editing.map((y, k) => (k === i ? { ...y, criteria: e.target.value } : y)))} />
                    <Textarea
                      autoGrow
                      maxRows={10}
                      placeholder="参考答案"
                      className="font-mono text-[14px]"
                      value={x.answer}
                      onChange={(e) => setEditing(editing.map((y, k) => (k === i ? { ...y, answer: e.target.value } : y)))}
                    />
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing([...editing, blank()])}>
                  加一项
                </Button>
                <span className={cn('text-[14px]', Math.abs(sum - h.points) > 0.01 ? INK.bad : 'text-ink-2')}>
                  加起来 {num(sum)} 分，满分 {num(h.points)} 分
                </span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => (setEditing(null), setError(''))}>
                    取消
                  </Button>
                  <Button size="sm" variant="primary" loading={busy} onClick={save}>
                    保存
                  </Button>
                </div>
              </div>
              {error && (
                <p role="alert" className={cn('text-[14px]', INK.bad)}>
                  {error}
                </p>
              )}
            </>
          ) : (
            <>
              {r?.status === 'error' && <p className={cn('rounded-lg px-3.5 py-2.5 text-[14px]', CHIP.bad)}>{r.error || '没拟出来'}</p>}
              {r?.items.length ? (
                <ol className="grid gap-3 lg:grid-cols-2">
                  {r.items.map((x, i) => (
                    <li key={i} className="rounded-lg bg-surface-2 px-4 py-3">
                      <div className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 text-[15px] font-medium text-ink">
                          {i + 1}. {x.title}
                        </span>
                        <span className="shrink-0 text-[14px] font-semibold tabular-nums text-brand-ink">{num(x.points)} 分</span>
                      </div>
                      {x.criteria && <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{x.criteria}</p>}
                      {x.answer && (
                        <details className="mt-2">
                          <summary className="cursor-pointer select-none text-[14px] text-ink-2 hover:text-ink">参考答案</summary>
                          <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-md bg-surface px-3 py-2 font-mono text-[13px] leading-relaxed text-ink">{x.answer}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                !drafting && <p className="text-[14px] text-ink-2">还没有评分标准</p>
              )}
              {!h.archived && !drafting && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setEditing(r?.items.length ? r.items.map((x) => ({ ...x })) : [{ ...blank(), points: h.points }])}>
                    {r?.items.length ? '改' : '自己写'}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Sparkles className="size-4" />} onClick={redraft}>
                    {r?.items.length ? '让助教重拟' : '让助教拟'}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------------- 助教批改那一条（老师的学生作业上方） ---------------- */

type Student = NonNullable<HomeworkDetail['students']>[number];
const isIn = (s: Student) => !!s.status && s.status !== 'todo' && s.status !== 'missing';

/** 分数分成五段，一段一根竖条：不到 60 的红，别的用主色。批改进行中条会一根根长起来 */
export function Spread({ scores, points, className }: { scores: number[]; points: number; className?: string }) {
  const edges = [0.6, 0.7, 0.8, 0.9];
  const labels = ['<60', '60+', '70+', '80+', '90+'];
  const counts = [0, 0, 0, 0, 0];
  for (const s of scores) {
    const r = points ? s / points : 0;
    counts[edges.filter((e) => r >= e).length]++;
  }
  const max = Math.max(1, ...counts);
  return (
    <div className={cn('flex items-end gap-1.5', className)} aria-label="分数分布">
      {counts.map((n, i) => (
        <div key={i} className="flex w-9 flex-col items-center gap-1" title={`${labels[i]}：${n} 人`}>
          <span className="text-[13px] font-medium tabular-nums text-ink-2">{n}</span>
          <div className="flex h-12 w-full items-end">
            <div
              className={cn('w-full rounded-t-[3px] transition-[height] duration-700', i === 0 ? 'bg-[#ef4444]/80' : 'bg-brand/80')}
              style={{ height: `${n ? Math.max(6, (n / max) * 100) : 2}%` }}
            />
          </div>
          <span className="text-[13px] tabular-nums text-ink-3">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 助教这边做到哪了：在批的时候一根进度条，批好一份长一截；批好了写平均分，旁边一组小竖条看分数怎么分布。
 * 按钮：让助教批、发给学生（看过再发的）、讲评。
 */
export function AiBar({ h, onReview }: { h: HomeworkDetail; onReview: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'grade' | 'release' | null>(null);
  const all = (h.students || []).filter((s) => s.joined && isIn(s));
  const byAi = all.filter((s) => s.score !== null && s.gradedBy === 'ai').length;
  const byTeacher = all.filter((s) => s.score !== null && s.gradedBy === 'teacher').length;
  const flagged = all.filter((s) => s.score === null && s.ai?.status === 'done' && s.ai.flag).length;
  const drafts = all.filter((s) => s.score === null && s.ai?.status === 'done' && !s.ai.flag && !s.ai.released).length;
  const failed = all.filter((s) => s.score === null && s.ai?.status === 'error').length;
  const waiting = all.filter((s) => s.score === null && s.status !== 'returned' && (!s.ai || s.ai.status === 'error')).length;
  const running = h.grading || 0;
  const gradedList = all.filter((s) => s.score !== null);
  const graded = gradedList.length;
  // 还没有批过的、也没在批的：这一条不显示
  if (!running && !graded && !drafts && !flagged && !failed && !(waiting && h.aiMode !== 'off')) return null;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['homework'] });
    qc.invalidateQueries({ queryKey: ['classes'] });
  };
  const grade = async () => {
    setBusy('grade');
    try {
      const r = await post<{ queued: number }>(`/homework/${h.id}/ai-grade`, {});
      await refresh();
      toast.success(r.queued ? `助教开始批这 ${r.queued} 份` : '没有要批的');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  const release = async () => {
    setBusy('release');
    try {
      const r = await post<{ released: number }>(`/homework/${h.id}/ai-release`, {});
      await refresh();
      toast.success(`发给了 ${r.released} 个学生`);
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  const avg = graded ? gradedList.reduce((n, s) => n + (s.score || 0), 0) / graded : null;
  const done = graded + drafts + flagged + failed;
  const headline = running
    ? `助教在批，批好 ${done} 份，还剩 ${running} 份`
    : graded
      ? `${byAi ? `助教批好 ${byAi} 份` : ''}${byAi && byTeacher ? '，' : ''}${byTeacher ? `你批了 ${byTeacher} 份` : ''}，平均 ${num(avg!)} 分`
      : drafts || flagged
        ? `助教批好 ${drafts + flagged} 份，还没发给学生`
        : `交上来 ${waiting} 份，还没批`;
  // 拿不准的下面单独有一栏「这几份助教拿不准，等你看一眼」，这里不再说一遍
  const sub = [drafts && `${drafts} 份等你看过再发`, failed && `${failed} 份没批成`].filter(Boolean).join('，');
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line bg-brand-soft/40 px-5 py-4 sm:px-6">
      <AgentAvatar agent={TA} size={44} status={running ? 'running' : null} />
      <div className="min-w-[200px] flex-1">
        <p className="text-[16px] font-semibold text-ink">{headline}</p>
        {running ? (
          <div className="mt-2 h-2 max-w-sm overflow-hidden rounded-full bg-surface">
            <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.round((done / Math.max(1, done + running)) * 100)}%` }} />
          </div>
        ) : (
          sub && <p className={cn('mt-0.5 text-[14px]', failed ? INK.warn : 'text-ink-2')}>{sub}</p>
        )}
      </div>
      {graded >= 3 && <Spread scores={gradedList.map((s) => s.score!)} points={h.points} className="max-sm:w-full max-sm:justify-center" />}
      <div className="flex flex-wrap gap-2 max-sm:order-last">
        {waiting > 0 && !running && !h.archived && h.aiMode !== 'off' && (
          <Button size="sm" variant="soft" icon={<Sparkles className="size-4" />} loading={busy === 'grade'} onClick={grade}>
            让助教批这 {waiting} 份
          </Button>
        )}
        {drafts > 0 && !h.archived && (
          <Button size="sm" variant="primary" loading={busy === 'release'} onClick={release}>
            发给学生
          </Button>
        )}
        {graded > 0 && (
          <Button size="sm" icon={<FileText className="size-4" />} onClick={onReview}>
            讲评
          </Button>
        )}
      </div>
    </div>
  );
}

/** 学生那一格右边：分数（不到六成红的）、助教在批、等你看、助教拟的分、没批成、等你批 */
export function AiCell({ s, points }: { s: Student; points: number }) {
  if (s.score !== null && s.status === 'graded')
    return (
      <span className="shrink-0 text-right leading-none">
        <span className={cn('text-[24px] font-semibold tabular-nums', s.score / points < 0.6 ? INK.bad : 'text-ink')}>{num(s.score)}</span>
        {s.gradedBy === 'teacher' && <span className="mt-1 block text-[13px] text-ink-2">你批的</span>}
      </span>
    );
  const ai = s.ai;
  const chip = (tone: string, children: React.ReactNode) => <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px]', tone)}>{children}</span>;
  if (s.status === 'returned') return chip(CHIP.warn, '退回重交');
  if (s.status === 'missing') return chip(CHIP.bad, '没交');
  if (s.status === 'todo') return chip(CHIP.gray, '还没交');
  if (ai && (ai.status === 'queued' || ai.status === 'running'))
    return chip(
      CHIP.brand,
      <>
        <Loader2 className="size-3.5 animate-spin" />
        在批
      </>,
    );
  if (ai && ai.status === 'done') return ai.flag ? chip(CHIP.warn, '等你看') : chip(CHIP.brand, `助教拟 ${ai.score === null ? '—' : num(ai.score)}`);
  if (ai && ai.status === 'error') return chip(CHIP.bad, '没批成');
  if (s.status === 'submitted' || s.status === 'late') return chip(CHIP.info, '等你批');
  return null;
}

/* ---------------- 同样的问题一起改 ---------------- */

export interface SameAsk {
  item: number;
  title: string;
  from: number;
  to: number;
  max: number;
  students: { sid: number; name: string; got: number; max: number; why: string }[];
}

/** 老师改了一项：同一项助教给了一样分的其他学生，勾着一起改 */
export function SameDialog({ hwId, ask, onClose }: { hwId: number; ask: SameAsk | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<number[] | null>(null),
    [busy, setBusy] = useState(false);
  const chosen = picked ?? ask?.students.map((s) => s.sid) ?? [];
  const apply = async () => {
    if (!ask || !chosen.length) return;
    setBusy(true);
    try {
      const r = await post<{ changed: number }>(`/homework/${hwId}/same`, { item: ask.item, got: ask.to, sids: chosen });
      await qc.invalidateQueries({ queryKey: ['homework'] });
      toast.success(`又改了 ${r.changed} 份`);
      setPicked(null);
      onClose();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!ask}
      onClose={() => (setPicked(null), onClose())}
      width={520}
      title={ask ? `「${ask.title}」助教也给了这几份 ${num(ask.from)} 分` : ''}
      desc={ask ? `一起改成 ${num(ask.to)} 分？` : ''}
      footer={
        <>
          <Button disabled={busy} onClick={() => (setPicked(null), onClose())}>
            不用
          </Button>
          <Button variant="primary" loading={busy} disabled={!chosen.length} onClick={apply}>
            一起改（{chosen.length}）
          </Button>
        </>
      }
    >
      <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto pb-2">
        {ask?.students.map((s) => (
          <li key={s.sid}>
            <label className="flex cursor-pointer gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-[var(--c-primary)]"
                checked={chosen.includes(s.sid)}
                onChange={(e) => setPicked(e.target.checked ? [...chosen, s.sid] : chosen.filter((x) => x !== s.sid))}
              />
              <span className="min-w-0">
                <span className="text-[15px] font-medium text-ink">{s.name}</span>
                {s.why && <span className="mt-0.5 block text-[14px] leading-relaxed text-ink-2">{s.why}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

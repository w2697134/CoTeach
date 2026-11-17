import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, MonitorUp, Plus, Send, Shuffle, UserRound, X } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { Avatar, Button, IconButton, Popover, Tabs, cn } from '../../components/ui';
import { QTYPE_NAME, type Deck, type Question } from '../prep/data';
import { Bars } from './Bars';
import { isChoice, letter, optionText, percent, type Pushed, type TeacherState } from './data';
import { CHIP, INK } from '../classes/tone';

type Tab = 'practice' | 'asks';

interface Item {
  key: string;
  label: string;
  q: Question;
  source: string | null;
  pushed: Pushed | null;
}

/**
 * 上课页右边一栏（手机上在课件下面）：到了几个人、随机点名；课堂练习一道一道（推送、实时看作答、公布答案、投到大屏），
 * 当堂出的题和课件上推的小测接在后面；学生的提问一条条进来。
 */
export function Panel({
  deck,
  practice,
  state,
  screen,
  busy,
  onPush,
  onNew,
  onReveal,
  onScreen,
  onCall,
  className,
}: {
  deck: Deck | null;
  practice: Question[];
  state: TeacherState;
  screen: number | null;
  /** 正在办的那件事（按钮转圈）：'push:来源'、'reveal:题号'、'call' */
  busy: string | null;
  onPush: (source: string) => void;
  onNew: () => void;
  onReveal: (id: number) => void;
  onScreen: (id: number | null) => void;
  onCall: () => void;
  className?: string;
}) {
  const [tab, setTab] = useState<Tab>('practice');
  // 提问栏没打开时来了新的，标签上点个点
  const [seen, setSeen] = useState(state.asks.length);
  useEffect(() => {
    if (tab === 'asks') setSeen(state.asks.length);
  }, [tab, state.asks.length]);
  const fresh = tab !== 'asks' && state.asks.length > seen;

  const items = useMemo(() => {
    const bySource = new Map(state.questions.filter((p) => p.source).map((p) => [p.source!, p]));
    const own = new Set(practice.map((q) => q.id));
    const list: Item[] = practice.map((q, i) => ({ key: `q-${q.id}`, label: String(i + 1), q, source: q.id, pushed: bySource.get(q.id) ?? null }));
    for (const p of state.questions) {
      if (p.source && own.has(p.source)) continue;
      const at = p.source?.startsWith('slide:') ? (deck?.slides.findIndex((s) => s.id === p.source!.slice(6)) ?? -1) : -1;
      list.push({ key: `p-${p.id}`, label: at >= 0 ? `第 ${at + 1} 页` : '当堂', q: p.q, source: p.source, pushed: p });
    }
    return list;
  }, [practice, state.questions, deck]);

  const here = state.attendance.count;
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center gap-2 px-4 pb-3 pt-3.5">
        <Popover
          width={300}
          align="start"
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className="flex items-center gap-2.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-3">
              {here > 0 ? (
                <span className="flex -space-x-1.5">
                  {state.attendance.people.slice(-3).map((p) => (
                    <Avatar key={p.id} name={p.name.slice(0, 1)} seed={p.name} size={26} ring />
                  ))}
                </span>
              ) : (
                <UserRound className="size-4 text-ink-3" />
              )}
              <span className="whitespace-nowrap text-[15px] text-ink-2">
                到了 <b className="text-[18px] font-semibold tabular-nums text-ink">{here}</b>
                <span className="tabular-nums"> / {state.attendance.total}</span>
              </span>
              <ChevronDown className="size-4 text-ink-3" />
            </button>
          )}
        >
          <div className="max-h-[60vh] overflow-y-auto px-2 py-2">
            <p className="px-1 text-[13px] text-ink-2">到了 {here} 人</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {state.attendance.people.map((p) => (
                <span key={p.id} className={cn('rounded-full px-2 py-0.5 text-[14px]', CHIP.ok)}>
                  {p.name}
                </span>
              ))}
            </div>
            {state.attendance.absent.length > 0 && (
              <>
                <p className="mt-3 px-1 text-[13px] text-ink-2">没来 {state.attendance.absent.length} 人</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {state.attendance.absent.map((n, i) => (
                    <span key={i} className="rounded-full bg-surface-3 px-2 py-0.5 text-[14px] text-ink-2">
                      {n}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </Popover>
        <Button className="ml-auto" variant="soft" icon={<Shuffle className="size-4" />} loading={busy === 'call'} disabled={!here} onClick={onCall}>
          随机点名
        </Button>
      </div>
      <Tabs<Tab>
        className="px-4"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'practice', label: '练习', count: items.length || null },
          {
            value: 'asks',
            label: (
              <span className="relative">
                提问
                {fresh && <span className="absolute -right-2 -top-0.5 size-2 rounded-full bg-bad" />}
              </span>
            ),
            count: state.asks.length || null,
          },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
        {tab === 'practice' ? (
          <div className="space-y-2.5">
            {items.map((it) => (
              <PushCard
                key={it.key}
                it={it}
                here={here}
                onScreen={screen === it.pushed?.id}
                busy={busy}
                onPush={() => it.source && onPush(it.source)}
                onReveal={() => it.pushed && onReveal(it.pushed.id)}
                onToggleScreen={() => it.pushed && onScreen(screen === it.pushed.id ? null : it.pushed.id)}
              />
            ))}
            <button
              type="button"
              onClick={onNew}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-3 text-[14px] text-ink-2 transition-colors hover:border-brand/50 hover:text-brand"
            >
              <Plus className="size-4" />
              出一道题
            </button>
          </div>
        ) : state.asks.length ? (
          <ul className="space-y-2">
            {[...state.asks].reverse().map((a) => (
              <li key={a.id} className="flex gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5">
                <Avatar name={a.name} seed={a.name} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13px] text-ink-3">
                    <span className="font-medium text-ink-2">{a.name}</span>
                    {clock(a.at)}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{a.text}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center py-10 text-center">
            <img src="/illustrations/entry-qa-v2.webp" alt="" className="w-28 opacity-90" draggable={false} />
            <p className="mt-2 text-[14px] text-ink-2">还没人提问</p>
          </div>
        )}
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 一道题一张卡片：没推的有「推送」；推了的实时写几个人答、几个人对，选择题出条形图，能公布答案、投到大屏 */
function PushCard({
  it,
  here,
  onScreen,
  busy,
  onPush,
  onReveal,
  onToggleScreen,
}: {
  it: Item;
  here: number;
  onScreen: boolean;
  busy: string | null;
  onPush: () => void;
  onReveal: () => void;
  onToggleScreen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(false);
  const p = it.pushed;
  const q = it.q;
  const right = new Set(q.choice ?? []);
  // 刚推出去的那一张自动展开一次，看得到条形图
  const was = useRef(!!p);
  useEffect(() => {
    if (p && !was.current) setOpen(true);
    was.current = !!p;
  }, [p]);
  return (
    <div
      className={cn(
        'rounded-xl border bg-surface px-3.5 py-3 transition-colors',
        onScreen ? 'border-brand ring-2 ring-brand/15' : p?.status === 'open' ? 'border-brand/40' : 'border-line',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-6 shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-center text-[13px] font-semibold text-ink-2">{it.label}</span>
        <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[13px] font-medium text-brand-ink">{QTYPE_NAME[q.type]}</span>
        {p?.status === 'open' && (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-ink">
            <span className="size-2 animate-pulse rounded-full bg-brand" />
            在答
          </span>
        )}
        {p?.status === 'revealed' && <span className={cn('text-[13px] font-medium', INK.ok)}>公布了</span>}
        <div className="ml-auto flex items-center gap-1">
          {p ? (
            <IconButton size="sm" label={onScreen ? '回到课件' : '投到大屏'} active={onScreen} onClick={onToggleScreen}>
              {onScreen ? <X className="size-4" /> : <MonitorUp className="size-4" />}
            </IconButton>
          ) : (
            <Button size="xs" variant="primary" icon={<Send className="size-3.5" />} loading={busy === `push:${it.source}`} onClick={onPush}>
              推送
            </Button>
          )}
        </div>
      </div>
      <button type="button" onClick={() => setOpen(!open)} className="mt-2 block w-full text-left">
        <div className={cn('text-ink', !open && 'line-clamp-2')}>
          <Markdown compact className="text-[15px]! leading-relaxed!">
            {q.stem}
          </Markdown>
        </div>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {q.code && <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] leading-relaxed text-ink">{q.code}</pre>}
          {!p && isChoice(q.type) && (
            <ul className="space-y-1">
              {q.options?.map((o, i) => (
                <li key={i} className={cn('flex items-start gap-2 rounded-lg px-2 py-1 text-[14px]', right.has(i) ? 'bg-ok-soft text-ink' : 'text-ink-2')}>
                  <b className={right.has(i) ? INK.ok : 'text-ink-3'}>{letter(i)}</b>
                  <span className="min-w-0 flex-1">{optionText(o, letter(i))}</span>
                  {right.has(i) && <Check className={cn('mt-0.5 size-4 shrink-0', INK.ok)} />}
                </li>
              ))}
            </ul>
          )}
          {!isChoice(q.type) && q.answer && (
            <p className="rounded-lg bg-ok-soft px-2.5 py-1.5 text-[14px] text-ink">
              <span className={cn('mr-1.5 font-medium', INK.ok)}>答案</span>
              {q.answer}
            </p>
          )}
        </div>
      )}
      {p && (
        <div className="mt-2.5 space-y-2.5">
          <div className="flex items-center gap-3 text-[14px] text-ink-2">
            <span>
              答了 <b className="text-[16px] tabular-nums text-ink">{p.answered}</b>
              <span className="tabular-nums"> / {here}</span>
            </span>
            {p.correct !== null && (
              <span>
                答对 <b className={cn('text-[16px] tabular-nums', INK.ok)}>{p.correct}</b>
                {p.answered > 0 && <span className="ml-1 tabular-nums">（{percent(p.correct / p.answered)}）</span>}
              </span>
            )}
          </div>
          {p.bars && p.bars.length > 0 && (open || isChoice(q.type) || q.type === 'judge') && <Bars bars={p.bars} answered={p.answered} mark />}
          {p.answers.length > 0 && (
            <div>
              <button type="button" className="inline-flex items-center gap-1 text-[14px] text-brand-ink hover:underline" onClick={() => setList(!list)}>
                <ChevronDown className={cn('size-4 transition-transform', list && 'rotate-180')} />
                {list ? '收起' : `谁答了什么（${p.answers.length}）`}
              </button>
              {list && (
                <ul className="mt-1.5 max-h-64 space-y-1 overflow-y-auto">
                  {p.answers.map((a, i) => (
                    <li key={i} className="flex items-start gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[14px]">
                      <span className="w-14 shrink-0 truncate text-ink-2">{a.name}</span>
                      <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', q.type === 'code' && 'font-mono text-[13px]')}>{a.text}</span>
                      {a.correct === true && <Check className={cn('mt-0.5 size-4 shrink-0', INK.ok)} />}
                      {a.correct === false && <X className={cn('mt-0.5 size-4 shrink-0', INK.bad)} />}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {p.status === 'open' && (
            <Button size="sm" variant="secondary" block icon={<Eye className="size-4" />} loading={busy === `reveal:${p.id}`} onClick={onReveal}>
              公布答案
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

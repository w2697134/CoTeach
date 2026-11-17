import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, MoreHorizontal, Trash2 } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { del } from '../../lib/api';
import { toast } from '../../lib/store';
import { Avatar, Card, IconButton, MenuItem, Popover, cn, useConfirm } from '../../components/ui';
import { QTYPE_NAME } from '../prep/data';
import { ThemeBanner, themeOf } from '../classes/look';
import { CHIP, INK } from '../classes/tone';
import { Bars } from './Bars';
import { isChoice, lasted, optionText, percent, useLectureState, type LectureDetail, type Pushed, type SummaryQuestion } from './data';

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`;
};

/** 这堂课一句话说完：来了几个、推了几道、答对多少、点了谁、有没有人问 */
function oneLine(s: NonNullable<LectureDetail['summary']>) {
  const parts = [`${s.classSize} 人来了 ${s.attended} 个`];
  if (s.questions.length) parts.push(`推了 ${s.questions.length} 道题${s.rate !== null ? `，答对 ${percent(s.rate)}` : ''}`);
  else parts.push('没推题');
  if (s.calls.length) parts.push(`点了${s.calls.map((c) => c.name).slice(0, 3).join('、')}`);
  parts.push(s.asks.length ? `学生问了 ${s.asks.length} 个问题` : '没人提问');
  return parts.join(' · ');
}

/**
 * 下课小结（程序算的，下课时存下）：横幅上一句话说完这堂课；左边是课上推的每道题（每个选项写原文、几个人选、哪个对、解析），
 * 学生课上问的；右边是来了谁、没来谁、点到谁。
 */
export function SummaryView({ d }: { d: LectureDetail }) {
  const s = d.summary;
  const l = d.lecture;
  const theme = themeOf(l.classId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  // 来了谁、每道题谁答了什么：课堂的现场记录（下了课不再刷新）
  const state = useLectureState(l.id, true).data;
  const remove = async () => {
    if (!(await confirm({ title: `删掉「${l.title}」这堂课的记录？`, okText: '删掉', danger: true }))) return;
    try {
      await del(`/classroom/${l.id}`);
      qc.invalidateQueries({ queryKey: ['lectures'] });
      navigate('/classroom');
    } catch (e) {
      toast.fromError(e);
    }
  };
  const pushed = new Map((state?.questions || []).map((p) => [p.n, p]));
  const explainOf = (q: SummaryQuestion) => pushed.get(q.n)?.q.explain || d.practice.find((x) => x.stem === q.stem)?.explain || '';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1120px] space-y-5 px-1 pb-10 pt-1 sm:px-3">
        <ThemeBanner theme={theme} className="rounded-2xl">
          <div className="flex items-start gap-3 px-5 py-6 sm:px-8 sm:py-7">
            <div className="min-w-0 flex-1 pr-2 sm:pr-40">
              <p className="text-[14px] text-white/90">
                {l.className} · {day(l.startedAt)} {hm(l.startedAt)}–{l.endedAt ? hm(l.endedAt) : ''} · {s ? lasted(0, s.minutes * 60_000) : lasted(l.startedAt, l.endedAt ?? l.startedAt)}
              </p>
              <h1 className="mt-1.5 text-balance text-[24px] font-semibold leading-snug [text-shadow:0_1px_2px_rgba(15,23,42,.18)]">{l.title}</h1>
              {s && <p className="mt-3 text-[15px] leading-relaxed text-white">{oneLine(s)}</p>}
            </div>
            <Popover
              width={160}
              trigger={({ toggle }) => (
                <IconButton label="更多" onClick={toggle} className="-mr-1 rounded-full bg-white/85 text-[#334155] shadow-xs hover:bg-white">
                  <MoreHorizontal className="size-5" />
                </IconButton>
              )}
            >
              {(close) => (
                <MenuItem icon={<Trash2 />} danger onClick={() => (close(), remove())}>
                  删掉这堂课的记录
                </MenuItem>
              )}
            </Popover>
          </div>
        </ThemeBanner>

        {s && (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-5">
              {s.questions.length > 0 ? (
                s.questions.map((q) => <QuestionCard key={q.id} q={q} p={pushed.get(q.n)} explain={explainOf(q)} />)
              ) : (
                <Card className="py-8 text-center text-[15px] text-ink-2">这堂课没推题</Card>
              )}
              <Card padded={false}>
                <h2 className="px-5 pb-1 pt-4 text-[16px] font-semibold text-ink sm:px-6">学生课上问的</h2>
                {s.asks.length ? (
                  <ul className="space-y-3 px-5 pb-5 pt-2 sm:px-6">
                    {s.asks.map((a, i) => (
                      <li key={i} className="flex gap-3">
                        <Avatar name={a.name} seed={a.name} size={32} />
                        <div className="min-w-0">
                          <p className="text-[13px] text-ink-3">
                            <span className="mr-2 font-medium text-ink-2">{a.name}</span>
                            {hm(a.at)}
                          </p>
                          <p className="mt-1 w-fit max-w-[44em] whitespace-pre-wrap break-words rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2 text-[15px] leading-relaxed text-ink">{a.text}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 pb-5 text-[15px] text-ink-2 sm:px-6">没人提问</p>
                )}
              </Card>
            </div>
            <div className="space-y-5">
              <Card padded={false} className="px-5 py-4">
                <h2 className="text-[16px] font-semibold text-ink">
                  来了 {s.attended} 人<span className="ml-1.5 text-[14px] font-normal text-ink-2">/ {s.classSize}</span>
                </h2>
                {state?.attendance.people.length ? (
                  <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5">
                    {state.attendance.people.map((p) => (
                      <li key={p.id} className="flex min-w-0 items-center gap-2">
                        <Avatar name={p.name} seed={p.name} size={28} />
                        <span className="truncate text-[14px] text-ink">{p.name}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  !s.attended && <p className="mt-2 text-[14px] text-ink-2">没人进课堂</p>
                )}
              </Card>
              {s.calls.length > 0 && (
                <Card padded={false} className="px-5 py-4">
                  <h2 className="text-[16px] font-semibold text-ink">点到的</h2>
                  <ul className="mt-2.5 space-y-2">
                    {s.calls.map((c, i) => (
                      <li key={i} className="flex items-center gap-2 text-[14px] text-ink">
                        <Avatar name={c.name} seed={c.name} size={28} />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="text-[13px] text-ink-3">{hm(c.at)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {s.absent.length > 0 && <Absent names={s.absent} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 没来的：先露一部分名字，多的点开 */
function Absent({ names }: { names: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? names : names.slice(0, 12);
  return (
    <Card padded={false} className="px-5 py-4">
      <h2 className="text-[16px] font-semibold text-ink">
        没来 {names.length} 人
      </h2>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {shown.map((n, i) => (
          <span key={i} className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[14px] text-ink-2">
            {n}
          </span>
        ))}
      </div>
      {names.length > shown.length || all ? (
        <button type="button" onClick={() => setAll(!all)} className="mt-2.5 inline-flex items-center gap-1 text-[14px] font-medium text-brand-ink hover:underline">
          <ChevronDown className={cn('size-4 transition-transform', all && 'rotate-180')} />
          {all ? '收起' : `还有 ${names.length - shown.length} 人`}
        </button>
      ) : null}
    </Card>
  );
}

/** 一道题一张卡片：题目、每个选项（原文、几个人选、哪个对）、答对几个、错得最多的那个、解析；不判对错的题摆几份学生的回答 */
function QuestionCard({ q, p, explain }: { q: SummaryQuestion; p: Pushed | undefined; explain: string }) {
  const judged = q.correct !== null;
  const choice = q.bars && (isChoice(q.type) || q.type === 'judge') && q.answered > 0;
  const answers = !choice && p ? p.answers.slice(0, 6) : [];
  return (
    <Card padded={false} className="px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold text-ink">第 {q.n} 题</span>
        <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[13px] font-medium text-brand-ink">{QTYPE_NAME[q.type]}</span>
        <span className="ml-auto text-[14px] text-ink-2">
          {judged ? (
            <>
              答对 <b className={cn('text-[18px] font-semibold tabular-nums', q.rate !== null && q.rate < 0.6 ? INK.bad : INK.ok)}>{q.correct}</b> / {q.answered}
              {q.rate !== null && <span className="ml-1">（{percent(q.rate)}）</span>}
            </>
          ) : (
            <>
              <b className="text-[18px] font-semibold tabular-nums text-ink">{q.answered}</b> 份回答
            </>
          )}
        </span>
      </div>
      <div className="mt-2.5 max-w-[44em] text-ink">
        <Markdown compact className="text-[16px]! leading-relaxed!">
          {q.stem}
        </Markdown>
      </div>
      {choice && <Bars className="mt-4 max-w-xl" bars={q.bars!} answered={q.answered} mark withText />}
      {q.wrong && (
        <p className={cn('mt-4 w-fit max-w-full rounded-lg px-3.5 py-2 text-[14px]', CHIP.bad)}>
          错得最多：<b className="font-semibold">{q.wrong.option ? optionText(q.wrong.option, q.wrong.text) : q.wrong.text}</b>
          {q.wrong.option && <span className="ml-1">（{q.wrong.text}）</span>}，{q.wrong.count} 人
        </p>
      )}
      {answers.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {answers.map((a, i) => (
            <li key={i} className="flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2 text-[14px]">
              <span className="w-14 shrink-0 truncate text-ink-2">{a.name}</span>
              <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words text-ink', q.type === 'code' && 'font-mono text-[13px]')}>{a.text}</span>
            </li>
          ))}
        </ul>
      )}
      {explain && (
        <p className="mt-4 max-w-[44em] border-l-[3px] border-line-strong pl-3.5 text-[15px] leading-relaxed text-ink-2">
          <span className="mr-1.5 font-medium text-ink">解析</span>
          {explain}
        </p>
      )}
    </Card>
  );
}

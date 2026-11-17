import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { MessageCircleQuestion, MoreHorizontal, Trash2 } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { del } from '../../lib/api';
import { toast } from '../../lib/store';
import { Avatar, Card, IconButton, MenuItem, Popover, cn, useConfirm } from '../../components/ui';
import { QTYPE_NAME } from '../prep/data';
import { themeBackground, themeOf } from '../classes/look';
import { Bars } from './Bars';
import { isChoice, lasted, optionText, percent, type LectureDetail, type SummaryQuestion } from './data';

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`;
};

/**
 * 下课小结（程序算的，下课时存下）：到课、推了几道题、正确率、学生提了几个问题；每道题答对几个、错得最多的选项；
 * 学生提的问题、没来的人、点到的人。
 */
export function SummaryView({ d }: { d: LectureDetail }) {
  const s = d.summary;
  const l = d.lecture;
  const theme = themeOf(l.classId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
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
  const tiles = [
    { label: '到课', value: s ? `${s.attended}` : '—', unit: s ? `/ ${s.classSize}` : '' },
    { label: '推题', value: s ? `${s.questions.length}` : '—', unit: '道' },
    { label: '正确率', value: percent(s?.rate), unit: '' },
    { label: '提问', value: s ? `${s.asks.length}` : '—', unit: '条' },
  ];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1000px] space-y-5 px-1 pb-10 pt-1 sm:px-3">
        <div className="relative overflow-hidden rounded-2xl px-5 py-5 text-white sm:px-7 sm:py-6" style={themeBackground(theme)}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-white/80">
                {l.className} · {day(l.startedAt)} {hm(l.startedAt)}–{l.endedAt ? hm(l.endedAt) : ''} · {s ? lasted(0, s.minutes * 60_000) : lasted(l.startedAt, l.endedAt ?? l.startedAt)}
              </p>
              <h1 className="mt-1 text-[22px] font-semibold leading-snug sm:text-[24px]">{l.title}</h1>
            </div>
            <Popover
              width={160}
              trigger={({ toggle }) => (
                <IconButton label="更多" onClick={toggle} className="-mr-1 text-white/85 hover:bg-white/15 hover:text-white">
                  <MoreHorizontal className="size-5" />
                </IconButton>
              )}
            >
              {(close) => (
                <MenuItem icon={<Trash2 />} danger onClick={() => (close(), remove())}>
                  删掉
                </MenuItem>
              )}
            </Popover>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="rounded-xl bg-white/15 px-3.5 py-2.5 backdrop-blur-[2px]">
                <p className="text-[12.5px] text-white/80">{t.label}</p>
                <p className="mt-0.5 text-[24px] font-semibold leading-tight tabular-nums">
                  {t.value}
                  {t.unit && <span className="ml-1 text-[13px] font-normal text-white/80">{t.unit}</span>}
                </p>
              </div>
            ))}
          </div>
        </div>

        {s && s.questions.length > 0 && (
          <Card padded={false}>
            <h2 className="px-5 pb-1 pt-4 text-[16px] font-semibold text-ink sm:px-6">每道题</h2>
            <ul>
              {s.questions.map((q) => (
                <QuestionRow key={q.id} q={q} />
              ))}
            </ul>
          </Card>
        )}

        {s && (
          <Card padded={false}>
            <h2 className="flex items-center gap-2 px-5 pb-2 pt-4 text-[16px] font-semibold text-ink sm:px-6">
              学生的提问
              {s.asks.length > 0 && <span className="text-[13px] font-normal text-ink-3">{s.asks.length}</span>}
            </h2>
            {s.asks.length ? (
              <ul className="pb-2">
                {s.asks.map((a, i) => (
                  <li key={i} className="flex gap-3 border-t border-line px-5 py-3 first:border-0 sm:px-6">
                    <Avatar name={a.name} seed={a.name} size={30} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] text-ink-3">
                        <span className="mr-2 font-medium text-ink-2">{a.name}</span>
                        {hm(a.at)}
                      </p>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-ink">{a.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-5 pb-5 text-[14px] text-ink-3 sm:px-6">
                <MessageCircleQuestion className="size-4" />
                没有人提问
              </p>
            )}
          </Card>
        )}

        {s && (s.absent.length > 0 || s.calls.length > 0) && (
          <div className="grid gap-5 md:grid-cols-2">
            {s.absent.length > 0 && <Names title="没来" names={s.absent} />}
            {s.calls.length > 0 && <Names title="点到的" names={s.calls.map((c) => c.name)} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Names({ title, names }: { title: string; names: string[] }) {
  return (
    <Card padded={false} className="px-5 py-4 sm:px-6">
      <h2 className="text-[16px] font-semibold text-ink">
        {title}
        <span className="ml-2 text-[13px] font-normal text-ink-3">{names.length}</span>
      </h2>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {names.map((n, i) => (
          <span key={i} className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[13.5px] text-ink-2">
            {n}
          </span>
        ))}
      </div>
    </Card>
  );
}

/** 一道题一行：题目，答对几个、正确率，错得最多的那个；选择、判断题带每个选项几个人 */
function QuestionRow({ q }: { q: SummaryQuestion }) {
  const judged = q.correct !== null;
  return (
    <li className="border-t border-line px-5 py-4 first:border-0 sm:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-ink">第 {q.n} 题</span>
            <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[12px] font-medium text-brand-ink">{QTYPE_NAME[q.type]}</span>
          </div>
          <div className="mt-1.5 line-clamp-3 text-ink-2">
            <Markdown compact className="text-[14px]! leading-relaxed!">
              {q.stem}
            </Markdown>
          </div>
          {q.bars && (isChoice(q.type) || q.type === 'judge') && q.answered > 0 && <Bars className="mt-3 max-w-md" bars={q.bars} answered={q.answered} mark />}
        </div>
        <div className="flex shrink-0 flex-row flex-wrap items-start gap-x-6 gap-y-2 md:w-56 md:flex-col md:gap-y-2.5">
          {judged ? (
            <div>
              <p className={cn('text-[26px] font-semibold leading-none tabular-nums', q.rate === null ? 'text-ink-3' : q.rate >= 0.6 ? 'text-ok' : 'text-bad')}>{percent(q.rate)}</p>
              <p className="mt-1 text-[12.5px] text-ink-3">
                答对 {q.correct} / {q.answered}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-[26px] font-semibold leading-none tabular-nums text-ink">{q.answered}</p>
              <p className="mt-1 text-[12.5px] text-ink-3">份作答</p>
            </div>
          )}
          {q.wrong && (
            <div className="min-w-0 rounded-lg bg-bad-soft px-3 py-2">
              <p className="text-[12px] text-bad">错得最多</p>
              <p className="mt-0.5 truncate text-[14px] text-ink">
                <b>{q.wrong.text}</b>
                {q.wrong.option && <span className="ml-1.5 text-ink-2">{optionText(q.wrong.option, q.wrong.text)}</span>}
                <span className="ml-1.5 text-[12.5px] text-ink-3">{q.wrong.count} 人</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

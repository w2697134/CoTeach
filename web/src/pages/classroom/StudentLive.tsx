import { useState } from 'react';
import { useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, X } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { Markdown } from '../../components/Markdown';
import { post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, ErrorState, Input, PageLoading, Textarea, cn } from '../../components/ui';
import { QTYPE_NAME } from '../prep/data';
import { SlideThumb } from '../prep/Slides';
import { teacherTitle } from '../cot/data';
import { themeBackground, themeOf } from '../classes/look';
import { CHIP, INK } from '../classes/tone';
import { Bars } from './Bars';
import { isChoice, lasted, letter, optionText, useStudentLecture, type StudentQuestion, type StudentState } from './data';

/**
 * 学生上课（/live/:id，手机上用）：打开就算到课。老师推的题出现在最上面，点选项或者写答案交上去；
 * 老师公布答案后看到对错、答案和解析、全班答得怎么样。下面是老师正放的那页课件；最底下一行能问老师一句。
 */
export function StudentLivePage() {
  const id = Number(useParams().id);
  const q = useStudentLecture(id);
  const s = q.data;
  useCrumbs([{ label: 'CoT 学伴', to: '/cot' }, { label: s ? s.title : null }]);
  if (q.isError && !s) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!s) return <PageLoading />;
  return <Room s={s} />;
}

function Room({ s }: { s: StudentState }) {
  const live = s.status === 'live';
  const theme = themeOf(s.classId);
  // 新推的在上面
  const questions = [...s.questions].reverse();
  const done = s.questions.filter((x) => x.mine);
  const right = done.filter((x) => x.correct === true).length;
  return (
    <div className="mx-auto w-full max-w-[680px] space-y-4 pb-28">
      <div className="relative overflow-hidden rounded-2xl px-5 py-4 text-white shadow-sm" style={themeBackground(theme)}>
        <div className="flex items-center gap-2 text-[13px] text-white/85">
          {live ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2 py-0.5 font-medium text-white">
              <span className="size-1.5 animate-pulse rounded-full bg-[#ff5d6c]" />
              上课中
            </span>
          ) : (
            <span className="rounded-full bg-white/20 px-2 py-0.5 font-medium text-white">已下课</span>
          )}
          <span className="truncate">
            {teacherTitle(s.teacher)} · {s.className}
          </span>
        </div>
        <h1 className="mt-2 text-[18px] font-semibold leading-snug">{s.title}</h1>
        {!live && (
          <p className="mt-1.5 text-[14px] text-white/85">
            {s.endedAt ? `上了 ${lasted(s.startedAt, s.endedAt)}` : ''}
            {s.questions.length > 0 && ` · 答了 ${done.length} 道`}
            {done.some((x) => x.correct !== undefined && x.correct !== null) && `，对了 ${right} 道`}
          </p>
        )}
      </div>

      {questions.map((x) => (
        <QuestionCard key={x.id} lectureId={s.id} x={x} live={live} />
      ))}

      {s.slide && (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xs">
          <div className="aspect-video">
            <SlideThumb slide={s.slide} theme={s.theme ?? undefined} />
          </div>
          <p className="border-t border-line px-4 py-2 text-[13px] tabular-nums text-ink-3">
            {s.page + 1} / {s.pages}
          </p>
        </div>
      )}

      {!s.slide && !questions.length && live && (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
          <img src="/illustrations/entry-practice-v2.webp" alt="" className="w-32" draggable={false} />
          <p className="mt-3 text-[15px] text-ink-2">已进课堂</p>
        </div>
      )}

      {s.asks.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface px-4 py-3">
          <p className="text-[13px] text-ink-3">我问的</p>
          <ul className="mt-1.5 space-y-1.5">
            {s.asks.map((a) => (
              <li key={a.id} className="text-[15px] leading-relaxed text-ink">
                {a.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {live && <AskBar lectureId={s.id} />}
    </div>
  );
}

/** 一道题：没交的作答；交了的锁住；公布了的看对错、答案、解析和全班的情况 */
function QuestionCard({ lectureId, x, live }: { lectureId: number; x: StudentQuestion; live: boolean }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = x.status === 'revealed';
  const mine = x.mine;
  const open = live && !shown && !mine;
  const picked = mine?.choice ?? choice;
  const said = mine?.text ?? text;
  const right = new Set(shown ? (x.choice ?? []) : []);
  const ready = isChoice(x.type) ? picked.length > 0 : !!said.trim();
  const submit = async () => {
    if (!open || !ready || busy) return;
    setBusy(true);
    try {
      await post(`/classroom/${lectureId}/questions/${x.id}/answer`, isChoice(x.type) ? { choice } : { text });
      await qc.invalidateQueries({ queryKey: ['lecture', lectureId, 'student'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const tag = shown
    ? x.correct === true
      ? { text: '答对了', cls: CHIP.ok }
      : x.correct === false
        ? { text: '答错了', cls: CHIP.bad }
        : mine
          ? { text: '已交', cls: 'bg-surface-3 text-ink-2' }
          : { text: '没交', cls: 'bg-surface-3 text-ink-2' }
    : mine
      ? { text: '已交', cls: CHIP.info }
      : live
        ? null
        : { text: '没交', cls: 'bg-surface-3 text-ink-2' };
  return (
    <div className={cn('rounded-2xl border bg-surface px-4 py-4 shadow-xs sm:px-5', open ? 'border-brand/50 ring-2 ring-brand/10' : 'border-line')}>
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">第 {x.n} 题</span>
        <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[13px] font-medium text-brand-ink">{QTYPE_NAME[x.type]}</span>
        {tag && <span className={cn('ml-auto rounded-full px-2.5 py-0.5 text-[13px] font-medium', tag.cls)}>{tag.text}</span>}
      </div>
      <div className="mt-2.5 text-ink">
        <Markdown className="text-[16px]! leading-relaxed!">{x.stem}</Markdown>
      </div>
      {x.code && <pre className="mt-2.5 overflow-x-auto rounded-xl bg-[#1e2233] px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-[#e6e9f5]">{x.code}</pre>}

      {isChoice(x.type) ? (
        <ul className="mt-3 space-y-2">
          {(x.options || []).map((o, i) => {
            const on = picked.includes(i);
            const ok = right.has(i);
            return (
              <li key={i}>
                <button
                  type="button"
                  disabled={!open}
                  onClick={() => setChoice(x.type === 'single' ? [i] : on ? choice.filter((c) => c !== i) : [...choice, i].sort())}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-[15px] transition-colors',
                    shown && ok
                      ? 'border-ok bg-ok-soft text-ink'
                      : shown && on
                        ? 'border-bad bg-bad-soft text-ink'
                        : on
                          ? 'border-brand bg-brand-soft text-ink'
                          : 'border-line text-ink-2',
                    open && !on && 'hover:border-line-strong active:bg-surface-2',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center text-[14px] font-semibold',
                      x.type === 'multi' ? 'rounded-md' : 'rounded-full',
                      shown && ok ? 'bg-ok text-white' : shown && on ? 'bg-bad text-white' : on ? 'bg-brand text-white' : 'bg-surface-3 text-ink-2',
                    )}
                  >
                    {letter(i)}
                  </span>
                  <span className="min-w-0 flex-1">{optionText(o, letter(i))}</span>
                  {shown && ok && <Check className={cn('size-4 shrink-0', INK.ok)} />}
                  {shown && on && !ok && <X className={cn('size-4 shrink-0', INK.bad)} />}
                </button>
              </li>
            );
          })}
        </ul>
      ) : x.type === 'judge' ? (
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          {['对', '错'].map((v) => {
            const on = said === v;
            const ok = shown && x.answer === v;
            return (
              <button
                key={v}
                type="button"
                disabled={!open}
                onClick={() => setText(v)}
                className={cn(
                  'flex h-14 items-center justify-center gap-2 rounded-xl border text-[18px] font-semibold transition-colors',
                  ok ? `border-ok ${CHIP.ok}` : shown && on ? `border-bad ${CHIP.bad}` : on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line text-ink-2',
                )}
              >
                {v === '对' ? <Check className="size-5" /> : <X className="size-5" />}
                {v}
              </button>
            );
          })}
        </div>
      ) : open ? (
        x.type === 'blank' ? (
          <Input sizeVariant="lg" className="mt-3" value={text} maxLength={200} placeholder="答案" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        ) : (
          <Textarea autoGrow rows={4} className={cn('mt-3 text-[15px]', x.type === 'code' && 'font-mono text-[14px]')} value={text} maxLength={5000} placeholder="答案" onChange={(e) => setText(e.target.value)} />
        )
      ) : mine?.text ? (
        <div className={cn('mt-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[15px] text-ink', x.type === 'code' && 'whitespace-pre-wrap font-mono text-[14px]')}>{mine.text}</div>
      ) : null}

      {open && (
        <Button size="lg" variant="primary" block className="mt-3.5" loading={busy} disabled={!ready} onClick={submit}>
          提交
        </Button>
      )}

      {shown && (
        <div className="mt-3.5 space-y-2.5 border-t border-line pt-3">
          {!isChoice(x.type) && x.type !== 'judge' && x.answer && (
            <p className="text-[15px] text-ink">
              <span className={cn('mr-2 font-medium', INK.ok)}>{x.type === 'blank' ? '答案' : '参考答案'}</span>
              {x.type === 'code' ? <pre className="mt-1 whitespace-pre-wrap font-mono text-[13px]">{x.answer}</pre> : x.answer}
            </p>
          )}
          {x.explain && (
            <p className="text-[15px] leading-relaxed text-ink-2">
              <span className="mr-2 font-medium text-ink">解析</span>
              {x.explain}
            </p>
          )}
          {x.stats && x.stats.answered > 0 && (
            <div>
              <p className="text-[13px] text-ink-3">
                全班 {x.stats.answered} 人答{x.stats.correct !== null ? `，${x.stats.correct} 人对` : ''}
              </p>
              {x.stats.bars && <Bars className="mt-2" bars={x.stats.bars} answered={x.stats.answered} mark />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 最底下一行：问老师一句（手机上贴着屏幕下沿） */
function AskBar({ lectureId }: { lectureId: number }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await post(`/classroom/${lectureId}/asks`, { text: t });
      setText('');
      toast.success('发给老师了');
      qc.invalidateQueries({ queryKey: ['lecture', lectureId, 'student'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-[248px]">
      <div className="mx-auto flex max-w-[680px] items-center gap-2">
        <Input
          sizeVariant="lg"
          className="flex-1 rounded-full"
          value={text}
          maxLength={300}
          placeholder="提问"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && send()}
        />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim() || busy}
          aria-label="发给老师"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
        >
          <ArrowUp className="size-5" />
        </button>
      </div>
    </div>
  );
}

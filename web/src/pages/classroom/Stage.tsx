import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Eye, Minimize2 } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { Button, cn } from '../../components/ui';
import { QTYPE_NAME } from '../prep/data';
import { Bars } from './Bars';
import { optionText, percent, type Pushed } from './data';
import { INK } from '../classes/tone';

/**
 * 课件在大块里尽量放大、不变形：电脑上按这块的宽和高取能放下的最大 16:9，手机上铺满宽度。
 */
export function Fit({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex w-full items-center justify-center lg:h-full lg:min-h-0 lg:[container-type:size]', className)}>
      <div className="aspect-video w-full overflow-hidden rounded-xl border border-line shadow-sm lg:w-[min(100cqw,calc(100cqh*16/9))]">{children}</div>
    </div>
  );
}

/**
 * 大屏上放一道题的作答（雨课堂的「投屏」）：题目大字；没公布之前只写答了几个人，不放分布，免得还没答的人跟着选；
 * 公布以后出每个选项几个人、哪个对、正确率。
 */
export function QuestionStage({
  p,
  here,
  busy,
  onReveal,
  onBack,
  className,
}: {
  p: Pushed;
  here: number;
  busy: boolean;
  onReveal: () => void;
  /** 有课件时「回到课件」 */
  onBack?: () => void;
  className?: string;
}) {
  const shown = p.status === 'revealed';
  const share = here ? Math.min(1, p.answered / here) : 0;
  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-y-auto rounded-xl border border-line bg-surface px-[4vmin] py-[3vmin] shadow-sm', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-lg bg-brand-soft px-3 py-1 text-[clamp(14px,2vmin,22px)] font-semibold text-brand-ink">
          第 {p.n} 题 · {QTYPE_NAME[p.q.type]}
        </span>
        <span className="text-[clamp(14px,2vmin,22px)] tabular-nums text-ink-2">
          答了 <b className="text-ink">{p.answered}</b> / {here}
        </span>
        {shown && p.correct !== null && (
          <span className="text-[clamp(14px,2vmin,22px)] tabular-nums text-ink-2">
            答对 <b className={p.answered && p.correct / p.answered >= 0.6 ? INK.ok : INK.bad}>{percent(p.answered ? p.correct / p.answered : null)}</b>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!shown && (
            <Button variant="primary" icon={<Eye className="size-4" />} loading={busy} onClick={onReveal}>
              公布答案
            </Button>
          )}
          {onBack && (
            <Button variant="secondary" onClick={onBack}>
              回到课件
            </Button>
          )}
        </div>
      </div>
      <div className="mt-[3vmin] text-[clamp(18px,3.2vmin,40px)] font-medium text-ink">
        <Markdown className="text-[length:inherit]! leading-snug!">{p.q.stem}</Markdown>
      </div>
      {p.q.code && <pre className="mt-[2vmin] overflow-x-auto rounded-xl border border-line bg-surface-2 px-[2.4vmin] py-[1.8vmin] font-mono text-[clamp(13px,2vmin,24px)] leading-relaxed text-ink">{p.q.code}</pre>}
      <div className="mt-[3vmin] flex-1">
        {shown && p.bars ? (
          <Bars big bars={p.bars} answered={p.answered} mark />
        ) : p.q.options?.length ? (
          <ul className="grid gap-[1.6vmin] sm:grid-cols-2">
            {p.q.options.map((o, i) => (
              <li key={i} className="flex items-start gap-[1.4vmin] rounded-[1.4vmin] border border-line px-[2vmin] py-[1.4vmin] text-[clamp(15px,2.6vmin,30px)] text-ink">
                <b className="text-brand-ink">{String.fromCharCode(65 + i)}</b>
                <span className="min-w-0">{optionText(o, String.fromCharCode(65 + i))}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!shown && (
          // 一个人一个格子，答了的亮起来（大屏上不写名字，免得没答的人难堪）
          <div className="mt-[4vmin]">
            <div className="flex max-w-[110vmin] flex-wrap gap-[0.9vmin]">
              {Array.from({ length: Math.max(here, p.answered) }, (_, i) => (
                <span
                  key={i}
                  className={cn('size-[2.6vmin] min-h-3.5 min-w-3.5 rounded-[0.6vmin] transition-colors duration-500', i < p.answered ? 'bg-brand' : 'bg-surface-3')}
                />
              ))}
            </div>
            <p className="mt-[1.6vmin] text-[clamp(15px,2.4vmin,28px)] text-ink-2">
              {here && p.answered >= here ? '都答完了' : share >= 0.8 ? `还差 ${here - p.answered} 个人` : `${p.answered} 个人答了`}
            </p>
          </div>
        )}
        {shown && (p.q.answer || p.q.explain) && !p.q.options?.length && (
          <div className="mt-[3vmin] rounded-xl bg-ok-soft px-[2.4vmin] py-[1.8vmin] text-[clamp(15px,2.4vmin,28px)] text-ink">
            <span className={cn('mr-3 font-semibold', INK.ok)}>答案</span>
            {p.q.type === 'code' ? <pre className="mt-1 whitespace-pre-wrap font-mono text-[0.8em]">{p.q.answer}</pre> : p.q.answer}
          </div>
        )}
        {shown && p.q.explain && (
          <p className="mt-[2vmin] text-[clamp(14px,2.2vmin,26px)] leading-relaxed text-ink-2">
            <span className="mr-2 font-medium text-ink">解析</span>
            {p.q.explain}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 全屏放映：浏览器全屏，黑底上放课件（或者正在投屏的那道题）；左右键、空格翻页，Esc 退出。
 * 点名的名字照样弹在最上面。
 */
export function Projector({
  children,
  dark,
  page,
  pages,
  onPage,
  onClose,
}: {
  children: ReactNode;
  dark: boolean;
  page: number;
  pages: number;
  onPage: (i: number) => void;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    let entered = false;
    document.documentElement
      .requestFullscreen?.()
      .then(() => (entered = true))
      .catch(() => {});
    // 按 Esc 退出浏览器全屏时，这一层也关掉（浏览器没让全屏的，Esc 也关）
    const onChange = () => !document.fullscreenElement && entered && close.current();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);
  return createPortal(
    <div className={cn('fixed inset-0 z-[100] flex items-center justify-center p-[2vmin]', dark ? 'bg-black' : 'bg-bg')}>
      <div className={cn('flex h-full w-full items-center justify-center [container-type:size]')}>
        <div className={cn(dark ? 'aspect-video w-[min(100cqw,calc(100cqh*16/9))]' : 'h-full w-full')}>{children}</div>
      </div>
      <div className={cn('absolute bottom-3 right-3 flex items-center gap-1 rounded-full px-1.5 py-1', dark ? 'bg-black/45 text-white/85' : 'bg-surface/90 text-ink-2 shadow-sm')}>
        {pages > 0 && (
          <>
            <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={() => onPage(page - 1)} aria-label="上一页">
              <ChevronLeft className="size-5" />
            </button>
            <span className="text-[14px] tabular-nums">
              {page + 1} / {pages}
            </span>
            <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={() => onPage(page + 1)} aria-label="下一页">
              <ChevronRight className="size-5" />
            </button>
          </>
        )}
        <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={onClose} aria-label="退出全屏">
          <Minimize2 className="size-5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

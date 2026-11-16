import { useState } from 'react';
import { BookOpen, ChevronRight, MessageCircleQuestion, Search } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { cn } from '../../components/ui';
import { FileCard, typeLabel } from '../kb/FileCard';
import { plainText } from '../kb/data';
import { readableError, stepLines, type StepLine } from '../kb/presentation';
import { teacherTitle, type StuRun } from './data';

const ICON: Record<string, typeof BookOpen> = { stu_look: Search, stu_ask: MessageCircleQuestion };

function Line({ line }: { line: StepLine }) {
  const Icon = Object.hasOwn(ICON, line.name) ? ICON[line.name] : BookOpen;
  return (
    <div className="flex items-start gap-2 text-[13px] leading-5 text-ink-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
      <span className="line-clamp-2 min-w-0 break-all">
        <span className="font-medium text-ink">{line.label}</span> {line.text}
      </span>
    </div>
  );
}

/** 老师那边送进来的一条：老师回复了学生问的事，或者发了通知。不是学伴说的，摆成一张小卡片，写着是哪位老师、哪个班 */
function Notice({ run }: { run: StuRun }) {
  const d = run.events.find((e) => e.type === 'notice')?.data || {};
  const reply = d.kind === 'reply';
  return (
    <div className="max-w-4xl rounded-xl border border-line bg-surface px-3.5 py-3 shadow-xs">
      <p className="text-[12.5px] text-ink-3">
        {d.teacher ? teacherTitle(String(d.teacher)) : '老师'}
        {d.className ? ` · ${d.className}` : ''}
        {reply ? ' · 回复' : ' · 通知'}
      </p>
      {reply && d.question && <p className="mt-1 line-clamp-2 border-l-2 border-line pl-2 text-[13px] leading-relaxed text-ink-3">{plainText(d.question)}</p>}
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{plainText(run.reply || '')}</p>
    </div>
  );
}

/**
 * 学生跟学伴的一轮：学生的话在右边；左边是学伴——干活时一行灰字（点开是工作记录），说完的话，发的文件。
 * 老师看学生的对话也用这个（只能看）。
 */
export function BuddyRunBlock({ run, live }: { run: StuRun; live: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (run.kind === 'notice') return <Notice run={run} />;
  const running = run.status === 'running';
  const lines = stepLines(run.events);
  const done = run.events.filter((e) => e.type === 'tool').length;
  const latest = lines[lines.length - 1];
  const files = run.events.filter((e) => e.type === 'file');
  const errorEvent = run.events.find((e) => e.type === 'error');
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-white">
          {plainText(run.request)}
        </div>
      </div>
      <div className="min-w-0 space-y-2.5 [&>*]:max-w-4xl">
        {done > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="inline-flex items-center gap-1 py-0.5 text-[12.5px] text-ink-3 transition-colors hover:text-ink-2"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
              工作记录 · {done} 步
            </button>
            {expanded && (
              <div className="ml-[6px] mt-1.5 space-y-1.5 border-l-2 border-line pl-3">
                {lines.map((l) =>
                  l.kind === 'say' ? (
                    <p key={l.id} className="text-[13px] leading-5 text-ink-3">
                      {l.text}
                    </p>
                  ) : (
                    <Line key={l.id} line={l} />
                  ),
                )}
              </div>
            )}
          </div>
        )}
        {running && (
          <div className="flex items-start gap-2 text-[13px] text-ink-3">
            <span className="mt-1.5 flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand/60" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
            {live && /[㐀-鿿]/.test(live) ? (
              <span className="min-w-0 whitespace-pre-wrap">{plainText(live)}</span>
            ) : (
              latest && !expanded && <span className="min-w-0 truncate">{latest.label ? `${latest.label} ${latest.text}` : latest.text}</span>
            )}
          </div>
        )}
        {!running && run.reply && (
          <div className="w-fit max-w-full rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5">
            <Markdown compact>{plainText(run.reply)}</Markdown>
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((e) => (
              // 资料包里的文件，或者作业的附件（作业页上本来就能下载的）
              <a key={e.id} href={e.data.hwFileId ? `/api/homework/files/${e.data.hwFileId}` : `/api/cot/files/${e.data.fileId}`} className="block" rel="noopener">
                <FileCard name={String(e.data.name || '文件')} meta={[typeLabel(String(e.data.name || '')), e.data.note].filter(Boolean).join(' · ')} />
              </a>
            ))}
          </div>
        )}
        {(errorEvent || run.error) && run.status !== 'canceled' && (
          <p role="alert" className="text-[13px] text-bad">
            {readableError(run.error || errorEvent?.data.message)}
          </p>
        )}
        {run.status === 'canceled' && <p className="text-[13px] text-ink-3">已停止</p>}
      </div>
    </div>
  );
}

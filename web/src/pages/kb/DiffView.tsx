import { useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronsUpDown } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { Badge, cn } from '../../components/ui';
import { PLAIN_NAMES, fileDir, fileTitle, plainPath, rehypePlainNames, type FileDiff } from './data';
import { buildTracked, rehypeTracked } from './tracked';

const STATUS: Record<FileDiff['status'], { text: string; tone: 'ok' | 'brand' | 'bad' | 'gray' }> = {
  added: { text: '新建', tone: 'ok' },
  modified: { text: '修改', tone: 'brand' },
  deleted: { text: '删除', tone: 'bad' },
  renamed: { text: '挪位置', tone: 'gray' },
};

const LANG: Record<string, string> = {
  py: 'python',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  java: 'java',
  js: 'javascript',
  ts: 'typescript',
  sql: 'sql',
  go: 'go',
  json: 'json',
};

/** 代码和纯文本包成代码块，和 Markdown 走同一套显示 */
function asMarkdown(path: string, text: string): string {
  if (/\.(md|markdown)$/i.test(path)) return text;
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((s) => s.length + 1)));
  return `${fence}${LANG[path.split('.').pop()!.toLowerCase()] || 'text'}\n${text.replace(/\n$/, '')}\n${fence}\n`;
}

/** 收起来的没改的几段，点开才显示 */
function Fold(props: { children?: ReactNode; 'data-count'?: number; 'data-pos'?: string }) {
  const [open, setOpen] = useState(false);
  if (open) return <>{props.children}</>;
  const where = props['data-pos'] === 'start' ? '前面' : props['data-pos'] === 'end' ? '后面' : '中间';
  return (
    <button type="button" className="ct-fold" onClick={() => setOpen(true)}>
      <ChevronsUpDown className="size-3.5" />
      {where} {props['data-count']} 段没改，点开看
    </button>
  );
}
const FOLD = { 'ct-fold': Fold };

/** 修订稿：排好版的新版，新加的标绿，删掉的划掉 */
function Tracked({ path, before, after }: { path: string; before: string; after: string }) {
  const t = useMemo(() => buildTracked(asMarkdown(path, before), asMarkdown(path, after)), [path, before, after]);
  const plugins = useMemo(() => [[rehypeTracked, t], rehypePlainNames] as any, [t]);
  if (!t.marks.length) return <p className="text-[14px] text-ink-3">{before === after ? '内容没变' : '文字没变，只改了格式'}</p>;
  return (
    <Markdown compact plugins={plugins} extraComponents={FOLD}>
      {t.source}
    </Markdown>
  );
}

/** 改动里的一个文件 */
export function FileDiffView({ diff, defaultOpen = true }: { diff: FileDiff; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen && diff.status !== 'deleted');
  const s = STATUS[diff.status];
  const dir = fileDir(diff.path);
  let body: ReactNode;
  if (diff.sourceChanged && !diff.binary && diff.before === diff.after) body = <p className="text-[14px] text-ink-3">原文件已更新，文字内容未变</p>;
  else if (diff.binary) body = <p className="text-[14px] text-ink-3">原文件</p>;
  else if (diff.status === 'added')
    body = (
      <Markdown compact plugins={PLAIN_NAMES}>
        {asMarkdown(diff.path, diff.after ?? '')}
      </Markdown>
    );
  else if (diff.status === 'deleted')
    body = (
      <>
        <p className="mb-3 text-[14px] text-ink-3">已移除</p>
        <div className="opacity-60">
          <Markdown compact plugins={PLAIN_NAMES}>
            {asMarkdown(diff.path, diff.before ?? '')}
          </Markdown>
        </div>
      </>
    );
  else body = <Tracked path={diff.path} before={diff.before ?? ''} after={diff.after ?? ''} />;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 bg-surface-2 px-3 py-2 text-left">
        <ChevronRight className={cn('size-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
        <Badge tone={s.tone}>{s.text}</Badge>
        <span className="min-w-0 truncate text-[14px]">
          {dir && <span className="text-ink-3">{plainPath(dir)} · </span>}
          <span className="font-medium text-ink">{fileTitle(diff.path)}</span>
        </span>
      </button>
      {open && (
        <div className="max-h-[560px] overflow-y-auto px-5 py-4">
          {diff.from && <p className="mb-3 text-[14px] text-ink-3">原位置：{plainPath(diff.from)}</p>}
          {body}
          {diff.truncated && <p className="mt-3 text-[13px] text-ink-3">内容太长，只显示了前面一部分</p>}
        </div>
      )}
    </div>
  );
}

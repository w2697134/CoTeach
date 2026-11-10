import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  ChevronRight,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  Globe,
  NotebookText,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import { get } from '../../lib/api';
import { SearchInput, cn } from '../../components/ui';
import type { TreeFile } from './data';
import { fileDir, fileTitle, folderItems, plainPath, plainText } from './presentation';

type Hit = { path: string; protected: boolean; snippet: string };

/** 老师交的原件（受保护的，或者读不出文字的文件）；其余是整理助手写的笔记 */
export const isMaterial = (f: Pick<TreeFile, 'protected' | 'text'>) => !!f.protected || !f.text;

/** 原件的类型用图标和颜色区分，和老师电脑上看到的文件差不多 */
const KIND_ICON: Record<string, { icon: LucideIcon; color: string }> = {
  pdf: { icon: FileText, color: 'text-rose-500' },
  document: { icon: FileText, color: 'text-sky-600' },
  text: { icon: FileText, color: 'text-ink-3' },
  slides: { icon: Presentation, color: 'text-orange-500' },
  sheet: { icon: FileSpreadsheet, color: 'text-emerald-600' },
  image: { icon: FileImage, color: 'text-violet-500' },
  code: { icon: FileCode, color: 'text-slate-500' },
  notebook: { icon: FileCode, color: 'text-slate-500' },
  archive: { icon: FileArchive, color: 'text-amber-600' },
  ebook: { icon: BookOpen, color: 'text-teal-600' },
  web: { icon: Globe, color: 'text-sky-500' },
};
export function MaterialIcon({ file, className }: { file: { source?: { kind: string } | null }; className?: string }) {
  const k = (file.source && Object.hasOwn(KIND_ICON, file.source.kind) && KIND_ICON[file.source.kind]) || { icon: FileIcon, color: 'text-ink-3' };
  const Icon = k.icon;
  return <Icon className={cn('size-4 shrink-0', k.color, className)} />;
}

/** 把找到的那几个字标出来 */
function Marked({ text, term }: { text: string; term: string }) {
  const lower = text.toLowerCase(),
    t = term.toLowerCase(),
    parts: { s: string; hit: boolean }[] = [];
  let at = 0;
  for (let i = lower.indexOf(t); t && i >= 0; i = lower.indexOf(t, i + t.length)) {
    if (i > at) parts.push({ s: text.slice(at, i), hit: false });
    parts.push({ s: text.slice(i, i + t.length), hit: true });
    at = i + t.length;
  }
  if (at < text.length) parts.push({ s: text.slice(at), hit: false });
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-brand-soft px-0.5 text-brand-ink">
            {p.s}
          </mark>
        ) : (
          <Fragment key={i}>{p.s}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * 所在位置：「全部 › 王建国的知识库 › 第7章 递归」，每一级都能点回去。
 * 「全部」是所有知识库摆在一起的最外层；不给 kb 就是正在最外层。
 */
export function Crumbs({
  kb,
  dir = '',
  onTop,
  onOpenDir,
  here = false,
  className,
}: {
  kb?: string;
  dir?: string;
  onTop: () => void;
  onOpenDir?: (path: string) => void;
  /** 最后一级就是正在看的这一层：加粗 */
  here?: boolean;
  className?: string;
}) {
  const parts = dir ? dir.split('/') : [];
  const levels = kb === undefined ? [] : [{ name: kb, path: '' }, ...parts.map((name, i) => ({ name: fileTitle(name), path: parts.slice(0, i + 1).join('/') }))];
  const link = (current: boolean) =>
    cn('min-w-0 truncate rounded px-1 py-0.5', current ? 'font-medium text-ink' : 'text-ink-3 transition-colors hover:bg-ink/[0.05] hover:text-ink');
  return (
    <nav className={cn('flex min-w-0 flex-1 items-center gap-0.5 text-[13.5px]', className)}>
      <button type="button" className={cn(link(here && !levels.length), 'shrink-0')} onClick={onTop}>
        全部
      </button>
      {levels.map((l, i) => (
        <Fragment key={i}>
          <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
          <button type="button" className={link(here && i === levels.length - 1)} onClick={() => onOpenDir?.(l.path)}>
            {l.name}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}

function Tile({ onClick, title, plate, name, meta, pending }: { onClick: () => void; title?: string; plate: ReactNode; name: string; meta: string; pending: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group relative flex min-w-0 flex-col items-center gap-2.5 rounded-xl border border-line bg-surface px-3 pb-3.5 pt-5 text-center transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/35 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      {plate}
      <span className="line-clamp-2 min-h-[2.7em] w-full break-words text-[13.5px] leading-[1.35] text-ink">{name}</span>
      <span className="text-[12px] leading-none text-ink-3">{meta}</span>
      {pending && <span className="absolute right-2.5 top-2.5 size-2 rounded-full bg-brand" title="有改动等你确认" />}
    </button>
  );
}

const plate = 'relative flex size-14 items-center justify-center rounded-2xl';
const FolderPlate = () => (
  <span className={cn(plate, 'bg-amber-400/15')}>
    <Folder className="size-7 fill-amber-400/35 text-amber-500" strokeWidth={1.75} />
  </span>
);
/** 整理助手写的：笔记图标，角上带整理助手的头像 */
const NotePlate = () => (
  <span className={cn(plate, 'bg-brand-soft')}>
    <NotebookText className="size-7 text-brand" strokeWidth={1.75} />
    <img src="/agents/keeper.webp" alt="" draggable={false} className="absolute -bottom-1 -right-1 size-5 rounded-full object-cover ring-2 ring-surface" />
  </span>
);
const MaterialPlate = ({ file }: { file: TreeFile }) => (
  <span className={cn(plate, 'bg-surface-2 ring-1 ring-inset ring-line')}>
    <MaterialIcon file={file} className="size-7" />
  </span>
);

/**
 * 知识库里的东西像电脑文件夹那样一格一格摆着：文件夹、老师交的原件、整理助手写的笔记。
 * 怎么分文件夹由整理助手定；上面一条路径能退回去，搜索整个知识库一起找。
 */
export function Files({
  cid,
  kbName,
  files,
  dir,
  onTop,
  onOpenDir,
  onOpenFile,
  pending,
  empty,
  actions,
}: {
  cid: number;
  kbName: string;
  files: TreeFile[];
  dir: string;
  /** 回到最外层，所有知识库摆在一起的那页 */
  onTop: () => void;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** 有改动等老师确认的文件 */
  pending: Set<string>;
  /** 知识库里还什么都没有时显示的 */
  empty: ReactNode;
  /** 搜索框左边的按钮（交资料） */
  actions?: ReactNode;
}) {
  const items = useMemo(() => folderItems(files, dir, pending), [files, dir, pending]);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery({
    queryKey: ['kb-search', cid, term],
    queryFn: () => get<{ results: Hit[] }>(`/knowledge/${cid}/kb/search?q=${encodeURIComponent(term)}`),
    enabled: !!term,
  });
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
        <Crumbs kb={kbName} dir={term ? '' : dir} here={!term} onTop={onTop} onOpenDir={(p) => (setQ(''), onOpenDir(p))} />
        {files.length > 0 && (
          <>
            {actions}
            <SearchInput value={q} onChange={setQ} className="w-36 shrink-0 sm:w-56" />
          </>
        )}
      </div>
      {/* 空的知识库：上面那条路径照样在，能回到最外层 */}
      {!files.length ? (
        <div className="min-h-0 flex-1">{empty}</div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {term ? (
          found.data && !found.data.results.length ? (
            <p className="px-1 py-2 text-[13.5px] text-ink-3">没找到</p>
          ) : (
            <div className="mx-auto max-w-[760px] space-y-0.5">
              {(found.data?.results || []).map((r) => {
                const where = fileDir(r.path);
                const f = byPath.get(r.path);
                const snippet = plainText(r.snippet).replace(/[#*`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
                return (
                  <button
                    key={r.path}
                    type="button"
                    onClick={() => onOpenFile(r.path)}
                    className="flex w-full flex-col items-stretch gap-0.5 rounded-lg px-3 py-2 text-left text-[14px] text-ink-2 transition-colors hover:bg-ink/[0.05] hover:text-ink"
                  >
                    <span className="flex w-full items-center gap-2 text-ink">
                      {f && isMaterial(f) ? <MaterialIcon file={f} /> : <NotebookText className="size-4 shrink-0 text-brand" />}
                      <span className="min-w-0 flex-1 truncate">
                        <Marked text={fileTitle(r.path)} term={term} />
                      </span>
                    </span>
                    {where && <span className="w-full truncate text-[12px] text-ink-3">{plainPath(where)}</span>}
                    {snippet && (
                      <span className="line-clamp-2 w-full text-[12.5px] leading-5 text-ink-2">
                        <Marked text={snippet} term={term} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-3">
            {items.map((it) =>
              it.kind === 'folder' ? (
                <Tile key={it.path} onClick={() => onOpenDir(it.path)} plate={<FolderPlate />} name={it.name} meta={`${it.count} 项`} pending={it.pending} />
              ) : (
                <Tile
                  key={it.file.path}
                  onClick={() => onOpenFile(it.file.path)}
                  title={isMaterial(it.file) && it.file.source ? fileTitle(it.file.source.name) : undefined}
                  plate={isMaterial(it.file) ? <MaterialPlate file={it.file} /> : <NotePlate />}
                  name={it.name}
                  meta={isMaterial(it.file) ? '原件' : it.file.studentId ? '个人记录' : '笔记'}
                  pending={it.pending}
                />
              ),
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

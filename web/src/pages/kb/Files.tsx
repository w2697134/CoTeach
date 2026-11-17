import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronRight, File as FileIcon, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Globe, NotebookText, Presentation, type LucideIcon } from 'lucide-react';
import { get } from '../../lib/api';
import { cn } from '../../components/ui';
import type { TreeFile } from './data';
import { fileDir, fileTitle, plainPath, plainText } from './presentation';
import { FolderChip, FolderGlyph, NoteCard, OriginalCard, WritingCard, isImage } from './Cards';
import { folderName, isOriginal, nameOf, type Origins } from './insight';

type Hit = { path: string; protected: boolean; snippet: string };

/** 老师交的原件（受保护的，或者读不出文字的文件）；其余是整理助手写的笔记 */
export const isMaterial = isOriginal;

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

/** 搜索：名字或正文里有这几个字的，附一小段上下文 */
export function SearchResults({ cid, term, files, onOpenFile }: { cid: number; term: string; files: TreeFile[]; onOpenFile: (path: string) => void }) {
  const found = useQuery({
    queryKey: ['kb-search', cid, term],
    queryFn: () => get<{ results: Hit[] }>(`/knowledge/${cid}/kb/search?q=${encodeURIComponent(term)}`),
    enabled: !!term,
  });
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  if (found.data && !found.data.results.length) return <p className="py-6 text-[15px] text-ink-3">没找到「{term}」</p>;
  return (
    <div className="max-w-[760px] space-y-1">
      {(found.data?.results || []).map((r) => {
        const where = fileDir(r.path);
        const f = byPath.get(r.path);
        const snippet = plainText(r.snippet).replace(/[#*`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
        return (
          <button
            key={r.path}
            type="button"
            onClick={() => onOpenFile(r.path)}
            className="flex w-full flex-col items-stretch gap-1 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
          >
            <span className="flex w-full items-center gap-2 text-[15px] text-ink">
              {f && isOriginal(f) ? <MaterialIcon file={f} /> : <NotebookText className="size-4 shrink-0 text-brand" />}
              <span className="min-w-0 flex-1 truncate">
                <Marked text={f ? nameOf(f) : fileTitle(r.path)} term={term} />
              </span>
              {where && <span className="max-w-[40%] shrink-0 truncate text-[13px] text-ink-3">{plainPath(where)}</span>}
            </span>
            {snippet && (
              <span className="line-clamp-2 w-full pl-6 text-[14px] leading-[22px] text-ink-2">
                <Marked text={snippet} term={term} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 搜索框旁边打的字过一会儿才去找 */
export function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value.trim()), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Group = { path: string; name: string; files: TreeFile[]; sub: { path: string; name: string; count: number }[]; total: number };
const byName = (a: string, b: string) => a.localeCompare(b, 'zh', { numeric: true });

/** 一个文件夹里直接放着的文件，和每个子文件夹里直接放着的文件、再往里的文件夹 */
export function layoutOf(files: TreeFile[], dir: string) {
  const prefix = dir ? dir + '/' : '';
  const here: TreeFile[] = [];
  const groups = new Map<string, { files: TreeFile[]; sub: Map<string, number>; total: number }>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length).split('/');
    if (rest.length === 1) {
      here.push(f);
      continue;
    }
    const g = groups.get(rest[0]) || { files: [], sub: new Map<string, number>(), total: 0 };
    g.total++;
    if (rest.length === 2) g.files.push(f);
    else g.sub.set(rest[1], (g.sub.get(rest[1]) || 0) + 1);
    groups.set(rest[0], g);
  }
  const sorted = (list: TreeFile[]) => [...list].sort((a, b) => byName(nameOf(a), nameOf(b)));
  const folders: Group[] = [...groups]
    .map(([name, g]) => ({
      path: prefix + name,
      name: folderName(name),
      files: sorted(g.files),
      sub: [...g.sub].map(([s, count]) => ({ path: `${prefix}${name}/${s}`, name: folderName(s), count })).sort((a, b) => byName(a.name, b.name)),
      total: g.total,
    }))
    .sort((a, b) => byName(a.name, b.name));
  return { here: sorted(here), folders };
}

/** 笔记一格一格摆（助教正在写的新笔记先摆一张空卡片），原件小一号摆在下面（图片单独一排小图） */
function Pile({
  cid,
  files,
  originals,
  origins,
  touched,
  pending,
  working,
  ghosts = [],
  onOpenFile,
}: {
  cid: number;
  files: TreeFile[];
  originals: TreeFile[];
  origins: Origins;
  touched: Map<string, { at: number; added: boolean }>;
  pending: Set<string>;
  working: Set<string>;
  ghosts?: string[];
  onOpenFile: (path: string) => void;
}) {
  const notes = files.filter((f) => !isOriginal(f));
  const docs = files.filter((f) => isOriginal(f) && !isImage(f));
  const images = files.filter((f) => isOriginal(f) && isImage(f));
  return (
    <div className="space-y-3">
      {notes.length + ghosts.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-3">
          {ghosts.map((p) => (
            <WritingCard key={`writing:${p}`} path={p} />
          ))}
          {notes.map((f) => (
            <NoteCard
              key={f.path}
              cid={cid}
              file={f}
              originals={originals}
              origins={origins}
              touched={touched.get(f.path)}
              pending={pending.has(f.path)}
              working={working.has(f.path)}
              onOpen={onOpenFile}
            />
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3">
          {docs.map((f) => (
            <OriginalCard key={f.path} cid={cid} file={f} origins={origins} onOpen={onOpenFile} />
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {images.map((f) => (
            <OriginalCard key={f.path} cid={cid} file={f} origins={origins} onOpen={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 一个文件夹摆成一段：笔记、原件各最多先摆这么多，多的点「还有几份」进去看 */
const PEEK = 9;

/**
 * 知识库里的东西：这一层直接放着的笔记和原件在最上面，每个文件夹一段，段里能看到里面的笔记写了什么。
 * 怎么分文件夹由助教定，这里照着摆，不固定骨架。
 */
export function Shelf({
  cid,
  files,
  dir,
  origins,
  touched,
  pending,
  working = new Set(),
  writing = [],
  onOpenDir,
  onOpenFile,
}: {
  cid: number;
  files: TreeFile[];
  dir: string;
  origins: Origins;
  touched: Map<string, { at: number; added: boolean }>;
  /** 有改动等老师确认的文件 */
  pending: Set<string>;
  /** 助教这会儿正在改的笔记 */
  working?: Set<string>;
  /** 助教这会儿正在写、还没交上来的新笔记（位置） */
  writing?: string[];
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { here, folders } = useMemo(() => layoutOf(files, dir), [files, dir]);
  const originals = useMemo(() => files.filter(isOriginal), [files]);
  const pile = { cid, originals, origins, touched, pending, working, onOpenFile };
  // 正在写的新笔记摆到它要放的那一段；不在这一层里的摆最上面
  const prefix = dir ? dir + '/' : '';
  const ghostsOf = (folder: string | null) =>
    writing.filter((p) => {
      const rest = p.startsWith(prefix) ? p.slice(prefix.length) : null;
      const top = rest && rest.includes('/') ? rest.split('/')[0] : null;
      const shown = top !== null && folders.some((g) => g.path === prefix + top);
      return folder === null ? !shown : shown && prefix + top === folder;
    });
  const topGhosts = ghostsOf(null);
  return (
    <div className="space-y-9">
      {here.length + topGhosts.length > 0 && <Pile files={here} ghosts={topGhosts} {...pile} />}
      {folders.map((g) => {
        const notes = g.files.filter((f) => !isOriginal(f)),
          rest = g.files.filter(isOriginal);
        const shown = [...notes.slice(0, PEEK), ...rest.slice(0, PEEK)];
        const more = g.files.length - shown.length;
        return (
          <section key={g.path}>
            <div className="mb-3 flex items-center gap-2.5">
              <FolderGlyph size={30} />
              <button type="button" onClick={() => onOpenDir(g.path)} className="min-w-0 truncate text-[16px] font-semibold text-ink transition-colors hover:text-brand-ink">
                {g.name}
              </button>
              <span className="shrink-0 text-[13px] text-ink-3">{g.total} 份</span>
              {(more > 0 || g.sub.length > 0) && (
                <button
                  type="button"
                  onClick={() => onOpenDir(g.path)}
                  className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[14px] text-brand-ink transition-colors hover:text-brand"
                >
                  {more > 0 ? `还有 ${more} 份` : '打开'}
                  <ChevronRight className="size-4" />
                </button>
              )}
            </div>
            {shown.length + ghostsOf(g.path).length > 0 && <Pile files={shown} ghosts={ghostsOf(g.path)} {...pile} />}
            {g.sub.length > 0 && (
              <div className={cn('flex flex-wrap gap-2', shown.length > 0 && 'mt-3')}>
                {g.sub.map((s) => (
                  <FolderChip key={s.path} name={s.name} count={s.count} onOpen={() => onOpenDir(s.path)} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

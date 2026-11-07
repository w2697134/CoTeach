import { Fragment, useEffect, useMemo, useState } from 'react';
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
  Globe,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import { get } from '../../lib/api';
import { SearchInput, Segmented, cn } from '../../components/ui';
import type { TreeFile } from './data';
import { fileDir, fileTitle, outline, plainPath, plainText, type OutlineNode } from './presentation';

type Hit = { path: string; protected: boolean; snippet: string };

/** 资料是老师交的原件，笔记是整理助手写的：分两栏放，同一个名字不会在一列里出现两遍 */
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

const row = (active: boolean) =>
  cn(
    'flex w-full items-center gap-2 rounded-lg pr-2 text-left text-[14px] transition-colors',
    active ? 'bg-brand-soft font-medium text-brand-ink' : 'text-ink-2 hover:bg-ink/[0.05] hover:text-ink',
  );

function Outline({
  nodes,
  selected,
  onSelect,
  pending,
  material,
}: {
  nodes: OutlineNode<TreeFile>[];
  selected: string | null;
  onSelect: (path: string) => void;
  pending: Set<string>;
  material: boolean;
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = (p: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const render = (list: OutlineNode<TreeFile>[], depth: number) =>
    list.map((n) => {
      const indent = 10 + depth * 16;
      if (!n.file) {
        const open = !closed.has(n.path);
        const hasPending = [...pending].some((p) => p.startsWith(n.path + '/'));
        return (
          <div key={n.path}>
            <button
              type="button"
              onClick={() => toggle(n.path)}
              className={cn(row(false), 'h-9 font-medium text-ink')}
              style={{ paddingLeft: indent - 4 }}
            >
              <ChevronRight className={cn('size-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              {hasPending && !open && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
            </button>
            {open && render(n.children, depth + 1)}
          </div>
        );
      }
      const active = selected === n.path;
      return (
        <button
          key={n.path}
          type="button"
          onClick={() => onSelect(n.path)}
          className={cn(row(active), 'min-h-9 py-1.5')}
          style={{ paddingLeft: indent + (depth ? 4 : 0) }}
          title={plainPath(n.path)}
        >
          {material && <MaterialIcon file={n.file} />}
          <span className="min-w-0 flex-1 truncate">{fileTitle(n.name)}</span>
          {n.file.studentId && <span className="shrink-0 rounded bg-surface-3 px-1.5 text-[11.5px] text-ink-3">个人</span>}
          {pending.has(n.path) && <span className="size-1.5 shrink-0 rounded-full bg-brand" title="有改动等你确认" />}
        </button>
      );
    });
  return <div className="space-y-0.5">{render(nodes, 0)}</div>;
}

/**
 * 左边的目录：上面一个搜索框，下面「笔记」「资料」两栏。
 * 笔记是整理助手写的，资料是老师交的原件；搜索两栏一起找。
 */
export function Contents({
  cid,
  files,
  directory,
  selected,
  onSelect,
  pending,
}: {
  cid: number;
  files: TreeFile[];
  /** 整理助手写的目录原文，用来排顺序 */
  directory: string;
  selected: string | null;
  onSelect: (path: string) => void;
  pending: Set<string>;
}) {
  const notes = useMemo(() => files.filter((f) => !isMaterial(f)), [files]);
  const materials = useMemo(() => files.filter(isMaterial), [files]);
  const selectedIsMaterial = materials.some((f) => f.path === selected);
  const [tab, setTab] = useState<'notes' | 'materials'>(selectedIsMaterial ? 'materials' : 'notes');
  // 从别处打开了一份资料（比如笔记里的出处），这一栏跟着切过去
  useEffect(() => {
    if (selected && materials.some((f) => f.path === selected)) setTab('materials');
    else if (selected && notes.some((f) => f.path === selected)) setTab('notes');
  }, [selected, materials, notes]);
  const noteTree = useMemo(() => outline(notes, directory, '笔记'), [notes, directory]);
  const materialTree = useMemo(() => outline(materials, directory, '资料'), [materials, directory]);

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
      <div className="space-y-2.5 px-2 pb-2 pt-1">
        <SearchInput value={q} onChange={setQ} />
        {!term && materials.length > 0 && (
          <Segmented
            size="sm"
            className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'notes', label: '笔记' },
              {
                value: 'materials',
                label: (
                  <>
                    资料<span className="tabular font-normal text-ink-3">{materials.length}</span>
                  </>
                ),
              },
            ]}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {term ? (
          found.data && !found.data.results.length ? (
            <p className="px-2.5 py-3 text-[13.5px] text-ink-3">没找到</p>
          ) : (
            <div className="space-y-0.5">
              {(found.data?.results || []).map((r) => {
                const dir = fileDir(r.path);
                const f = byPath.get(r.path);
                const snippet = plainText(r.snippet).replace(/[#*`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
                return (
                  <button
                    key={r.path}
                    type="button"
                    onClick={() => onSelect(r.path)}
                    className={cn(row(selected === r.path), 'flex-col items-stretch gap-0.5 px-2.5 py-2')}
                  >
                    <span className="flex w-full items-center gap-2 text-ink">
                      {f && isMaterial(f) && <MaterialIcon file={f} />}
                      <span className="min-w-0 flex-1 truncate">
                        <Marked text={fileTitle(r.path)} term={term} />
                      </span>
                      {r.protected && <span className="shrink-0 text-[11.5px] font-normal text-ink-3">资料</span>}
                    </span>
                    {dir && <span className="w-full truncate text-[12px] font-normal text-ink-3">{plainPath(dir)}</span>}
                    {snippet && (
                      <span className="line-clamp-2 w-full text-[12.5px] font-normal leading-5 text-ink-2">
                        <Marked text={snippet} term={term} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )
        ) : tab === 'materials' && materials.length ? (
          <Outline nodes={materialTree} selected={selected} onSelect={onSelect} pending={pending} material />
        ) : !notes.length ? (
          <p className="px-2.5 py-3 text-[13.5px] text-ink-3">还没有笔记</p>
        ) : (
          <Outline nodes={noteTree} selected={selected} onSelect={onSelect} pending={pending} material={false} />
        )}
      </div>
    </div>
  );
}

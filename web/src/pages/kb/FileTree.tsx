import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, FileText, Folder, FolderOpen } from 'lucide-react';
import { get } from '../../lib/api';
import { SearchInput, cn } from '../../components/ui';
import type { TreeFile } from './data';
import { fileTitle, plainPath } from './data';
import { fileDir, plainText } from './presentation';

type Hit = { path: string; protected: boolean; snippet: string };

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

/** 目录上方的搜索：输入几个字就按名字和内容找，清空回到目录 */
export function TreeSearch({
  cid,
  files,
  selected,
  onSelect,
  pending,
}: {
  cid: number;
  files: TreeFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  pending: Set<string>;
}) {
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
  return (
    <div>
      <div className="sticky top-0 z-10 bg-surface p-2 pb-1">
        <SearchInput value={q} onChange={setQ} />
      </div>
      {!term ? (
        <FileTree files={files} selected={selected} onSelect={onSelect} pending={pending} />
      ) : found.data && !found.data.results.length ? (
        <p className="px-4 py-3 text-[13px] text-ink-3">没找到</p>
      ) : (
        <div className="space-y-px p-2 pt-1">
          {(found.data?.results || []).map((r) => {
            const dir = fileDir(r.path);
            const snippet = plainText(r.snippet).replace(/[#*`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
            return (
              <button
                key={r.path}
                type="button"
                onClick={() => onSelect(r.path)}
                className={cn(
                  'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
                  selected === r.path ? 'bg-brand-soft' : 'hover:bg-surface-3',
                )}
              >
                <span className="flex w-full items-center gap-1.5 text-[14px] text-ink">
                  <FileText className="size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">
                    <Marked text={fileTitle(r.path)} term={term} />
                  </span>
                  {r.protected && <span className="shrink-0 text-[11px] text-ink-3">原文</span>}
                </span>
                {dir && <span className="w-full truncate pl-[22px] text-[12px] text-ink-3">{plainPath(dir)}</span>}
                {snippet && (
                  <span className="line-clamp-2 w-full pl-[22px] text-[12.5px] leading-5 text-ink-2">
                    <Marked text={snippet} term={term} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Node {
  name: string;
  path: string;
  file?: TreeFile;
  children: Node[];
}

function build(files: TreeFile[]): Node[] {
  const root: Node = { name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.name === name);
      if (!next) {
        next = { name, path, children: [] };
        cur.children.push(next);
      }
      if (i === parts.length - 1) next.file = f;
      cur = next;
    });
  }
  const sort = (nodes: Node[], top: boolean) => {
    nodes.sort((a, b) => {
      const fa = a.file ? 1 : 0;
      const fb = b.file ? 1 : 0;
      return fa - fb || a.name.localeCompare(b.name, 'zh', { numeric: true });
    });
    nodes.forEach((n) => sort(n.children, false));
  };
  sort(root.children, true);
  return root.children;
}

export function FileTree({
  files,
  selected,
  onSelect,
  pending,
}: {
  files: TreeFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  /** 有待确认改动的文件 */
  pending: Set<string>;
}) {
  const nodes = useMemo(() => build(files), [files]);
  // 资料原件默认收起，其余展开
  const [closed, setClosed] = useState<Set<string>>(() => new Set(['资料/原件']));
  const toggle = (p: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const render = (list: Node[], depth: number) =>
    list.map((n) => {
      const pad = { paddingLeft: 10 + depth * 14 };
      if (!n.file) {
        const open = !closed.has(n.path);
        const hasPending = [...pending].some((p) => p.startsWith(n.path + '/'));
        return (
          <div key={n.path}>
            <button
              type="button"
              onClick={() => toggle(n.path)}
              className="flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[14px] font-medium text-ink-2 hover:bg-surface-3"
              style={pad}
            >
              <ChevronRight className={cn('size-3.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
              {open ? <FolderOpen className="size-4 shrink-0 text-amber-500" /> : <Folder className="size-4 shrink-0 text-amber-500" />}
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              {hasPending && !open && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
            </button>
            {open && render(n.children, depth + 1)}
          </div>
        );
      }
      const active = selected === n.path;
      const Icon = n.file.text ? FileText : File;
      return (
        <button
          key={n.path}
          type="button"
          onClick={() => onSelect(n.path)}
          className={cn(
            'flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[14px] transition-colors',
            active ? 'bg-brand-soft font-medium text-brand-ink' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
          )}
          style={{ paddingLeft: 10 + depth * 14 + 18 }}
          title={plainPath(n.path)}
        >
          <Icon className={cn('size-4 shrink-0', active ? 'text-brand' : n.file.text ? 'text-ink-3' : 'text-ink-3/70')} />
          <span className="min-w-0 flex-1 truncate">{fileTitle(n.name)}</span>
          {n.file.protected && <span className="shrink-0 text-[11px] text-ink-3">原文</span>}
          {n.file.studentId && <span className="shrink-0 text-[11px] text-ink-3">个人</span>}
          {pending.has(n.path) && <span className="size-1.5 shrink-0 rounded-full bg-brand" title="有待确认的改动" />}
        </button>
      );
    });

  return <div className="space-y-px p-2">{render(nodes, 0)}</div>;
}

import { useMemo, useState } from 'react';
import { ChevronRight, File, FileText, Folder, FolderOpen } from 'lucide-react';
import { cn } from '../../components/ui';
import type { TreeFile } from './data';
import { fileTitle, plainPath } from './data';

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

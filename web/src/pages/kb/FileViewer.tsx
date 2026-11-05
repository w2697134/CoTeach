import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, History, Pencil, Save, X } from 'lucide-react';
import { api, download, get } from '../../lib/api';
import { fromNow, fmtSize } from '../../lib/format';
import { toast } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { Alert, Button, Empty, IconButton, Skeleton, Textarea, cn } from '../../components/ui';
import { PLAIN_NAMES, plainText, useFile, type CommitInfo } from './data';

const isKeeper = (name: string) => name === '整理助手';

function WhoLine({ c }: { c: CommitInfo }) {
  return (
    <span className="truncate">
      {c.author}
      {c.committer && c.committer !== c.author ? ` 写，${c.committer} 确认` : isKeeper(c.author) ? ' 整理' : ' 改'} · {fromNow(c.time)}
    </span>
  );
}

function FileHistory({ cid, path, onOpenChange }: { cid: number; path: string; onOpenChange: (id: number) => void }) {
  const q = useQuery({ queryKey: ['kb-history', cid, path], queryFn: () => get<{ commits: CommitInfo[] }>(`/courses/${cid}/kb/history?path=${encodeURIComponent(path)}`) });
  if (!q.data) return <Skeleton className="m-4 h-24" />;
  return (
    <div className="divide-y divide-line border-b border-line bg-surface-2">
      {q.data.commits.map(c => (
        <button
          key={c.sha}
          type="button"
          disabled={!c.changeId}
          onClick={() => c.changeId && onOpenChange(c.changeId)}
          className="flex w-full items-center gap-3 px-5 py-2.5 text-left text-[13.5px] enabled:hover:bg-surface-3"
        >
          <span className="min-w-0 flex-1 truncate text-ink">{plainText(c.title)}</span>
          <span className="shrink-0 text-ink-3">
            <WhoLine c={c} />
          </span>
        </button>
      ))}
    </div>
  );
}

export function FileViewer({ cid, path, onOpenChange, pendingHere }: { cid: number; path: string | null; onOpenChange: (id: number) => void; pendingHere: number | null }) {
  const q = useFile(cid, path);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    setEditing(false);
    setShowHistory(false);
  }, [path]);

  if (!path) return <Empty icon={<FileText />} title="选一个文件" />;
  if (q.error) return <Alert tone="bad" className="m-5">{(q.error as Error).message}</Alert>;
  const f = q.data;
  const isMd = path.endsWith('.md');
  // 资料/第7章.md 对应的原件放在 资料/原件/ 下
  const original = path.startsWith('资料/') && !path.startsWith('资料/原件/') ? path.replace(/^资料\//, '资料/原件/').replace(/\.md$/, '') : null;

  const save = async () => {
    if (!f) return;
    setSaving(true);
    try {
      await api(`/courses/${cid}/kb/file`, { method: 'PUT', body: { path, content: draft, base: f.hash } });
      toast.success('已保存', '改动里随时可以撤回');
      setEditing(false);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSaving(false);
      qc.invalidateQueries({ queryKey: ['kb-file', cid, path] });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] font-semibold text-ink" title={path}>
            {path.split('/').pop()!.replace(/\.md$/, '')}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3">
            <span className="truncate">{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '知识库'}</span>
            {f?.last && (
              <>
                <span>·</span>
                <WhoLine c={f.last} />
              </>
            )}
          </p>
        </div>
        {f && !editing && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="历史" active={showHistory} onClick={() => setShowHistory(!showHistory)}>
              <History className="size-[18px]" />
            </IconButton>
            {f.text !== null ? (
              <Button
                size="sm"
                icon={<Pencil className="size-3.5" />}
                onClick={() => {
                  setDraft(f.text || '');
                  setEditing(true);
                }}
              >
                编辑
              </Button>
            ) : (
              <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => download(`/api/courses/${cid}/kb/raw?path=${encodeURIComponent(path)}`)}>
                下载
              </Button>
            )}
          </div>
        )}
        {editing && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" icon={<X className="size-3.5" />} onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={saving} disabled={draft === f?.text} onClick={save}>
              保存
            </Button>
          </div>
        )}
      </div>
      {showHistory && !editing && <FileHistory cid={cid} path={path} onOpenChange={onOpenChange} />}
      {pendingHere && !editing && (
        <button type="button" onClick={() => onOpenChange(pendingHere)} className="flex items-center gap-2 border-b border-line bg-brand-soft/60 px-5 py-2 text-left text-[13.5px] text-brand-ink hover:bg-brand-soft">
          有一处待确认的改动涉及这个文件，点开看
        </button>
      )}
      <div className={cn('min-h-0 flex-1 overflow-y-auto', editing ? 'p-3' : 'px-6 py-5')}>
        {!f ? (
          <Skeleton className="h-64" />
        ) : editing ? (
          <Textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="h-full min-h-[420px] resize-none font-mono text-[13.5px] leading-relaxed"
            spellCheck={false}
            autoFocus
          />
        ) : f.text === null ? (
          <Empty icon={<FileText />} title={`原件 · ${fmtSize(f.size)}`} />
        ) : isMd ? (
          <Markdown plugins={PLAIN_NAMES}>{f.text}</Markdown>
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-[13.5px] leading-relaxed text-ink">{f.text}</pre>
        )}
        {f && !editing && original && f.text !== null && (
          <OriginalLink cid={cid} base={original} />
        )}
      </div>
    </div>
  );
}

/** 文字是从原件转出来的：给个下载原件的入口 */
function OriginalLink({ cid, base }: { cid: number; base: string }) {
  const tree = useQueryClient().getQueryData<{ files: { path: string }[] }>(['kb-tree', cid]);
  const hit = tree?.files.find(x => x.path.startsWith(base + '.'));
  if (!hit) return null;
  return (
    <button
      type="button"
      onClick={() => download(`/api/courses/${cid}/kb/raw?path=${encodeURIComponent(hit.path)}`)}
      className="mt-6 inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:border-line-strong hover:text-ink"
    >
      <Download className="size-3.5" />
      下载原件 {hit.path.split('/').pop()}
    </button>
  );
}

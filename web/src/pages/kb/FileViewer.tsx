import { useEffect, useState } from 'react';
import { useBlocker, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, History, Pencil, Save, X, FolderInput, Trash2 } from 'lucide-react';
import { api, download, get } from '../../lib/api';
import { fromNow, fmtSize } from '../../lib/format';
import { toast } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { Alert, Button, Empty, IconButton, Input, Modal, Skeleton, Textarea, cn, useConfirm } from '../../components/ui';
import { PLAIN_NAMES, plainText, plainPath, fileTitle, fileDir, useFile, useCourse, type CommitInfo } from './data';
import { LocationField } from './LocationField';
import { copyText } from '../../lib/clipboard';

function WhoLine({ c }: { c: CommitInfo }) {
  return (
    <span className="truncate">
      {c.author}
      {c.committer && c.committer !== c.author ? ` · ${c.committer} 确认` : ''} · {fromNow(c.time)}
    </span>
  );
}

function FileHistory({ cid, path, onOpenChange }: { cid: number; path: string; onOpenChange: (id: number) => void }) {
  const q = useQuery({
    queryKey: ['kb-history', cid, path],
    queryFn: () => get<{ commits: CommitInfo[] }>(`/knowledge/${cid}/kb/history?path=${encodeURIComponent(path)}`),
  });
  if (q.error)
    return (
      <Alert tone="bad" className="m-4">
        历史加载失败。
        <Button size="sm" onClick={() => q.refetch()}>
          重试
        </Button>
      </Alert>
    );
  if (!q.data) return <Skeleton className="m-4 h-24" />;
  return (
    <div className="divide-y divide-line border-b border-line bg-surface-2">
      {q.data.commits.map((c) => (
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

export function FileViewer({
  cid,
  path,
  onOpenChange,
  pendingHere,
}: {
  cid: number;
  path: string | null;
  onOpenChange: (id: number) => void;
  pendingHere: number | null;
}) {
  const q = useFile(cid, path);
  const archived = useCourse(cid).data?.knowledgeBase.status === 'archived';
  const confirm = useConfirm(),
    [, setParams] = useSearchParams();
  const [moving, setMoving] = useState(false),
    [destination, setDestination] = useState(''),
    [destinationFolder, setDestinationFolder] = useState(''),
    [moveError, setMoveError] = useState('');
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editBase, setEditBase] = useState<{
    id: string;
    hash: string | null;
    text: string;
  } | null>(null);
  const [moveBase, setMoveBase] = useState<{
    id: string;
    hash: string | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [latestOpen, setLatestOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const dirty = editing && draft !== editBase?.text;
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked')
      void confirm({
        title: '还有未保存的修改',
        desc: '离开后，这些修改会丢失。',
        okText: '放弃修改并离开',
      }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker, confirm]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    setEditing(false);
    setShowHistory(false);
  }, [cid, path]);

  if (!path) return <Empty icon={<FileText />} title="选一个文件" />;
  if (q.error && !q.data)
    return (
      <Alert tone="bad" className="m-5">
        {(q.error as Error).message}
        <Button size="sm" onClick={() => q.refetch()}>
          重试
        </Button>
      </Alert>
    );
  const f = q.data;
  const isMd = /\.md$/i.test(path);
  const refresh = (removedPath?: string) => {
    qc.invalidateQueries({ queryKey: ['kb-tree', cid] });
    qc.invalidateQueries({
      queryKey: ['kb-file', cid],
      predicate: (q) => q.queryKey[2] !== removedPath,
    });
    qc.invalidateQueries({ queryKey: ['kb-changes', cid] });
    qc.invalidateQueries({ queryKey: ['kb-history', cid] });
  };
  const remove = async () => {
    if (
      !f ||
      !(await confirm({
        title: '移除这份文件？',
        desc: `移除「${fileTitle(path)}」？`,
        okText: '移除',
      }))
    )
      return;
    setSaving(true);
    try {
      await api(`/knowledge/${cid}/kb/file?path=${encodeURIComponent(path)}&base=${f.hash}&baseEntryId=${encodeURIComponent(f.id)}`, {
        method: 'DELETE',
      });
      setParams((prev) => {
        const n = new URLSearchParams(prev);
        n.delete('f');
        return n;
      });
      refresh(path);
      toast.success('已移除');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setSaving(false);
    }
  };
  const move = async () => {
    if (!f || !moveBase) return;
    setSaving(true);
    setMoveError('');
    try {
      const to = [destinationFolder, destination.trim() + (path.match(/\.[^./]+$/)?.[0] || '')].filter(Boolean).join('/');
      if (to === path) throw new Error('目标位置与原位置相同');
      await api(`/knowledge/${cid}/kb/move`, {
        method: 'POST',
        body: { from: path, to, base: moveBase.hash, baseEntryId: moveBase.id },
      });
      setMoving(false);
      setParams((prev) => {
        const n = new URLSearchParams(prev);
        n.set('f', to);
        return n;
      });
      refresh(path);
      toast.success('已移动');
    } catch (e) {
      setMoveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!f || !editBase) return;
    setSaving(true);
    setSaveError('');
    try {
      await api(`/knowledge/${cid}/kb/file`, {
        method: 'PUT',
        body: {
          path,
          content: draft,
          base: editBase.hash,
          baseEntryId: editBase.id,
        },
      });
      toast.success('已保存', '改动里随时可以撤回');
      setEditing(false);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
      qc.invalidateQueries({ queryKey: ['kb-file', cid, path] });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] font-semibold text-ink" title={plainPath(path)}>
            {fileTitle(path)}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3">
            <span className="truncate">{plainPath(fileDir(path)) || '知识库'}</span>
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
            {!archived && !editing && (
              <>
                <IconButton
                  label="改名或移动"
                  disabled={saving}
                  onClick={() => {
                    setDestination(fileTitle(path));
                    setDestinationFolder(fileDir(path));
                    setMoveBase({ id: f.id, hash: f.hash });
                    setMoveError('');
                    setMoving(true);
                  }}
                >
                  <FolderInput className="size-[18px]" />
                </IconButton>
                <IconButton label="移除文件" disabled={saving} onClick={remove}>
                  <Trash2 className="size-[18px]" />
                </IconButton>
              </>
            )}
            {f.text !== null && !f.protected && !archived ? (
              <Button
                size="sm"
                icon={<Pencil className="size-3.5" />}
                onClick={() => {
                  setDraft(f.text || '');
                  setSaveError('');
                  setEditBase({ id: f.id, hash: f.hash, text: f.text || '' });
                  setEditing(true);
                }}
              >
                编辑
              </Button>
            ) : f.text === null ? (
              <Button
                size="sm"
                icon={<Download className="size-3.5" />}
                onClick={() => download(`/api/knowledge/${cid}/kb/raw?path=${encodeURIComponent(path)}`)}
              >
                下载
              </Button>
            ) : null}
          </div>
        )}
        {editing && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" icon={<X className="size-3.5" />} onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Save className="size-3.5" />}
              loading={saving}
              disabled={draft === f?.text}
              onClick={save}
            >
              保存
            </Button>
          </div>
        )}
      </div>
      {f?.protected && (
        <div className="border-b border-line bg-surface-2 px-5 py-2 text-[13px] leading-relaxed text-ink-3">
          原文 · 只读
          {f.source?.sourceClass && (
            <span>
              {' '}
              · 来源：{f.source.sourceClass} · {f.source.term || '学期待指定'}
            </span>
          )}
        </div>
      )}
      {showHistory && !editing && <FileHistory cid={cid} path={path} onOpenChange={onOpenChange} />}
      {f?.student && (
        <div className="border-b border-line bg-brand-soft/40 px-5 py-2 text-[13px] text-brand-ink">{f.student.name}的个人记录</div>
      )}
      {pendingHere && !editing && (
        <button
          type="button"
          onClick={() => onOpenChange(pendingHere)}
          className="flex items-center gap-2 border-b border-line bg-brand-soft/60 px-5 py-2 text-left text-[13.5px] text-brand-ink hover:bg-brand-soft"
        >
          查看待确认改动
        </button>
      )}
      {editing && saveError && (
        <Alert tone="bad" className="m-3 mb-0">
          <p>{saveError}</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                copyText(draft)
                  .then(() => toast.success('已复制'))
                  .catch(toast.fromError)
              }
            >
              复制草稿
            </Button>
            <Button
              size="sm"
              loading={q.isFetching}
              onClick={async () => {
                const result = await q.refetch();
                if (result.error) setSaveError(result.error.message);
                else setLatestOpen(true);
              }}
            >
              查看最新内容
            </Button>
          </div>
        </Alert>
      )}
      <div className={cn('min-h-0 flex-1 overflow-y-auto', editing ? 'p-3' : 'px-6 py-5')}>
        {!f ? (
          <Skeleton className="h-64" />
        ) : editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-full min-h-[420px] resize-none font-mono text-[13.5px] leading-relaxed"
            spellCheck={false}
            autoFocus
          />
        ) : f.text === null ? (
          <Empty icon={<FileText />} title={`原文 · ${fmtSize(f.size)}`} />
        ) : isMd ? (
          <Markdown plugins={PLAIN_NAMES}>{f.text}</Markdown>
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-[13.5px] leading-relaxed text-ink">{f.text}</pre>
        )}
        {f?.source && !editing && (
          <Button
            className="mt-6"
            size="sm"
            icon={<Download className="size-3.5" />}
            onClick={() => download(`/api/knowledge/${cid}/sources/${f.source!.id}/raw`)}
          >
            下载原文件
          </Button>
        )}
      </div>
      <Modal
        open={moving}
        onClose={() => !saving && setMoving(false)}
        title="改名或移动"
        footer={
          <>
            <Button disabled={saving} onClick={() => setMoving(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!destination.trim() || (destination.trim() === fileTitle(path) && destinationFolder === fileDir(path))}
              onClick={move}
            >
              保存位置
            </Button>
          </>
        }
      >
        <label className="block text-[14px] text-ink">
          名称
          <Input className="mt-2" autoFocus value={destination} onChange={(e) => setDestination(e.target.value.replace(/[\\/]/g, ''))} />
        </label>
        <div className="mt-3">
          <LocationField cid={cid} value={destinationFolder} onChange={setDestinationFolder} />
        </div>
        {moveError && (
          <p role="alert" className="mt-3 text-[14px] text-bad">
            {moveError}
          </p>
        )}
      </Modal>
      <Modal open={latestOpen} onClose={() => setLatestOpen(false)} title="最新内容">
        <Markdown plugins={PLAIN_NAMES}>{f?.text || ''}</Markdown>
      </Modal>
    </div>
  );
}

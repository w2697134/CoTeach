import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, FolderInput, History, MoreHorizontal, Pencil, Save, Trash2, X } from 'lucide-react';
import { api, download, get } from '../../lib/api';
import { fromNow, fmtSize } from '../../lib/format';
import { toast } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { Alert, Button, Empty, Input, MenuItem, Modal, Popover, Skeleton, Textarea, cn, useConfirm } from '../../components/ui';
import { PLAIN_NAMES, plainText, fileTitle, fileDir, rehypePlainNames, useFile, useCourse, type CommitInfo } from './data';
import { kbTarget, rehypeKbLinks, splitTitle, withoutFrontMatter } from './presentation';
import { LocationField } from './LocationField';
import { MaterialIcon } from './Contents';
import { copyText } from '../../lib/clipboard';

function WhoLine({ c }: { c: CommitInfo }) {
  return (
    <span className="truncate">
      {c.author}
      {c.committer && c.committer !== c.author ? ` · ${c.committer}确认` : ''} · {fromNow(c.time)}
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
      <Alert tone="bad" className="mx-6 mt-4">
        历史加载失败。
        <Button size="sm" onClick={() => q.refetch()}>
          重试
        </Button>
      </Alert>
    );
  if (!q.data) return <Skeleton className="mx-6 mt-4 h-24" />;
  return (
    <div className="mx-auto mt-4 w-full max-w-[760px] px-6 sm:px-10">
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2">
        {q.data.commits.map((c) => (
          <button
            key={c.sha}
            type="button"
            disabled={!c.changeId}
            onClick={() => c.changeId && onOpenChange(c.changeId)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13.5px] enabled:hover:bg-surface-3"
          >
            <span className="min-w-0 flex-1 truncate text-ink">{plainText(c.title)}</span>
            <span className="shrink-0 text-ink-3">
              <WhoLine c={c} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const fmtDay = (t: number) => new Date(t).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

/** 中间翻开的那一页：笔记像文档一样排好；资料显示原件转出来的文字，可以下载原件 */
export function FileViewer({
  cid,
  path,
  paths,
  onSelect,
  onOpenChange,
  pendingHere,
}: {
  cid: number;
  path: string | null;
  /** 知识库里所有的位置：正文提到的就能点开 */
  paths: string[];
  onSelect: (path: string) => void;
  onOpenChange: (id: number) => void;
  pendingHere: number | null;
}) {
  const q = useFile(cid, path);
  // 链接组件只建一次，用到的最新值从这里取，免得每次刷新都重排整篇文档
  const live = useRef({ onSelect, path, known: new Set(paths) });
  live.current = { onSelect, path, known: useMemo(() => new Set(paths), [paths]) };
  const plugins = useMemo(() => [rehypeKbLinks(paths), rehypePlainNames], [paths]);
  const anchors = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        const { onSelect, path, known } = live.current;
        const target = kbTarget(href, path || '', known);
        return target ? (
          <button type="button" className="kb-link" onClick={() => onSelect(target)}>
            {children}
          </button>
        ) : (
          <a href={href} target={href?.startsWith('/') ? undefined : '_blank'} rel="noreferrer">
            {children}
          </a>
        );
      },
    }),
    [],
  );
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
  const [editBase, setEditBase] = useState<{ id: string; hash: string | null; text: string } | null>(null);
  const [moveBase, setMoveBase] = useState<{ id: string; hash: string | null } | null>(null);
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

  if (!path) return <Empty icon={<FileText />} title="还没有内容" />;
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
  const material = !!f && (f.protected || f.text === null);
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
    if (!f || !(await confirm({ title: '移除这一份？', desc: `移除「${fileTitle(path)}」？`, okText: '移除' }))) return;
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
        body: { path, content: draft, base: editBase.hash, baseEntryId: editBase.id },
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

  // 所在位置：资料、笔记两栏的外层文件夹不再重复写
  const dir = fileDir(path).replace(material ? /^资料(\/|$)/ : /^笔记(\/|$)/, '');
  const crumb = [material ? '资料' : '笔记', ...dir.split('/').filter(Boolean).map(fileTitle)];
  // 笔记的大标题从正文里拿；资料用老师交的原件名字，正文原样显示
  const shown = f?.text != null && isMd ? withoutFrontMatter(f.text) : f?.text || '';
  const split = f?.text != null && isMd ? splitTitle(shown, fileTitle(path)) : null;
  // 资料的标题用原件名字；正文开头的大标题和它一样就不再显示一遍
  const title = material ? fileTitle(f?.source?.name || path) : split?.title || fileTitle(path);
  const body = split && (!material || split.title === title) ? split.body : shown;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 sm:px-5">
        <p className="min-w-0 flex-1 truncate text-[13px] text-ink-3">{crumb.join(' › ')}</p>
        {f && !editing && (
          <div className="flex shrink-0 items-center gap-1">
            {f.source && (
              <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => download(`/api/knowledge/${cid}/sources/${f.source!.id}/raw`)}>
                下载原件
              </Button>
            )}
            {!f.source && f.text === null && (
              <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => download(`/api/knowledge/${cid}/kb/raw?path=${encodeURIComponent(path)}`)}>
                下载
              </Button>
            )}
            {f.text !== null && !f.protected && !archived && (
              <Button
                size="sm"
                icon={<Pencil className="size-3.5" />}
                onClick={() => {
                  setDraft(f.text || '');
                  setSaveError('');
                  setEditBase({ id: f.id, hash: f.hash, text: f.text || '' });
                  setShowHistory(false);
                  setEditing(true);
                }}
              >
                编辑
              </Button>
            )}
            <Popover
              width={168}
              trigger={({ toggle }) => (
                <Button size="sm" variant="ghost" aria-label="更多" onClick={toggle} className="px-2">
                  <MoreHorizontal className="size-4" />
                </Button>
              )}
            >
              {(close) => (
                <div onClick={close}>
                  <MenuItem icon={<History />} active={showHistory} onClick={() => setShowHistory(!showHistory)}>
                    历史版本
                  </MenuItem>
                  {!archived && (
                    <>
                      <MenuItem
                        icon={<FolderInput />}
                        disabled={saving}
                        onClick={() => {
                          setDestination(fileTitle(path));
                          setDestinationFolder(fileDir(path));
                          setMoveBase({ id: f.id, hash: f.hash });
                          setMoveError('');
                          setMoving(true);
                        }}
                      >
                        改名或移动
                      </MenuItem>
                      <MenuItem icon={<Trash2 />} danger disabled={saving} onClick={remove}>
                        移除
                      </MenuItem>
                    </>
                  )}
                </div>
              )}
            </Popover>
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
      {pendingHere && !editing && (
        <button
          type="button"
          onClick={() => onOpenChange(pendingHere)}
          className="flex shrink-0 items-center gap-2 border-b border-brand/15 bg-brand-soft/70 px-5 py-2 text-left text-[13.5px] text-brand-ink hover:bg-brand-soft"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-brand" />
          <span className="min-w-0 flex-1">这一页有改动等你确认</span>
          <span className="shrink-0 font-medium">看改动</span>
        </button>
      )}
      {editing && saveError && (
        <Alert tone="bad" className="m-3 mb-0">
          <p>{saveError}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => copyText(draft).then(() => toast.success('已复制')).catch(toast.fromError)}>
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
      <div className={cn('min-h-0 flex-1 overflow-y-auto', editing && 'flex flex-col p-3')}>
        {showHistory && !editing && <FileHistory cid={cid} path={path} onOpenChange={onOpenChange} />}
        {!f ? (
          <div className="mx-auto w-full max-w-[760px] px-6 py-8 sm:px-10">
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="mt-4 h-4 w-40" />
            <Skeleton className="mt-8 h-64" />
          </div>
        ) : editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[420px] flex-1 resize-none text-[15px] leading-[1.8]"
            spellCheck={false}
            autoFocus
          />
        ) : (
          <article className="mx-auto w-full max-w-[760px] px-6 pb-16 pt-8 sm:px-10">
            <h1 className="flex items-start gap-3 text-[26px] font-semibold leading-snug tracking-tight text-ink">
              {material && <MaterialIcon file={f} className="mt-[7px] size-6" />}
              <span className="min-w-0 break-words">{title}</span>
            </h1>
            <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-ink-3">
              {material ? (
                <>
                  <span>原件</span>
                  {f.source && <span>· {fmtDay(f.source.createdAt)}交的</span>}
                  {f.source?.sourceClass && (
                    <span>
                      · 来源：{f.source.sourceClass} · {f.source.term || '学期待指定'}
                    </span>
                  )}
                  {f.text === null && <span>· {fmtSize(f.size)}</span>}
                </>
              ) : (
                f.last && <WhoLine c={f.last} />
              )}
            </p>
            {f.student && (
              <p className="mt-3 inline-flex rounded-lg bg-brand-soft/60 px-3 py-1.5 text-[13px] text-brand-ink">{f.student.name}的个人记录</p>
            )}
            <div className="mt-6">
              {f.text === null ? (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-14 text-ink-3">
                  <FileText className="size-8" />
                  <span className="text-[13.5px]">这一份没有转成文字，可以下载原件查看</span>
                </div>
              ) : isMd ? (
                <Markdown className="md-doc" plugins={plugins} extraComponents={anchors}>
                  {body}
                </Markdown>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-[14.5px] leading-[1.85] text-ink">{f.text}</pre>
              )}
            </div>
          </article>
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

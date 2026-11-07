import { useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ListTree, Upload } from 'lucide-react';
import { useAuth } from '../../lib/store';
import { Card, Drawer, ErrorState, IconButton, PageLoading, Segmented, Skeleton, cn } from '../../components/ui';
import { ChangeDetail, ChangesList } from './Changes';
import { Contents, isMaterial } from './Contents';
import { DIRECTORY } from './presentation';
import { FileViewer } from './FileViewer';
import { HandInButton, KeeperPanel, type KeeperHandle } from './KeeperPanel';
import { useChanges, useCourse, useFile, useKbStream, useTree } from './data';
import { pickedFromDrop } from './intake';
import { KnowledgeTools } from './Manage';

export function KnowledgeBasePage() {
  const cid = Number(useParams().id);
  const userId = useAuth((state) => state.user?.id);
  return <KnowledgeBaseContent key={`${userId}:${cid}`} cid={cid} />;
}

/**
 * 一个知识库：左边目录（笔记、资料两栏），中间翻开的一页，右边整理助手。
 * 交资料、跟它说话、它改了什么都在右边；看改动也在中间那一页上看。
 */
function KnowledgeBaseContent({ cid }: { cid: number }) {
  const [params, setParams] = useSearchParams();
  const course = useCourse(cid);
  const tree = useTree(cid);
  const pending = useChanges(cid, 'pending');
  const keeper = useRef<KeeperHandle>(null);
  const live = useKbStream(cid, (operations) => {
    const current = params.get('f') || selected;
    const operation = operations.find((op) => op.from === current || (op.deleted && op.path === current));
    if (operation)
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (operation.from) next.set('f', operation.path);
          else next.delete('f');
          return next;
        },
        { replace: true },
      );
  });
  const [dragging, setDragging] = useState(0);
  // 手机上一次只放一栏
  const [pane, setPane] = useState<'contents' | 'page' | 'keeper'>('keeper');
  const [contentsOpen, setContentsOpen] = useState(false);

  const files = tree.data?.files || [];
  const directoryPath = files.some((f) => f.path === DIRECTORY) ? DIRECTORY : null;
  // 「目录」这一页和目录一起要，不等目录回来再要；目录里没有这一页就不要了
  const directoryFile = useFile(cid, tree.data && !directoryPath ? null : DIRECTORY);
  // 目录还没取到时先不排，免得列表先按名字排一遍再跳成目录的顺序
  const directory = !directoryPath || directoryFile.isError ? '' : (directoryFile.data?.text ?? null);
  const selected = params.get('f') || directoryPath || files.find((f) => !isMaterial(f))?.path || files[0]?.path || null;
  const changeId = Number(params.get('change')) || null;
  const listing = params.get('v') === 'changes';

  const update = (fn: (n: URLSearchParams) => void) =>
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      fn(n);
      return n;
    });
  const select = (p: string) => {
    update((n) => {
      n.set('f', p);
      n.delete('v');
      n.delete('change');
    });
    setPane('page');
    setContentsOpen(false);
  };
  const openChange = (id: number) => {
    update((n) => n.set('change', String(id)));
    setPane('page');
  };
  const openChanges = () => {
    update((n) => {
      n.set('v', 'changes');
      n.delete('change');
    });
    setPane('page');
  };

  const paths = useMemo(() => (tree.data?.files || []).map((f) => f.path), [tree.data]);
  const pendingPaths = useMemo(() => new Set((pending.data?.changes || []).flatMap((c) => c.files.map((f) => f.path))), [pending.data]);
  const pendingHere = (pending.data?.changes || []).find((c) => c.files.some((f) => f.path === selected))?.id ?? null;

  if (course.error) return <ErrorState error={course.error} onRetry={() => course.refetch()} />;
  if (!course.data) return <PageLoading />;
  const kb = course.data.knowledgeBase,
    archived = kb.status === 'archived';
  const filesDragged = (e: React.DragEvent) => !archived && e.dataTransfer.types.includes('Files');

  const contents = tree.error ? (
    <ErrorState error={tree.error} onRetry={() => tree.refetch()} />
  ) : !tree.data || directory === null ? (
    <Skeleton className="m-2 h-48" />
  ) : (
    <Contents
      cid={cid}
      files={files}
      directory={directory}
      selected={changeId || listing ? null : selected}
      onSelect={select}
      pending={pendingPaths}
    />
  );

  const page = changeId ? (
    <ChangeDetail cid={cid} id={changeId} backLabel={listing ? '全部改动' : '返回'} onBack={() => update((n) => n.delete('change'))} />
  ) : listing ? (
    <ChangesList
      cid={cid}
      onOpen={openChange}
      onBack={() =>
        update((n) => {
          n.delete('v');
          n.delete('change');
        })
      }
    />
  ) : tree.data && !files.length ? (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <img src="/agents/keeper.webp" alt="" className="size-32 animate-float rounded-full shadow-md" draggable={false} />
      {archived ? (
        <p className="text-[14px] text-ink-3">这个学期没有留下内容</p>
      ) : (
        <HandInButton size="md" variant="primary" onPick={(picked) => keeper.current?.handIn(picked)} />
      )}
    </div>
  ) : (
    <FileViewer key={cid} cid={cid} path={selected} paths={paths} onSelect={select} onOpenChange={openChange} pendingHere={pendingHere} />
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col gap-3"
      onDragEnter={(e) => filesDragged(e) && setDragging((n) => n + 1)}
      onDragLeave={(e) => filesDragged(e) && setDragging((n) => Math.max(0, n - 1))}
      onDragOver={(e) => filesDragged(e) && e.preventDefault()}
      onDrop={(e) => {
        if (!filesDragged(e)) return;
        e.preventDefault();
        setDragging(0);
        setPane('keeper');
        void pickedFromDrop(e.dataTransfer).then((picked) => keeper.current?.handIn(picked));
      }}
    >
      {dragging > 0 && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand/60 bg-brand-soft/70 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 text-[16px] font-medium text-brand-ink">
            <Upload className="size-5" />
            交资料
          </div>
        </div>
      )}
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <IconButton label="目录" className="hidden lg:inline-flex min-[90rem]:hidden" onClick={() => setContentsOpen(true)}>
          <ListTree className="size-[18px]" />
        </IconButton>
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-tight text-ink">{kb.kind === 'teacher' ? '长期知识库' : kb.name}</h1>
          {kb.kind === 'class' && (
            <span className="shrink-0 text-[13px] text-ink-3">
              {kb.term}
              {archived ? ' · 已封存' : ''}
            </span>
          )}
        </div>
        <KnowledgeTools key={cid} kb={kb} onSelect={select} />
      </div>
      <div className="px-1 lg:hidden">
        <Segmented
          value={pane}
          onChange={setPane}
          options={[
            { value: 'contents', label: '目录' },
            { value: 'page', label: '内容' },
            { value: 'keeper', label: '整理助手' },
          ]}
        />
      </div>
      {/* 宽屏三栏；中等宽度两栏，目录收进抽屉；手机一次一栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] min-[90rem]:grid-cols-[232px_minmax(0,1fr)_360px] min-[107.5rem]:grid-cols-[256px_minmax(0,1fr)_384px]">
        <div className={cn('min-h-0 max-lg:rounded-lg max-lg:border max-lg:border-line max-lg:bg-surface max-lg:pt-2 lg:hidden min-[90rem]:block', pane !== 'contents' && 'max-lg:hidden')}>
          {contents}
        </div>
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'page' && 'max-lg:hidden')}>
          {page}
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'keeper' && 'max-lg:hidden')}>
          <KeeperPanel ref={keeper} key={cid} cid={cid} live={live} onOpenChange={openChange} onOpenChanges={openChanges} />
        </Card>
      </div>
      <Drawer open={contentsOpen} onClose={() => setContentsOpen(false)} title="目录" side="left" width={300}>
        <div className="h-full pt-2">{contents}</div>
      </Drawer>
    </div>
  );
}

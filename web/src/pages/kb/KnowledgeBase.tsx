import { useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FileStack, FilePlus, FolderOpen, FolderTree, Upload } from 'lucide-react';
import { useAuth } from '../../lib/store';
import { Badge, Button, Card, Drawer, Empty, ErrorState, MenuItem, PageLoading, Popover, Segmented, Skeleton, cn } from '../../components/ui';
import { ChangesDrawer } from './Changes';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { KeeperPanel } from './KeeperPanel';
import { useChanges, useCourse, useKbStream, useTree } from './data';
import { handIn, pickedFromDrop, pickedFromList, type Picked } from './intake';
import { KnowledgeTools } from './Manage';

export function KnowledgeBasePage() {
  const cid = Number(useParams().id);
  const userId = useAuth((state) => state.user?.id);
  return <KnowledgeBaseContent key={`${userId}:${cid}`} cid={cid} />;
}

function KnowledgeBaseContent({ cid }: { cid: number }) {
  const [params, setParams] = useSearchParams();
  const course = useCourse(cid);
  const tree = useTree(cid);
  const pending = useChanges(cid, 'pending');
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
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  // 手机上一次只放一栏
  const [pane, setPane] = useState<'tree' | 'file' | 'keeper'>('keeper');

  const [treeOpen, setTreeOpen] = useState(false);
  const selected = params.get('f') || tree.data?.files.find((f) => f.path === '目录.md')?.path || tree.data?.files[0]?.path || null;
  const select = (p: string) => {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set('f', p);
      return n;
    });
    setPane('file');
    setTreeOpen(false);
  };

  const pendingPaths = useMemo(() => new Set((pending.data?.changes || []).flatMap((c) => c.files.map((f) => f.path))), [pending.data]);
  const pendingHere = (pending.data?.changes || []).find((c) => c.files.some((f) => f.path === selected))?.id ?? null;

  const openChange = (id: number | null) => {
    setFocus(id);
    setDrawer(true);
  };

  // 选的文件、选的文件夹、拖进来的都从这里交：登记好就切到整理助手看进度，上传在后台继续
  const upload = async (files: Picked[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    try {
      await handIn(qc, cid, files);
      setPane('keeper');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
      if (folderInput.current) folderInput.current.value = '';
    }
  };

  if (course.error) return <ErrorState error={course.error} onRetry={() => course.refetch()} />;
  if (!course.data) return <PageLoading />;
  const pendingCount = pending.data?.changes.length ?? course.data.pending;
  const kb = course.data.knowledgeBase,
    archived = kb.status === 'archived';
  const filesDragged = (e: React.DragEvent) => !archived && e.dataTransfer.types.includes('Files');
  const treeView = tree.error ? (
    <ErrorState error={tree.error} onRetry={() => tree.refetch()} />
  ) : !tree.data ? (
    <Skeleton className="m-4 h-48" />
  ) : !tree.data.files.length ? (
    <Empty compact title="还没有内容" />
  ) : (
    <FileTree files={tree.data.files} selected={selected} onSelect={select} pending={pendingPaths} />
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
        void pickedFromDrop(e.dataTransfer).then(upload);
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
      <div className="flex flex-wrap items-center gap-2 px-1">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
          <h1 className="break-words text-[20px] font-semibold tracking-tight text-ink">
            {kb.kind === 'teacher' ? '长期知识库' : kb.name}
          </h1>
          {kb.kind === 'class' && (
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              {kb.term}
              {archived ? ' · 已封存' : ''}
            </p>
          )}
        </div>
        <KnowledgeTools key={cid} kb={kb} onSelect={select} />
        <Button className="hidden lg:inline-flex 2xl:hidden" icon={<FolderTree className="size-4" />} onClick={() => setTreeOpen(true)}>
          目录
        </Button>
        <Button icon={<FileStack className="size-4" />} onClick={() => openChange(null)}>
          改动
          {pendingCount > 0 && (
            <Badge tone="brand" className="ml-1.5">
              {pendingCount}
            </Badge>
          )}
        </Button>
        {!archived && (
          <Popover
            trigger={({ toggle }) => (
              <Button variant="primary" icon={<Upload className="size-4" />} loading={uploading} onClick={toggle}>
                交资料
              </Button>
            )}
          >
            {(close) => (
              <div className="flex min-w-36 flex-col p-1.5" onClick={close}>
                <MenuItem icon={<FilePlus />} onClick={() => fileInput.current?.click()}>
                  选文件
                </MenuItem>
                <MenuItem icon={<FolderOpen />} onClick={() => folderInput.current?.click()}>
                  选文件夹
                </MenuItem>
              </div>
            )}
          </Popover>
        )}
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => upload(pickedFromList(e.target.files || []))} />
        <input
          ref={(el) => {
            // 选整个文件夹：React 不认识这个属性，直接设到元素上
            folderInput.current = el;
            el?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => upload(pickedFromList(e.target.files || []))}
        />
      </div>
      <div className="px-1 lg:hidden">
        <Segmented
          value={pane}
          onChange={(v) => setPane(v as typeof pane)}
          options={[
            { value: 'tree', label: '目录' },
            { value: 'file', label: '内容' },
            { value: 'keeper', label: '整理助手' },
          ]}
        />
      </div>
      {/* 宽屏三栏；中等宽度两栏，目录放进抽屉；手机一次一栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[220px_minmax(0,1fr)_360px]">
        <Card padded={false} className={cn('min-h-0 overflow-y-auto lg:hidden 2xl:block', pane !== 'tree' && 'hidden')}>
          {treeView}
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden lg:block', pane !== 'file' && 'hidden')}>
          <FileViewer key={cid} cid={cid} path={selected} onOpenChange={openChange} pendingHere={pendingHere} />
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden lg:block', pane !== 'keeper' && 'hidden')}>
          <KeeperPanel key={cid} cid={cid} live={live} onOpenChange={openChange} onUpload={() => fileInput.current?.click()} />
        </Card>
      </div>
      <Drawer open={treeOpen} onClose={() => setTreeOpen(false)} title="目录" side="left" width={300}>
        {treeView}
      </Drawer>
      <ChangesDrawer cid={cid} open={drawer} onClose={() => setDrawer(false)} focus={focus} setFocus={setFocus} />
    </div>
  );
}

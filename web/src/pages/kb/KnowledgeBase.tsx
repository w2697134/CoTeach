import { useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FileStack, FolderTree, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { Badge, Button, Card, Drawer, ErrorState, PageLoading, Segmented, cn } from '../../components/ui';
import { ChangesDrawer } from './Changes';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { KeeperPanel } from './KeeperPanel';
import { useChanges, useCourse, useKbStream, useTree } from './data';

const ACCEPT = '.md,.markdown,.txt,.docx,.pptx,.pdf,.py,.c,.cpp,.java,.js,.sql';

export function KnowledgeBasePage() {
  const cid = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const course = useCourse(cid);
  const tree = useTree(cid);
  const pending = useChanges(cid, 'pending');
  const live = useKbStream(cid);
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  // 手机上一次只放一栏
  const [pane, setPane] = useState<'tree' | 'file' | 'keeper'>('keeper');

  const [treeOpen, setTreeOpen] = useState(false);
  const selected = params.get('f') || '目录.md';
  const select = (p: string) => {
    setParams(prev => {
      const n = new URLSearchParams(prev);
      n.set('f', p);
      return n;
    });
    setPane('file');
    setTreeOpen(false);
  };

  const pendingPaths = useMemo(() => new Set((pending.data?.changes || []).flatMap(c => c.files.map(f => f.path))), [pending.data]);
  const pendingHere = (pending.data?.changes || []).find(c => c.files.some(f => f.path === selected))?.id ?? null;

  const openChange = (id: number | null) => {
    setFocus(id);
    setDrawer(true);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append('file', f);
    setUploading(true);
    try {
      const r = await api<{ done: { name: string }[]; failed: { name: string; error: string }[]; runId: number | null }>(`/courses/${cid}/kb/upload`, { body: fd });
      if (r.done.length) toast.success(`交了 ${r.done.length} 份资料`, r.runId ? '整理助手开始整理了' : '整理助手正在忙，等它做完再跟它说一声');
      for (const f of r.failed) toast.error(`${f.name} 没交上`, f.error);
      setPane('keeper');
      qc.invalidateQueries({ queryKey: ['kb-runs', cid] });
      qc.invalidateQueries({ queryKey: ['kb-tree', cid] });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  if (course.error) return <ErrorState error={course.error} onRetry={() => course.refetch()} />;
  if (!course.data) return <PageLoading />;
  const pendingCount = pending.data?.changes.length ?? course.data.pending;
  const treeView = tree.data && <FileTree files={tree.data.files} selected={selected} onSelect={select} pending={pendingPaths} />;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 px-1">
        <h1 className="min-w-0 flex-1 truncate text-[20px] font-semibold tracking-tight text-ink">{course.data.course.name}</h1>
        <Button className="hidden lg:inline-flex xl:hidden" icon={<FolderTree className="size-4" />} onClick={() => setTreeOpen(true)}>
          目录
        </Button>
        <Button icon={<FileStack className="size-4" />} onClick={() => openChange(null)}>
          改动
          {pendingCount > 0 && (
            <Badge tone="brand" className="ml-1.5">
              {pendingCount} 待确认
            </Badge>
          )}
        </Button>
        <Button variant="primary" icon={<Upload className="size-4" />} loading={uploading} onClick={() => fileInput.current?.click()}>
          交资料
        </Button>
        <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={e => upload(e.target.files)} />
      </div>
      <div className="px-1 lg:hidden">
        <Segmented
          value={pane}
          onChange={v => setPane(v as typeof pane)}
          options={[
            { value: 'tree', label: '目录' },
            { value: 'file', label: '内容' },
            { value: 'keeper', label: '整理助手' },
          ]}
        />
      </div>
      {/* 宽屏三栏；中等宽度两栏，目录放进抽屉；手机一次一栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[240px_minmax(0,1fr)_380px]">
        <Card padded={false} className={cn('min-h-0 overflow-y-auto lg:hidden xl:block', pane !== 'tree' && 'hidden')}>
          {treeView}
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden lg:block', pane !== 'file' && 'hidden')}>
          <FileViewer cid={cid} path={selected} onOpenChange={openChange} pendingHere={pendingHere} />
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden lg:block', pane !== 'keeper' && 'hidden')}>
          <KeeperPanel cid={cid} live={live} onOpenChange={openChange} onUpload={() => fileInput.current?.click()} />
        </Card>
      </div>
      <Drawer open={treeOpen} onClose={() => setTreeOpen(false)} title="目录" side="left" width={300}>
        {treeView}
      </Drawer>
      <ChangesDrawer cid={cid} open={drawer} onClose={() => setDrawer(false)} focus={focus} setFocus={setFocus} />
    </div>
  );
}

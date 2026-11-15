import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Upload } from 'lucide-react';
import { useAuth } from '../../lib/store';
import { Card, ErrorState, PageLoading, Segmented, Skeleton, cn } from '../../components/ui';
import { ChangeDetail, ChangesList } from './Changes';
import { Files } from './Files';
import { FileViewer } from './FileViewer';
import { HandInButton, KeeperPanel, type KeeperHandle } from './KeeperPanel';
import { TA, useChanges, useCourse, useKbStream, useTree } from './data';
import { pickedFromDrop, type Picked } from './intake';

export function KnowledgeBasePage() {
  const cid = Number(useParams().id);
  const userId = useAuth((state) => state.user?.id);
  return <KnowledgeBaseContent key={`${userId}:${cid}`} cid={cid} />;
}

/**
 * 点进一个知识库：中间像电脑文件夹那样一格一格摆着文件夹和文件，点文件夹进去、点文件翻开看；右边是这个知识库的整理助手。
 * 怎么分文件夹由整理助手定。交资料、跟它说话、它改了什么都在右边；看改动在中间。
 * 上面路径的「全部」回到最外层，所有知识库摆在一起，改名、删除在那里。
 */
function KnowledgeBaseContent({ cid }: { cid: number }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toTop = () => navigate('/knowledge');
  const course = useCourse(cid);
  const tree = useTree(cid);
  const pending = useChanges(cid, 'pending');
  const keeper = useRef<KeeperHandle>(null);
  const opened = params.get('f');
  useKbStream(cid, (operations) => {
    const operation = operations.find((op) => op.from === opened || (op.deleted && op.path === opened));
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
  const [pane, setPane] = useState<'page' | 'keeper'>('keeper');

  const files = tree.data?.files || [];
  const wanted = params.get('d') || '';
  // 文件夹被整理助手挪走或清空了，就回到最外面
  const dir = wanted && files.some((f) => f.path.startsWith(wanted + '/')) ? wanted : '';
  const changeId = Number(params.get('change')) || null;
  const listing = params.get('v') === 'changes';

  const update = (fn: (n: URLSearchParams) => void) =>
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      fn(n);
      return n;
    });
  const openDir = (p: string) => {
    update((n) => {
      if (p) n.set('d', p);
      else n.delete('d');
      n.delete('f');
      n.delete('v');
      n.delete('change');
    });
    setPane('page');
  };
  const select = (p: string) => {
    update((n) => {
      n.set('f', p);
      n.delete('v');
      n.delete('change');
    });
    setPane('page');
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
  // 交的资料由整理助手接着读、分进文件夹；手机上切到它那一栏看进度
  const handIn = (picked: Picked[]) => {
    setPane('keeper');
    keeper.current?.handIn(picked);
  };

  const paths = useMemo(() => (tree.data?.files || []).map((f) => f.path), [tree.data]);
  const pendingPaths = useMemo(() => new Set((pending.data?.changes || []).flatMap((c) => c.files.map((f) => f.path))), [pending.data]);
  const pendingHere = (pending.data?.changes || []).find((c) => c.files.some((f) => f.path === opened))?.id ?? null;

  if (course.error) return <ErrorState error={course.error} onRetry={() => course.refetch()} />;
  if (!course.data) return <PageLoading />;
  const kb = course.data.knowledgeBase,
    archived = kb.status === 'archived';
  const filesDragged = (e: React.DragEvent) => !archived && e.dataTransfer.types.includes('Files');

  const empty = (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <img src="/agents/keeper.webp" alt="" className="size-32 animate-float rounded-full shadow-md" draggable={false} />
      {archived ? (
        <p className="text-[14px] text-ink-3">这个学期没有留下内容</p>
      ) : (
        <HandInButton size="md" variant="primary" onPick={handIn} />
      )}
    </div>
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
  ) : opened ? (
    <FileViewer
      key={cid}
      cid={cid}
      kbName={kb.name}
      path={opened}
      paths={paths}
      onSelect={select}
      onBack={() => openDir(dir)}
      onTop={toTop}
      onOpenDir={openDir}
      onOpenChange={openChange}
      pendingHere={pendingHere}
    />
  ) : tree.error ? (
    <ErrorState error={tree.error} onRetry={() => tree.refetch()} />
  ) : !tree.data ? (
    <Skeleton className="m-4 h-48" />
  ) : (
    <Files
      cid={cid}
      kbName={kb.name}
      files={files}
      dir={dir}
      onTop={toTop}
      onOpenDir={openDir}
      onOpenFile={select}
      pending={pendingPaths}
      empty={empty}
      actions={!archived && <HandInButton variant="secondary" compact onPick={handIn} />}
    />
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
      <div className="px-1 lg:hidden">
        <Segmented
          value={pane}
          onChange={setPane}
          options={[
            { value: 'page', label: '文件' },
            { value: 'keeper', label: TA.name },
          ]}
        />
      </div>
      {/* 宽屏两栏：文件、整理助手；手机一次一栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] min-[90rem]:grid-cols-[minmax(0,1fr)_360px] min-[107.5rem]:grid-cols-[minmax(0,1fr)_384px]">
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'page' && 'max-lg:hidden')}>
          {page}
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'keeper' && 'max-lg:hidden')}>
          <KeeperPanel
            ref={keeper}
            kbId={cid}
            file={opened}
            onOpenChange={(kb, id) => (kb === cid ? openChange(id) : navigate(`/knowledge/${kb}?change=${id}`))}
            onOpenChanges={openChanges}
          />
        </Card>
      </div>
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { toast, useAuth } from '../../lib/store';
import { useCrumbs } from '../../components/layout/Crumbs';
import { Card, ErrorState, PageLoading, SearchInput, Segmented, cn } from '../../components/ui';
import { ChangeDetail, ChangesList } from './Changes';
import { SearchResults, Shelf, layoutOf, useDebounced } from './Files';
import { FileViewer } from './FileViewer';
import { KeeperPanel, type KeeperHandle } from './KeeperPanel';
import { KnowledgeTools } from './Manage';
import { CardsSkeleton, FolderGlyph, WritingCard } from './Cards';
import { ActivityList, Sentence } from './Activity';
import { DropTray, useHandIn } from './DropTray';
import { TA, fileDir, fileTitle, plainPath, plainText, useChange, useChanges, useCourse, useKbStream, useTree, type Change, type TreeFile } from './data';
import { pickedFromDrop, type Picked } from './intake';
import { activitiesOf, folderName, isOriginal, nameOf, originsOf, piecesText, sentencesOf, suggestionsFor, touchedAt, type Piece } from './insight';

export function KnowledgeBasePage() {
  const cid = Number(useParams().id);
  const userId = useAuth((state) => state.user?.id);
  return <KnowledgeBaseContent key={`${userId}:${cid}`} cid={cid} />;
}

/** 「11 篇笔记 · 7 份原件 · 2 个文件夹」 */
function countLine(notes: number, originals: number, folders = 0) {
  return [notes && `${notes} 篇笔记`, originals && `${originals} 份原件`, folders && `${folders} 个文件夹`].filter(Boolean).join(' · ');
}

/**
 * 点进一个知识库：最上面是库名和交资料的地方，接着「最近」助教整理了什么，下面按文件夹摆着笔记和原件，
 * 笔记能看到写了什么、从哪份原件来。点开一篇在中间翻着看；右边是 CoT 助教（只摆在知识库页说过的话）。
 * 现在在哪写在顶栏（知识库 › 王建国的知识库 › 第7章），回去点顶栏。
 */
function KnowledgeBaseContent({ cid }: { cid: number }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const course = useCourse(cid);
  const tree = useTree(cid);
  const pending = useChanges(cid, 'pending');
  const all = useChanges(cid);
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
  // 手机上一次只放一栏：先看资料
  const [pane, setPane] = useState<'page' | 'keeper'>('page');
  const [q, setQ] = useState('');
  const term = useDebounced(q);

  const files = useMemo(() => tree.data?.files || [], [tree.data]);
  const changes = useMemo(() => all.data?.changes || [], [all.data]);
  const wanted = params.get('d') || '';
  // 文件夹被整理助手挪走或清空了，就回到最外面
  const dir = wanted && files.some((f) => f.path.startsWith(wanted + '/')) ? wanted : '';
  const changeId = Number(params.get('change')) || null;
  const listing = params.get('v') === 'changes';

  const origins = useMemo(() => originsOf(files, changes), [files, changes]);
  const touched = useMemo(() => touchedAt(changes), [changes]);
  const activities = useMemo(() => activitiesOf(changes, files).map((a) => ({ ...a, kbId: cid })), [changes, files, cid]);
  const sentences = useMemo(() => sentencesOf(changes, files), [changes, files]);
  const suggestions = useMemo(() => suggestionsFor(files, origins), [files, origins]);
  const pendingPaths = useMemo(() => new Set((pending.data?.changes || []).flatMap((c) => c.files.map((f) => f.path))), [pending.data]);
  const pendingHere = (pending.data?.changes || []).find((c) => c.files.some((f) => f.path === opened))?.id ?? null;
  const status = useHandIn(cid);
  const shownChange = useChange(cid, changeId).data?.change;
  // 助教这会儿在后台改的、在写的笔记：卡片上标「在改」，新的先摆一张「在写」的空卡片
  const { working, writing } = useMemo(() => {
    const known = new Set(files.map((f) => f.path));
    const live = status.touching.filter((t) => t.kbId === cid || t.kbId === null).map((t) => t.path);
    return { working: new Set(live.filter((p) => known.has(p))), writing: live.filter((p) => !known.has(p) && /\.md$/i.test(p)) };
  }, [status.touching, files, cid]);

  const kb = course.data?.knowledgeBase;
  const archived = kb?.status === 'archived';
  const here = `/knowledge/${cid}`;
  const at = (p: string) => `${here}?d=${encodeURIComponent(p)}`;
  // 顶栏的位置：知识库 › 王建国的知识库 › 文件夹… › 这一页
  const folderOf = opened ? fileDir(opened) : dir;
  const folderCrumbs = folderOf
    ? folderOf.split('/').map((name, i, parts) => ({ label: folderName(name), to: at(parts.slice(0, i + 1).join('/')) }))
    : [];
  const deeper = !!(opened || changeId || listing || dir);
  useCrumbs([
    { label: '知识库', to: '/knowledge' },
    { label: kb?.name, to: deeper ? here : undefined },
    ...(changeId
      ? [{ label: '改动', to: `${here}?v=changes` }, { label: shownChange ? changeTitle(shownChange, sentences.get(shownChange.id)) : null }]
      : listing
        ? [{ label: '改动' }]
        : opened
          ? [...folderCrumbs, { label: displayTitle(opened, files) }]
          : folderCrumbs.map((c, i) => (i === folderCrumbs.length - 1 ? { label: c.label } : c))),
  ]);

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
    setQ('');
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
  // 交资料框、整页拖进来的：马上发给助教整理；助教正忙就先摆在右边输入框上方（手机上切过去看）
  const handIn = (picked: Picked[]) => {
    if (!picked.length) return;
    const sent = keeper.current?.handInNow?.(picked);
    if (sent) return;
    setPane('keeper');
    toast.info('助教这会儿在回话', '文件先放在输入框上了，它回完你点发送');
  };

  if (course.error) return <ErrorState error={course.error} onRetry={() => course.refetch()} />;
  if (!kb) return <PageLoading />;
  const filesDragged = (e: React.DragEvent) => !archived && e.dataTransfer.types.includes('Files');

  const { here: loose, folders } = layoutOf(files, dir);
  const scope = dir ? files.filter((f) => f.path.startsWith(dir + '/')) : files;
  const notesCount = scope.filter((f) => !isOriginal(f)).length;
  const meta = [
    countLine(notesCount, scope.length - notesCount, dir ? folders.length : 0),
    !dir && kb.term,
    archived && '已封存，只能查阅',
  ]
    .filter(Boolean)
    .join(' · ');

  const overview = (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-5 sm:px-6 sm:pt-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {dir ? (
            <FolderGlyph size={52} />
          ) : (
            <img src="/illustrations/kb/books.webp" alt="" draggable={false} className="size-14 shrink-0 select-none object-contain sm:size-16" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[18px] font-semibold leading-tight text-ink sm:text-[24px]">{dir ? folderName(dir) : kb.name}</h1>
            {meta && <p className="mt-1 truncate text-[14px] text-ink-3">{meta}</p>}
            {!dir && kb.pending > 0 && (
              <button type="button" onClick={openChanges} className="mt-1 text-[14px] font-medium text-brand-ink hover:underline hover:underline-offset-4">
                有 {kb.pending} 处改动等你确认
              </button>
            )}
          </div>
          {files.length > 0 && <SearchInput value={q} onChange={setQ} placeholder="找笔记、原件" className="w-full max-sm:order-last sm:w-56" />}
          {!dir && <KnowledgeTools kb={kb} onDeleted={() => navigate('/knowledge')} />}
        </div>
        {term ? (
          <div className="mt-6">
            <SearchResults cid={cid} term={term} files={files} onOpenFile={select} />
          </div>
        ) : !tree.data ? (
          <div className="mt-8">{tree.error ? <ErrorState error={tree.error} onRetry={() => tree.refetch()} /> : <CardsSkeleton />}</div>
        ) : !files.length ? (
          <>
            {archived ? (
              <p className="mt-10 text-center text-[15px] text-ink-3">这个学期没有留下内容</p>
            ) : (
              <DropTray big className="mt-6" onPick={handIn} status={status} onOpenChange={(kbId, id) => (kbId === cid ? openChange(id) : navigate(`/knowledge/${kbId}?change=${id}`))} />
            )}
            {writing.length > 0 && (
              <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-3">
                {writing.map((p) => (
                  <WritingCard key={p} path={p} />
                ))}
              </div>
            )}
            <ActivityList className="mt-8" items={activities} onOpenFile={(_, p) => select(p)} onOpenChange={(_, id) => openChange(id)} onOpenAll={openChanges} />
          </>
        ) : (
          <>
            {!dir && !archived && (
              <DropTray className="mt-6" onPick={handIn} status={status} onOpenChange={(kbId, id) => (kbId === cid ? openChange(id) : navigate(`/knowledge/${kbId}?change=${id}`))} />
            )}
            {!dir && <ActivityList className="mt-7" items={activities} limit={3} onOpenFile={(_, p) => select(p)} onOpenChange={(_, id) => openChange(id)} onOpenAll={openChanges} />}
            <div className={cn(dir ? 'mt-7' : 'mt-9')}>
              {!dir && (loose.length > 0 || folders.length > 0) && <h2 className="mb-3 text-[16px] font-semibold text-ink">笔记和原件</h2>}
              <Shelf
                cid={cid}
                files={files}
                dir={dir}
                origins={origins}
                touched={touched}
                pending={pendingPaths}
                working={working}
                writing={writing}
                onOpenDir={openDir}
                onOpenFile={select}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );

  const page = changeId ? (
    <ChangeDetail
      cid={cid}
      id={changeId}
      headline={sentences.get(changeId) && <Sentence pieces={sentences.get(changeId)!} onOpenFile={select} />}
    />
  ) : listing ? (
    <ChangesList cid={cid} onOpen={openChange} describe={(c) => (sentences.get(c.id) ? piecesText(sentences.get(c.id)!) : null)} />
  ) : opened ? (
    <FileViewer key={cid} cid={cid} path={opened} files={files} origins={origins} onSelect={select} onOpenDir={openDir} onOpenChange={openChange} pendingHere={pendingHere} />
  ) : (
    overview
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
        void pickedFromDrop(e.dataTransfer).then(handIn);
      }}
    >
      {dragging > 0 && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand/60 bg-brand-soft/80">
          <div className="flex flex-col items-center gap-3">
            <img src="/illustrations/kb/drop.webp" alt="" className="h-32 w-auto" draggable={false} />
            <p className="text-[18px] font-semibold text-brand-ink">松手就交给助教整理</p>
          </div>
        </div>
      )}
      <div className="px-1 lg:hidden">
        <Segmented
          value={pane}
          onChange={setPane}
          options={[
            { value: 'page', label: '资料' },
            { value: 'keeper', label: TA.name },
          ]}
        />
      </div>
      {/* 宽屏两栏：资料、CoT 助教；手机一次一栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] min-[90rem]:grid-cols-[minmax(0,1fr)_360px] min-[107.5rem]:grid-cols-[minmax(0,1fr)_384px]">
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'page' && 'max-lg:hidden')}>
          {page}
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'keeper' && 'max-lg:hidden')}>
          <KeeperPanel
            ref={keeper}
            kbId={cid}
            file={opened}
            suggestions={suggestions}
            onOpenChange={(kb, id) => (kb === cid ? openChange(id) : navigate(`/knowledge/${kb}?change=${id}`))}
            onOpenChanges={openChanges}
          />
        </Card>
      </div>
    </div>
  );
}

/** 顶栏里一页的名字：原件用交的时候的名字 */
function displayTitle(path: string, files: TreeFile[]) {
  const f = files.find((x) => x.path === path);
  return f ? nameOf(f) : fileTitle(path) || plainPath(path);
}

/** 顶栏里一次改动的名字：那一句话太长就截一截 */
function changeTitle(c: Change, pieces?: Piece[]) {
  const text = pieces ? piecesText(pieces) : plainText(c.title);
  return text.length > 18 ? text.slice(0, 17) + '…' : text;
}

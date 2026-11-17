import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { fmtTime } from '../../lib/format';
import { Card, ErrorState, Segmented, Skeleton, cn } from '../../components/ui';
import { TA, changesQuery, treeQuery, useKnowledgeBases, usePrefetchKb, type Change, type KnowledgeBase, type TreeFile } from './data';
import { KeeperPanel, type KeeperHandle } from './KeeperPanel';
import { KnowledgeTools } from './Manage';
import { NewKnowledgeBaseModal } from './NewKnowledgeBase';
import { pickedFromDrop, type Picked } from './intake';
import { NoteCard, WritingCard } from './Cards';
import { ActivityList, type KbActivity } from './Activity';
import { DropTray, useHandIn } from './DropTray';
import { activitiesOf, isOriginal, nameOf, originsOf, suggestionsFor, touchedAt, type Origins } from './insight';

const byName = (a: TreeFile, b: TreeFile) => nameOf(a).localeCompare(nameOf(b), 'zh', { numeric: true });

/**
 * 一个知识库摆成一段：书本图标、名字、几篇笔记几份原件、最近哪天整理过；下面是最近动过的三篇笔记，看得到写了什么。
 * 名字旁边的「⋯」改名、删除。
 */
function KbShelf({
  kb,
  files,
  loading,
  origins,
  touched,
  lastAt,
  live,
  onOpen,
  onOpenFile,
  onHover,
}: {
  kb: KnowledgeBase;
  files: TreeFile[];
  loading: boolean;
  origins: Origins;
  touched: Map<string, { at: number; added: boolean }>;
  lastAt: number | null;
  /** 助教这会儿在这个库里写、改的笔记 */
  live: string[];
  onOpen: () => void;
  onOpenFile: (path: string) => void;
  onHover: () => void;
}) {
  const notes = files.filter((f) => !isOriginal(f));
  const originals = files.filter(isOriginal);
  const known = new Set(files.map((f) => f.path));
  const writing = live.filter((p) => !known.has(p) && /\.md$/i.test(p)).slice(0, 3);
  const working = new Set(live.filter((p) => known.has(p)));
  // 正在改的排最前，再是最近动过的
  const rank = (f: TreeFile) => (working.has(f.path) ? Infinity : (touched.get(f.path)?.at ?? 0));
  const recent = [...notes].sort((a, b) => rank(b) - rank(a) || byName(a, b)).slice(0, Math.max(0, 3 - writing.length));
  const meta = [
    notes.length && `${notes.length} 篇笔记`,
    originals.length && `${originals.length} 份原件`,
    kb.term,
    kb.status === 'archived' && '已封存',
    lastAt && `${fmtTime(lastAt, false)}整理过`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onOpen} onPointerEnter={onHover} onFocus={onHover} className="group flex min-w-0 flex-1 items-center gap-3 text-left">
          <img src="/illustrations/kb/books.webp" alt="" draggable={false} className="size-12 shrink-0 select-none object-contain transition-transform duration-200 group-hover:-rotate-3 group-hover:scale-105" />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-[18px] font-semibold text-ink transition-colors group-hover:text-brand-ink">{kb.name}</span>
              {kb.pending > 0 && <span className="shrink-0 rounded-full bg-brand px-2 text-[13px] font-medium leading-[22px] text-white">{kb.pending} 处等你确认</span>}
            </span>
            {meta && <span className="mt-0.5 block truncate text-[14px] text-ink-3">{meta}</span>}
          </span>
        </button>
        <KnowledgeTools kb={kb} />
        <button type="button" onClick={onOpen} className="hidden shrink-0 items-center gap-0.5 text-[14px] text-brand-ink transition-colors hover:text-brand sm:inline-flex">
          {files.length ? `全部 ${files.length} 份` : '打开'}
          <ChevronRight className="size-4" />
        </button>
      </div>
      {loading ? (
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[176px] rounded-2xl" />
          ))}
        </div>
      ) : recent.length + writing.length ? (
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-3">
          {writing.map((p) => (
            <WritingCard key={`writing:${p}`} path={p} />
          ))}
          {recent.map((f) => (
            <NoteCard
              key={f.path}
              cid={kb.id}
              file={f}
              originals={originals}
              origins={origins}
              touched={touched.get(f.path)}
              working={working.has(f.path)}
              onOpen={onOpenFile}
            />
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="mt-4 w-full rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-[15px] text-ink-2 transition-colors hover:border-brand/50 hover:text-brand-ink"
        >
          {originals.length ? `${originals.length} 份原件，还没整理成笔记` : '还没有资料'}
        </button>
      )}
      {files.length > 0 && (
        <button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-0.5 text-[14px] text-brand-ink sm:hidden">
          全部 {files.length} 份
          <ChevronRight className="size-4" />
        </button>
      )}
    </section>
  );
}

/**
 * 知识库最外层：老师的资料空间。最上面是交资料的地方（交到哪个库由助教看内容定），接着「最近」助教整理了什么，
 * 下面每个知识库一段，摆着最近动过的笔记。右边是 CoT 助教，只有一个，管所有的知识库。
 */
export function KnowledgeHomePage() {
  useCrumbs([{ label: '知识库' }]);
  const navigate = useNavigate();
  const prefetch = usePrefetchKb();
  const bases = useKnowledgeBases();
  const list = useMemo(() => bases.data?.knowledgeBases || [], [bases.data]);
  // 每个库的文件和改动；顺便取好，点进去不用再等
  const trees = useQueries({ queries: list.map((k) => treeQuery(k.id)) });
  const logs = useQueries({ queries: list.map((k) => changesQuery(k.id)) });
  const keeper = useRef<KeeperHandle>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(0);
  // 手机上一次只放一栏：先看资料
  const [pane, setPane] = useState<'page' | 'keeper'>('page');
  const status = useHandIn(null);

  // 文件和改动哪个库的变了才重算
  const version = [...trees, ...logs].map((r) => r.dataUpdatedAt).join(',');
  const shelves = useMemo(
    () =>
      list.map((kb, i) => {
        const files = trees[i]?.data?.files || [];
        const changes: Change[] = logs[i]?.data?.changes || [];
        const origins = originsOf(files, changes);
        const activities: KbActivity[] = activitiesOf(changes, files).map((a) => ({ ...a, kbId: kb.id, kbName: list.length > 1 ? kb.name : undefined }));
        return { kb, files, loading: !trees[i]?.data, origins, touched: touchedAt(changes), activities, lastAt: activities[0]?.at ?? null };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, version],
  );
  const activities = useMemo(() => shelves.flatMap((s) => s.activities).sort((a, b) => b.at - a.at), [shelves]);
  // 先说最近整理过的那个库
  const suggestions = useMemo(
    () => [...new Set([...shelves].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).flatMap((s) => suggestionsFor(s.files, s.origins)))].slice(0, 3),
    [shelves],
  );

  const handIn = (picked: Picked[]) => {
    if (!picked.length) return;
    const sent = keeper.current?.handInNow?.(picked);
    if (!sent) setPane('keeper');
  };
  const openFile = (kbId: number, path: string) => navigate(`/knowledge/${kbId}?f=${encodeURIComponent(path)}`);
  const openChange = (kbId: number, id: number) => navigate(`/knowledge/${kbId}?change=${id}`);
  const filesDragged = (e: React.DragEvent) => list.length > 0 && e.dataTransfer.types.includes('Files');

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
            { value: 'page', label: '知识库' },
            { value: 'keeper', label: TA.name },
          ]}
        />
      </div>
      {/* 宽屏两栏：资料空间、CoT 助教；手机一次一栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] min-[90rem]:grid-cols-[minmax(0,1fr)_360px] min-[107.5rem]:grid-cols-[minmax(0,1fr)_384px]">
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'page' && 'max-lg:hidden')}>
          <div className="h-full min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-5 sm:px-6 sm:pt-6">
              {bases.error ? (
                <ErrorState error={bases.error} onRetry={() => bases.refetch()} />
              ) : !bases.data ? (
                <Skeleton className="h-[104px] rounded-2xl" />
              ) : !list.length ? (
                <div className="flex flex-col items-center px-6 py-16 text-center">
                  <img src="/illustrations/kb/books.webp" alt="" draggable={false} className="size-36 select-none object-contain" />
                  <p className="mt-4 text-[18px] font-semibold text-ink">还没有知识库</p>
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-4 text-[15px] font-medium text-white shadow-xs transition-colors hover:bg-brand-hover"
                  >
                    <Plus className="size-4" />
                    新建知识库
                  </button>
                </div>
              ) : (
                <>
                  <DropTray onPick={handIn} status={status} onOpenChange={openChange} />
                  <ActivityList
                    className="mt-7"
                    items={activities}
                    onOpenFile={openFile}
                    onOpenChange={openChange}
                    onOpenAll={list.length === 1 ? () => navigate(`/knowledge/${list[0].id}?v=changes`) : undefined}
                  />
                  <div className="mt-9 space-y-10">
                    {shelves.map((s) => (
                      <KbShelf
                        key={s.kb.id}
                        kb={s.kb}
                        files={s.files}
                        loading={s.loading}
                        origins={s.origins}
                        touched={s.touched}
                        lastAt={s.lastAt}
                        live={status.touching.filter((t) => t.kbId === s.kb.id || (t.kbId === null && list.length === 1)).map((t) => t.path)}
                        onOpen={() => navigate(`/knowledge/${s.kb.id}`)}
                        onOpenFile={(path) => openFile(s.kb.id, path)}
                        onHover={() => prefetch(s.kb.id)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="mt-10 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong py-4 text-[15px] text-ink-2 transition-colors hover:border-brand/50 hover:bg-brand-soft/40 hover:text-brand-ink"
                  >
                    <Plus className="size-4" />
                    新建知识库
                  </button>
                </>
              )}
            </div>
          </div>
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'keeper' && 'max-lg:hidden')}>
          <KeeperPanel ref={keeper} kbId={null} suggestions={suggestions} onOpenChange={openChange} />
        </Card>
      </div>
      <NewKnowledgeBaseModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          navigate(`/knowledge/${id}`);
        }}
      />
    </div>
  );
}

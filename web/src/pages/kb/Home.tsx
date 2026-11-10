import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { BookOpen, Plus, Upload } from 'lucide-react';
import { Card, ErrorState, Segmented, Skeleton, cn } from '../../components/ui';
import { treeQuery, useKnowledgeBases, usePrefetchKb, type KnowledgeBase } from './data';
import { Crumbs } from './Files';
import { KeeperPanel, type KeeperHandle } from './KeeperPanel';
import { KnowledgeTools } from './Manage';
import { NewKnowledgeBaseModal } from './NewKnowledgeBase';
import { pickedFromDrop } from './intake';

/** 一个知识库：像电脑里的 C 盘、D 盘，横着的一格，图标和文件夹不一样；右上角「⋯」改名、删除 */
function Drive({ kb, count, onOpen, onHover }: { kb: KnowledgeBase; count?: number; onOpen: () => void; onHover: () => void }) {
  const meta = [kb.term, kb.status === 'archived' && '已封存', count !== undefined && `${count} 份文件`].filter(Boolean).join(' · ');
  return (
    <div className="group relative transition-transform duration-150 hover:-translate-y-0.5">
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={onHover}
        onFocus={onHover}
        className="flex w-full min-w-0 items-center gap-4 rounded-xl border border-line bg-surface py-4 pl-4 pr-11 text-left transition-[border-color,box-shadow] duration-150 group-hover:border-brand/35 group-hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-sm">
          <BookOpen className="size-7" strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 break-words text-[15px] font-medium leading-snug text-ink">{kb.name}</span>
            {kb.pending > 0 && (
              <span className="shrink-0 rounded-full bg-brand px-1.5 text-[11.5px] font-semibold leading-[18px] text-white" title="有改动等你确认">
                {kb.pending}
              </span>
            )}
          </span>
          {meta && <span className="mt-1 block text-[12.5px] text-ink-3">{meta}</span>}
        </span>
      </button>
      <div className="absolute right-2 top-2">
        <KnowledgeTools kb={kb} />
      </div>
    </div>
  );
}

/**
 * 知识库最外层：左边老师所有的知识库摆在一起，最后一格新建；点进一个才是文件夹和文件。
 * 右边是整理助手：只有一个，管所有的知识库。在这里跟它说话、交资料，它自己看该放进哪个库。
 */
export function KnowledgeHomePage() {
  const navigate = useNavigate();
  const prefetch = usePrefetchKb();
  const bases = useKnowledgeBases();
  const list = bases.data?.knowledgeBases || [];
  // 每个知识库有多少份文件；顺便把目录取好，点进去不用再等
  const trees = useQueries({ queries: list.map((k) => treeQuery(k.id)) });
  const keeper = useRef<KeeperHandle>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(0);
  // 手机上一次只放一栏
  const [pane, setPane] = useState<'page' | 'keeper'>('keeper');
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
            { value: 'page', label: '知识库' },
            { value: 'keeper', label: '整理助手' },
          ]}
        />
      </div>
      {/* 宽屏两栏：知识库、整理助手；手机一次一栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] min-[90rem]:grid-cols-[minmax(0,1fr)_360px] min-[107.5rem]:grid-cols-[minmax(0,1fr)_384px]">
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'page' && 'max-lg:hidden')}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b border-line px-3 sm:px-4">
              <Crumbs here onTop={() => {}} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              {bases.error ? (
                <ErrorState error={bases.error} onRetry={() => bases.refetch()} />
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {!bases.data ? (
                    <Skeleton className="h-[90px] rounded-xl" />
                  ) : (
                    list.map((k, i) => (
                      <Drive key={k.id} kb={k} count={trees[i]?.data?.files.length} onOpen={() => navigate(`/knowledge/${k.id}`)} onHover={() => prefetch(k.id)} />
                    ))
                  )}
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="flex w-full items-center gap-4 rounded-xl border border-dashed border-line-strong p-4 text-left text-ink-2 transition-colors hover:border-brand/50 hover:bg-brand-soft/40 hover:text-brand-ink"
                  >
                    <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-surface-2">
                      <Plus className="size-6" />
                    </span>
                    <span className="text-[15px] font-medium">新建知识库</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </Card>
        <Card padded={false} className={cn('min-h-0 overflow-hidden rounded-2xl lg:block', pane !== 'keeper' && 'max-lg:hidden')}>
          <KeeperPanel ref={keeper} kbId={null} onOpenChange={(kb, id) => navigate(`/knowledge/${kb}?change=${id}`)} />
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

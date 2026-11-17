import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Folder } from 'lucide-react';
import { fmtTime } from '../../lib/format';
import { Skeleton, cn } from '../../components/ui';
import { usePreview, type TreeFile } from './data';
import { FileTypeIcon, typeLabel } from './FileCard';
import { folderName, mentionedOriginals, nameOf, notePreview, pathName, type Origins } from './insight';

/** 滚到跟前才去取笔记正文（几十篇笔记不一次全取） */
function useSeen(ref: RefObject<Element | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

const TEN_MINUTES = 10 * 60_000;
/** 助教正在改的、刚写好、刚改过、等老师确认的，卡片右上角标一下 */
function Mark({ fresh, pending, working }: { fresh?: { at: number; added: boolean } | null; pending?: boolean; working?: boolean }) {
  if (working)
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-2 text-[13px] leading-[22px] text-white">
        <span className="size-1.5 animate-pulse rounded-full bg-white" />
        在改
      </span>
    );
  if (pending) return <span className="shrink-0 rounded-full bg-brand-soft px-2 text-[13px] leading-[22px] text-brand-ink">等你确认</span>;
  if (!fresh || Date.now() - fresh.at > TEN_MINUTES) return null;
  return <span className="shrink-0 rounded-full bg-ok-soft px-2 text-[13px] leading-[22px] text-emerald-700 dark:text-emerald-300">{fresh.added ? '新' : '刚改过'}</span>;
}

/** 卡片里能单独点的一小段（「来自《…》」）：盖在整张卡片的按钮上面 */
function Inner({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="pointer-events-auto relative z-10 min-w-0 truncate rounded-md text-left text-brand-ink transition-colors hover:text-brand hover:underline hover:underline-offset-4"
    >
      {children}
    </button>
  );
}

/**
 * 一篇笔记：名字、开头几行，从哪份原件整理来的、哪天改的。
 * 像一页纸摆在桌上，点开整篇看。
 */
export function NoteCard({
  cid,
  file,
  originals,
  origins,
  touched,
  pending,
  working,
  onOpen,
}: {
  cid: number;
  file: TreeFile;
  /** 这个库所有的原件（笔记「出处」里写到的认得出来） */
  originals: TreeFile[];
  origins: Origins;
  touched?: { at: number; added: boolean } | null;
  pending?: boolean;
  /** 助教这会儿正在改这一篇 */
  working?: boolean;
  onOpen: (path: string) => void;
}) {
  const box = useRef<HTMLElement>(null);
  const seen = useSeen(box);
  const q = usePreview(cid, seen ? file.path : null);
  const name = pathName(file.path);
  const text = q.data?.text;
  const preview = typeof text === 'string' ? notePreview(text, name) : null;
  const said = typeof text === 'string' ? mentionedOriginals(text, originals) : [];
  const from = said.length ? said : origins.from.get(file.path) || [];
  const byPath = new Map(originals.map((o) => [o.path, o]));
  const first = from.map((p) => byPath.get(p)).find(Boolean);
  const student = q.data?.student?.name;
  return (
    <article
      ref={box}
      className={cn(
        'group relative flex flex-col rounded-2xl border bg-surface px-4 pb-3.5 pt-4 shadow-xs transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/35 hover:shadow-md sm:min-h-[176px]',
        working ? 'border-brand/50 ring-2 ring-brand/10' : touched && Date.now() - touched.at < TEN_MINUTES ? 'border-ok/40' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(file.path)}
        aria-label={name}
        className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      />
      <div className="pointer-events-none flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 break-words text-[16px] font-semibold leading-[23px] text-ink">{name}</h3>
        <Mark fresh={touched} pending={pending} working={working} />
      </div>
      <div className="pointer-events-none mt-2 min-h-[44px] sm:min-h-[66px]">
        {preview ? (
          preview.excerpt ? (
            <p className="line-clamp-2 break-words text-[14px] leading-[22px] text-ink-2 sm:line-clamp-3">{preview.excerpt}</p>
          ) : (
            <p className="text-[14px] leading-[22px] text-ink-3">还是空的</p>
          )
        ) : q.error ? (
          <p className="text-[14px] leading-[22px] text-ink-3">没读出来，点开看</p>
        ) : (
          <div className="space-y-2 pt-1">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        )}
      </div>
      <div className="pointer-events-none mt-auto flex min-w-0 items-center gap-2 pt-3 text-[13px] leading-5 text-ink-3">
        {student ? (
          <span className="min-w-0 truncate">{student}的个人记录</span>
        ) : first ? (
          <span className="flex min-w-0 items-center">
            <span className="shrink-0">来自</span>
            <Inner onClick={() => onOpen(first.path)} title={`看原件《${nameOf(first)}》`}>
              《{nameOf(first)}》
            </Inner>
            {from.length > 1 && <span className="shrink-0">等 {from.length} 份</span>}
          </span>
        ) : null}
        {touched && <span className="ml-auto shrink-0 pl-2">{fmtTime(touched.at, false)}</span>}
      </div>
    </article>
  );
}

/** 助教这会儿正在写的新笔记：还没交上来，先摆一张空卡片占着位置，写好了换成真的 */
export function WritingCard({ path }: { path: string }) {
  const where = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/').pop() : '';
  return (
    <article className="flex flex-col rounded-2xl border border-dashed border-brand/50 bg-brand-soft/30 px-4 pb-3.5 pt-4 sm:min-h-[176px]">
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 break-words text-[16px] font-semibold leading-[23px] text-ink">{pathName(path)}</h3>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-2 text-[13px] leading-[22px] text-white">
          <span className="size-1.5 animate-pulse rounded-full bg-white" />
          在写
        </span>
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-10/12" />
        <Skeleton className="h-3.5 w-1/2 max-sm:hidden" />
      </div>
      {where && <p className="mt-auto truncate pt-3 text-[13px] leading-5 text-ink-2">放在「{folderName(where)}」</p>}
    </article>
  );
}

const SHOWN_IMAGE = /^(png|jpe?g|gif|webp|bmp)$/i;
/** 原件是图片的显示小图（原件档案区的原文件；读不出来就退回图标） */
function Thumb({ cid, file }: { cid: number; file: TreeFile }) {
  const [broken, setBroken] = useState(false);
  if (broken || !file.sourceId) return null;
  return (
    <img
      src={`/api/knowledge/${cid}/sources/${encodeURIComponent(file.sourceId)}/raw`}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
      className="aspect-[4/3] w-full rounded-t-xl bg-surface-2 object-cover"
    />
  );
}

export const isImage = (f: TreeFile) => f.source?.kind === 'image' || SHOWN_IMAGE.test((f.path.match(/\.([a-z]+)\.md$/i) || [])[1] || '');

/** 一份原件：按类型上色的图标（图片显示小图）、名字、哪天交的；整理成了哪篇笔记 */
export function OriginalCard({ cid, file, origins, onOpen }: { cid: number; file: TreeFile; origins: Origins; onOpen: (path: string) => void }) {
  const name = nameOf(file);
  const kind = file.source?.kind;
  const notes = origins.to.get(file.path) || [];
  const meta = [typeLabel(name, kind), file.source ? `${fmtTime(file.source.createdAt, false)}交` : ''].filter(Boolean).join(' · ');
  const image = isImage(file) && !!file.sourceId;
  const made = notes.length > 0 && (
    <span className="flex min-w-0 items-center text-[13px] leading-5 text-ink-3">
      <span className="shrink-0">整理成</span>
      <Inner onClick={() => onOpen(notes[0])} title={`看笔记《${pathName(notes[0])}》`}>
        《{pathName(notes[0])}》
      </Inner>
      {notes.length > 1 && <span className="shrink-0">等 {notes.length} 篇</span>}
    </span>
  );
  return (
    <article className="group relative flex min-w-0 flex-col rounded-xl border border-line bg-surface shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-brand/35 hover:shadow-md">
      <button
        type="button"
        onClick={() => onOpen(file.path)}
        aria-label={`原件《${name}》`}
        className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      />
      {image && <Thumb cid={cid} file={file} />}
      <div className="pointer-events-none flex min-w-0 items-center gap-3 px-3 py-2.5">
        {!image && <FileTypeIcon name={name} kind={kind} size={40} />}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-[15px] font-medium leading-[21px] text-ink" title={name}>
            {name}
          </p>
          <p className="mt-0.5 truncate text-[13px] leading-5 text-ink-3">{meta}</p>
          {made}
        </div>
      </div>
    </article>
  );
}

/** 文件夹的小图标（和电脑上的文件夹一个颜色） */
export function FolderGlyph({ size = 28 }: { size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-lg bg-amber-400/15" style={{ width: size, height: size }}>
      <Folder className="fill-amber-400/35 text-amber-500" style={{ width: size * 0.6, height: size * 0.6 }} strokeWidth={1.9} />
    </span>
  );
}

/** 一个文件夹里还套着的文件夹：一颗小按钮，名字和里面几份 */
export function FolderChip({ name, count, onOpen }: { name: string; count: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-1.5 pr-3 text-left shadow-xs transition-[border-color,box-shadow] hover:border-brand/35 hover:shadow-md"
    >
      <FolderGlyph size={28} />
      <span className="min-w-0 truncate text-[14px] text-ink">{name}</span>
      <span className="shrink-0 text-[13px] text-ink-3">{count} 份</span>
    </button>
  );
}

export function CardsSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-[176px] rounded-2xl" />
      ))}
    </div>
  );
}

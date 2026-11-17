import type { ReactNode } from 'react';
import { File as FileIcon, FileArchive, FileCode, FileSpreadsheet, FileText, Folder, Globe, Image as ImageIcon, Presentation, X, type LucideIcon } from 'lucide-react';
import { cn } from '../../components/ui';

/**
 * 文件在对话里的样子，照微信、飞书、ChatGPT 的文件消息：白底小卡片，左边按类型上色的图标块，右边文件名，下面一行灰字。
 * Word 蓝、Excel 绿、PPT 橙、PDF 红，老师一眼认得出。
 */
type FileType = 'doc' | 'sheet' | 'slides' | 'pdf' | 'image' | 'archive' | 'code' | 'text' | 'web' | 'folder' | 'other';

const EXT: Record<string, FileType> = {
  doc: 'doc',
  docx: 'doc',
  wps: 'doc',
  odt: 'doc',
  rtf: 'doc',
  pages: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  ods: 'sheet',
  et: 'sheet',
  numbers: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  dps: 'slides',
  key: 'slides',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  heic: 'image',
  tif: 'image',
  tiff: 'image',
  svg: 'image',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  py: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  java: 'code',
  js: 'code',
  ts: 'code',
  sql: 'code',
  ipynb: 'code',
  go: 'code',
  m: 'code',
  r: 'code',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  html: 'web',
  htm: 'web',
  mhtml: 'web',
};
const KIND: Record<string, FileType> = {
  document: 'doc',
  sheet: 'sheet',
  slides: 'slides',
  pdf: 'pdf',
  image: 'image',
  archive: 'archive',
  code: 'code',
  notebook: 'code',
  text: 'text',
  web: 'web',
  iwork: 'doc',
};
const LOOK: Record<FileType, { bg: string; icon: LucideIcon; label: string; text?: string }> = {
  doc: { bg: '#2f6fed', icon: FileText, label: 'Word 文档' },
  sheet: { bg: '#15a05c', icon: FileSpreadsheet, label: 'Excel 表格' },
  slides: { bg: '#f0672a', icon: Presentation, label: 'PPT 演示' },
  pdf: { bg: '#e5443a', icon: FileText, label: 'PDF', text: 'PDF' },
  image: { bg: '#8b5cf6', icon: ImageIcon, label: '图片' },
  archive: { bg: '#d18a12', icon: FileArchive, label: '压缩包' },
  code: { bg: '#475569', icon: FileCode, label: '代码' },
  text: { bg: '#64748b', icon: FileText, label: '文本' },
  web: { bg: '#0e9fb3', icon: Globe, label: '网页' },
  folder: { bg: '#f5a524', icon: Folder, label: '文件夹' },
  other: { bg: '#94a3b8', icon: FileIcon, label: '文件' },
};

export function fileType(name: string, kind?: string | null, folder?: boolean): FileType {
  if (folder) return 'folder';
  const ext = (name.split('.').pop() || '').toLowerCase();
  return (Object.hasOwn(EXT, ext) && EXT[ext]) || (kind && Object.hasOwn(KIND, kind) && KIND[kind]) || 'other';
}
export const typeLabel = (name: string, kind?: string | null) => LOOK[fileType(name, kind)].label;

export function formatSize(bytes?: number | null) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** 按类型上色的图标块 */
export function FileTypeIcon({ name, kind, folder, size = 36, className }: { name: string; kind?: string | null; folder?: boolean; size?: number; className?: string }) {
  const look = LOOK[fileType(name, kind, folder)];
  const Icon = look.icon;
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-[10px] text-white shadow-[inset_0_-2px_0_rgba(0,0,0,.08)]', className)}
      style={{
        width: size,
        height: size,
        backgroundColor: look.bg,
        borderRadius: Math.round(size * 0.26),
      }}
    >
      {look.text ? (
        <span className="font-bold tracking-tight" style={{ fontSize: Math.round(size * 0.27) }}>
          {look.text}
        </span>
      ) : (
        <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={folder ? 2 : 1.9} fill={folder ? 'currentColor' : 'none'} fillOpacity={folder ? 0.25 : 0} />
      )}
    </span>
  );
}

/**
 * 一张文件卡片：图标块、文件名（最多两行）、下面一行灰字（类型 · 大小，或者没读出来的原因）。
 * 带 onRemove 时右上角有个叉（输入框上方还没发出去的）；带 onClick 时整张能点（文件夹展开）。
 */
export function FileCard({
  name,
  kind,
  folder,
  meta,
  bad,
  compact,
  onRemove,
  onClick,
  after,
  className,
  children,
}: {
  name: string;
  kind?: string | null;
  folder?: boolean;
  meta?: ReactNode;
  /** 灰字那行用红色（没读出来） */
  bad?: boolean;
  /** 输入框上方用的小一号：名字一行 */
  compact?: boolean;
  onRemove?: () => void;
  onClick?: () => void;
  /** 卡片右边的东西（展开箭头） */
  after?: ReactNode;
  className?: string;
  /** 卡片下面展开的内容 */
  children?: ReactNode;
}) {
  const Head = onClick ? 'button' : 'div';
  return (
    <div className={cn('relative max-w-full rounded-xl border border-line bg-surface text-left shadow-xs', compact ? 'w-[188px]' : 'w-[248px]', className)}>
      <Head
        type={onClick ? 'button' : undefined}
        onClick={onClick}
        className={cn('flex w-full items-center text-left', compact ? 'gap-2.5 px-2.5 py-2' : 'gap-3 px-3 py-2.5')}
        title={name}
      >
        <FileTypeIcon name={name} kind={kind} folder={folder} size={compact ? 30 : 36} />
        <span className="min-w-0 flex-1">
          <span className={cn('break-all font-medium leading-[1.35] text-ink', compact ? 'line-clamp-1 text-[13px]' : 'line-clamp-2 text-[14px]')}>{name}</span>
          {meta && <span className={cn('mt-0.5 block truncate text-[12px] leading-4', bad ? 'text-bad' : 'text-ink-3')}>{meta}</span>}
        </span>
        {after}
      </Head>
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label="去掉"
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-ink/70 text-white shadow-sm hover:bg-ink"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

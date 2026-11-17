import { useRef } from 'react';
import { Paperclip, X } from 'lucide-react';
import { toast } from '../../lib/store';
import { IconButton, Spinner } from '../../components/ui';
import { FileCard, formatSize, typeLabel } from '../kb/FileCard';
import { pickedFromList, type Picked } from '../kb/intake';
import type { LessonFile } from './data';

/**
 * 备课带文件：回形针选、拖进来、粘贴都行，
 * 选好的摆成文件卡片（跟 CoT 助教对话框里的附件一个样子），叉掉就不带了。
 * 能带什么、多大跟服务器一样（server/src/prep/files.ts，大小照交资料的规矩）。
 */
const USABLE =
  /\.(pdf|pptx?|pptm|ppsx?|potx?|dps|odp|docx?|docm|dotx?|wps|odt|rtf|png|jpe?g|gif|webp|bmp|tiff?|heic|txt|md|markdown|py|ipynb|c|h|cc|cpp|hpp|java|js|jsx|ts|tsx|sql|go|rs|cs|kt|swift|rb|php|r|m|sh|json|ya?ml|xml|css)$/i;
export const ACCEPT = '.pdf,.ppt,.pptx,.doc,.docx,.wps,.rtf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.txt,.md,.py,.ipynb,.c,.cpp,.h,.java,.js,.ts,.sql,.go';
const MB = 1024 * 1024;
export const MAX_FILES = 20;

/** 挑出备课用得上的；用不上的、空的、太大的、放不下的，同一个原因的并成一句说 */
export function keepUsable(list: Picked[], have: { size: number }[], maxOne = 200 * MB): Picked[] {
  const out: Picked[] = [];
  const why = new Map<string, string[]>();
  let total = have.reduce((n, f) => n + f.size, 0);
  for (const p of list) {
    const name = p.path.split('/').pop() || p.path;
    const no = !USABLE.test(name)
      ? '备课用不上，能带 PDF、PPT、Word、图片、文字和代码文件'
      : !p.file.size
        ? '是空文件'
        : p.file.size > maxOne
          ? `太大了，一份最大 ${maxOne / MB} MB`
          : have.length + out.length >= MAX_FILES
            ? `放不下了，一次最多带 ${MAX_FILES} 份`
            : total + p.file.size > 500 * MB
              ? '放不下了，一次带的一共最多 500 MB'
              : '';
    if (no) why.set(no, [...(why.get(no) || []), `「${name}」`]);
    else {
      out.push(p);
      total += p.file.size;
    }
  }
  for (const [no, names] of why) toast.error(`${names.slice(0, 3).join('')}${names.length > 3 ? ` 等 ${names.length} 份` : ''}${no}`);
  return out;
}

/** 回形针：点了直接选文件 */
export function ClipButton({ onPick, disabled }: { onPick: (files: Picked[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton label="带文件" onClick={() => input.current?.click()} disabled={disabled}>
        <Paperclip className="size-[18px]" />
      </IconButton>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = pickedFromList(e.target.files || []);
          e.target.value = '';
          if (files.length) onPick(files);
        }}
      />
    </>
  );
}

export interface Attached {
  key: string;
  name: string;
  size: number;
  /** 图片的小图（本地预览） */
  url: string | null;
  /** 还在传 */
  busy?: boolean;
}

/** 输入框上方横着排的一行：图片是小图，别的是文件卡片，右上角叉掉（照 ChatGPT、CoT 助教的输入框） */
export function AttachedRow({ list, onRemove }: { list: Attached[]; onRemove: (key: string) => void }) {
  if (!list.length) return null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-1 pb-2 pt-1.5 [&>*]:shrink-0">
      {list.map((a) =>
        a.url ? (
          <div key={a.key} className="relative" title={a.name}>
            <img src={a.url} alt={a.name} className="size-[50px] rounded-xl border border-line object-cover shadow-xs" />
            {a.busy ? (
              <span className="absolute inset-0 grid place-items-center rounded-xl bg-surface/60">
                <Spinner className="size-4" />
              </span>
            ) : (
              <button
                type="button"
                aria-label="去掉"
                onClick={() => onRemove(a.key)}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-ink/70 text-white shadow-sm hover:bg-ink"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        ) : (
          <FileCard
            key={a.key}
            compact
            name={a.name}
            meta={[typeLabel(a.name), formatSize(a.size)].filter(Boolean).join(' · ')}
            after={a.busy ? <Spinner className="size-4 shrink-0" /> : undefined}
            onRemove={a.busy ? undefined : () => onRemove(a.key)}
          />
        ),
      )}
    </div>
  );
}

/** 这节课带的文件：点开看（图片、PDF 在新标签页里直接看），别的下载；没读出来的红字写原因 */
export function LessonFiles({ lessonId, files, className }: { lessonId: number; files: LessonFile[]; className?: string }) {
  if (!files.length) return null;
  const open = (f: LessonFile) => {
    const url = `/api/prep/${lessonId}/files/${f.id}`;
    if (/\.(png|jpe?g|gif|webp|pdf)$/i.test(f.name)) window.open(`${url}?inline=1`, '_blank', 'noopener');
    else {
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
    }
  };
  return (
    <div className={className}>
      {/* 名字要看全（同一章的讲义、课件前半截一样）：用大一号的卡片；手机上横着滑，不一张张往下排 */}
      <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible [&>*]:shrink-0">
        {files.map((f) => (
          <FileCard
            key={f.id}
            name={f.name}
            kind={f.kind}
            bad={f.status === 'unread'}
            meta={f.status === 'unread' ? f.reason : [typeLabel(f.name, f.kind), formatSize(f.size)].filter(Boolean).join(' · ')}
            onClick={f.status === 'uploading' ? undefined : () => open(f)}
          />
        ))}
      </div>
    </div>
  );
}

/** 同一份文件选两次只算一份 */
export const keyOf = (p: Picked) => `${p.path}:${p.file.size}:${p.file.lastModified}`;
/** 拿到的文件换成卡片要的样子（图片做本地小图） */
export const toAttached = (p: Picked): Attached => ({
  key: keyOf(p),
  name: p.path.split('/').pop() || p.path,
  size: p.file.size,
  url: /^image\/(png|jpeg|gif|webp)$/.test(p.file.type) ? URL.createObjectURL(p.file) : null,
});

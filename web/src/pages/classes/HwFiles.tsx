import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { toast } from '../../lib/store';
import { Button, Spinner } from '../../components/ui';
import { FileCard, formatSize, typeLabel } from '../kb/FileCard';
import { canPreview, fileUrl, uploadFile, type HwFile } from './homework';

const MAX = 50 * 1024 * 1024;

/** 打开附件：图片和 PDF 在新标签页里直接看，别的下载 */
export function openFile(f: HwFile) {
  if (canPreview(f.name)) {
    window.open(fileUrl(f, true), '_blank', 'noopener');
    return;
  }
  const a = document.createElement('a');
  a.href = fileUrl(f);
  a.download = f.name;
  a.click();
}

/** 附件一排：跟整理助手里一样的文件卡片，点开看或下载 */
export function FileList({ files, className }: { files: HwFile[]; className?: string }) {
  if (!files.length) return null;
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2.5">
        {files.map((f) => (
          <FileCard key={f.id} name={f.name} meta={`${typeLabel(f.name)} · ${formatSize(f.size)}`} onClick={() => openFile(f)} />
        ))}
      </div>
    </div>
  );
}

/** 加附件：选了就传，传好的显示成卡片，右上角叉掉 */
export function FilePicker({ files, onChange, disabled }: { files: HwFile[]; onChange: (f: HwFile[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string[]>([]);
  // 一次选好几个是一个个传的，每传好一个都要接在最新的那一串后面
  const latest = useRef(files);
  latest.current = files;
  const pick = async (list: FileList | null) => {
    const chosen = [...(list || [])];
    if (input.current) input.current.value = '';
    for (const file of chosen) {
      if (file.size > MAX) {
        toast.error(`「${file.name}」超过 50 MB`);
        continue;
      }
      setBusy((b) => [...b, file.name]);
      try {
        const f = await uploadFile(file);
        latest.current = [...latest.current, f];
        onChange(latest.current);
      } catch (e) {
        toast.fromError(e);
      } finally {
        setBusy((b) => b.filter((n) => n !== file.name));
      }
    }
  };
  return (
    <div className="space-y-3">
      {(files.length > 0 || busy.length > 0) && (
        <div className="flex flex-wrap gap-2.5">
          {files.map((f) => (
            <FileCard
              key={f.id}
              compact
              name={f.name}
              meta={formatSize(f.size)}
              onRemove={disabled ? undefined : () => onChange(files.filter((x) => x.id !== f.id))}
            />
          ))}
          {busy.map((n, i) => (
            <FileCard key={`up-${i}-${n}`} compact name={n} meta="正在上传…" after={<Spinner className="size-4 shrink-0" />} />
          ))}
        </div>
      )}
      <input ref={input} type="file" multiple hidden onChange={(e) => pick(e.target.files)} />
      <Button size="sm" icon={<Paperclip className="size-4" />} disabled={disabled} onClick={() => input.current?.click()}>
        添加附件
      </Button>
    </div>
  );
}

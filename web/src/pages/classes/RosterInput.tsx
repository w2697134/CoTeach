import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Textarea, cn } from '../../components/ui';
import { rosterCount, rosterText, unreadNote } from './data';

interface Read {
  name: string | null;
  students: { studentNo: string; name: string }[];
  unread: string[];
}

/** 名单：直接粘贴，或者把教务网导出的表拖进来、选进来。读出来的学号姓名放进框里，老师看过再交 */
export function RosterInput({
  value,
  onChange,
  onName,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onName?: (name: string) => void;
  autoFocus?: boolean;
}) {
  const pick = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false),
    [note, setNote] = useState(''),
    [over, setOver] = useState(false);
  const read = async (file: File) => {
    setReading(true);
    setNote('');
    try {
      const r = await api<Read>(`/classes/roster?file=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      onChange(rosterText(r.students));
      if (r.name) onName?.(r.name);
      setNote(unreadNote(r.unread));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setReading(false);
      if (pick.current) pick.current.value = '';
    }
  };
  const count = rosterCount(value);
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const file = e.dataTransfer.files[0];
        if (!file) return;
        e.preventDefault();
        setOver(false);
        void read(file);
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] text-ink">
          名单
          {count > 0 && <span className="ml-1.5 text-ink-3">{count} 人</span>}
        </span>
        <Button size="sm" icon={<Upload className="size-4" />} loading={reading} onClick={() => pick.current?.click()}>
          选文件
        </Button>
      </div>
      <Textarea
        autoFocus={autoFocus}
        className={cn('mt-1.5 min-h-40', over && 'border-brand ring-2 ring-brand/30')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="学号 姓名"
      />
      <input
        ref={pick}
        type="file"
        hidden
        accept=".xlsx,.xls,.ods,.csv,.tsv,.txt"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void read(file);
        }}
      />
      {note && (
        <p role="alert" className="mt-2 text-[13.5px] text-bad">
          {note}
        </p>
      )}
    </div>
  );
}

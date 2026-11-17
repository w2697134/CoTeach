import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Select, Textarea, cn } from '../../components/ui';
import { looksNo, rosterCount, rosterText, unreadNote, type RosterRead } from './data';

type Table = { rows: string[][]; noCol: number; nameCol: number };

/**
 * 表头认不出的表：像飞书导入那样把表摆出来，老师选哪一列是学号、哪一列是姓名（先按猜的选好）。
 * 选好后把像学号的那些行写进名单框，表头、标题、表尾这类行自然就跳过了。
 */
function PickColumns({ table, onDone }: { table: Table; onDone: (text: string, picked: number) => void }) {
  const [no, setNo] = useState(table.noCol),
    [name, setName] = useState(table.nameCol);
  const width = Math.max(...table.rows.map((r) => r.length));
  // 每列的名字取表头那行（前几行里第一行有两格以上的；标题行只有一格），没有就取这列第一个有字的
  const head = table.rows.slice(0, 5).find((r) => r.filter(Boolean).length >= 2);
  const hint = (i: number) => (head?.[i] || table.rows.slice(0, 5).find((r) => r[i])?.[i] || '').slice(0, 10);
  const options = Array.from({ length: width }, (_, i) => (
    <option key={i} value={i}>
      第 {i + 1} 列{hint(i) ? `：${hint(i)}` : ''}
    </option>
  ));
  const picked = table.rows.filter((r) => looksNo((r[no] || '').trim()) && (r[name] || '').trim());
  const shown = table.rows.slice(0, 6);
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] text-ink">
        <label className="flex items-center gap-2">
          学号
          <Select sizeVariant="sm" value={no} onChange={(e) => setNo(Number(e.target.value))}>
            {options}
          </Select>
        </label>
        <label className="flex items-center gap-2">
          姓名
          <Select sizeVariant="sm" value={name} onChange={(e) => setName(Number(e.target.value))}>
            {options}
          </Select>
        </label>
        <Button size="sm" variant="primary" className="ml-auto" disabled={!picked.length || no === name} onClick={() => onDone(rosterText(picked.map((r) => ({ studentNo: r[no].trim(), name: r[name].trim() }))), picked.length)}>
          用这两列（{picked.length} 人）
        </Button>
      </div>
      <div className="mt-3 overflow-x-auto rounded-md border border-line bg-surface">
        <table className="w-full text-left text-[13px]">
          <tbody>
            {shown.map((r, y) => (
              <tr key={y} className="border-b border-line last:border-0">
                {Array.from({ length: width }, (_, i) => (
                  <td key={i} className={cn('max-w-40 truncate px-2 py-1.5 text-ink-2', (i === no || i === name) && 'bg-brand-soft font-medium text-ink')}>
                    {r[i] || ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 名单：直接粘贴，或者把教务网导出的表拖进来、选进来。读出来的学号姓名放进框里，老师看过再交 */
export function RosterInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const pick = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false),
    [note, setNote] = useState(''),
    [over, setOver] = useState(false),
    [table, setTable] = useState<Table | null>(null);
  const read = async (file: File) => {
    setReading(true);
    setNote('');
    setTable(null);
    try {
      const r = await api<RosterRead>(`/classes/roster?file=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      if ('table' in r) setTable(r.table);
      else {
        onChange(rosterText(r.students));
        setNote(unreadNote(r.unread));
      }
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
          从 Excel 导入
        </Button>
      </div>
      {table && (
        <PickColumns
          table={table}
          onDone={(text) => {
            onChange(text);
            setTable(null);
          }}
        />
      )}
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
        <p role="alert" className="mt-2 text-[14px] text-bad">
          {note}
        </p>
      )}
    </div>
  );
}

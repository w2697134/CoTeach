import { useState } from 'react';
import { Input } from '../../components/ui';
import { plainPath, useTree } from './data';

export function LocationField({ cid, value, onChange }: { cid: number; value: string; onChange: (folder: string) => void }) {
  const tree = useTree(cid);
  const [creating, setCreating] = useState(false),
    [parent, setParent] = useState(value),
    [name, setName] = useState('');
  const folders = new Set(['', value, parent]);
  for (const file of tree.data?.files || []) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const options = [...folders].sort().map((folder) => (
    <option key={folder} value={folder}>
      {plainPath(folder) || '知识库'}
    </option>
  ));
  const selectClass = 'mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink';
  return (
    <div className="space-y-3">
      <label className="block text-[14px] text-ink">
        位置
        <select
          className={selectClass}
          value={creating ? '__new__' : value}
          onChange={(e) => {
            if (e.target.value === '__new__') {
              setCreating(true);
              setParent(value);
              setName('');
            } else {
              setCreating(false);
              onChange(e.target.value);
            }
          }}
        >
          {options}
          <option value="__new__">新建文件夹…</option>
        </select>
      </label>
      {creating && (
        <>
          <label className="block text-[14px] text-ink">
            上一级
            <select
              className={selectClass}
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                onChange([e.target.value, name.trim()].filter(Boolean).join('/'));
              }}
            >
              {options}
            </select>
          </label>
          <label className="block text-[14px] text-ink">
            文件夹名称
            <Input
              className="mt-1.5"
              value={name}
              onChange={(e) => {
                const text = e.target.value.replace(/[\\/]/g, '');
                setName(text);
                onChange([parent, text.trim()].filter(Boolean).join('/'));
              }}
            />
          </label>
        </>
      )}
    </div>
  );
}

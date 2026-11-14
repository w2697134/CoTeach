import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, MoreHorizontal, MoreVertical, PenLine, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, IconButton, Input, MenuItem, Modal, Popover, useConfirm } from '../../components/ui';

/** 每个班右上角的「⋮」：改名、归档或恢复、删除。在卡片彩色头上传 onPicture（白点）；在横幅插图上传 onImage（白底圆钮） */
export function ClassTools({
  item,
  onDeleted,
  onPicture,
  onImage,
}: {
  item: { id: number; name: string; archived?: boolean };
  onDeleted?: () => void;
  onPicture?: boolean;
  onImage?: boolean;
}) {
  const qc = useQueryClient(),
    confirm = useConfirm();
  const [renaming, setRenaming] = useState(false),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const rename = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/classes/${item.id}`, { method: 'PATCH', body: { name } });
      qc.invalidateQueries({ queryKey: ['classes'] });
      qc.invalidateQueries({ queryKey: ['class', item.id] });
      setRenaming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // 归档、恢复都能再改回来，不弹确认
  const archive = async (archived: boolean) => {
    setBusy(true);
    try {
      await api(`/classes/${item.id}`, { method: 'PATCH', body: { archived } });
      qc.setQueryData(['class', item.id], (old: object | undefined) => (old ? { ...old, archived } : old));
      await qc.invalidateQueries({ queryKey: ['classes'] });
      toast.success(archived ? '已归档' : '已恢复');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `删除「${item.name}」？`, desc: '名单会一起删掉。', okText: '删除', danger: true }))) return;
    setBusy(true);
    try {
      await api(`/classes/${item.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['classes'] });
      toast.success('已删除');
      onDeleted?.();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Popover
        width={160}
        trigger={({ toggle }) => (
          <IconButton
            label="更多"
            size="sm"
            onClick={toggle}
            disabled={busy}
            className={
              onImage
                ? 'rounded-full bg-white/85 text-[#334155] shadow-xs hover:bg-white'
                : onPicture
                  ? 'rounded-full bg-black/10 text-white hover:bg-black/20'
                  : 'text-ink-3'
            }
          >
            {onPicture || onImage ? <MoreVertical className="size-4" /> : <MoreHorizontal className="size-4" />}
          </IconButton>
        )}
      >
        {(close) => (
          <div onClick={close}>
            <MenuItem
              icon={<PenLine />}
              onClick={() => {
                setName(item.name);
                setError('');
                setRenaming(true);
              }}
            >
              改名
            </MenuItem>
            {item.archived ? (
              <MenuItem icon={<ArchiveRestore />} onClick={() => archive(false)}>
                恢复
              </MenuItem>
            ) : (
              <MenuItem icon={<Archive />} onClick={() => archive(true)}>
                归档
              </MenuItem>
            )}
            <MenuItem icon={<Trash2 />} danger onClick={remove}>
              删除这个班
            </MenuItem>
          </div>
        )}
      </Popover>
      <Modal
        open={renaming}
        onClose={() => !busy && setRenaming(false)}
        title="改名"
        footer={
          <>
            <Button disabled={busy} onClick={() => setRenaming(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim() || name.trim() === item.name} onClick={rename}>
              保存
            </Button>
          </>
        }
      >
        <label className="block text-[14px] text-ink">
          名称
          <Input autoFocus className="mt-1.5" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename()} />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-[14px] text-bad">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}

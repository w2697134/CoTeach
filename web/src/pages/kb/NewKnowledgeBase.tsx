import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../../lib/api';
import { Button, Input, Modal } from '../../components/ui';

/** 新建知识库：只要一个名字 */
export function NewKnowledgeBaseModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setName('');
      setError('');
    }
  }, [open]);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<{ id: number }>('/knowledge', { name });
      await qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
      onCreated(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="新建知识库"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
            创建
          </Button>
        </>
      }
    >
      <label className="block text-[14px] text-ink">
        名称
        <Input autoFocus className="mt-1.5" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      </label>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-bad">
          {error}
        </p>
      )}
    </Modal>
  );
}

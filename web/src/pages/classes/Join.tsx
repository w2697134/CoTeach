import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Button, Input, Modal, Skeleton } from '../../components/ui';
import { normalCode, type ClassPeek } from './data';
import { themeBackground, themeOf } from './look';
import { INK } from './tone';

/** 输了加课码看到的班：彩色方块写班名第一个字，旁边是班名、老师，进不去的写原因 */
export function PeekCard({ k }: { k: ClassPeek }) {
  const note = k.joined ? '已经加入了' : k.archived ? '已归档' : !k.open ? '已停止加入' : '';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-lg text-[17px] font-medium text-white"
        style={themeBackground(themeOf(k.id))}
      >
        {k.name.slice(0, 1)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-[15px] font-medium text-ink">{k.name}</p>
        <p className="text-[13px] text-ink-3">
          {k.teacher}
          {note && <span className={!k.joined ? INK.warn : undefined}> · {note}</span>}
        </p>
      </div>
    </div>
  );
}

/** 自己用学号注册的账号，学号就是账号名，加别的班也用它，不让改 */
export const ownStudentNo = (u: { username: string; studentNo: string | null } | null | undefined) =>
  u?.studentNo && u.username.toLowerCase() === u.studentNo.toLowerCase() ? u.studentNo : null;

/** 学生加入班级：输加课码，看到是哪个班、哪位老师，填学号姓名（账号上有的先填好） */
export function JoinModal({ open, onClose, initialCode = '' }: { open: boolean; onClose: () => void; initialCode?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const fixedNo = ownStudentNo(me);
  const [code, setCode] = useState(''),
    [no, setNo] = useState(''),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setCode(normalCode(initialCode));
    setNo(me?.studentNo || '');
    setName(me?.name || '');
    setError('');
  }, [open, initialCode, me]);
  const c = normalCode(code);
  const peek = useQuery({
    queryKey: ['class-join', c],
    queryFn: () => get<ClassPeek>(`/classes/join/${c}`),
    enabled: open && c.length === 6,
    retry: false,
  });
  const found = c.length === 6 ? peek.data : undefined;
  const canJoin = !!found && (found.joined || found.open);
  const go = (id: number) => {
    onClose();
    navigate(`/classes/${id}`);
  };
  const join = async () => {
    if (!found || !canJoin || busy) return;
    if (found.joined) return go(found.id);
    setBusy(true);
    setError('');
    try {
      const r = await post<{ id: number; name: string }>('/classes/join', { code: c, studentNo: fixedNo || no, name });
      await qc.invalidateQueries({ queryKey: ['classes'] });
      toast.success(`已加入「${r.name}」`);
      go(r.id);
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
      title="加入班级"
      width={460}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!canJoin || (!found!.joined && (!(fixedNo || no).trim() || !name.trim()))} onClick={join}>
            {found?.joined ? '进入班级' : '加入'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-[14px] text-ink">
          加课码
          <Input
            autoFocus={!c}
            className="mt-1.5 font-mono text-[18px] uppercase tracking-[0.3em]"
            value={code}
            maxLength={8}
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && join()}
          />
        </label>
        {c.length === 6 &&
          (peek.isFetching ? (
            <Skeleton className="h-[60px] rounded-lg" />
          ) : peek.error ? (
            <p role="alert" className="text-[14px] text-bad">
              {(peek.error as Error).message}
            </p>
          ) : (
            found && <PeekCard k={found} />
          ))}
        {found && !found.joined && found.open && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-[14px] text-ink">
              学号
              <Input
                autoFocus={!!c && !fixedNo}
                className="mt-1.5"
                value={fixedNo || no}
                disabled={!!fixedNo}
                maxLength={40}
                inputMode="text"
                onChange={(e) => setNo(e.target.value)}
              />
            </label>
            <label className="block text-[14px] text-ink">
              姓名
              <Input className="mt-1.5" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && join()} />
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-[14px] text-bad">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

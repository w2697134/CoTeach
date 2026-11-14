import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, QrCode, UserPlus } from 'lucide-react';
import { encode } from 'uqr';
import { get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Button, IconButton, Input, Modal, Popover, Skeleton } from '../../components/ui';
import { normalCode } from './data';
import { themeBackground, themeOf } from './look';

/** 二维码：一格一个方块画成 SVG，白底深色 */
export function Qr({ text, size = 184 }: { text: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, n: qr.data.length };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="rounded-lg bg-white" role="img" aria-label="二维码">
      <path d={path} fill="#111827" />
    </svg>
  );
}

const copyText = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what}已复制`);
  } catch {
    toast.error('没复制上', text);
  }
};

/** 老师在班级横幅上看到的加课码：照课堂派，大字写出来，旁边复制、二维码（扫了打开加入的网址） */
export function JoinCode({ code }: { code: string }) {
  const link = `${window.location.origin}/join/${code}`;
  return (
    <div className="flex shrink-0 items-center gap-1 self-start rounded-xl bg-white/95 py-1 pl-3.5 pr-1 text-ink shadow-[0_2px_8px_rgba(15,23,42,.12)] sm:self-auto">
      <span className="text-[13px] text-ink-3">加课码</span>
      <span className="ml-1.5 mr-0.5 font-mono text-[22px] font-semibold leading-9 tracking-[0.16em]">{code}</span>
      <IconButton size="sm" label="复制加课码" onClick={() => copyText(code, '加课码')}>
        <Copy className="size-4" />
      </IconButton>
      <Popover
        align="end"
        width={232}
        trigger={({ toggle }) => (
          <IconButton size="sm" label="二维码" onClick={toggle}>
            <QrCode className="size-4" />
          </IconButton>
        )}
      >
        <div className="flex flex-col items-center gap-2 px-2 pb-2 pt-3">
          <Qr text={link} />
          <p className="font-mono text-[18px] font-semibold tracking-[0.16em] text-ink">{code}</p>
          <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => copyText(link, '链接')}>
            复制链接
          </Button>
        </div>
      </Popover>
    </div>
  );
}

interface Peek {
  id: number;
  name: string;
  teacher: string;
  joined: boolean;
}

/** 学生加入班级：输加课码，看到是哪个班、哪位老师，填学号姓名（账号上有的先填好） */
export function JoinModal({ open, onClose, initialCode = '' }: { open: boolean; onClose: () => void; initialCode?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
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
    queryFn: () => get<Peek>(`/classes/join/${c}`),
    enabled: open && c.length === 6,
    retry: false,
  });
  const found = c.length === 6 ? peek.data : undefined;
  const go = (id: number) => {
    onClose();
    navigate(`/classes/${id}`);
  };
  const join = async () => {
    if (!found || busy) return;
    if (found.joined) return go(found.id);
    setBusy(true);
    setError('');
    try {
      const r = await post<{ id: number; name: string }>('/classes/join', { code: c, studentNo: no, name });
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
      icon={<UserPlus />}
      width={460}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!found || (!found.joined && (!no.trim() || !name.trim()))} onClick={join}>
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
            found && (
              <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                <span
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg text-[17px] font-medium text-white"
                  style={themeBackground(themeOf(found.id))}
                >
                  {found.name.slice(0, 1)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-medium text-ink">{found.name}</p>
                  <p className="text-[13px] text-ink-3">{found.joined ? `${found.teacher} · 已经加入了` : found.teacher}</p>
                </div>
              </div>
            )
          ))}
        {found && !found.joined && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-[14px] text-ink">
              学号
              <Input autoFocus={!!c} className="mt-1.5" value={no} maxLength={40} inputMode="text" onChange={(e) => setNo(e.target.value)} />
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

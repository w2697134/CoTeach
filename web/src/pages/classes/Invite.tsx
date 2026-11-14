import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Copy, Download, Maximize2, QrCode, RefreshCw, X } from 'lucide-react';
import { encode } from 'uqr';
import { api, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, IconButton, Modal, cn, useConfirm } from '../../components/ui';
import { joinLink, type ClassDetail } from './data';
import { themeBackground, themeOf } from './look';

/** 老师邀请学生：照雨课堂、课堂派、Google Classroom。加课码、二维码、链接，能下载二维码发群里，能全屏投到教室大屏上 */

const cells = (text: string) => encode(text, { ecc: 'M', border: 2 }).data;
const bare = (link: string) => link.replace(/^https?:\/\//, '');

/** 二维码：一格一个方块画成 SVG，白底深色。fill：跟着外面的框一样大 */
export function Qr({ text, size = 184, fill, className }: { text: string; size?: number; fill?: boolean; className?: string }) {
  const { path, n } = useMemo(() => {
    const data = cells(text);
    let d = '';
    data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, n: data.length };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={fill ? '100%' : size}
      height={fill ? '100%' : size}
      shapeRendering="crispEdges"
      className={cn('shrink-0 rounded-lg bg-white', className)}
      role="img"
      aria-label="二维码"
    >
      <path d={path} fill="#111827" />
    </svg>
  );
}

export const copyText = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what}已复制`);
  } catch {
    toast.error('没复制上', text);
  }
};

/** 下载二维码图片：班名、二维码、加课码、链接，老师发到班级群里用 */
export function downloadQr(code: string, name: string) {
  const W = 720,
    H = 920,
    Q = 560;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return toast.error('这个浏览器下载不了图片');
  const font = '"Inter Variable", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillStyle = '#0f172a';
  g.font = `600 34px ${font}`;
  let title = name;
  while (title.length > 1 && g.measureText(title).width > W - 96) title = title.slice(0, -1);
  g.fillText(title === name ? name : `${title}…`, W / 2, 78);
  const data = cells(joinLink(code));
  const cell = Math.floor(Q / data.length),
    size = cell * data.length,
    x0 = Math.round((W - size) / 2),
    y0 = 130 + Math.round((Q - size) / 2);
  g.fillStyle = '#111827';
  data.forEach((row, y) => row.forEach((on, x) => on && g.fillRect(x0 + x * cell, y0 + y * cell, cell, cell)));
  // 「加课码」小字和码大字排在一行，整行居中
  g.textAlign = 'left';
  g.font = `400 26px ${font}`;
  const lw = g.measureText('加课码').width;
  g.font = `700 52px "JetBrains Mono Variable", Consolas, Menlo, monospace`;
  (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '6px';
  const cw = g.measureText(code).width;
  const left = (W - lw - 18 - cw) / 2;
  g.fillStyle = '#0f172a';
  g.fillText(code, left + lw + 18, 768);
  (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  g.font = `400 26px ${font}`;
  g.fillStyle = '#64748b';
  g.fillText('加课码', left, 770);
  g.textAlign = 'center';
  g.font = `400 22px ${font}`;
  g.fillText(bare(joinLink(code)), W / 2, 840);
  canvas.toBlob((blob) => {
    if (!blob) return toast.error('图片没生成出来');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `加入班级-${name.replace(/[\\/:*?"<>|]/g, '')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

/** 改了加课码、允许加入以后，班级页和班级列表跟着变 */
export function patchClass(qc: QueryClient, id: number, patch: Partial<ClassDetail>) {
  qc.setQueryData<ClassDetail>(['class', id], (old) => (old ? { ...old, ...patch } : old));
  qc.invalidateQueries({ queryKey: ['classes'] });
}

/** 横幅上班名下面那行的加课码：能加入时写出码，旁边复制、二维码（点开邀请）；停止加入时写「已停止加入」 */
export function CodeLine({ code, open, onInvite }: { code: string; open: boolean; onInvite: () => void }) {
  const btn = 'rounded-md p-1 text-white/85 transition-colors hover:bg-white/15 hover:text-white';
  if (!open)
    return (
      <button type="button" onClick={onInvite} className="rounded-full bg-white/20 px-2.5 py-0.5 text-[13px] text-white transition-colors hover:bg-white/30">
        已停止加入
      </button>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-white/85">加课码</span>
      <span className="ml-1 font-mono text-[18px] font-semibold tracking-[0.12em] text-white">{code}</span>
      <button type="button" title="复制加课码" aria-label="复制加课码" className={btn} onClick={() => copyText(code, '加课码')}>
        <Copy className="size-4" />
      </button>
      <button type="button" title="二维码" aria-label="二维码" className={btn} onClick={onInvite}>
        <QrCode className="size-4" />
      </button>
    </span>
  );
}

/** 二维码、加课码、链接、三个按钮。班里还没人时直接摆在成员栏里；「邀请学生」弹出来的也是它（竖着排） */
export function InvitePanel({ k, onProject, vertical }: { k: { id: number; name: string; code: string }; onProject: () => void; vertical?: boolean }) {
  const link = joinLink(k.code);
  return (
    <div className={cn('flex flex-col items-center gap-5', !vertical && 'sm:flex-row sm:justify-center sm:gap-10')}>
      <Qr text={link} size={vertical ? 200 : 168} className="ring-1 ring-line" />
      <div className={cn('flex min-w-0 flex-col items-center', !vertical && 'sm:items-start')}>
        <p className="text-[14px] text-ink-3">加课码</p>
        <div className="mt-1 flex items-center gap-1">
          <span className="font-mono text-[38px] font-semibold leading-none tracking-[0.14em]" style={{ color: themeOf(k.id).ink }}>
            {k.code}
          </span>
          <IconButton label="复制加课码" onClick={() => copyText(k.code, '加课码')}>
            <Copy className="size-4" />
          </IconButton>
        </div>
        <p className="mt-2 max-w-full truncate text-[13px] text-ink-3">{bare(link)}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button size="sm" icon={<Copy className="size-4" />} onClick={() => copyText(link, '链接')}>
            复制链接
          </Button>
          <Button size="sm" icon={<Download className="size-4" />} onClick={() => downloadQr(k.code, k.name)}>
            下载二维码
          </Button>
          <Button size="sm" icon={<Maximize2 className="size-4" />} onClick={onProject}>
            全屏
          </Button>
        </div>
      </div>
    </div>
  );
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:shadow-[var(--ring)] focus-visible:outline-none disabled:opacity-60',
        checked ? 'bg-brand' : 'bg-line-strong',
      )}
    >
      <span className={cn('inline-block size-5 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
    </button>
  );
}

/** 「邀请学生」：上面是二维码和加课码，下面是允许加入的开关、换加课码 */
export function InviteModal({
  k,
  open,
  onClose,
  onProject,
}: {
  k: { id: number; name: string; code: string; joinOpen?: boolean };
  open: boolean;
  onClose: () => void;
  onProject: () => void;
}) {
  const qc = useQueryClient(),
    confirm = useConfirm();
  const [busy, setBusy] = useState<'open' | 'code' | null>(null);
  const opened = k.joinOpen !== false;
  const setOpen = async (v: boolean) => {
    setBusy('open');
    try {
      await api(`/classes/${k.id}`, { method: 'PATCH', body: { joinOpen: v } });
      patchClass(qc, k.id, { joinOpen: v });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    if (!(await confirm({ title: '换一个加课码？', desc: '原来的加课码和二维码就不能用了，已经加入的学生不受影响。', okText: '换' }))) return;
    setBusy('code');
    try {
      const r = await post<{ code: string }>(`/classes/${k.id}/code`);
      patchClass(qc, k.id, { code: r.code });
      toast.success('加课码换好了');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="邀请学生" width={480}>
      <div className={cn('pb-1 pt-2 transition-opacity', !opened && 'pointer-events-none select-none opacity-35')} aria-hidden={!opened}>
        <InvitePanel k={k} onProject={onProject} vertical />
      </div>
      <div className="mt-5 divide-y divide-line border-t border-line">
        <div className="flex items-center gap-3 py-3.5">
          <span className="flex-1 text-[14.5px] text-ink">允许加入</span>
          <Switch checked={opened} disabled={busy === 'open'} onChange={setOpen} label="允许加入" />
        </div>
        <div className="flex items-center gap-3 py-3">
          <span className="flex-1 text-[14.5px] text-ink">换一个加课码</span>
          <Button size="sm" icon={<RefreshCw className="size-4" />} loading={busy === 'code'} disabled={!opened} onClick={reset}>
            换码
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 全屏：投到教室大屏上，学生拿手机扫。底色用这个班的颜色，中间白卡片上是二维码和大字加课码 */
export function Projector({ k, open, onClose }: { k: { id: number; name: string; code: string }; open: boolean; onClose: () => void }) {
  // 页面刷新数据时 onClose 会换一个，不能因此退出再进全屏
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    let entered = false;
    document.documentElement
      .requestFullscreen?.()
      .then(() => (entered = true))
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    // 按 Esc 退出浏览器全屏时，这一层也关掉
    const onChange = () => !document.fullscreenElement && entered && close.current();
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, [open]);
  if (!open) return null;
  const theme = themeOf(k.id),
    link = joinLink(k.code);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="加课码" className="fixed inset-0 z-[95] flex items-center justify-center p-[3vmin]" style={themeBackground(theme)}>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        title="关闭"
        className="absolute right-[2vmin] top-[2vmin] rounded-full bg-white/20 p-2.5 text-white transition-colors hover:bg-white/30"
      >
        <X className="size-6" />
      </button>
      <div className="flex max-h-full max-w-full flex-col items-center gap-[3vmin] rounded-[3vmin] bg-white px-[6vmin] py-[5vmin] text-center shadow-[0_30px_80px_-20px_rgba(15,23,42,.45)] landscape:flex-row landscape:gap-[6vmin] landscape:text-left">
        <div className="size-[min(62vh,80vw)] landscape:size-[min(64vh,42vw)]">
          <Qr text={link} fill />
        </div>
        <div className="min-w-0">
          <p className="max-w-[40vw] break-words text-[clamp(22px,4.2vmin,44px)] font-semibold leading-tight text-[#0f172a] portrait:max-w-[80vw]">{k.name}</p>
          <p className="mt-[4vmin] text-[clamp(15px,2.6vmin,26px)] text-[#64748b]">加课码</p>
          <p className="font-mono text-[clamp(44px,11vmin,128px)] font-bold leading-[1.1] tracking-[0.12em]" style={{ color: theme.ink }}>
            {k.code}
          </p>
          <p className="mt-[3vmin] text-[clamp(13px,2.2vmin,22px)] text-[#64748b]">{bare(link)}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { GripHorizontal, X } from 'lucide-react';
import { cn } from '../../components/ui';
import { Qr } from '../classes/Invite';
import { checkinLink, mmss, useCheckin, useLeft, type CheckinData } from './data';

/**
 * 签到「分屏」小窗：
 * 浮在所有窗口最上面的一个小窗，只放二维码、倒计时、签了几个；老师在旁边放自己的 PPT，迟到的学生照样扫。
 * 用浏览器的画中画小窗（Chrome、Edge 116 以后有：能拖、能拉大小、能关，盖在 PPT 放映上面也看得见）；
 * 浏览器没有这个的，就在网页里浮一个能拖、右下角能拉大小、能关的小框。小窗挂在整个应用上，换页面也不关。
 */

interface PipApi {
  requestWindow: (o: { width: number; height: number }) => Promise<Window>;
}
interface FloatState {
  id: number | null;
  win: Window | null;
  open: (id: number) => void;
  close: () => void;
}

/** 把网页的样式抄进小窗（小窗是一张空白页） */
function copyStyles(win: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = win.document.createElement('style');
      style.textContent = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n');
      win.document.head.appendChild(style);
    } catch {
      if (!sheet.href) continue;
      const link = win.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      win.document.head.appendChild(link);
    }
  }
  const from = document.documentElement,
    to = win.document.documentElement;
  to.className = from.className;
  for (const a of Array.from(from.attributes)) if (a.name.startsWith('data-')) to.setAttribute(a.name, a.value);
  win.document.body.style.margin = '0';
}

export const useCheckinFloat = create<FloatState>((set, get) => ({
  id: null,
  win: null,
  open: (id) => {
    const old = get().win;
    if (old && !old.closed) old.close();
    const pip = (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
    if (!pip?.requestWindow) return set({ id, win: null });
    // 浏览器只认用户点的那一下：这里不先等别的，直接开
    pip.requestWindow({ width: 320, height: 400 }).then(
      (win) => {
        copyStyles(win);
        win.document.title = '签到';
        win.addEventListener('pagehide', () => {
          if (get().win === win) set({ id: null, win: null });
        });
        set({ id, win });
      },
      () => set({ id, win: null }),
    );
  },
  close: () => {
    const w = get().win;
    set({ id: null, win: null });
    if (w && !w.closed) w.close();
  },
}));

/** 挂在整个应用上（AppShell）：开着签到小窗就摆出来 */
export function CheckinFloat() {
  const id = useCheckinFloat((s) => s.id);
  const win = useCheckinFloat((s) => s.win);
  const close = useCheckinFloat((s) => s.close);
  if (!id) return null;
  return <Float key={id} id={id} win={win} onClose={close} />;
}

function Float({ id, win, onClose }: { id: number; win: Window | null; onClose: () => void }) {
  const q = useCheckin(id);
  const left = useLeft(q.data);
  const body = <Mini c={q.data} left={left} gone={q.isError} />;
  if (win) return createPortal(<div className="h-screen w-screen overflow-hidden [container-type:size]">{body}</div>, win.document.body);
  return createPortal(<Panel onClose={onClose}>{body}</Panel>, document.body);
}

/** 小窗里的东西：哪门课、二维码（按小窗大小取最大）、倒计时、签了几个。字跟着小窗大小变 */
function Mini({ c, left, gone }: { c: CheckinData | undefined; left: number; gone: boolean }) {
  if (gone) return <p className="flex h-full items-center justify-center bg-white text-[15px] text-[#64748b]">这次签到不在了</p>;
  if (!c?.token) return <div className="h-full bg-white" />;
  const open = c.open && left > 0;
  return (
    <div className="flex h-full flex-col bg-white px-[5cqmin] pb-[4cqmin] pt-[3cqmin] text-[#0f172a] [container-type:size]">
      <p className="truncate text-center text-[clamp(12px,5cqmin,20px)] text-[#64748b]">{c.className} · 扫码签到</p>
      <div className="min-h-0 flex-1 py-[2cqmin] [container-type:size]">
        <div className="relative mx-auto aspect-square" style={{ width: 'min(100cqw, 100cqh)' }}>
          <Qr text={checkinLink(c.token)} fill className={cn('transition-opacity', !open && 'opacity-15')} />
          {!open && <p className="absolute inset-0 flex items-center justify-center text-[clamp(16px,8cqmin,32px)] font-semibold text-[#334155]">签到结束了</p>}
        </div>
      </div>
      <div className="flex items-baseline justify-center gap-[4cqmin]">
        <span className={cn('font-mono text-[clamp(20px,11cqmin,52px)] font-bold leading-none tabular-nums', open ? 'text-[#0f172a]' : 'text-[#94a3b8]')}>{open ? mmss(left) : '已结束'}</span>
        <span className="text-[clamp(13px,5.5cqmin,24px)] text-[#475569]">
          签了 <b className="tabular-nums text-[#0f172a]">{c.signed}</b> / {c.total}
        </span>
      </div>
    </div>
  );
}

/** 浏览器没有画中画小窗时：网页里浮一个小框，拖上面那条移动，右下角拉大小，右上角关 */
function Panel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, window.innerWidth - 320 - 24), y: Math.max(8, window.innerHeight - 420 - 24) }));
  // 大小只在开始时定一次，之后由老师拉（每秒刷新倒计时也不会把拉好的大小弹回去）
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.width = '300px';
    el.style.height = '380px';
  }, []);
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    const sx = e.clientX - pos.x,
      sy = e.clientY - pos.y;
    const move = (ev: PointerEvent) =>
      setPos({
        x: Math.min(Math.max(0, ev.clientX - sx), window.innerWidth - el.offsetWidth),
        y: Math.min(Math.max(0, ev.clientY - sy), window.innerHeight - el.offsetHeight),
      });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="签到小窗"
      className="fixed z-[96] flex min-h-[220px] min-w-[200px] flex-col overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white shadow-[0_24px_60px_-16px_rgba(15,23,42,.45)] [resize:both]"
      style={{ left: pos.x, top: pos.y, maxWidth: '96vw', maxHeight: '96vh' }}
    >
      <div onPointerDown={drag} className="flex h-8 shrink-0 cursor-move touch-none select-none items-center justify-center bg-[#f8fafc]">
        <GripHorizontal className="size-4 text-[#94a3b8]" />
        <button type="button" onClick={onClose} aria-label="关掉小窗" className="absolute right-1.5 top-1 rounded-md p-1 text-[#64748b] transition-colors hover:bg-[#e2e8f0] hover:text-[#0f172a]">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 [container-type:size]">{children}</div>
    </div>
  );
}

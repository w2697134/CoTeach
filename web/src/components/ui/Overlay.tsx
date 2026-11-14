import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useToasts } from '../../lib/store';
import { Button, IconButton } from './Button';
import { cn } from './cn';

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [open, onClose]);
}

function useBodyLock(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
}

/** 内容滚动时，上面或下面还有没露出来的部分吗（有才在标题下、按钮上画细线） */
function useScrollEdges() {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const box = useRef<HTMLElement | null>(null);
  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const top = el.scrollTop > 0,
      bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, []);
  const observer = useRef<ResizeObserver | null>(null);
  // 挂在内容上：外面的滚动盒子和里面的内容，哪个变高变矮都重新量
  const content = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      box.current = el?.parentElement ?? null;
      if (!el || !box.current) return;
      observer.current = new ResizeObserver(measure);
      observer.current.observe(box.current);
      observer.current.observe(el);
    },
    [measure],
  );
  return { edges, content, measure };
}

/* ---------------- Modal ---------------- */
/**
 * 对话框照飞书、课堂派的样子：标题、内容、右下角按钮，中间不加分隔线和灰底栏；背景只压暗，不糊。
 * 内容长到要滚动时，标题下、按钮上才出细线。
 */
export function Modal({
  open,
  onClose,
  title,
  desc,
  children,
  footer,
  width = 460,
  className,
  closeOnOverlay = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  closeOnOverlay?: boolean;
}) {
  const titleId = useId();
  useEscape(open, onClose);
  useBodyLock(open);
  const { edges, content, measure } = useScrollEdges();
  const head = !!(title || desc);
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-6">
          <motion.div
            className="absolute inset-0 bg-[var(--c-overlay)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeOnOverlay ? onClose : undefined}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            className={cn(
              'relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-lg sm:rounded-xl',
              className,
            )}
            style={{ maxWidth: width }}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          >
            {head && (
              <div
                className={cn(
                  'flex items-start gap-3 border-b px-6 pb-3 pt-5 transition-colors',
                  edges.top ? 'border-line' : 'border-transparent',
                )}
              >
                <div className="min-w-0 flex-1">
                  {title && (
                    <h2 id={titleId} className="text-[18px] font-semibold leading-7 text-ink">
                      {title}
                    </h2>
                  )}
                  {desc && <p className="mt-1 text-[14px] text-ink-3">{desc}</p>}
                </div>
                <IconButton size="sm" label="关闭" onClick={onClose} className="-mr-2 mt-0.5 text-ink-3">
                  <X className="size-[18px]" />
                </IconButton>
              </div>
            )}
            <div
              onScroll={measure}
              className={cn('min-h-0 flex-1 overflow-y-auto px-6', head ? 'pt-1' : 'pt-6', footer ? 'pb-2' : 'pb-6')}
            >
              <div ref={content}>{children}</div>
            </div>
            {footer && (
              <div
                className={cn(
                  'flex items-center justify-end gap-2 border-t px-6 pb-5 pt-4 transition-colors',
                  edges.bottom ? 'border-line' : 'border-transparent',
                )}
              >
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ---------------- Drawer ---------------- */
/** 侧边抽屉，样子跟对话框一样：标题、内容、底下按钮，不加灰底栏；内容滚动时才出细线。actions 放在关闭按钮旁边（上一个、下一个） */
export function Drawer({
  open,
  onClose,
  title,
  desc,
  children,
  footer,
  width = 480,
  side = 'right',
  actions,
  keepMounted = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  side?: 'right' | 'left';
  actions?: ReactNode;
  keepMounted?: boolean;
}) {
  useEscape(open, onClose);
  const { edges, content, measure } = useScrollEdges();
  return createPortal(
    <AnimatePresence>
      {(open || keepMounted) && (
        <div hidden={!open} className="fixed inset-0 z-[70]">
          <motion.div
            className="absolute inset-0 bg-[var(--c-overlay)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined}
            className={cn(
              'absolute top-0 flex h-full w-full flex-col border-line bg-surface shadow-lg',
              side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
            )}
            style={{ maxWidth: width }}
            initial={{ x: side === 'right' ? '100%' : '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: side === 'right' ? '100%' : '-100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 36 }}
          >
            {(title || desc) && (
              <div className={cn('flex items-start gap-3 border-b px-6 pb-3 pt-5 transition-colors', edges.top ? 'border-line' : 'border-transparent')}>
                <div className="min-w-0 flex-1">
                  {title && <h2 className="text-[18px] font-semibold leading-7 text-ink">{title}</h2>}
                  {desc && <p className="mt-0.5 text-[14px] text-ink-3">{desc}</p>}
                </div>
                {actions}
                <IconButton size="sm" label="关闭" onClick={onClose} className="-mr-2 mt-0.5 text-ink-3">
                  <X className="size-[18px]" />
                </IconButton>
              </div>
            )}
            <div onScroll={measure} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div ref={content}>{children}</div>
            </div>
            {footer && (
              <div className={cn('flex items-center justify-end gap-2 border-t px-6 pb-5 pt-4 transition-colors', edges.bottom ? 'border-line' : 'border-transparent')}>
                {footer}
              </div>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ---------------- Confirm（Promise 风格） ---------------- */
interface ConfirmOptions {
  title: string;
  desc?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        width={420}
        title={state?.title}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {state?.cancelText || '取消'}
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {state?.okText || '确定'}
            </Button>
          </>
        }
      >
        {state?.desc ? <div className="text-sm leading-relaxed text-ink-2">{state.desc}</div> : null}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

/* ---------------- Popover / Menu ---------------- */
export function Popover({
  trigger,
  children,
  align = 'end',
  width,
  className,
  open: openProp,
  onOpenChange,
}: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end' | 'center';
  width?: number;
  className?: string;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (v: boolean) => {
    setInner(v);
    onOpenChange?.(v);
  };
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      const w = width || panel.current?.offsetWidth || 220;
      const h = panel.current?.offsetHeight || 200;
      let left = align === 'start' ? r.left : align === 'center' ? r.left + r.width / 2 - w / 2 : r.right - w;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      const up = r.bottom + h + 12 > window.innerHeight && r.top > h + 12;
      setPos({ top: up ? r.top - h - 6 : r.bottom + 6, left, up });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align, width]);
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || panel.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', fn);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fn);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <>
      <div ref={ref} className="inline-flex">
        {trigger({ open, toggle: () => setOpen(!open) })}
      </div>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panel}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.14 }}
              className={cn('fixed z-[90] rounded-lg border border-line bg-surface p-1 shadow-lg', className)}
              style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
            >
              {typeof children === 'function' ? children(() => setOpen(false)) : children}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  active,
  shortcut,
  disabled,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  active?: boolean;
  shortcut?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0',
        danger ? 'text-bad hover:bg-bad-soft' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        active && 'bg-surface-3 text-ink',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[12.5px] font-medium uppercase tracking-wide text-ink-3">{children}</div>;
}

/* ---------------- Tooltip（轻量） ---------------- */
export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[13px] text-surface opacity-0 shadow-md transition-opacity delay-100 group-hover/tip:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {content}
      </span>
    </span>
  );
}

/* ---------------- Toaster ---------------- */
export function Toaster() {
  const { items, dismiss } = useToasts();
  const icons = {
    success: <CheckCircle2 className="size-5 text-ok" />,
    error: <XCircle className="size-5 text-bad" />,
    info: <Info className="size-5 text-info" />,
    warning: <AlertTriangle className="size-5 text-warn" />,
  };
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[100] flex flex-col items-center gap-2 px-4 sm:top-5" aria-live="polite">
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-lg"
          >
            <span className="mt-0.5 shrink-0">{icons[t.type]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{t.title}</p>
              {t.desc && <p className="mt-0.5 text-[14px] leading-snug text-ink-3">{t.desc}</p>}
            </div>
            <button
              className="shrink-0 rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
              onClick={() => dismiss(t.id)}
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

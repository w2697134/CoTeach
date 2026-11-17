import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Shuffle, X } from 'lucide-react';
import { Button } from '../../components/ui';

export interface Called {
  id: number;
  name: string;
  /** 这一轮还剩几个人没点（点名的那台设备才知道） */
  left?: number;
  total?: number;
}

/**
 * 随机点名（雨课堂、课堂派都有）：名字先在进了课堂的人里滚一阵，停在点到的那个人身上，大大地写在屏幕中间。
 * 大屏和老师的手机开着同一堂课时，哪边点的两边都弹出来。
 */
export function RollCall({ called, names, busy, onAgain, onClose }: { called: Called; names: string[]; busy: boolean; onAgain: () => void; onClose: () => void }) {
  const [shown, setShown] = useState(called.name);
  const [rolling, setRolling] = useState(true);
  const pool = useRef(names);
  pool.current = names.length > 1 ? names : [called.name];
  useEffect(() => {
    setRolling(true);
    let i = 0;
    const started = Date.now();
    let timer = 0;
    // 先快后慢地换名字，一秒多一点停下
    const step = () => {
      const t = Date.now() - started;
      if (t > 1300) {
        setShown(called.name);
        setRolling(false);
        return;
      }
      const list = pool.current;
      i = (i + 1 + Math.floor(Math.random() * Math.max(1, list.length - 1))) % list.length;
      setShown(list[i]);
      timer = window.setTimeout(step, 50 + t / 9);
    };
    step();
    return () => clearTimeout(timer);
  }, [called.id, called.name]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="随机点名" className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(15,23,42,.55)] p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 340, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[min(860px,92vw)] overflow-hidden rounded-[28px] bg-surface px-6 pb-8 pt-10 text-center shadow-lg sm:px-10"
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-90"
          style={{ background: 'radial-gradient(60% 100% at 50% 0%, var(--c-primary-soft), transparent)' }}
        />
        <button type="button" onClick={onClose} aria-label="关闭" className="absolute right-4 top-4 rounded-full p-2 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink">
          <X className="size-5" />
        </button>
        <p className="relative text-[clamp(15px,2.2vmin,22px)] font-medium text-brand-ink">随机点名</p>
        <motion.p
          key={rolling ? 'rolling' : `done-${called.id}`}
          initial={rolling ? false : { scale: 0.7, opacity: 0.4 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 16 }}
          className={`relative mt-[3vmin] break-words font-bold leading-tight tracking-tight ${rolling ? 'text-ink-3' : 'text-ink'}`}
          style={{ fontSize: 'clamp(56px, 15vmin, 168px)' }}
        >
          {shown}
        </motion.p>
        <div className="relative mt-[4vmin] flex flex-wrap items-center justify-center gap-3">
          {!rolling && called.left !== undefined && called.total !== undefined && (
            <span className="text-[14px] text-ink-3">
              这一轮还剩 {called.left} / {called.total} 人
            </span>
          )}
          <Button size="lg" variant="primary" icon={<Shuffle className="size-5" />} loading={busy} disabled={rolling} onClick={onAgain}>
            再点一个
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

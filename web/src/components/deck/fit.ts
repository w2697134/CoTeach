import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * 字多了自动缩小：元素本身大小固定、超出的部分藏起来；先按原大小量，放不下就二分找一个刚好放得下的比例，
 * 写进 CSS 变量（--fit / --tfit），字号都乘这个变量。最小也放不下时 onDone 收到 overflow=true。
 * 一页按 1280×720 排，外面缩放不影响量出来的结果，所以缩略图、编辑大图、放映三处量出来一样。
 */
export function useFit(
  ref: RefObject<HTMLElement | null>,
  key: string,
  opts: { min?: number; name?: string; onDone?: (scale: number, overflow: boolean) => void } = {},
) {
  const [fonts, setFonts] = useState(0);
  useLayoutEffect(() => {
    const set = ref.current?.ownerDocument?.fonts;
    if (!set) return;
    let alive = true;
    const bump = () => alive && setFonts((n) => n + 1);
    set.addEventListener('loadingdone', bump);
    if (set.status === 'loading') set.ready.then(bump);
    return () => {
      alive = false;
      set.removeEventListener('loadingdone', bump);
    };
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const name = opts.name || '--fit';
    const min = opts.min ?? 0.5;
    const over = () => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    const put = (v: number) => el.style.setProperty(name, v.toFixed(4));
    put(1);
    let scale = 1,
      overflow = false;
    if (over()) {
      put(min);
      if (over()) {
        scale = min;
        overflow = true;
      } else {
        let lo = min,
          hi = 1;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2;
          put(mid);
          if (over()) hi = mid;
          else lo = mid;
        }
        scale = lo;
        put(lo);
      }
    }
    opts.onDone?.(scale, overflow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fonts]);
}

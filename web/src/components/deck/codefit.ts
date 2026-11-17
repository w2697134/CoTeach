/**
 * 代码块不折行。
 * 页面、放映、导出 PPT 都用同一份排好的页面，所以只在这里缩一次。
 */

/** 代码块的字最小缩到原来的几成 */
const MIN_CODE_FIT = 0.75;

/**
 * 代码一行放不下会折成两行：把代码的字缩小（--cfit），缩到最小还折行就算了，交给整页缩小。
 * 一页上的几块代码缩成一样大（并排的两块一大一小难看）。
 */
export function fitCode(slide: HTMLElement) {
  const pres = Array.from(slide.querySelectorAll<HTMLElement>('pre.code'));
  for (const pre of pres) pre.style.removeProperty('--cfit');
  const blocks = pres.map((pre) => ({ pre, lines: Array.from(pre.querySelectorAll<HTMLElement>('.line')) })).filter((b) => b.lines.length);
  if (!blocks.length) return;
  const win = slide.ownerDocument.defaultView!;
  const wraps = (b: (typeof blocks)[number]) => {
    const lh = parseFloat(win.getComputedStyle(b.pre).lineHeight) || 0;
    return lh > 0 && b.lines.some((l) => l.offsetHeight > lh * 1.5);
  };
  const put = (v: number) => blocks.forEach((b) => (v < 1 ? b.pre.style.setProperty('--cfit', v.toFixed(3)) : b.pre.style.removeProperty('--cfit')));
  const any = () => blocks.some(wraps);
  if (!any()) return;
  put(MIN_CODE_FIT);
  if (any()) return;
  let lo = MIN_CODE_FIT,
    hi = 1;
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    put(mid);
    if (any()) hi = mid;
    else lo = mid;
  }
  put(lo);
}

/** 等浏览器空下来再做：眼前这页先画出来，再在后台取别的 */
export function whenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 600);
  return () => window.clearTimeout(id);
}

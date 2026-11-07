/** 普通 HTTP 部署也能由用户点击复制，不依赖安全上下文的 Clipboard API。 */
export async function copyText(text: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* 使用浏览器的选择复制 */
    }
  }
  const focused = document.activeElement as HTMLElement | null;
  const input = document.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(input);
  input.select();
  try {
    if (!document.execCommand('copy')) throw new Error('未能复制，请选中草稿后手动复制');
  } finally {
    input.remove();
    focused?.focus();
  }
}

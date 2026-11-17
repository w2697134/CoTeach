import { deckTitle } from './model';
import type { Deck } from './types';

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || '课件';

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 导出 PowerPoint（pptxgenjs 用到时才下载） */
export async function downloadPptx(deck: Deck, opts: { answers?: boolean; fileName?: string } = {}) {
  const { deckToPptx } = await import('./pptx');
  const blob = await deckToPptx(deck, opts);
  saveBlob(blob, `${safeName(opts.fileName || deckTitle(deck))}.pptx`);
}

/** 导出 PDF：浏览器打印，一页一张 */
export async function printDeck(deck: Deck, opts: { answers?: boolean; title?: string } = {}) {
  const m = await import('./print');
  await m.printDeck(deck, { ...opts, title: safeName(opts.title || deckTitle(deck)) });
}

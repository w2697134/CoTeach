import { expandPages } from './model';
import { mountStage, type Stage } from './stage';
import type { Deck } from './types';

const PRINT_CSS = `
@page { size: 1280px 720px; margin: 0; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important; }
  body > *:not(#dk-print) { display: none !important; }
  #dk-print { position: static !important; left: 0 !important; width: auto !important; }
  #dk-print .dk-print-page { position: relative; width: 1280px; height: 720px; overflow: hidden; break-after: page; page-break-after: always; break-inside: avoid; }
  #dk-print .dk-print-page:last-child { break-after: auto; page-break-after: auto; }
}`;

/** 打印用的那一块：屏幕上藏在外面，打印时只印它，一页一张 */
export async function mountPrintStage(deck: Deck, opts: { answers?: boolean } = {}): Promise<Stage> {
  document.getElementById('dk-print')?.remove();
  document.getElementById('dk-print-css')?.remove();
  const style = document.createElement('style');
  style.id = 'dk-print-css';
  style.textContent = PRINT_CSS;
  document.head.appendChild(style);
  const stage = await mountStage(deck, expandPages(deck, opts.answers ?? true), { id: 'dk-print' });
  const dispose = stage.dispose;
  return {
    ...stage,
    dispose: () => {
      dispose();
      style.remove();
    },
  };
}

/** 导出 PDF：打开浏览器的打印，选「另存为 PDF」。文件名用课件标题 */
export async function printDeck(deck: Deck, opts: { answers?: boolean; title?: string } = {}) {
  const stage = await mountPrintStage(deck, opts);
  const oldTitle = document.title;
  if (opts.title) document.title = opts.title;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.title = oldTitle;
    stage.dispose();
  };
  window.addEventListener('afterprint', () => setTimeout(finish, 0), { once: true });
  try {
    window.print();
  } finally {
    setTimeout(finish, 1000);
  }
}

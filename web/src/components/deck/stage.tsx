import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { sectionNumbers } from './model';
import { SlideView } from './Slide';
import type { Deck, Page } from './types';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** 每一页按 1280×720 原大画出来（打印、导出 PPT 都从这里量） */
export function StagePages({ deck, pages }: { deck: Deck; pages: Page[] }) {
  const sections = sectionNumbers(deck.slides);
  return (
    <>
      {pages.map((p, i) => (
        <div className="dk-print-page" key={`${p.slide.id}-${p.revealed ? 'a' : 'q'}-${i}`}>
          <SlideView slide={p.slide} theme={deck.theme} index={p.index} sectionNo={sections.get(p.slide.id)} revealed={p.revealed} />
        </div>
      ))}
    </>
  );
}

export interface Stage {
  host: HTMLDivElement;
  /** 每一页的外框（里面是 .dk-slide 或者 iframe） */
  pages: HTMLElement[];
  dispose: () => void;
}

/** 在页面外面挂一块地方把所有页画好；字体加载完、字号量好以后再交出去 */
export async function mountStage(deck: Deck, pages: Page[], opts: { id?: string; style?: string } = {}): Promise<Stage> {
  const host = document.createElement('div');
  if (opts.id) host.id = opts.id;
  host.style.cssText = opts.style ?? 'position:fixed;left:-30000px;top:0;width:1280px;pointer-events:none;';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<StagePages deck={deck} pages={pages} />));
  await document.fonts?.ready;
  await frame();
  // HTML 页在 iframe 里，等每一页都放好、量好字号
  const frames = [...host.querySelectorAll<HTMLIFrameElement>('iframe')];
  const t0 = Date.now();
  while (frames.some((f) => f.dataset.ready !== '1') && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 30));
  await frame();
  await frame();
  return {
    host,
    pages: [...host.querySelectorAll<HTMLElement>('.dk-print-page')],
    dispose: () => {
      root.unmount();
      host.remove();
    },
  };
}

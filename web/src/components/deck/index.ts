/**
 * 课件组件：看、改、放映、导出。
 *
 *   每页有 html（模型照 SLIDE_KIT_GUIDE 写的 HTML）就在 iframe 沙箱里显示；没有 html 的按 layout 版式画。
 *
 *   <DeckEditor deck={deck} onChange={save} onAskAI={(i) => …} busy={[slideId]} />
 *   <SlideView slide={s} theme={deck.theme} width={320} />        一页（缩略图、预览）
 *   <DeckShow deck={deck} start={0} presenter onClose={…} />       单独放映
 *   downloadPptx(deck) / printDeck(deck)                           导出 PPT / PDF
 */
export type { Deck, Slide, SlideLayout, Page } from './types';
export { LAYOUTS, LAYOUT_NAMES } from './types';
export { THEMES, DEFAULT_THEME, themeOf, type DeckTheme } from './themes';
export { SlideView, SLIDE_W, SLIDE_H, type SlideViewProps } from './Slide';
export { DeckEditor, type DeckEditorProps, type DeckEditorHandle } from './DeckEditor';
export { DeckShow, type DeckShowProps } from './Show';
export { downloadPptx, printDeck } from './exporting';
export { normalizeDeck, blankSlide, adaptLayout, deckTitle, slideTitle, hasAnswer, sectionNumbers, expandPages } from './model';
export { SLIDE_KIT_CSS, SLIDE_KIT_GUIDE, HTML_TEMPLATES, type HtmlTemplate } from './kit';
export { HtmlSlide, type HtmlSlideProps } from './HtmlSlide';
export { sanitizeHtml, htmlText, htmlTitle } from './html';
export { CODE_LANGS } from './code';

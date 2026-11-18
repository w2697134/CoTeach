import { forwardRef } from 'react';
import { DeckEditor, DeckShow, type Deck as KitDeck, type DeckEditorHandle } from '../../components/deck';
import type { Deck } from './data';

/**
 * 课件这一栏：课件组件的编辑器（左边缩略图、中间点字就改、讲稿、换主题、撤销），「让助教改这一页」交给右边那一栏。
 * 还在备的时候只能看。
 */
export const DeckPane = forwardRef<
  DeckEditorHandle,
  {
    deck: Deck;
    readOnly: boolean;
    /** 助教正在改的那一页（第几页，0 起），盖一层「在改」 */
    busyPage: number | null;
    fileName: string;
    initialSlide: number;
    onChange: (d: Deck) => void;
    onAskAI: (index: number) => void;
    onSlide?: (index: number) => void;
  }
>(function DeckPane(p, ref) {
  const busy = p.busyPage !== null && p.deck.slides[p.busyPage] ? [p.deck.slides[p.busyPage].id] : [];
  return (
    <DeckEditor
      ref={ref}
      deck={p.deck as unknown as KitDeck}
      onChange={(d) => p.onChange(d as unknown as Deck)}
      onAskAI={p.onAskAI}
      busy={busy}
      readOnly={p.readOnly}
      fileName={p.fileName}
      initialSlide={p.initialSlide}
      onSlide={p.onSlide}
    />
  );
});

/** 全屏放映（带演讲者视图）：课件组件的放映 */
export function Present({ deck, start, onClose }: { deck: Deck; start: number; onClose: () => void }) {
  return <DeckShow deck={deck as unknown as KitDeck} start={start} onClose={() => onClose()} />;
}

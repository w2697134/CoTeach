import { useCallback, useReducer, useRef } from 'react';
import type { Deck } from './types';

interface Snap {
  deck: Deck;
  /** 改的是哪一页（撤销时翻回那一页） */
  sel: number;
}
interface State {
  past: Snap[];
  present: Snap;
  future: Snap[];
  lastKey: string | null;
  lastAt: number;
}

const LIMIT = 200;
/** 同一个格子里连着打字，隔得不久就算一步 */
const MERGE_MS = 1500;

/**
 * 撤销、重做。状态放在 ref 里，改完马上能读到最新的（连着做几步也不会丢），再触发一次重画。
 */
export function useDeckHistory(initial: () => Deck) {
  const ref = useRef<State | null>(null);
  if (!ref.current) ref.current = { past: [], present: { deck: initial(), sel: 0 }, future: [], lastKey: null, lastAt: 0 };
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const commit = useCallback((deck: Deck, sel: number, key?: string) => {
    const h = ref.current!;
    if (deck === h.present.deck) return false;
    const now = Date.now();
    if (key && key === h.lastKey && now - h.lastAt < MERGE_MS) h.present = { deck, sel };
    else {
      h.past = [...h.past.slice(-(LIMIT - 1)), h.present];
      h.present = { deck, sel };
    }
    h.future = [];
    h.lastKey = key ?? null;
    h.lastAt = now;
    redraw();
    return true;
  }, []);

  const undo = useCallback((): Snap | null => {
    const h = ref.current!;
    const prev = h.past[h.past.length - 1];
    if (!prev) return null;
    const undone = h.present;
    h.past = h.past.slice(0, -1);
    h.future = [undone, ...h.future];
    h.present = { deck: prev.deck, sel: Math.max(0, Math.min(undone.sel, prev.deck.slides.length - 1)) };
    h.lastKey = null;
    redraw();
    return h.present;
  }, []);

  const redo = useCallback((): Snap | null => {
    const h = ref.current!;
    const next = h.future[0];
    if (!next) return null;
    h.future = h.future.slice(1);
    h.past = [...h.past, h.present];
    h.present = next;
    h.lastKey = null;
    redraw();
    return next;
  }, []);

  /** 打断合并：比如换了一页再打字，算新的一步 */
  const cut = useCallback(() => {
    ref.current!.lastKey = null;
  }, []);

  const h = ref.current;
  return {
    deck: h.present.deck,
    get: () => ref.current!.present.deck,
    commit,
    undo,
    redo,
    cut,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}

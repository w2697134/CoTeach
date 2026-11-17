import { useEffect, useRef, useState } from 'react';
import { Moon, RotateCcw, Sun } from 'lucide-react';
import { DeckEditor, SlideView, THEMES, hasAnswer, sectionNumbers, type Deck, type DeckEditorHandle } from '../../components/deck';
import { SAMPLE_DECK } from '../../components/deck/sample';
import { SAMPLE_HTML_DECK } from '../../components/deck/sample-html';
import { IconButton, Segmented, cn } from '../../components/ui';
import { toast, useTheme } from '../../lib/store';

type View = 'editor' | 'gallery';
type Sample = 'html' | 'layout';
const SAMPLES: Record<Sample, Deck> = { html: SAMPLE_HTML_DECK, layout: SAMPLE_DECK };

/**
 * 课件组件的演示页，只在开发环境注册（/lab/deck）。
 * ?view=gallery&theme=stage 直接打开某个主题的全部版式，方便截图。
 */
export function DeckLabPage() {
  const params = new URLSearchParams(window.location.search);
  const [view, setView] = useState<View>(params.get('view') === 'gallery' ? 'gallery' : 'editor');
  const [sample, setSample] = useState<Sample>(params.get('sample') === 'layout' ? 'layout' : 'html');
  const [deck, setDeck] = useState<Deck>(() => ({ ...SAMPLES[sample], theme: params.get('theme') || SAMPLES[sample].theme }));
  const [busy, setBusy] = useState<string[]>([]);
  const [epoch, setEpoch] = useState(0);
  const editor = useRef<DeckEditorHandle>(null);
  const { dark, setPref } = useTheme();
  useEffect(() => {
    document.title = '课件 · CoTeach';
  }, []);
  const askAI = (i: number) => {
    const id = deck.slides[i]?.id;
    if (!id) return;
    toast.info(`让助教改第 ${i + 1} 页`);
    setBusy((b) => [...b, id]);
    setTimeout(() => setBusy((b) => b.filter((x) => x !== id)), 2400);
  };
  return (
    <div className="flex h-dvh flex-col bg-bg text-ink">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <span className="text-[15px] font-semibold">课件</span>
        <Segmented
          size="sm"
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { value: 'editor', label: '编辑器' },
            { value: 'gallery', label: '全部版式' },
          ]}
        />
        <Segmented
          size="sm"
          value={sample}
          onChange={(v) => {
            setSample(v);
            setDeck(SAMPLES[v]);
            setEpoch((e) => e + 1);
          }}
          options={[
            { value: 'html', label: 'HTML 课件' },
            { value: 'layout', label: '版式课件' },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label="重置"
            onClick={() => {
              setDeck(SAMPLES[sample]);
              setEpoch((e) => e + 1);
            }}
          >
            <RotateCcw className="size-4" />
          </IconButton>
          <IconButton label={dark ? '浅色' : '深色'} onClick={() => setPref(dark ? 'light' : 'dark')}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </IconButton>
        </div>
      </header>
      {view === 'editor' ? (
        <div className="min-h-0 flex-1 p-3 sm:p-4">
          <div className="h-full overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            <DeckEditor key={epoch} ref={editor} deck={deck} onChange={setDeck} onAskAI={askAI} busy={busy} />
          </div>
        </div>
      ) : (
        <Gallery key={epoch} deck={deck} initialTheme={params.get('theme') || 'all'} />
      )}
    </div>
  );
}

function Gallery({ deck, initialTheme }: { deck: Deck; initialTheme: string }) {
  const [theme, setTheme] = useState(initialTheme);
  const sections = sectionNumbers(deck.slides);
  const shown = theme === 'all' ? THEMES : THEMES.filter((t) => t.id === theme);
  const big = shown.length === 1;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface/90 px-4 py-2 backdrop-blur">
        <Segmented
          size="sm"
          value={theme}
          onChange={setTheme}
          options={[{ value: 'all', label: '全部' }, ...THEMES.map((t) => ({ value: t.id, label: t.name }))]}
        />
      </div>
      <div className="space-y-10 p-6">
        {shown.map((t) => (
          <section key={t.id}>
            <h2 className="mb-3 text-[15px] font-semibold text-ink">{t.name}</h2>
            <div className={cn('grid gap-4', big ? 'grid-cols-[repeat(auto-fill,minmax(400px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(260px,1fr))]')}>
              {deck.slides.flatMap((s, i) => {
                const items = [{ revealed: false, key: s.id }];
                if (hasAnswer(s)) items.push({ revealed: true, key: `${s.id}-a` });
                return items.map((it) => (
                  <figure key={it.key} className="m-0">
                    <AutoSlide>{(w) => <SlideView slide={s} theme={t.id} index={i} sectionNo={sections.get(s.id)} width={w} revealed={it.revealed} className="rounded-md shadow-sm ring-1 ring-line" />}</AutoSlide>
                    <figcaption className="mt-1.5 text-[13px] text-ink-3">
                      {i + 1} · {s.title || s.layout}
                      {it.revealed ? ' · 答案' : ''}
                    </figcaption>
                  </figure>
                ));
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** 按格子的宽度画一页 */
function AutoSlide({ children }: { children: (w: number) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(Math.floor(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ aspectRatio: '16 / 9' }}>
      {w > 0 && children(w)}
    </div>
  );
}

import { decorUrl, THEMES, type DecorKind } from './themes';

/**
 * 课件样式（SLIDE_KIT_CSS）：模型写的每一页 HTML 用这套类名，画布固定 1280×720。
 * 四套主题只换 CSS 变量（body 上的 t-violet / t-stage / t-clean / t-paper），HTML 不用改。
 * 给模型看的说明在 SLIDE_KIT_GUIDE。
 */

const SANS = `"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", "Hiragino Sans GB", system-ui, sans-serif`;
const SERIF = `"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STZhongsong", "SimSun", serif`;
const MONO = `Consolas, "Cascadia Mono", "SF Mono", Menlo, "Microsoft YaHei", monospace`;

const bg = (theme: string, kind: DecorKind, color: string) => {
  const t = THEMES.find((x) => x.id === theme)!;
  const url = decorUrl(t, kind);
  return url ? `url("${url}") 0 0 / 100% 100% no-repeat, ${color}` : color;
};

/* ================================================================ 主题变量 */
const THEME_CSS = `
.t-violet {
  --bg: #ffffff;
  --page-bg: ${bg('violet', 'content', '#ffffff')};
  --cover-bg: ${bg('violet', 'cover', '#4f46e5')};
  --section-bg: ${bg('violet', 'section', '#fbfbff')};
  --center-bg: ${bg('violet', 'quote', '#f7f6ff')};
  --ink: #161a3a; --text: #2c3252; --muted: #6b7191;
  --accent: #4f46e5; --accent-2: #8b5cf6; --accent-3: #0d9488;
  --accent-soft: #f0effe; --accent-line: #dedbfd; --accent-ink: #4338ca; --on-accent: #ffffff;
  --card: #ffffff; --card-border: #e7e7f6; --shadow: 0 14px 34px -20px rgba(43, 35, 140, 0.32); --chip: #f1f2f8;
  --line: #ebebf5; --line-strong: #d4d3ee; --arrow: #a7a3e8; --node-border: #dcd9fb;
  --ok: #059669; --ok-soft: #e6f7ef; --ok-ink: #047857;
  --warn: #d97706; --warn-soft: #fff4df; --warn-ink: #b45309;
  --bad: #dc2626; --bad-soft: #fdecec; --bad-ink: #b91c1c;
  --hl: rgba(139, 92, 246, 0.18);
  --code-bg: #f8f8fd; --code-border: #e3e2f4; --code-fg: #1d1f3d; --code-dim: #8a8aa8; --code-gutter: #b3b1cf;
  --code-mark: rgba(124, 58, 237, 0.1); --code-shadow: none;
  --code-inline-bg: #efeefe; --code-inline-ink: #4338ca;
  --tk-kw: #7c3aed; --tk-str: #0f7a5c; --tk-num: #c2410c; --tk-com: #6e6d8c; --tk-fn: #2457d6; --tk-type: #0e7490;
  --tk-bi: #2457d6; --tk-lit: #c2410c; --tk-meta: #a21caf; --tk-attr: #0e7490; --tk-tag: #be185d; --tk-var: #b45309;
  --th-bg: #4f46e5; --th-ink: #ffffff; --row-alt: #f8f8fe;
  --cover-ink: #ffffff; --cover-sub: rgba(255, 255, 255, 0.84); --cover-kicker: rgba(255, 255, 255, 0.8); --cover-chip: rgba(255, 255, 255, 0.16); --cover-bar: rgba(255, 255, 255, 0.9);
  --cover-align: flex-start; --cover-text: left; --cover-max: 820px;
  --secnum-color: transparent; --secnum-stroke: 3px #8b5cf6; --secnum-bg: transparent; --secnum-size: auto; --secnum-font: 220px; --secnum-weight: 800; --secnum-r: 0;
  --bar-w: 56px; --bar-h: 6px; --bar-r: 3px;
  --dot-w: 14px; --dot-h: 14px; --dot-r: 4px; --dot-bg: var(--accent); --dot-border: 0;
  --radius: 22px;
  --font-head: ${SANS}; --font-body: ${SANS}; --font-mono: ${MONO}; --head-weight: 700;
}
.t-stage {
  --bg: #0b0f1a;
  --page-bg: ${bg('stage', 'content', '#0b0f1a')};
  --cover-bg: ${bg('stage', 'cover', '#0b0f1a')};
  --section-bg: ${bg('stage', 'section', '#0b0f1a')};
  --center-bg: ${bg('stage', 'quote', '#0b0f1a')};
  --ink: #f4f6ff; --text: #cdd5ea; --muted: #8b94b2;
  --accent: #22d3ee; --accent-2: #a78bfa; --accent-3: #fbbf24;
  --accent-soft: rgba(34, 211, 238, 0.1); --accent-line: rgba(34, 211, 238, 0.28); --accent-ink: #67e8f9; --on-accent: #04121a;
  --card: rgba(255, 255, 255, 0.045); --card-border: rgba(255, 255, 255, 0.1); --shadow: none; --chip: rgba(255, 255, 255, 0.07);
  --line: rgba(255, 255, 255, 0.1); --line-strong: rgba(255, 255, 255, 0.22); --arrow: rgba(103, 232, 249, 0.6); --node-border: rgba(255, 255, 255, 0.16);
  --ok: #34d399; --ok-soft: rgba(52, 211, 153, 0.14); --ok-ink: #6ee7b7;
  --warn: #fbbf24; --warn-soft: rgba(251, 191, 36, 0.12); --warn-ink: #fcd34d;
  --bad: #f87171; --bad-soft: rgba(248, 113, 113, 0.13); --bad-ink: #fca5a5;
  --hl: rgba(34, 211, 238, 0.22);
  --code-bg: #10162a; --code-border: rgba(255, 255, 255, 0.09); --code-fg: #dbe2f3; --code-dim: #7c86a6; --code-gutter: #4b5576;
  --code-mark: rgba(34, 211, 238, 0.14); --code-shadow: 0 30px 60px -30px rgba(0, 0, 0, 0.9);
  --code-inline-bg: rgba(34, 211, 238, 0.13); --code-inline-ink: #67e8f9;
  --tk-kw: #ff7b72; --tk-str: #a5d6ff; --tk-num: #79c0ff; --tk-com: #6e7a91; --tk-fn: #d2a8ff; --tk-type: #ffa657;
  --tk-bi: #79c0ff; --tk-lit: #79c0ff; --tk-meta: #d2a8ff; --tk-attr: #7ee787; --tk-tag: #7ee787; --tk-var: #ffa657;
  --th-bg: #16263a; --th-ink: #a5f3fc; --row-alt: rgba(255, 255, 255, 0.03);
  --cover-ink: #ffffff; --cover-sub: #aab3cf; --cover-kicker: #67e8f9; --cover-chip: rgba(255, 255, 255, 0.1); --cover-bar: #22d3ee;
  --cover-align: flex-start; --cover-text: left; --cover-max: 820px;
  --secnum-color: #22d3ee; --secnum-stroke: 0 transparent; --secnum-bg: transparent; --secnum-size: auto; --secnum-font: 220px; --secnum-weight: 800; --secnum-r: 0;
  --bar-w: 44px; --bar-h: 4px; --bar-r: 2px;
  --dot-w: 12px; --dot-h: 12px; --dot-r: 50%; --dot-bg: var(--accent); --dot-border: 0;
  --radius: 20px;
  --font-head: ${SANS}; --font-body: ${SANS}; --font-mono: ${MONO}; --head-weight: 700;
}
.t-clean {
  --bg: #ffffff;
  --page-bg: ${bg('clean', 'content', '#ffffff')};
  --cover-bg: ${bg('clean', 'cover', '#ffffff')};
  --section-bg: ${bg('clean', 'section', '#f6f7f7')};
  --center-bg: ${bg('clean', 'quote', '#ffffff')};
  --ink: #0b0d12; --text: #30343b; --muted: #7b818b;
  --accent: #0f9d7a; --accent-2: #0b7a5f; --accent-3: #f59e0b;
  --accent-soft: #ebf7f3; --accent-line: #cdeadf; --accent-ink: #0b7a5f; --on-accent: #ffffff;
  --card: #f6f7f8; --card-border: #e8eaed; --shadow: none; --chip: #f1f3f5;
  --line: #e8eaed; --line-strong: #d3d7dc; --arrow: #9aa3ad; --node-border: #d9dde2;
  --ok: #0f9d7a; --ok-soft: #e7f5f0; --ok-ink: #0b7a5f;
  --warn: #d97706; --warn-soft: #fdf3e1; --warn-ink: #a35a06;
  --bad: #dc2626; --bad-soft: #fcecec; --bad-ink: #b91c1c;
  --hl: rgba(15, 157, 122, 0.16);
  --code-bg: #f6f8fa; --code-border: #e4e7eb; --code-fg: #1f2328; --code-dim: #8c959f; --code-gutter: #b1b8c0;
  --code-mark: rgba(15, 157, 122, 0.12); --code-shadow: none;
  --code-inline-bg: #f0f2f4; --code-inline-ink: #0b7a5f;
  --tk-kw: #cf222e; --tk-str: #0a3069; --tk-num: #0550ae; --tk-com: #6e7781; --tk-fn: #8250df; --tk-type: #953800;
  --tk-bi: #0550ae; --tk-lit: #0550ae; --tk-meta: #8250df; --tk-attr: #116329; --tk-tag: #116329; --tk-var: #953800;
  --th-bg: #111827; --th-ink: #ffffff; --row-alt: #fafbfb;
  --cover-ink: #0b0d12; --cover-sub: #6b7280; --cover-kicker: #0f9d7a; --cover-chip: #eef0f2; --cover-bar: #0f9d7a;
  --cover-align: flex-start; --cover-text: left; --cover-max: 780px;
  --secnum-color: #0f9d7a; --secnum-stroke: 0 transparent; --secnum-bg: transparent; --secnum-size: auto; --secnum-font: 240px; --secnum-weight: 300; --secnum-r: 0;
  --bar-w: 30px; --bar-h: 4px; --bar-r: 0;
  --dot-w: 18px; --dot-h: 3px; --dot-r: 0; --dot-bg: var(--accent); --dot-border: 0;
  --radius: 12px;
  --font-head: ${SANS}; --font-body: ${SANS}; --font-mono: ${MONO}; --head-weight: 650;
}
.t-paper {
  --bg: #f6f1e7;
  --page-bg: ${bg('paper', 'content', '#f6f1e7')};
  --cover-bg: ${bg('paper', 'cover', '#f6f1e7')};
  --section-bg: ${bg('paper', 'section', '#f6f1e7')};
  --center-bg: ${bg('paper', 'quote', '#f6f1e7')};
  --ink: #2a221c; --text: #3e352d; --muted: #8b7e6e;
  --accent: #b23a2b; --accent-2: #2f5d62; --accent-3: #c08a2e;
  --accent-soft: #f3e6da; --accent-line: #e7d0bf; --accent-ink: #9a2f22; --on-accent: #fff8ef;
  --card: #fbf8f1; --card-border: #e4d8c2; --shadow: none; --chip: #eee5d4;
  --line: #e2d6c1; --line-strong: #cdbd9f; --arrow: #b9a688; --node-border: #dccdb2;
  --ok: #3f7d4e; --ok-soft: #e4eddb; --ok-ink: #2f6a3e;
  --warn: #b7791f; --warn-soft: #f8ecd2; --warn-ink: #8a5a14;
  --bad: #b23a2b; --bad-soft: #f6e1db; --bad-ink: #8a2c20;
  --hl: rgba(192, 138, 46, 0.24);
  --code-bg: #efe6d3; --code-border: #e0d2b7; --code-fg: #3b3128; --code-dim: #9a8b78; --code-gutter: #b5a58b;
  --code-mark: rgba(178, 58, 43, 0.11); --code-shadow: none;
  --code-inline-bg: #ece2cf; --code-inline-ink: #8a2c20;
  --tk-kw: #a3332a; --tk-str: #4a7a3d; --tk-num: #a35f12; --tk-com: #9d907f; --tk-fn: #6b4296; --tk-type: #2f5d62;
  --tk-bi: #2f5d62; --tk-lit: #a35f12; --tk-meta: #6b4296; --tk-attr: #2f5d62; --tk-tag: #a3332a; --tk-var: #8a4b1f;
  --th-bg: #3a2f27; --th-ink: #f8f1e4; --row-alt: #f1eadc;
  --cover-ink: #2a221c; --cover-sub: #7c6f60; --cover-kicker: #b23a2b; --cover-chip: #ece2cf; --cover-bar: #b23a2b;
  --cover-align: center; --cover-text: center; --cover-max: 920px;
  --secnum-color: #fff8ef; --secnum-stroke: 0 transparent; --secnum-bg: #b23a2b; --secnum-size: 190px; --secnum-font: 104px; --secnum-weight: 700; --secnum-r: 14px;
  --bar-w: 40px; --bar-h: 3px; --bar-r: 0;
  --dot-w: 13px; --dot-h: 13px; --dot-r: 50%; --dot-bg: transparent; --dot-border: 2.5px solid var(--accent);
  --radius: 14px;
  --font-head: ${SERIF}; --font-body: ${SANS}; --font-mono: ${MONO}; --head-weight: 700;
}`;

/* ================================================================ 版面和组件 */
const BASE_CSS = `
html, body { margin: 0; padding: 0; width: 1280px; height: 720px; overflow: hidden; background: var(--bg); }
body { position: relative; font-family: var(--font-body); font-size: 26px; line-height: 1.55; color: var(--text);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
*, *::before, *::after { box-sizing: border-box; }
#sk-root { position: absolute; inset: 0; }

/* 一页 */
.slide { position: relative; width: calc(1280px / var(--fit, 1)); height: calc(720px / var(--fit, 1));
  transform: scale(var(--fit, 1)); transform-origin: 0 0; overflow: hidden;
  display: flex; flex-direction: column; gap: 30px; padding: 64px 88px 64px; background: var(--page-bg); }
:where(.slide) :where(h1, h2, h3, h4, p, ul, ol, dl, figure, blockquote, pre) { margin: 0; }
.slide img, .slide svg { max-width: 100%; }
.slide.cover { justify-content: center; align-items: var(--cover-align); text-align: var(--cover-text); gap: 26px; padding: 0 120px; background: var(--cover-bg); color: var(--cover-ink); }
.slide.section { justify-content: center; padding: 0 120px; background: var(--section-bg); }
.slide.center { justify-content: center; align-items: center; text-align: center; padding: 0 150px; background: var(--center-bg); }

/* 字 */
h1, .title { font-family: var(--font-head); font-size: 52px; line-height: 1.2; font-weight: var(--head-weight); color: var(--ink); letter-spacing: -0.01em; text-wrap: balance; }
h2 { font-family: var(--font-head); font-size: 38px; line-height: 1.25; font-weight: var(--head-weight); color: var(--ink); }
h3 { font-size: 28px; line-height: 1.35; font-weight: 700; color: var(--ink); }
h4 { font-size: 23px; line-height: 1.4; font-weight: 700; color: var(--ink); }
.subtitle { font-size: 26px; line-height: 1.5; color: var(--muted); font-weight: 400; }
.kicker { font-size: 17px; line-height: 1.4; font-weight: 700; letter-spacing: 0.14em; color: var(--accent-ink); }
.lead { font-size: 30px; line-height: 1.55; }
p { text-wrap: pretty; }
.small { font-size: 20px; }
.big { font-size: 34px; }
.muted { color: var(--muted); }
.accent { color: var(--accent-ink); }
.center-text { text-align: center; }
strong, b { font-weight: 700; color: var(--ink); }
em { font-style: normal; font-weight: 700; color: var(--accent-ink); }
mark, .hl { background: var(--hl); color: inherit; padding: 0 0.12em; border-radius: 0.18em; }
code { font-family: var(--font-mono); font-size: 0.86em; padding: 0.05em 0.34em; border-radius: 0.26em; background: var(--code-inline-bg); color: var(--code-inline-ink); font-variant-ligatures: none; }
hr { border: 0; height: 2px; margin: 0; background: var(--line); }

/* 标题区：上面一道短色条 */
.head { position: relative; display: flex; flex-direction: column; gap: 10px; padding-top: 26px; flex: none; }
.head::before { content: ''; position: absolute; left: 0; top: 0; width: var(--bar-w); height: var(--bar-h); border-radius: var(--bar-r); background: var(--accent); }
.head.plain { padding-top: 0; }
.head.plain::before { display: none; }
.cover .head::before { background: var(--cover-bar); left: var(--cover-bar-left, 0); }
.t-paper .cover .head::before { width: 54px; height: 54px; border-radius: 8px; left: calc(50% - 27px); top: 0; }
.t-paper .cover .head { padding-top: 92px; }
.cover .title, .cover h1 { font-size: 78px; line-height: 1.15; font-weight: 800; color: var(--cover-ink); max-width: var(--cover-max); }
.cover .subtitle { font-size: 30px; color: var(--cover-sub); max-width: 760px; }
.cover .kicker { color: var(--cover-kicker); }
.cover .tag { background: var(--cover-chip); color: var(--cover-ink); }
.t-paper .cover .title { font-weight: 700; letter-spacing: 0.02em; }
.section .title, .section h2 { font-size: 64px; line-height: 1.18; }

/* 排版 */
.row { display: flex; align-items: center; gap: 20px; }
.row.top { align-items: flex-start; }
.row.wrap { flex-wrap: wrap; }
.stack > * + * { margin-top: 16px; }
.fill { flex: 1; min-height: 0; min-width: 0; }
.middle { margin-top: auto; margin-bottom: auto; }
.bottom { margin-top: auto; }
.grid-2, .grid-3, .grid-4, .split { display: grid; gap: 24px; }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.split { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 56px; align-items: center; flex: 1; min-height: 0; }
.gap-sm { gap: 12px; }
.gap-lg { gap: 40px; }

/* 列表 */
ul.list, ol.list, ul.checks { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 18px; font-size: 28px; line-height: 1.5; }
ul.list > li { position: relative; padding-left: 38px; }
ul.list > li::before { content: ''; position: absolute; left: 2px; top: calc(0.75em - var(--dot-h) / 2); width: var(--dot-w); height: var(--dot-h); border-radius: var(--dot-r); background: var(--dot-bg); border: var(--dot-border); }
ol.list { counter-reset: n; }
ol.list > li { position: relative; padding-left: 58px; counter-increment: n; }
ol.list > li::before { content: counter(n); position: absolute; left: 0; top: calc(0.75em - 19px); width: 38px; height: 38px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink); font-size: 20px; font-weight: 800; line-height: 38px; text-align: center; }
ul.checks > li { position: relative; padding-left: 52px; }
ul.checks > li::before { content: '✓'; position: absolute; left: 0; top: calc(0.75em - 16px); width: 32px; height: 32px; border-radius: 50%; background: var(--ok-soft); color: var(--ok); font-size: 18px; font-weight: 800; line-height: 32px; text-align: center; }
.list.sm, .checks.sm { font-size: 23px; gap: 12px; }
.list.lg, .checks.lg { font-size: 32px; gap: 24px; }
.list.cols, .checks.cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 48px; }
li > b:first-child, li > strong:first-child { margin-right: 0.3em; }

/* 卡片 */
.card { position: relative; padding: 28px 30px; border-radius: var(--radius); background: var(--card); border: 1.5px solid var(--card-border); box-shadow: var(--shadow); font-size: 23px; line-height: 1.55; }
.card > * + * { margin-top: 12px; }
.card > h3, .card > h4 { margin-bottom: 0; }
.card.soft { background: var(--accent-soft); border-color: var(--accent-line); box-shadow: none; }
.card.accent { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.card.accent h3, .card.accent h4, .card.accent b, .card.accent strong, .card.accent .muted { color: var(--on-accent); }
.card.outline { background: transparent; box-shadow: none; }
.card.dashed { background: transparent; box-shadow: none; border-style: dashed; border-color: var(--line-strong); }
.icon { width: 56px; height: 56px; flex: none; border-radius: 16px; display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent-ink); font-size: 26px; font-weight: 800; line-height: 1; }
.icon.solid { background: var(--accent); color: var(--on-accent); }

/* 步骤 */
ol.steps { list-style: none; padding: 0; counter-reset: s; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 32px; font-size: 22px; line-height: 1.5; color: var(--muted); }
ol.steps > li { position: relative; counter-increment: s; padding-top: 92px; }
ol.steps > li::before { content: counter(s); position: absolute; left: 0; top: 0; width: 66px; height: 66px; border-radius: 50%; background: var(--accent); color: var(--on-accent); font-size: 27px; font-weight: 800; line-height: 66px; text-align: center; z-index: 1; }
ol.steps > li::after { content: ''; position: absolute; left: 80px; right: -18px; top: 31.5px; height: 3px; border-radius: 2px; background: var(--line-strong); }
ol.steps > li:last-child::after { display: none; }
ol.steps > li > b, ol.steps > li > strong { display: block; margin-bottom: 8px; font-size: 26px; line-height: 1.4; color: var(--ink); }
ol.steps.vertical { grid-auto-flow: row; grid-auto-columns: auto; gap: 22px; }
ol.steps.vertical > li { padding: 6px 0 0 84px; min-height: 56px; }
ol.steps.vertical > li::before { width: 56px; height: 56px; line-height: 56px; font-size: 23px; }
ol.steps.vertical > li::after { left: 26.5px; right: auto; top: 62px; bottom: -18px; width: 3px; height: auto; }
ol.steps.vertical > li > b, ol.steps.vertical > li > strong { display: inline; margin: 0 0.5em 0 0; }

/* 代码块 */
/* 像 PPT 里贴的代码：浅底细边框、行号淡色，不画窗口按钮；一行太长时页面把这一块的字缩小（--cfit），不折行 */
pre.code { position: relative; display: block; padding: 22px 32px 22px 0; border-radius: min(var(--radius), 16px); background: var(--code-bg); color: var(--code-fg); border: 1.5px solid var(--code-border); box-shadow: var(--code-shadow);
  font-family: var(--font-mono); font-size: calc(22px * var(--cfit, 1)); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; counter-reset: ln; font-variant-ligatures: none; text-align: left; }
pre.code code { display: block; padding: 0; border-radius: 0; background: none; color: inherit; font-size: inherit; }
pre.code .line { display: block; position: relative; padding-left: 76px; min-height: 1.6em; margin-right: -32px; padding-right: 32px; }
pre.code .line::before { content: counter(ln); counter-increment: ln; position: absolute; left: 0; top: 0; width: 54px; text-align: right; color: var(--code-gutter); }
pre.code .line.mark { background: var(--code-mark); box-shadow: inset 4px 0 0 var(--accent); }
.t-stage pre.code.has-mark .line:not(.mark) > span { opacity: 0.55; }
pre.code.plain .line { padding-left: 32px; }
pre.code.plain .line::before { display: none; }
pre.code.sm { font-size: calc(19px * var(--cfit, 1)); }
.tk-kw { color: var(--tk-kw); } .tk-str { color: var(--tk-str); } .tk-num { color: var(--tk-num); } .tk-com { color: var(--tk-com); }
.tk-fn { color: var(--tk-fn); } .tk-type { color: var(--tk-type); } .tk-bi { color: var(--tk-bi); } .tk-lit { color: var(--tk-lit); }
.tk-meta { color: var(--tk-meta); } .tk-attr { color: var(--tk-attr); } .tk-tag { color: var(--tk-tag); } .tk-var { color: var(--tk-var); } .tk-sub, .tk-x { color: var(--code-fg); }

/* 提示框 */
.callout { position: relative; padding: 20px 26px 20px 46px; border-radius: 16px; background: var(--accent-soft); color: var(--text); font-size: 24px; line-height: 1.55; }
.callout::before { content: ''; position: absolute; left: 18px; top: 18px; bottom: 18px; width: 6px; border-radius: 3px; background: var(--accent); }
.callout > b:first-child, .callout > strong:first-child { color: var(--accent-ink); margin-right: 0.4em; }
.callout.warn { background: var(--warn-soft); }
.callout.warn::before { background: var(--warn); }
.callout.warn > b:first-child, .callout.warn > strong:first-child { color: var(--warn-ink); }
.callout.bad { background: var(--bad-soft); }
.callout.bad::before { background: var(--bad); }
.callout.bad > b:first-child, .callout.bad > strong:first-child { color: var(--bad-ink); }
.callout.ok { background: var(--ok-soft); }
.callout.ok::before { background: var(--ok); }
.callout.ok > b:first-child, .callout.ok > strong:first-child { color: var(--ok-ink); }

/* 大数字 */
.stat { display: flex; flex-direction: column; gap: 6px; }
.num, .big-num { font-family: var(--font-body); font-size: 96px; line-height: 1.05; font-weight: 800; letter-spacing: -0.03em; color: var(--accent); }
.label { font-size: 22px; line-height: 1.45; color: var(--muted); }
.section .big-num { flex: none; display: flex; align-items: center; justify-content: center; width: var(--secnum-size); height: var(--secnum-size); border-radius: var(--secnum-r);
  background: var(--secnum-bg); color: var(--secnum-color); -webkit-text-stroke: var(--secnum-stroke); font-family: var(--font-head); font-size: var(--secnum-font); font-weight: var(--secnum-weight); line-height: 1; letter-spacing: -0.03em; }
.t-paper .section .big-num { letter-spacing: 0; }

/* 标签 */
.tags { display: flex; flex-wrap: wrap; gap: 10px; }
.tag { display: inline-flex; align-items: center; height: 36px; padding: 0 16px; border-radius: 18px; background: var(--accent-soft); color: var(--accent-ink); font-size: 18px; font-weight: 700; line-height: 1; white-space: nowrap; vertical-align: middle; }
.tag.solid { background: var(--accent); color: var(--on-accent); }
.tag.ok { background: var(--ok-soft); color: var(--ok-ink); }
.tag.warn { background: var(--warn-soft); color: var(--warn-ink); }
.tag.bad { background: var(--bad-soft); color: var(--bad-ink); }
.tag.gray { background: var(--chip); color: var(--muted); }

/* 图示：方块和箭头 */
.flow { display: flex; align-items: center; }
.flow.vertical { flex-direction: column; align-items: center; }
.node { flex: none; min-width: 170px; padding: 24px 30px; border-radius: 20px; background: var(--card); border: 2px solid var(--node-border); box-shadow: var(--shadow); color: var(--ink); font-size: 28px; font-weight: 700; line-height: 1.35; text-align: center; }
.node small, .node .small { display: block; margin-top: 6px; font-size: 19px; font-weight: 500; color: var(--muted); }
.node.accent { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.node.accent small, .node.accent .small { color: var(--on-accent); opacity: 0.85; }
.node.soft { background: var(--accent-soft); border-color: var(--accent-line); box-shadow: none; }
.node.round { border-radius: 999px; }
.arrow { position: relative; flex: 1; min-width: 64px; height: 3px; margin: 0 16px; border-radius: 2px; background: var(--arrow); }
.arrow::after { content: ''; position: absolute; right: -4px; top: -8px; width: 0; height: 0; border-left: 15px solid var(--arrow); border-top: 9.5px solid transparent; border-bottom: 9.5px solid transparent; }
.arrow > span { position: absolute; left: 0; right: 0; bottom: 12px; font-size: 19px; line-height: 1.3; color: var(--muted); text-align: center; white-space: nowrap; }
.arrow.down, .flow.vertical .arrow { flex: none; width: 3px; height: 52px; min-width: 0; margin: 14px 0; }
.arrow.down::after, .flow.vertical .arrow::after { right: auto; top: auto; left: -8px; bottom: -4px; border-left: 9.5px solid transparent; border-right: 9.5px solid transparent; border-top: 15px solid var(--arrow); border-bottom: 0; }
.arrow.down > span, .flow.vertical .arrow > span { left: 18px; right: auto; bottom: auto; top: 50%; margin-top: -11px; text-align: left; }
.box { padding: 22px 26px; border-radius: 18px; border: 2px dashed var(--line-strong); }

/* 表格 */
.slide table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 22px; line-height: 1.45; background: var(--card); border: 1.5px solid var(--card-border); border-radius: 16px; overflow: hidden; }
.slide th { background: var(--th-bg); color: var(--th-ink); font-weight: 700; text-align: left; padding: 15px 22px; vertical-align: middle; }
.slide td { padding: 13px 22px; border-top: 1px solid var(--line); vertical-align: top; color: var(--text); }
.slide tbody tr:nth-child(even) td { background: var(--row-alt); }
.slide td:first-child { color: var(--ink); font-weight: 650; }
.slide table.plain td:first-child { font-weight: 400; color: var(--text); }

/* 引用 */
blockquote, .quote { position: relative; font-family: var(--font-head); font-size: 46px; line-height: 1.5; font-weight: 650; color: var(--ink); text-wrap: pretty; }
blockquote::before, .quote::before { content: '“'; position: absolute; left: -26px; top: -118px; font-family: Georgia, 'Times New Roman', serif; font-size: 220px; line-height: 1; font-weight: 700; color: var(--accent); opacity: 0.2; }
.cite { font-size: 24px; color: var(--muted); }

/* 练习：揭晓答案时 body 上加 reveal */
.question { font-size: 34px; line-height: 1.45; font-weight: 650; color: var(--ink); }
ol.options { list-style: none; padding: 0; counter-reset: opt; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; font-size: 27px; line-height: 1.45; }
ol.options.one-col { grid-template-columns: minmax(0, 1fr); }
ol.options > li { position: relative; counter-increment: opt; padding: 18px 64px 18px 84px; border-radius: 16px; background: var(--card); border: 2px solid var(--card-border); min-height: 80px; }
ol.options > li::before { content: counter(opt, upper-alpha); position: absolute; left: 22px; top: 18px; width: 42px; height: 42px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink); font-size: 21px; font-weight: 800; line-height: 42px; text-align: center; }
.reveal ol.options > li.answer { background: var(--ok-soft); border-color: var(--ok); }
.reveal ol.options > li.answer::before { background: var(--ok); color: #ffffff; }
.reveal ol.options > li.answer::after { content: '✓'; position: absolute; right: 24px; top: 20px; height: 38px; line-height: 38px; font-size: 30px; font-weight: 800; color: var(--ok); }
.reveal ol.options > li:not(.answer) { opacity: 0.45; }
.explain { display: none; position: relative; padding: 18px 24px 18px 46px; border-radius: 16px; background: var(--accent-soft); font-size: 23px; line-height: 1.55; }
.explain::before { content: ''; position: absolute; left: 18px; top: 18px; bottom: 18px; width: 6px; border-radius: 3px; background: var(--accent); }
.reveal .explain { display: block; }

/* 图片、图 */
figure { display: flex; flex-direction: column; align-items: center; gap: 10px; }
figcaption { font-size: 18px; color: var(--muted); }

/* 页码（不是模型写的，渲染时加） */
.sk-pageno { position: absolute; right: 52px; bottom: 26px; z-index: 5; font-size: 16px; line-height: 20px; letter-spacing: 0.08em; color: var(--muted); font-variant-numeric: tabular-nums; }
.t-paper .sk-pageno { left: 0; right: 0; bottom: 40px; text-align: center; letter-spacing: 0.2em; }
.t-clean .sk-pageno { right: 80px; bottom: 22px; }
.no-num .sk-pageno { display: none; }
`;

/** 编辑时才有的：鼠标移上去给字描一圈，告诉老师这里能点 */
export const SLIDE_EDIT_CSS = `
.editing { caret-color: var(--accent); }
.editing .slide :is(h1, h2, h3, h4, p, li, td, th, blockquote, figcaption, .kicker, .subtitle, .label, .num, .big-num, .tag, .node, .cite, .question, .explain, .callout, pre):hover {
  outline: 2px solid color-mix(in srgb, var(--accent) 30%, transparent); outline-offset: 3px; border-radius: 4px; }
.editing .slide :focus { outline: none; }
.editing ::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }
`;

export const SLIDE_KIT_CSS = `/* CoTeach 课件样式 · 一页 1280×720 */\n${THEME_CSS}\n${BASE_CSS}`;

/** 给模型看的样式说明（写进生成课件的提示词） */
export const SLIDE_KIT_GUIDE = `你写的是一页课件的 HTML 片段，画布固定 1280×720，不能滚动。外层已经套好了样式（SLIDE_KIT_CSS），主题由系统换，你只写结构和字。
规则：只写一个根元素 <div class="slide">…</div>；只用下面的类名，必要时加少量行内 style（间距、宽度、对齐）；不要写 <style>、<script>、事件属性、外部图片和链接（图可以用行内 <svg> 或 data: 图片）；字要少，一页一个意思，大约 6 行以内的正文，代码不超过 12 行；颜色不要自己写，用类名。

页面
- <div class="slide">：普通页，从上往下排，块和块之间自动留 30px。
- <div class="slide cover">：封面（主题色底，字是白的）。里面放 .head（.kicker 小字、h1.title、.subtitle），可再加 .tags。
- <div class="slide section">：章节页。<div class="row"><span class="big-num">01</span><div><h2 class="title">章节名</h2><p class="subtitle">一句话</p></div></div>
- <div class="slide center">：居中的页（引用、一句话总结）。
- 位置：.middle 让一块在剩下的空间里上下居中；.bottom 放到最下面；.fill 占满剩下的空间。

标题区
- <header class="head"><p class="kicker">小标签</p><h1 class="title">标题</h1><p class="subtitle">副标题</p></header>（顶上自动有一道短色条；.head.plain 不要色条）
- 字：h2 / h3 / h4 小标题，.lead 大一号的正文，.small 小字，.muted 灰字，.accent 主题色字，<b> 加粗，<em> 强调（主题色加粗），<mark> 荧光笔，<code> 行内代码。

列表
- <ul class="list"> 圆点；<ol class="list"> 带编号圆圈；<ul class="checks"> 打勾。加 .sm / .lg 变小变大，.cols 排成两栏。<li> 里开头可以用 <b>小标题</b> 再接说明。

卡片和网格
- .grid-2 / .grid-3 / .grid-4 等宽两三四栏；.split 左右两半（上下居中）；.row 横排（.row.top 顶端对齐），.stack 竖排。
- <div class="card"><h3>标题</h3><p>说明</p></div>；.card.soft 浅色底，.card.accent 实色底，.card.outline 只有边框，.card.dashed 虚线框。
- <div class="icon">字或 emoji</div> 圆角小方块，.icon.solid 实色。

步骤
- <ol class="steps"><li><b>第一步</b>说明</li>…</ol> 横排带编号和连线，2 到 4 步；超过 4 步用 <ol class="steps vertical">。

代码
- <pre class="code" data-lang="python"><code>代码原样写，&lt; &gt; &amp; 要转义</code></pre> 代码框，自动上色、带行号。
- data-mark="2,4-5" 突出这几行；.plain 不要行号；.sm 字小一号。

提示框
- <div class="callout"><b>记住</b>说明</div> 主题色；.callout.warn 注意（橙）；.callout.bad 易错（红）；.callout.ok 正确做法（绿）。

大数字和标签
- <div class="stat"><div class="num">98%</div><div class="label">说明</div></div>；单独的大数字用 .big-num。
- <span class="tag">标签</span>，.tag.solid / .ok / .warn / .bad / .gray；一排标签放在 <div class="tags"> 里。

图示
- <div class="flow"><div class="node">输入<small>小字</small></div><div class="arrow"><span>箭头上的字</span></div><div class="node accent">处理</div></div>
- .node.soft 浅色，.node.accent 实色，.node.round 胶囊形；.flow.vertical 竖着排（箭头朝下），单独的竖箭头用 .arrow.down；.box 虚线框，把几块框在一起。

表格
- 普通 <table>，第一行用 <thead><tr><th>…；第一列自动加粗，<table class="plain"> 不加粗。不超过 6 行 4 列。

引用
- <blockquote>一句话</blockquote><p class="cite">—— 出处</p>，常放在 .slide.center 里。

练习（放映时可以揭晓答案）
- <p class="question">题目</p><ol class="options"><li>选项</li><li class="answer">正确的选项</li>…</ol><div class="explain"><b>解析</b>为什么</div>
- 正确选项加 class="answer"（多选就加在几个上）；选项长就用 <ol class="options one-col">；.explain 只在揭晓后显示。`;

/* ================================================================ 新建一页时的样子 */
export interface HtmlTemplate {
  id: string;
  name: string;
  html: string;
}

export const HTML_TEMPLATES: HtmlTemplate[] = [
  {
    id: 'cover',
    name: '封面',
    html: `<div class="slide cover"><header class="head"><p class="kicker">课程名称</p><h1 class="title">这节课的标题</h1><p class="subtitle">第几讲 · 副标题</p></header></div>`,
  },
  {
    id: 'section',
    name: '章节',
    html: `<div class="slide section"><div class="row gap-lg"><span class="big-num">01</span><div><h2 class="title">章节名称</h2><p class="subtitle">这一部分讲什么</p></div></div></div>`,
  },
  {
    id: 'points',
    name: '要点',
    html: `<div class="slide"><header class="head"><h1 class="title">标题</h1></header><ul class="list"><li>第一条要点</li><li>第二条要点</li><li>第三条要点</li></ul></div>`,
  },
  {
    id: 'cards',
    name: '卡片',
    html: `<div class="slide"><header class="head"><h1 class="title">标题</h1></header><div class="grid-3"><div class="card"><div class="icon">1</div><h3>小标题</h3><p>一两句说明</p></div><div class="card"><div class="icon">2</div><h3>小标题</h3><p>一两句说明</p></div><div class="card"><div class="icon">3</div><h3>小标题</h3><p>一两句说明</p></div></div></div>`,
  },
  {
    id: 'compare',
    name: '对比',
    html: `<div class="slide"><header class="head"><h1 class="title">甲和乙有什么不同</h1></header><div class="grid-2"><div class="card"><h3>甲</h3><ul class="list sm"><li>特点</li><li>特点</li></ul></div><div class="card soft"><h3>乙</h3><ul class="list sm"><li>特点</li><li>特点</li></ul></div></div></div>`,
  },
  {
    id: 'code',
    name: '代码',
    html: `<div class="slide"><header class="head"><h1 class="title">标题</h1></header><pre class="code" data-lang="python"><code>print("你好")</code></pre><div class="callout"><b>说明</b>这段代码做了什么</div></div>`,
  },
  {
    id: 'steps',
    name: '步骤',
    html: `<div class="slide"><header class="head"><h1 class="title">标题</h1></header><ol class="steps middle"><li><b>第一步</b>说明</li><li><b>第二步</b>说明</li><li><b>第三步</b>说明</li></ol></div>`,
  },
  {
    id: 'flow',
    name: '图示',
    html: `<div class="slide"><header class="head"><h1 class="title">标题</h1></header><div class="flow middle"><div class="node">输入</div><div class="arrow"><span>经过</span></div><div class="node accent">处理</div><div class="arrow"></div><div class="node">输出</div></div></div>`,
  },
  {
    id: 'table',
    name: '表格',
    html: `<div class="slide"><header class="head"><h1 class="title">标题</h1></header><table><thead><tr><th>名称</th><th>作用</th><th>例子</th></tr></thead><tbody><tr><td>甲</td><td>说明</td><td>示例</td></tr><tr><td>乙</td><td>说明</td><td>示例</td></tr></tbody></table></div>`,
  },
  {
    id: 'stats',
    name: '数字',
    html: `<div class="slide"><header class="head"><h1 class="title">标题</h1></header><div class="grid-3 middle"><div class="stat"><div class="num">3</div><div class="label">说明</div></div><div class="stat"><div class="num">80%</div><div class="label">说明</div></div><div class="stat"><div class="num">12</div><div class="label">说明</div></div></div></div>`,
  },
  {
    id: 'quiz',
    name: '练习',
    html: `<div class="slide"><header class="head"><p class="kicker">随堂练习</p><p class="question">题目写在这里？</p></header><ol class="options"><li>选项一</li><li class="answer">选项二</li><li>选项三</li><li>选项四</li></ol><div class="explain"><b>解析</b>为什么选它</div></div>`,
  },
  {
    id: 'quote',
    name: '引用',
    html: `<div class="slide center"><blockquote>一句值得记住的话</blockquote><p class="cite">—— 出处</p></div>`,
  },
  {
    id: 'summary',
    name: '小结',
    html: `<div class="slide"><header class="head"><h1 class="title">本课小结</h1></header><ul class="checks lg"><li>收获一</li><li>收获二</li><li>收获三</li></ul></div>`,
  },
];

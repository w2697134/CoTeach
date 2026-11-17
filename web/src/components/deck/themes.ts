import type { SlideLayout } from './types';

/**
 * 主题：颜色和字号写在 deck.css 的 .dk-t-<id> 里；这里放名字、导出 PPT 用的字体、
 * 以及每种页面的底纹（一张 1280×720 的 SVG，网页里当背景图，导出 PPT 时画成图片垫在最底下）。
 */
export type DecorKind = 'cover' | 'section' | 'content' | 'quote';

export interface DeckTheme {
  id: string;
  name: string;
  dark: boolean;
  /** 选主题时的色块 */
  swatch: [string, string, string];
  /** 导出 PPT 用的字体（老师电脑上大多有） */
  fonts: { head: string; body: string; mono: string };
  decor: (kind: DecorKind) => string | null;
}

const W = 1280,
  H = 720;
const svg = (body: string, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;

/** 一片小圆点 */
const dots = (x: number, y: number, cols: number, rows: number, gap: number, r: number, fill: string, opacity = 1) => {
  let out = '';
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) out += `<circle cx="${x + i * gap}" cy="${y + j * gap}" r="${r}"/>`;
  return `<g fill="${fill}" opacity="${opacity}">${out}</g>`;
};

/* ---------------- 紫蓝（默认，跟 CoTeach 的颜色一路） ---------------- */
const violet: DeckTheme = {
  id: 'violet',
  name: '紫蓝',
  dark: false,
  swatch: ['#4f46e5', '#8b5cf6', '#14b8a6'],
  fonts: { head: 'Microsoft YaHei', body: 'Microsoft YaHei', mono: 'Consolas' },
  decor(kind) {
    if (kind === 'cover')
      return svg(
        `<rect width="${W}" height="${H}" fill="url(#g)"/>
         <circle cx="1075" cy="150" r="300" fill="#a78bfa" opacity=".38"/>
         <circle cx="1170" cy="700" r="250" fill="#2dd4bf" opacity=".5"/>
         <circle cx="1175" cy="700" r="250" fill="url(#t)" opacity=".7"/>
         <circle cx="880" cy="350" r="118" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2"/>
         <circle cx="-60" cy="760" r="210" fill="#fff" opacity=".05"/>
         ${dots(1046, 66, 6, 4, 22, 2.6, '#fff', 0.55)}`,
        `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b33c4"/><stop offset=".55" stop-color="#5b47ec"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>
         <radialGradient id="t" cx=".3" cy=".3" r=".8"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#0d9488"/></radialGradient>`,
      );
    if (kind === 'section')
      return svg(
        `<rect width="${W}" height="${H}" fill="#fbfbff"/>
         <circle cx="1290" cy="735" r="330" fill="#efebff"/>
         <circle cx="1290" cy="735" r="200" fill="#e6e0ff" opacity=".7"/>
         ${dots(1060, 64, 6, 3, 22, 2.6, '#c4b5fd', 0.9)}`,
      );
    if (kind === 'quote')
      return svg(
        `<rect width="${W}" height="${H}" fill="#f7f6ff"/>
         <circle cx="40" cy="40" r="330" fill="#eeebff"/>
         <circle cx="1240" cy="700" r="190" fill="#dff5f2"/>
         ${dots(1046, 70, 6, 3, 22, 2.6, '#c4b5fd', 0.9)}`,
      );
    return svg(
      `<rect width="${W}" height="${H}" fill="#ffffff"/>
       <circle cx="1290" cy="735" r="215" fill="#f4f1ff"/>
       ${dots(1094, 52, 6, 3, 20, 2.4, '#d6cefb')}`,
    );
  },
};

/* ---------------- 讲台（深色） ---------------- */
const grid = (step: number, color: string) => {
  let d = '';
  for (let x = step; x < W; x += step) d += `M${x} 0V${H}`;
  for (let y = step; y < H; y += step) d += `M0 ${y}H${W}`;
  return `<path d="${d}" stroke="${color}" stroke-width="1" fill="none"/>`;
};
const stage: DeckTheme = {
  id: 'stage',
  name: '讲台',
  dark: true,
  swatch: ['#0b0f1a', '#22d3ee', '#a78bfa'],
  fonts: { head: 'Microsoft YaHei', body: 'Microsoft YaHei', mono: 'Consolas' },
  decor(kind) {
    const glow = `<radialGradient id="a"><stop offset="0" stop-color="#4f46e5" stop-opacity=".55"/><stop offset="1" stop-color="#4f46e5" stop-opacity="0"/></radialGradient>
      <radialGradient id="b"><stop offset="0" stop-color="#06b6d4" stop-opacity=".4"/><stop offset="1" stop-color="#06b6d4" stop-opacity="0"/></radialGradient>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>`;
    if (kind === 'cover')
      return svg(
        `<rect width="${W}" height="${H}" fill="#0b0f1a"/>
         <g mask="url(#m)">${grid(64, 'rgba(255,255,255,.05)')}</g>
         <circle cx="190" cy="80" r="620" fill="url(#a)"/>
         <circle cx="1150" cy="660" r="560" fill="url(#b)"/>
         <circle cx="1010" cy="250" r="150" fill="none" stroke="#22d3ee" stroke-opacity=".35" stroke-width="1.5"/>
         <circle cx="1010" cy="250" r="96" fill="none" stroke="#a78bfa" stroke-opacity=".35" stroke-width="1.5"/>
         <circle cx="1106" cy="216" r="6" fill="#22d3ee"/>`,
        glow,
      );
    if (kind === 'section')
      return svg(
        `<rect width="${W}" height="${H}" fill="#0b0f1a"/>
         <g mask="url(#m)" opacity=".8">${grid(64, 'rgba(255,255,255,.04)')}</g>
         <circle cx="260" cy="360" r="520" fill="url(#a)" opacity=".8"/>
         <circle cx="1200" cy="700" r="420" fill="url(#b)" opacity=".7"/>`,
        glow,
      );
    if (kind === 'quote')
      return svg(`<rect width="${W}" height="${H}" fill="#0b0f1a"/><circle cx="640" cy="330" r="560" fill="url(#a)" opacity=".6"/>`, glow);
    return svg(
      `<rect width="${W}" height="${H}" fill="#0b0f1a"/>
       <circle cx="80" cy="-40" r="520" fill="url(#a)" opacity=".5"/>
       <circle cx="1280" cy="760" r="380" fill="url(#b)" opacity=".35"/>`,
      glow,
    );
  },
};

/* ---------------- 简白 ---------------- */
const clean: DeckTheme = {
  id: 'clean',
  name: '简白',
  dark: false,
  swatch: ['#ffffff', '#111827', '#0f9d7a'],
  fonts: { head: 'Microsoft YaHei', body: 'Microsoft YaHei', mono: 'Consolas' },
  decor(kind) {
    if (kind === 'cover')
      return svg(
        `<rect width="${W}" height="${H}" fill="#ffffff"/>
         <rect x="0" y="0" width="18" height="${H}" fill="#0f9d7a"/>
         <rect x="980" y="0" width="300" height="${H}" fill="#f3f5f4"/>
         <circle cx="980" cy="360" r="150" fill="none" stroke="#0f9d7a" stroke-width="2"/>
         <circle cx="980" cy="360" r="6" fill="#0f9d7a"/>
         <path d="M980 0V${H}" stroke="#e3e6e8" stroke-width="1.5"/>
         <path d="M96 640H900" stroke="#e5e7eb" stroke-width="1.5"/>`,
      );
    if (kind === 'section') return svg(`<rect width="${W}" height="${H}" fill="#f6f7f7"/><rect x="0" y="0" width="18" height="${H}" fill="#0f9d7a"/>`);
    if (kind === 'quote') return svg(`<rect width="${W}" height="${H}" fill="#ffffff"/><rect x="0" y="0" width="18" height="${H}" fill="#0f9d7a"/>`);
    return svg(`<rect width="${W}" height="${H}" fill="#ffffff"/><path d="M80 664H1200" stroke="#eceef1" stroke-width="1.5"/>`);
  },
};

/* ---------------- 书卷（暖纸、宋体标题、朱红） ---------------- */
const frame = (inset: number, color: string, double: boolean) =>
  `<rect x="${inset}" y="${inset}" width="${W - inset * 2}" height="${H - inset * 2}" fill="none" stroke="${color}" stroke-width="1.5"/>` +
  (double ? `<rect x="${inset + 7}" y="${inset + 7}" width="${W - inset * 2 - 14}" height="${H - inset * 2 - 14}" fill="none" stroke="${color}" stroke-width=".8"/>` : '');
const corner = (x: number, y: number, sx: number, sy: number, color: string) =>
  `<path d="M${x} ${y + sy * 34}V${y}H${x + sx * 34}" fill="none" stroke="${color}" stroke-width="3"/>`;
const paper: DeckTheme = {
  id: 'paper',
  name: '书卷',
  dark: false,
  swatch: ['#f6f1e7', '#b23a2b', '#2f5d62'],
  fonts: { head: 'STZhongsong', body: 'Microsoft YaHei', mono: 'Consolas' },
  decor(kind) {
    const base = `<rect width="${W}" height="${H}" fill="#f6f1e7"/><rect width="${W}" height="${H}" fill="url(#v)"/>`;
    const defs = `<radialGradient id="v" cx=".5" cy=".45" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#6b4f2a" stop-opacity=".07"/></radialGradient>`;
    if (kind === 'cover' || kind === 'section')
      return svg(
        `${base}${frame(26, '#d5c4a5', true)}
         ${corner(20, 20, 1, 1, '#b23a2b')}${corner(W - 20, 20, -1, 1, '#b23a2b')}${corner(20, H - 20, 1, -1, '#b23a2b')}${corner(W - 20, H - 20, -1, -1, '#b23a2b')}`,
        defs,
      );
    if (kind === 'quote') return svg(`${base}${frame(26, '#d5c4a5', false)}`, defs);
    return svg(`${base}${frame(26, '#e0d3bb', false)}`, defs);
  },
};

export const THEMES: DeckTheme[] = [violet, stage, clean, paper];
export const DEFAULT_THEME = 'violet';
export const themeOf = (id: string | undefined) => THEMES.find((t) => t.id === id) || violet;

export const decorKind = (layout: SlideLayout): DecorKind =>
  layout === 'cover' ? 'cover' : layout === 'section' ? 'section' : layout === 'quote' ? 'quote' : 'content';

const cache = new Map<string, string | null>();
/** 底纹做成 data: 网址，同一种只做一次 */
export function decorUrl(theme: DeckTheme, kind: DecorKind) {
  const key = `${theme.id}:${kind}`;
  if (!cache.has(key)) {
    const s = theme.decor(kind);
    cache.set(key, s ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.replace(/\s+/g, ' '))}` : null);
  }
  return cache.get(key)!;
}

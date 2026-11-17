import type PptxGenJSType from 'pptxgenjs';
import { deckTitle, expandPages, letter } from './model';
import { mountStage } from './stage';
import { themeOf, type DeckTheme } from './themes';
import type { Deck, Page } from './types';

/**
 * 导出 PPT：先把每页按 1280×720 原大画在页面外面，再一个个量出位置、颜色、字号，用 pptxgenjs 画成原生的
 * 形状、文本框和表格（字都能在 PowerPoint / WPS 里接着改）。底纹（渐变、圆、网格）画成一张图垫在最底下。
 * 代码用等宽字体，每一小段保留高亮的颜色；讲稿进备注；练习页后面多一页揭晓答案。
 */

type Pptx = InstanceType<typeof PptxGenJSType>;
type PSlide = ReturnType<Pptx['addSlide']>;
type TextRun = { text: string; options?: Record<string, unknown> };

const IN = 1 / 96; // 像素 → 英寸
const PT = 0.75; // 像素 → 磅

/* ---------------- 颜色：任何 CSS 颜色都画到 1×1 的画布上再读回来 ---------------- */
interface RGBA {
  hex: string;
  a: number;
  css: string;
}
let probe: CanvasRenderingContext2D | null = null;
const colorCache = new Map<string, RGBA>();
function rgba(css: string): RGBA {
  if (!css || css === 'transparent' || css === 'none') return { hex: '000000', a: 0, css: 'transparent' };
  const hit = colorCache.get(css);
  if (hit) return hit;
  if (!probe) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true })!;
  }
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  const out = { hex: [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase(), a: a / 255, css };
  colorCache.set(css, out);
  return out;
}
const transparency = (a: number) => Math.max(0, Math.min(100, Math.round((1 - a) * 100)));

/* ---------------- 字体 ---------------- */
function fontOf(family: string, theme: DeckTheme) {
  if (/Georgia|Times/i.test(family) && !/Inter|YaHei/i.test(family)) return 'Georgia';
  if (/Mono|Consolas|Menlo|Cascadia|monospace/i.test(family)) return theme.fonts.mono;
  if (/Serif SC|Songti|STZhongsong|SimSun|Source Han Serif/i.test(family)) return theme.fonts.head;
  return theme.fonts.body;
}

/** 一页的底：一张图（同一张图的页共用一个母版，PPT 里只存一份）或者底色 */
interface Background {
  data?: string;
  color: string;
}

/** CSS 里 url("…") 的网址（SVG 底纹里自己带括号，不能用简单的正则） */
function cssUrl(v: string): string | null {
  // 「底纹图, 底色」写法算出来是 url("…"), none
  const t = v.trim().replace(/(,\s*none)+$/, '');
  if (!t.startsWith('url(') || !t.endsWith(')')) return null;
  let inner = t.slice(4, -1).trim();
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) inner = inner.slice(1, -1);
  return inner.startsWith('data:') ? inner.replace(/\\"/g, '"') : null;
}

/** 大的底图存成 JPEG（渐变用 PNG 太大） */
const compact = (c: HTMLCanvasElement) => {
  const png = c.toDataURL('image/png');
  return (png.length > 600_000 ? c.toDataURL('image/jpeg', 0.9) : png).replace(/^data:/, '');
};

/* ---------------- 底纹画成图片 ---------------- */
const rasterCache = new Map<string, string>();
async function rasterize(url: string, bg: string): Promise<string> {
  const key = `${bg}|${url}`;
  const hit = rasterCache.get(key);
  if (hit) return hit;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  const data = compact(c);
  rasterCache.set(key, data);
  return data;
}

/* ---------------- 阴影 ---------------- */
interface Shadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: RGBA;
}
function shadows(css: string): Shadow[] {
  if (!css || css === 'none') return [];
  return css
    .split(/,(?![^(]*\))/)
    .map((part) => {
      const inset = /\binset\b/.test(part);
      const col = part.match(/(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]{3,8})/i)?.[0] || 'rgba(0,0,0,0)';
      const nums = part
        .replace(col, '')
        .replace('inset', '')
        .trim()
        .split(/\s+/)
        .map((v) => parseFloat(v))
        .filter((v) => !Number.isNaN(v));
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      return { inset, x, y, blur, spread, color: rgba(col) };
    })
    .filter((s) => s.color.a > 0);
}

/* ---------------- 量位置 ---------------- */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Ctx {
  pptx: Pptx;
  slide: PSlide;
  origin: DOMRect;
  theme: DeckTheme;
}
const rel = (ctx: Ctx, r: DOMRect): Box => ({ x: r.left - ctx.origin.left, y: r.top - ctx.origin.top, w: r.width, h: r.height });
const inches = (b: Box) => ({ x: b.x * IN, y: b.y * IN, w: Math.max(0.01, b.w * IN), h: Math.max(0.01, b.h * IN) });

function px(v: string) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

/** 一个块的底色、边框、圆角、阴影，画成形状 */
function addShape(ctx: Ctx, el: HTMLElement, cs: CSSStyleDeclaration, opacity: number) {
  drawBox(ctx, rel(ctx, el.getBoundingClientRect()), cs, opacity, 1);
}

/** b 是画出来的位置；k 是页面整体缩放（字多了缩小时，算出来的边框、圆角、阴影要跟着乘） */
function drawBox(ctx: Ctx, b: Box, cs: CSSStyleDeclaration, opacity: number, k: number, noFill = false) {
  if (b.w < 0.5 || b.h < 0.5) return;
  const fill = noFill ? rgba('transparent') : rgba(cs.backgroundColor);
  const widths = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)].map((w) => w * k);
  const colors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].map(rgba);
  const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  const visible = widths.map((w, i) => w > 0 && colors[i].a > 0 && styles[i] !== 'none' && styles[i] !== 'hidden');
  const uniform = visible.every(Boolean) && widths.every((w) => Math.abs(w - widths[0]) < 0.01) && colors.every((c) => c.hex === colors[0].hex && Math.abs(c.a - colors[0].a) < 0.01);
  const radiusRaw = cs.borderTopLeftRadius;
  const radius = radiusRaw.endsWith('%') ? (parseFloat(radiusRaw) / 100) * Math.min(b.w, b.h) : px(radiusRaw) * k;
  const round = radius > 0.5;
  const circle = round && radius >= Math.min(b.w, b.h) / 2 - 0.5 && Math.abs(b.w - b.h) < 1;
  const sh = shadows(cs.boxShadow).map((s) => ({ ...s, x: s.x * k, y: s.y * k, blur: s.blur * k, spread: s.spread * k }));
  const outer = sh.find((s) => !s.inset && s.blur > 0);
  const P = ctx.pptx;
  const type = circle ? P.ShapeType.ellipse : round ? P.ShapeType.roundRect : P.ShapeType.rect;
  if (fill.a > 0 || uniform) {
    const lineW = uniform ? widths[0] : 0;
    // CSS 的边框画在盒子里面，PPT 的线压在边上：往里缩半根线宽，外沿就对齐了
    const inset = lineW / 2;
    const box = { x: b.x + inset, y: b.y + inset, w: b.w - lineW, h: b.h - lineW };
    ctx.slide.addShape(type, {
      ...inches(box),
      fill: fill.a > 0 ? { color: fill.hex, transparency: transparency(fill.a * opacity) } : { type: 'none' },
      line: uniform ? { color: colors[0].hex, width: lineW * PT, transparency: transparency(colors[0].a * opacity) } : { type: 'none' },
      ...(round && !circle ? { rectRadius: Math.min(radius - inset, Math.min(box.w, box.h) / 2) * IN } : {}),
      ...(outer
        ? {
            shadow: {
              type: 'outer',
              color: outer.color.hex,
              opacity: Math.min(1, outer.color.a * opacity * 0.7),
              blur: Math.min(100, outer.blur * PT * 0.6),
              offset: Math.min(200, Math.hypot(outer.x, outer.y) * PT * 0.5),
              angle: Math.round(((Math.atan2(outer.y, outer.x) * 180) / Math.PI + 360) % 360),
            },
          }
        : {}),
    });
  }
  // 只有一边的边框（左边的色条、底下的细线）画成细长条
  if (!uniform) {
    const sides: [number, Box][] = [
      [0, { x: b.x, y: b.y, w: b.w, h: widths[0] }],
      [1, { x: b.x + b.w - widths[1], y: b.y, w: widths[1], h: b.h }],
      [2, { x: b.x, y: b.y + b.h - widths[2], w: b.w, h: widths[2] }],
      [3, { x: b.x, y: b.y, w: widths[3], h: b.h }],
    ];
    for (const [i, box] of sides)
      if (visible[i])
        ctx.slide.addShape(P.ShapeType.rect, { ...inches(box), fill: { color: colors[i].hex, transparency: transparency(colors[i].a * opacity) }, line: { type: 'none' } });
  }
  // 不糊的阴影是同样的形状挪个位置（代码框左上角的三个小圆点）
  for (const s of sh)
    if (!s.inset && s.blur === 0 && s.spread === 0 && (s.x || s.y))
      ctx.slide.addShape(type, {
        ...inches({ x: b.x + s.x, y: b.y + s.y, w: b.w, h: b.h }),
        fill: { color: s.color.hex, transparency: transparency(s.color.a * opacity) },
        line: { type: 'none' },
        ...(round && !circle ? { rectRadius: Math.min(radius, Math.min(b.w, b.h) / 2) * IN } : {}),
      });
  // 往里画的实心阴影（代码里突出那一行左边的色条）
  for (const s of sh)
    if (s.inset && s.blur === 0 && (s.x || s.y)) {
      const box =
        s.x > 0 ? { x: b.x, y: b.y, w: s.x, h: b.h } : s.x < 0 ? { x: b.x + b.w + s.x, y: b.y, w: -s.x, h: b.h } : s.y > 0 ? { x: b.x, y: b.y, w: b.w, h: s.y } : { x: b.x, y: b.y + b.h + s.y, w: b.w, h: -s.y };
      ctx.slide.addShape(P.ShapeType.rect, { ...inches(box), fill: { color: s.color.hex, transparency: transparency(s.color.a * opacity) }, line: { type: 'none' } });
    }
}

const hasBox = (cs: CSSStyleDeclaration) =>
  rgba(cs.backgroundColor).a > 0 || [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].some((w) => px(w) > 0);

/* ---------------- 字 ---------------- */
function runStyle(cs: CSSStyleDeclaration, opacity: number, theme: DeckTheme, k = 1): Record<string, unknown> {
  const col = rgba(cs.color);
  const o: Record<string, unknown> = {
    fontFace: fontOf(cs.fontFamily, theme),
    fontSize: Math.round(px(cs.fontSize) * k * PT * 10) / 10,
    color: col.hex,
    bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
  };
  const t = transparency(col.a * opacity);
  if (t > 0) o.transparency = t;
  if (cs.fontStyle === 'italic') o.italic = true;
  const ls = px(cs.letterSpacing);
  if (Math.abs(ls) > 0.3) o.charSpacing = Math.round(ls * k * PT * 10) / 10;
  const deco = cs.textDecorationLine || '';
  if (deco.includes('underline')) o.underline = { style: 'sng' };
  if (deco.includes('line-through')) o.strike = 'sngStrike';
  return o;
}

/** 一个元素里的字拆成一段段（行内代码、加粗各成一段），换行变成新段落 */
function runsOf(el: HTMLElement, opacity: number, theme: DeckTheme): TextRun[] {
  const runs: TextRun[] = [];
  const visit = (node: Node, op: number) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const text = n.textContent || '';
        if (!text) return;
        const cs = getComputedStyle(n.parentElement!);
        const style = runStyle(cs, op, theme);
        const bg = rgba(cs.backgroundColor);
        if (bg.a > 0.05 && n.parentElement !== el) style.highlight = bg.hex;
        const parts = text.split('\n');
        parts.forEach((p, i) => {
          runs.push({ text: p, options: { ...style, ...(i < parts.length - 1 ? { breakLine: true } : {}) } });
        });
      } else if (n instanceof HTMLElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (n.tagName === 'BR') {
          if (runs.length) runs[runs.length - 1].options = { ...runs[runs.length - 1].options, breakLine: true };
          return;
        }
        visit(n, op * (parseFloat(cs.opacity) || 1));
      }
    });
  };
  visit(el, opacity);
  return runs.filter((r, i) => r.text !== '' || r.options?.breakLine || i === runs.length - 1);
}

function addText(ctx: Ctx, el: HTMLElement, cs: CSSStyleDeclaration, opacity: number) {
  if (hasBox(cs)) addShape(ctx, el, cs, opacity);
  const runs = runsOf(el, opacity, ctx.theme);
  if (!runs.some((r) => r.text.trim())) return;
  const b = rel(ctx, el.getBoundingClientRect());
  const pl = px(cs.paddingLeft) + px(cs.borderLeftWidth),
    pr = px(cs.paddingRight) + px(cs.borderRightWidth),
    pt = px(cs.paddingTop) + px(cs.borderTopWidth),
    pb = px(cs.paddingBottom) + px(cs.borderBottomWidth);
  const box = { x: b.x + pl, y: b.y + pt, w: b.w - pl - pr, h: b.h - pt - pb };
  const flex = cs.display.includes('flex');
  const align: 'left' | 'center' | 'right' =
    flex && cs.justifyContent === 'center' ? 'center' : cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'right' : 'left';
  const valign: 'top' | 'middle' = flex && cs.alignItems === 'center' ? 'middle' : 'top';
  const fs = px(cs.fontSize);
  const lhRaw = cs.lineHeight;
  const lh = lhRaw === 'normal' ? fs * 1.3 : px(lhRaw);
  const oneLine = box.h < lh * 1.5;
  // PPT 里的字体跟网页的不完全一样，宽度留一点余量，免得多折一行
  const slack = oneLine ? Math.max(6, box.w * 0.06) : Math.max(4, box.w * 0.035);
  if (align === 'center') {
    box.x -= slack / 2;
    box.w += slack;
  } else if (align === 'right') {
    box.x -= slack;
    box.w += slack;
  } else box.w += slack;
  const stroke = px(cs.getPropertyValue('-webkit-text-stroke-width'));
  const strokeColor = rgba(cs.getPropertyValue('-webkit-text-stroke-color'));
  const base = runStyle(cs, opacity, ctx.theme);
  if (stroke > 0 && rgba(cs.color).a === 0) {
    for (const r of runs) r.options = { ...r.options, transparency: 100, outline: { color: strokeColor.hex, size: stroke * PT } };
  }
  ctx.slide.addText(runs as any, {
    ...inches(box),
    ...base,
    margin: 0,
    align,
    valign,
    lineSpacing: Math.round(lh * PT * 10) / 10,
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    wrap: !oneLine || cs.whiteSpace === 'pre-wrap' ? !oneLine : false,
    fit: 'none',
    isTextBox: true,
  });
}

/* ---------------- 代码块 ---------------- */
function addCode(ctx: Ctx, el: HTMLElement, opacity: number) {
  const lines = [...el.querySelectorAll<HTMLElement>(':scope > .dk-cl')];
  if (!lines.length) return;
  for (const line of lines) if (line.classList.contains('is-mark')) addShape(ctx, line, getComputedStyle(line), opacity);
  const lnEls = lines.map((l) => l.querySelector<HTMLElement>('.dk-ln')!);
  const ltEls = lines.map((l) => l.querySelector<HTMLElement>('.dk-lt')!);
  const first = rel(ctx, ltEls[0].getBoundingClientRect());
  const last = rel(ctx, lines[lines.length - 1].getBoundingClientRect());
  const lineCs = getComputedStyle(lines[0]);
  const lh = px(getComputedStyle(el).lineHeight) || px(lineCs.minHeight);
  const wrap = getComputedStyle(ltEls[0]).whiteSpace === 'pre-wrap';
  // 行号
  const lnCs = getComputedStyle(lnEls[0]);
  const lnBox = rel(ctx, lnEls[0].getBoundingClientRect());
  const nums: TextRun[] = lnEls.map((ln, i) => ({
    text: ln.textContent || '',
    options: { ...runStyle(getComputedStyle(ln), opacity, ctx.theme), ...(i < lnEls.length - 1 ? { breakLine: true } : {}) },
  }));
  const common = { margin: 0, valign: 'top' as const, lineSpacing: Math.round(lh * PT * 10) / 10, paraSpaceBefore: 0, paraSpaceAfter: 0, fit: 'none' as const, isTextBox: true };
  ctx.slide.addText(nums as any, {
    ...inches({ x: lnBox.x, y: lnBox.y, w: lnBox.w - px(lnCs.paddingRight) + 2, h: last.y + last.h - lnBox.y }),
    ...runStyle(lnCs, opacity, ctx.theme),
    align: 'right',
    wrap: false,
    ...common,
  });
  // 代码：每行的每一小段带自己的颜色
  const runs: TextRun[] = [];
  ltEls.forEach((lt, i) => {
    const before = runs.length;
    for (const r of runsOf(lt, opacity * (parseFloat(getComputedStyle(lt).opacity) || 1), ctx.theme)) runs.push(r);
    if (runs.length === before) runs.push({ text: ' ', options: runStyle(getComputedStyle(lt), opacity, ctx.theme) });
    if (i < ltEls.length - 1) runs[runs.length - 1].options = { ...runs[runs.length - 1].options, breakLine: true };
  });
  const right = rel(ctx, el.getBoundingClientRect());
  ctx.slide.addText(runs as any, {
    ...inches({ x: first.x, y: first.y, w: right.x + right.w - first.x, h: last.y + last.h - first.y }),
    ...runStyle(getComputedStyle(ltEls[0]), opacity, ctx.theme),
    align: 'left',
    wrap,
    ...common,
  });
}

/* ---------------- 表格 ---------------- */
function addTable(ctx: Ctx, table: HTMLTableElement, opacity: number) {
  const rows = [...table.rows];
  if (!rows.length) return;
  const tb = rel(ctx, table.getBoundingClientRect());
  const colW = [...rows[0].cells].map((c) => c.getBoundingClientRect().width * IN);
  const rowH = rows.map((r) => r.getBoundingClientRect().height * IN);
  const data = rows.map((r) =>
    [...r.cells].map((cell) => {
      const cs = getComputedStyle(cell);
      const field = cell.querySelector<HTMLElement>('[data-pp="text"]') || cell;
      const runs = runsOf(field, opacity, ctx.theme);
      const fill = rgba(cs.backgroundColor);
      const bottom = rgba(cs.borderBottomColor);
      const bw = px(cs.borderBottomWidth);
      const none = { type: 'none' as const };
      return {
        text: runs.length ? runs : '',
        options: {
          ...runStyle(cs, opacity, ctx.theme),
          ...(fill.a > 0 ? { fill: { color: fill.hex, transparency: transparency(fill.a * opacity) } } : {}),
          valign: cs.verticalAlign === 'middle' ? 'middle' : 'top',
          align: 'left',
          margin: [px(cs.paddingTop) * PT, px(cs.paddingRight) * PT, px(cs.paddingBottom) * PT, px(cs.paddingLeft) * PT],
          border: [none, none, bw > 0 && bottom.a > 0 ? { type: 'solid' as const, pt: bw * PT, color: bottom.hex } : none, none],
          lineSpacing: Math.round(px(cs.lineHeight) * PT * 10) / 10 || undefined,
        },
      };
    }),
  );
  ctx.slide.addTable(data as any, { ...inches(tb), colW, rowH, autoPage: false });
}

/* ---------------- 走一遍 ---------------- */
function walk(ctx: Ctx, el: Element, opacity: number) {
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.classList.contains('dk-decor')) continue;
    const cs = getComputedStyle(child);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const op = opacity * (parseFloat(cs.opacity) || 0);
    if (op < 0.02) continue;
    const kind = child.dataset.pp;
    if (kind === 'skip') continue;
    if (kind === 'text') addText(ctx, child, cs, op);
    else if (kind === 'code') addCode(ctx, child, op);
    else if (kind === 'table' && child instanceof HTMLTableElement) addTable(ctx, child, op);
    else {
      if (kind === 'shape') addShape(ctx, child, cs, op);
      walk(ctx, child, op);
    }
  }
}

/** 版式页的底：底纹图或者底色 */
async function legacyBackground(root: HTMLElement): Promise<Background> {
  const bg = rgba(getComputedStyle(root).backgroundColor);
  const decor = root.querySelector<HTMLElement>(':scope > .dk-decor');
  const url = decor && cssUrl(getComputedStyle(decor).backgroundImage);
  return url ? { data: await rasterize(url, bg.a ? `#${bg.hex}` : '#ffffff'), color: bg.hex } : { color: bg.hex };
}

async function buildSlide(ctx: Ctx, root: HTMLElement) {
  walk(ctx, root, 1);
}

/* ================================================================ HTML 页 */
/**
 * 量 iframe 里画好的页面：每段字按它真实的位置和字号放成文本框；有底色、边框的块放成形状；
 * 列表的圆点、编号、色条这些（::before / ::after）按位置补上；代码块是等宽字的文本框带底色；
 * 表格是原生表格；箭头是带箭头的线；SVG 和图片转成图片。量不出来的块（旋转、滤镜、裁切）截成图片，
 * 整页出错就整页截图。
 */
interface HCtx extends Ctx {
  win: Window;
  doc: Document;
  /** 整页缩小的比例（字多时页面会整体缩小，算出来的字号、边框要乘它） */
  z: number;
  /** 这一页的底色（荧光笔颜色和它混一下） */
  base: RGBA;
}
type Align = 'left' | 'center' | 'right';
const isEl = (n: Node): n is Element => n.nodeType === 1;
const hcs = (h: HCtx, el: Element, pseudo?: string) => h.win.getComputedStyle(el, pseudo);
const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片画不出来'));
    img.src = src;
  });
const svgUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
const xmlAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const blend = (c: RGBA, base: RGBA) => {
  const ch = (i: number) => {
    const a = parseInt(c.hex.slice(i, i + 2), 16),
      b = parseInt(base.hex.slice(i, i + 2), 16);
    return Math.round(a * c.a + b * (1 - c.a))
      .toString(16)
      .padStart(2, '0');
  };
  return (ch(0) + ch(2) + ch(4)).toUpperCase();
};
const widen = (b: Box, align: Align, slack: number): Box =>
  align === 'center' ? { ...b, x: b.x - slack / 2, w: b.w + slack } : align === 'right' ? { ...b, x: b.x - slack, w: b.w + slack } : { ...b, w: b.w + slack };
const alignOf = (cs: CSSStyleDeclaration): Align => (cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'right' : 'left');

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 块的背景（渐变、底纹）画成图片 */
async function rasterBackground(el: HTMLElement, cs: CSSStyleDeclaration, out: Box): Promise<string | null> {
  try {
    const c = canvas(out.w * 2, out.h * 2);
    const g = c.getContext('2d')!;
    const single = cssUrl(cs.backgroundImage);
    if (single) {
      const col = rgba(cs.backgroundColor);
      if (col.a > 0) {
        g.fillStyle = col.css;
        g.fillRect(0, 0, c.width, c.height);
      }
      g.drawImage(await loadImage(single), 0, 0, c.width, c.height);
    } else {
      const w = el.offsetWidth || out.w,
        hh = el.offsetHeight || out.h;
      const style = ['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-origin', 'background-clip']
        .map((p) => `${p}:${cs.getPropertyValue(p)}`)
        .join(';');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}"><foreignObject width="${w}" height="${hh}"><div xmlns="http://www.w3.org/1999/xhtml" style="${xmlAttr(style)};width:${w}px;height:${hh}px;border-radius:${xmlAttr(cs.borderRadius)}"></div></foreignObject></svg>`;
      g.drawImage(await loadImage(svgUrl(svg)), 0, 0, c.width, c.height);
    }
    return c.toDataURL('image/png').replace(/^data:/, '');
  } catch {
    return null;
  }
}

/** 整页（或者只留某一块）截成图片：把页面连样式一起放进 SVG 的 foreignObject 里画 */
async function rasterPage(h: HCtx, keep?: Element): Promise<string | null> {
  const KEEP = 'data-sk-keep';
  const marked = keep ? [keep, ...Array.from(keep.querySelectorAll('*'))] : [];
  marked.forEach((e) => e.setAttribute(KEEP, ''));
  let xml: string;
  try {
    xml = new XMLSerializer().serializeToString(h.doc.documentElement);
  } finally {
    marked.forEach((e) => e.removeAttribute(KEEP));
  }
  if (keep)
    xml = xml.replace(
      '</head>',
      `<style>html,body{background:transparent!important}body *{visibility:hidden!important}[${KEEP}],[${KEEP}] *{visibility:visible!important}#sk-root>.slide{background:none!important}</style></head>`,
    );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><foreignObject x="0" y="0" width="1280" height="720">${xml}</foreignObject></svg>`;
  try {
    const img = await loadImage(svgUrl(svg));
    const c = canvas(2560, 1440);
    c.getContext('2d')!.drawImage(img, 0, 0, 2560, 1440);
    if (!keep) return c.toDataURL('image/png').replace(/^data:/, '');
    const r = keep.getBoundingClientRect();
    const cut = canvas(r.width * 2, r.height * 2);
    cut.getContext('2d')!.drawImage(c, r.left * 2, r.top * 2, r.width * 2, r.height * 2, 0, 0, cut.width, cut.height);
    return cut.toDataURL('image/png').replace(/^data:/, '');
  } catch {
    return null;
  }
}

/** 行内 SVG：把算出来的颜色、线宽写回去，再画成图片 */
async function rasterSvg(h: HCtx, svg: Element, b: Box): Promise<string | null> {
  const clone = svg.cloneNode(true) as Element;
  const src = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const dst = [clone, ...Array.from(clone.querySelectorAll('*'))];
  const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'stop-color', 'stop-opacity'];
  src.forEach((s, i) => {
    const cs = hcs(h, s);
    const d = dst[i];
    d.setAttribute('style', `${d.getAttribute('style') || ''};${props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';')}`);
  });
  clone.setAttribute('width', String(b.w));
  clone.setAttribute('height', String(b.h));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  try {
    const img = await loadImage(svgUrl(new XMLSerializer().serializeToString(clone)));
    const c = canvas(b.w * 2, b.h * 2);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').replace(/^data:/, '');
  } catch {
    return null;
  }
}

async function rasterImg(img: HTMLImageElement, b: Box): Promise<string | null> {
  try {
    const c = canvas(b.w * 2, b.h * 2);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').replace(/^data:/, '');
  } catch {
    return null;
  }
}

/** 旋转、滤镜、裁切、竖排这些量不准的，截图 */
function complex(cs: CSSStyleDeclaration) {
  if (cs.filter && cs.filter !== 'none') return true;
  if (cs.clipPath && cs.clipPath !== 'none') return true;
  const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
  if (mask && mask !== 'none') return true;
  if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true;
  if (cs.writingMode && cs.writingMode.startsWith('vertical')) return true;
  const t = cs.transform;
  if (t && t !== 'none') {
    const v = t.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number);
    if (!v || Math.abs(v[1]) > 1e-3 || Math.abs(v[2]) > 1e-3 || Math.abs(v[0] - 1) > 1e-3 || Math.abs(v[3] - 1) > 1e-3) return true;
  }
  return false;
}

/** ::before / ::after 里的字：引号里的字、计数器（编号、ABCD）、attr() */
function pseudoText(content: string, el: Element) {
  let out = '';
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counter\(\s*([\w-]+)\s*(?:,\s*([\w-]+)\s*)?\)|attr\(\s*([\w-]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined || m[2] !== undefined)
      out += (m[1] ?? m[2]).replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, '$1');
    else if (m[3]) {
      const parent = el.parentElement;
      const sibs = parent ? Array.from(parent.children).filter((c) => c.localName === el.localName) : [el];
      let n = sibs.indexOf(el) + 1;
      const start = Number(parent?.getAttribute('start'));
      if (start) n += start - 1;
      const style = m[4];
      out += style === 'upper-alpha' || style === 'upper-latin' ? String.fromCharCode(64 + n) : style === 'lower-alpha' || style === 'lower-latin' ? String.fromCharCode(96 + n) : style === 'decimal-leading-zero' ? String(n).padStart(2, '0') : String(n);
    } else if (m[5]) out += el.getAttribute(m[5]) || '';
  }
  return out;
}

/** 绝对定位的 ::before / ::after（圆点、编号、色条、对勾） */
function hPseudo(h: HCtx, el: Element, which: '::before' | '::after', op: number) {
  const p = hcs(h, el, which);
  const content = p.content;
  if (!content || content === 'none' || content === 'normal' || p.display === 'none' || p.position !== 'absolute') return;
  const pop = op * (parseFloat(p.opacity) || 0);
  if (pop < 0.03) return;
  const z = h.z;
  const host = rel(h, el.getBoundingClientRect());
  const ecs = hcs(h, el);
  const bl = px(ecs.borderLeftWidth) * z,
    bt = px(ecs.borderTopWidth) * z;
  const pw = host.w - bl - px(ecs.borderRightWidth) * z,
    ph = host.h - bt - px(ecs.borderBottomWidth) * z;
  const num = (v: string) => (!v || v === 'auto' ? null : px(v) * z);
  const L = num(p.left),
    R = num(p.right),
    T = num(p.top),
    B = num(p.bottom);
  let w = num(p.width) ?? 0,
    hh = num(p.height) ?? 0;
  if (!w && L !== null && R !== null) w = pw - L - R;
  if (!hh && T !== null && B !== null) hh = ph - T - B;
  const text = pseudoText(content, el);
  const fs = px(p.fontSize) * z;
  const lh = p.lineHeight === 'normal' ? fs * 1.3 : px(p.lineHeight) * z;
  if (!w && text) w = Math.max(fs * 0.8, [...text].length * fs * 0.62);
  if (!hh && text) hh = lh;
  if (w < 0.3 || hh < 0.3) return;
  let x = L !== null ? host.x + bl + L : R !== null ? host.x + bl + pw - R - w : host.x + bl;
  let y = T !== null ? host.y + bt + T : B !== null ? host.y + bt + ph - B - hh : host.y + bt;
  x += px(p.marginLeft) * z;
  y += px(p.marginTop) * z;
  const m = p.transform.match(/matrix\(([^)]+)\)/);
  if (m) {
    const v = m[1].split(',').map(Number);
    x += (v[4] || 0) * z;
    y += (v[5] || 0) * z;
  }
  const b = { x, y, w, h: hh };
  drawBox(h, b, p, pop, z);
  if (text.trim()) {
    const align = alignOf(p);
    const mid = Math.abs(lh - hh) < 2 || (p.display.includes('flex') && p.alignItems === 'center');
    h.slide.addText([{ text, options: runStyle(p, pop, h.theme, z) }] as any, {
      ...inches(widen(b, align, 6)),
      margin: 0,
      align,
      valign: mid ? 'middle' : 'top',
      lineSpacing: Math.round(lh * PT * 10) / 10,
      wrap: false,
      fit: 'none',
      isTextBox: true,
    });
  }
}

/** 一串行内的字（字和 b、code、mark 这些）变成一段段带样式的字 */
function hRuns(h: HCtx, nodes: Node[], op: number, container: Element): TextRun[] {
  const runs: TextRun[] = [];
  let space = true;
  const visit = (n: Node, o: number) => {
    if (n.nodeType === 3) {
      const pe = n.parentElement!;
      const cs = hcs(h, pe);
      let t = n.textContent || '';
      const keep = /^(pre|pre-wrap|break-spaces)$/.test(cs.whiteSpace);
      if (!keep) {
        t = t.replace(/[\t\r\n\f ]+/g, ' ');
        if (space) t = t.replace(/^ /, '');
      }
      if (!t) return;
      space = /[ \n]$/.test(t);
      const style = runStyle(cs, o, h.theme, h.z);
      const bg = rgba(cs.backgroundColor);
      if (pe !== container && cs.display.startsWith('inline') && bg.a > 0.04) style.highlight = blend(bg, h.base);
      const parts = keep ? t.split('\n') : [t];
      parts.forEach((part, i) => runs.push({ text: part, options: { ...style, ...(i < parts.length - 1 ? { breakLine: true } : {}) } }));
    } else if (isEl(n)) {
      if (n.localName === 'br') {
        if (runs.length) runs[runs.length - 1].options = { ...runs[runs.length - 1].options, breakLine: true };
        space = true;
        return;
      }
      const cs = hcs(h, n);
      if (cs.display === 'none' || n.localName === 'svg' || n.localName === 'img') return;
      // 网页里靠外边距隔开的（「KeyError」后面接说明），PPT 里补一个空格
      const gap = (side: 'Left' | 'Right') => px(cs[`margin${side}`]) * h.z > 2;
      if (gap('Left') && runs.length && !space) {
        runs.push({ text: ' ', options: runs[runs.length - 1].options });
        space = true;
      }
      n.childNodes.forEach((c) => visit(c, o * (parseFloat(cs.opacity) || 1)));
      if (gap('Right') && runs.length && !space) {
        const { breakLine: _b, highlight: _h, ...rest } = (runs[runs.length - 1].options || {}) as Record<string, unknown>;
        runs.push({ text: ' ', options: rest });
        space = true;
      }
    }
  };
  nodes.forEach((n) => visit(n, op));
  const last = runs[runs.length - 1];
  if (last) last.text = last.text.replace(/ $/, '');
  return runs;
}

/** 一串行内的字：按字真实的位置放一个文本框 */
function hGroup(h: HCtx, parent: Element, pcs: CSSStyleDeclaration, nodes: Node[], op: number) {
  const runs = hRuns(h, nodes, op, parent);
  if (!runs.some((r) => r.text.trim())) return;
  const rects: DOMRect[] = [];
  const collect = (n: Node) => {
    if (n.nodeType === 3) {
      if (!n.textContent?.trim()) return;
      const r = h.doc.createRange();
      r.selectNodeContents(n);
      rects.push(...Array.from(r.getClientRects()).filter((x) => x.width > 0.3 && x.height > 0.3));
    } else if (isEl(n)) n.childNodes.forEach(collect);
  };
  nodes.forEach(collect);
  if (!rects.length) return;
  const fs = px(pcs.fontSize) * h.z;
  const lh = pcs.lineHeight === 'normal' ? fs * 1.32 : px(pcs.lineHeight) * h.z;
  let top = Infinity,
    bottom = -Infinity,
    left = Infinity,
    right = -Infinity;
  for (const r of rects) {
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  // 量到的只是字形那么高，上下补到整行高
  const half = Math.max(0, (lh - rects[0].height) / 2);
  top -= half;
  bottom += half;
  const lines = Math.max(1, Math.round((bottom - top) / lh));
  const align = alignOf(pcs);
  const box = { x: left - h.origin.left, y: top - h.origin.top, w: right - left, h: bottom - top };
  h.slide.addText(runs as any, {
    ...inches(widen(box, align, lines > 1 ? Math.max(6, box.w * 0.035) : 10)),
    ...runStyle(pcs, op, h.theme, h.z),
    margin: 0,
    align,
    valign: 'top',
    lineSpacing: Math.round(lh * PT * 10) / 10,
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    wrap: lines > 1,
    fit: 'none',
    isTextBox: true,
  });
}

async function hBox(h: HCtx, el: HTMLElement, cs: CSSStyleDeclaration, b: Box, op: number) {
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    const data = await rasterBackground(el, cs, b);
    if (data) {
      h.slide.addImage({ data, ...inches(b) });
      drawBox(h, b, cs, op, h.z, true);
      return;
    }
  }
  drawBox(h, b, cs, op, h.z);
}

/** 箭头：PPT 里画成带箭头的线 */
function hArrow(h: HCtx, cs: CSSStyleDeclaration, b: Box, op: number) {
  const col = rgba(cs.backgroundColor);
  if (col.a === 0) return;
  const vertical = b.h > b.w;
  const thick = vertical ? b.w : b.h;
  const head = 11 * h.z;
  const line = { color: col.hex, width: Math.max(0.75, thick * PT), endArrowType: 'triangle' as const, transparency: transparency(col.a * op) };
  if (vertical) h.slide.addShape(h.pptx.ShapeType.line, { x: (b.x + b.w / 2) * IN, y: b.y * IN, w: 0, h: (b.h + head) * IN, line });
  else h.slide.addShape(h.pptx.ShapeType.line, { x: b.x * IN, y: (b.y + b.h / 2) * IN, w: (b.w + head) * IN, h: 0, line });
}

/** 代码块：底色框、三个小圆点、语言、突出的行、行号，代码本身是一个等宽字的文本框 */
async function hPre(h: HCtx, pre: HTMLElement, cs: CSSStyleDeclaration, op: number) {
  const b = rel(h, pre.getBoundingClientRect());
  await hBox(h, pre, cs, b, op);
  hPseudo(h, pre, '::before', op);
  hPseudo(h, pre, '::after', op);
  const lines = Array.from(pre.querySelectorAll<HTMLElement>('.line'));
  if (!lines.length) return hGroup(h, pre, cs, Array.from(pre.childNodes), op);
  for (const l of lines) if (l.classList.contains('mark')) drawBox(h, rel(h, l.getBoundingClientRect()), hcs(h, l), op, h.z);
  for (const l of lines) hPseudo(h, l, '::before', op);
  const lcs = hcs(h, lines[0]);
  const lh = px(cs.lineHeight) * h.z;
  const pad = px(lcs.paddingLeft) * h.z;
  const first = rel(h, lines[0].getBoundingClientRect());
  const last = rel(h, lines[lines.length - 1].getBoundingClientRect());
  const runs: TextRun[] = [];
  lines.forEach((l, i) => {
    const before = runs.length;
    runs.push(...hRuns(h, Array.from(l.childNodes).filter((n) => !(isEl(n) && n.localName === 'br')), op, l));
    if (runs.length === before) runs.push({ text: ' ', options: runStyle(lcs, op, h.theme, h.z) });
    if (i < lines.length - 1) runs[runs.length - 1].options = { ...runs[runs.length - 1].options, breakLine: true };
  });
  h.slide.addText(runs as any, {
    ...inches({ x: first.x + pad, y: first.y, w: first.w - pad + 6, h: last.y + last.h - first.y }),
    ...runStyle(lcs, op, h.theme, h.z),
    margin: 0,
    align: 'left',
    valign: 'top',
    lineSpacing: Math.round(lh * PT * 10) / 10,
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    wrap: true,
    fit: 'none',
    isTextBox: true,
  });
}

/** 表格：原生表格，格子里的字能改 */
function hTable(h: HCtx, table: HTMLTableElement, op: number) {
  const rows = Array.from(table.rows);
  if (!rows.length) return;
  const tb = rel(h, table.getBoundingClientRect());
  drawBox(h, tb, hcs(h, table), op, h.z);
  const z = h.z;
  const colW = Array.from(rows[0].cells).map((c) => c.getBoundingClientRect().width * IN);
  const rowH = rows.map((r) => r.getBoundingClientRect().height * IN);
  const none = { type: 'none' as const };
  const data = rows.map((r) =>
    Array.from(r.cells).map((cell) => {
      const cs = hcs(h, cell);
      const runs = hRuns(h, Array.from(cell.childNodes), op, cell);
      const fill = rgba(cs.backgroundColor);
      const top = rgba(cs.borderTopColor);
      const tw = px(cs.borderTopWidth) * z;
      return {
        text: runs.length ? runs : '',
        options: {
          ...runStyle(cs, op, h.theme, z),
          ...(fill.a > 0 ? { fill: { color: fill.hex, transparency: transparency(fill.a * op) } } : {}),
          valign: cs.verticalAlign === 'middle' ? 'middle' : 'top',
          align: alignOf(cs),
          margin: [px(cs.paddingTop) * z * PT, px(cs.paddingRight) * z * PT, px(cs.paddingBottom) * z * PT, px(cs.paddingLeft) * z * PT],
          border: [tw > 0 && top.a > 0 ? { type: 'solid' as const, pt: tw * PT, color: top.hex } : none, none, none, none],
          lineSpacing: Math.round(px(cs.lineHeight) * z * PT * 10) / 10 || undefined,
        },
      };
    }),
  );
  h.slide.addTable(data as any, { ...inches(tb), colW, rowH, autoPage: false });
}

async function hwalk(h: HCtx, el: Element, opacity: number, isRoot = false): Promise<void> {
  const cs = hcs(h, el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return;
  const op = opacity * (parseFloat(cs.opacity) || 0);
  if (op < 0.03) return;
  const tag = el.localName.toLowerCase();
  const b = rel(h, el.getBoundingClientRect());
  const image = (data: string | null) => data && h.slide.addImage({ data, ...inches(b) });
  if (tag === 'svg') return void image(await rasterSvg(h, el, b));
  if (tag === 'img') return void image(await rasterImg(el as HTMLImageElement, b));
  if (tag === 'pre') return hPre(h, el as HTMLElement, cs, op);
  if (tag === 'table') return hTable(h, el as HTMLTableElement, op);
  if (!isRoot && complex(cs)) return void image(await rasterPage(h, el));
  if (el.classList.contains('arrow')) {
    hArrow(h, cs, b, op);
    for (const c of Array.from(el.children)) await hwalk(h, c, op);
    return;
  }
  if (!isRoot) await hBox(h, el as HTMLElement, cs, b, op);
  hPseudo(h, el, '::before', op);
  let group: Node[] = [];
  const flush = () => {
    if (group.length) hGroup(h, el, cs, group, op);
    group = [];
  };
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) {
      group.push(n);
      continue;
    }
    if (!isEl(n)) continue;
    const ccs = hcs(h, n);
    if (ccs.display === 'none') continue;
    if (n.localName === 'br' || (ccs.display === 'inline' && n.localName !== 'svg' && n.localName !== 'img')) {
      group.push(n);
      continue;
    }
    flush();
    await hwalk(h, n, op);
  }
  flush();
  hPseudo(h, el, '::after', op);
}

/** HTML 页的底：根元素的底色和底纹（渐变也画成图） */
async function htmlBackground(frame: HTMLIFrameElement): Promise<Background> {
  const doc = frame.contentDocument!;
  const win = doc.defaultView!;
  const base0 = rgba(win.getComputedStyle(doc.body).backgroundColor);
  const root = doc.querySelector<HTMLElement>('#sk-root > .slide');
  if (!root) return { color: base0.hex };
  const rcs = win.getComputedStyle(root);
  const rbg = rgba(rcs.backgroundColor);
  const base = rbg.a > 0 ? rbg : base0;
  const url = cssUrl(rcs.backgroundImage);
  if (url) return { data: await rasterize(url, `#${base.hex}`), color: base.hex };
  if (rcs.backgroundImage && rcs.backgroundImage !== 'none') {
    const data = await rasterBackground(root, rcs, { x: 0, y: 0, w: 1280, h: 720 });
    if (data) return { data, color: base.hex };
  }
  return { color: base.hex };
}

async function buildHtmlSlide(ctx: Ctx, frame: HTMLIFrameElement) {
  const doc = frame.contentDocument!;
  const win = doc.defaultView!;
  const base0 = rgba(win.getComputedStyle(doc.body).backgroundColor);
  const h: HCtx = { ...ctx, origin: new DOMRect(0, 0, 1280, 720), win, doc, z: Number(doc.body.dataset.fit) || 1, base: base0 };
  const root = doc.querySelector<HTMLElement>('#sk-root > .slide');
  if (!root) return;
  const rcs = win.getComputedStyle(root);
  const rbg = rgba(rcs.backgroundColor);
  h.base = rbg.a > 0 ? rbg : base0;
  try {
    await hwalk(h, root, 1, true);
  } catch (err) {
    // 量不出来就整页截图垫底（字不能改，但样子是对的）
    console.warn('这一页导出成整页图片', err);
    (ctx.slide as unknown as { _slideObjects: unknown[] })._slideObjects = [];
    const full = await rasterPage(h);
    if (full) ctx.slide.background = { data: full };
    return;
  }
  const pn = doc.querySelector<HTMLElement>('.sk-pageno');
  if (pn && win.getComputedStyle(pn).display !== 'none' && pn.textContent?.trim()) hGroup({ ...h, z: 1 }, pn, win.getComputedStyle(pn), Array.from(pn.childNodes), 1);
}

/** HTML 练习页的答案写进备注 */
function htmlAnswerNote(html: string) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const keys = Array.from(d.querySelectorAll('ol.options > li'))
    .map((li, i) => (li.classList.contains('answer') ? letter(i) : ''))
    .filter(Boolean);
  if (!keys.length) return '';
  const ex = d.querySelector('.explain')?.textContent?.replace(/\s+/g, ' ').replace(/^解析\s*/, '').trim();
  return `答案：${keys.join('、')}${ex ? `\n解析：${ex}` : ''}`;
}

function answerNote(page: Page) {
  const q = page.slide.quiz;
  if (!q?.answer.length) return '';
  const keys = q.answer.map(letter).join('、');
  return `答案：${keys}${q.explain?.trim() ? `\n解析：${q.explain.trim()}` : ''}`;
}

/** 做成一个 .pptx（Blob） */
export async function deckToPptx(deck: Deck, opts: { answers?: boolean } = {}): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  const theme = themeOf(deck.theme);
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = deckTitle(deck);
  pptx.subject = '课件';
  pptx.author = 'CoTeach';
  pptx.company = 'CoTeach';
  pptx.theme = { headFontFace: theme.fonts.head, bodyFontFace: theme.fonts.body };
  const pages = expandPages(deck, opts.answers ?? true);
  const stage = await mountStage(deck, pages);
  const masters = new Map<string, string>();
  try {
    for (let i = 0; i < pages.length; i++) {
      const el = stage.pages[i];
      const page = pages[i];
      const frame = el.querySelector('iframe');
      const legacy = el.querySelector<HTMLElement>('.dk-slide');
      const bg = frame ? await htmlBackground(frame) : await legacyBackground(legacy!);
      let slide: PSlide;
      if (bg.data) {
        // 同一张底图的页共用一个母版，底图在文件里只存一份
        let name = masters.get(bg.data);
        if (!name) {
          name = `底纹 ${masters.size + 1}`;
          pptx.defineSlideMaster({ title: name, background: { data: bg.data } });
          masters.set(bg.data, name);
        }
        slide = pptx.addSlide({ masterName: name });
      } else {
        slide = pptx.addSlide();
        slide.background = { color: bg.color };
      }
      if (frame) await buildHtmlSlide({ pptx, slide, origin: new DOMRect(0, 0, 1280, 720), theme }, frame);
      else await buildSlide({ pptx, slide, origin: legacy!.getBoundingClientRect(), theme }, legacy!);
      const answer = page.revealed ? '' : typeof page.slide.html === 'string' ? htmlAnswerNote(page.slide.html) : page.slide.layout === 'quiz' ? answerNote(page) : '';
      const notes = [page.slide.notes?.trim() || '', answer].filter(Boolean).join('\n\n');
      if (notes) slide.addNotes(notes);
    }
  } finally {
    stage.dispose();
  }
  return (await pptx.write({ outputType: 'blob' })) as Blob;
}

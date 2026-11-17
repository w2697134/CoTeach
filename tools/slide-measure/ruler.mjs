// 尺子：课件做成的幻灯片（2026-11-17）。每页照课件样式放进 1280×720 的画布，用无头 Edge 量：
//   跑出画布的页（内容比画布高或宽）、字太小的页（正文小于 20px 的字占多数）、几乎空着的页；再拼一张总览图给人看。
// 用法：node tools/slide-measure/ruler.mjs <课件.json 或 备课尺子输出的 pN.json> <样式.css> <输出目录>
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [deckFile, cssFile, outDir] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(deckFile, 'utf8'));
const deck = raw.deck || raw;
const css = readFileSync(cssFile, 'utf8');
// 页面自己的画法（web/src/components/deck 的 html.ts、codefit.ts）打成一个脚本
const bundle = resolve(outDir, '.app.js');
mkdirSync(outDir, { recursive: true });
execSync(`"${resolve('web/node_modules/.bin/esbuild' + (process.platform === 'win32' ? '.CMD' : ''))}" tools/slide-measure/app-entry.ts --bundle --format=iife --log-level=warning --outfile="${bundle}"`, { stdio: 'inherit' });
const app = readFileSync(bundle, 'utf8');
mkdirSync(outDir, { recursive: true });
const PORT = 9352;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = resolve(outDir, '.edge-profile');
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank',
]);
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const rows = [];
try {
  let target;
  for (let t = 0; t < 150 && !target; t++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page'); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.bad(new Error(JSON.stringify(d.error))) : p.ok(d.result); } });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  // 空架子 + 页面自己的画法写成本地文件打开（空白页带 Trusted Types，不许塞 HTML 字符串）。主题用默认的紫蓝（body 上的 t-violet）
  const skeleton = resolve(outDir, '.skeleton.html');
  writeFileSync(skeleton, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden}${css}</style></head><body class="t-violet"><div id="sk-root"></div><script>${app.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
  await send('Page.navigate', { url: 'file:///' + skeleton.replace(/\\/g, '/') });
  for (let t = 0; t < 100 && !(await run(`document.readyState === 'complete' && typeof SK === 'object'`).catch(() => false)); t++) await sleep(100);
  const slides = deck.slides || [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (!s.html) { rows.push({ page: i + 1, title: s.title, html: false }); continue; }
    // 跟页面一样：收拾 HTML、包根元素、代码分行上色
    await run(`document.body.style.removeProperty('--fit'); document.getElementById('sk-root').replaceChildren(SK.buildSlideNode(${JSON.stringify(s.html)}, document)); document.fonts.ready.then(() => 1)`);
    await sleep(150);
    // 代码折行：先量原样折了几行，再照页面缩代码的字，量缩完还折几行、缩到多少
    const code = await run(`(() => {
      const slide = document.querySelector('#sk-root > .slide');
      const wrapped = () => [...slide.querySelectorAll('pre.code')].reduce((n, pre) => {
        const lh = parseFloat(getComputedStyle(pre).lineHeight) || 0;
        return n + [...pre.querySelectorAll('.line')].filter((l) => lh && l.offsetHeight > lh * 1.5).length;
      }, 0);
      const before = wrapped();
      SK.fitCode(slide);
      const fits = [...slide.querySelectorAll('pre.code')].map((p) => Number(p.style.getPropertyValue('--cfit') || 1));
      return { before, after: wrapped(), fit: fits.length ? Math.min(...fits) : 1 };
    })()`);
    const m = await run(`(() => {
      const slide = document.querySelector('.slide');
      const box = slide.getBoundingClientRect();
      let over = 0, small = 0, total = 0, chars = 0;
      for (const el of slide.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && (r.right > box.right + 2 || r.bottom > box.bottom + 2 || r.left < box.left - 2 || r.top < box.top - 2)) over++;
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (own) { const n = own.length; total += n; chars += n; if (parseFloat(getComputedStyle(el).fontSize) < 20) small += n; }
      }
      return { over, small, total, chars, sh: slide.scrollHeight, sw: slide.scrollWidth };
    })()`);
    // 页面上字多了会整页缩小（HtmlSlide 的 --fit，最小 0.5）：照样缩一遍，记下缩到多少
    const fit = await run(`(() => {
      const el = document.querySelector('.slide'), b = document.body;
      const over = () => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
      const put = (z) => b.style.setProperty('--fit', z.toFixed(4));
      put(1);
      if (!over()) return 1;
      put(0.5);
      if (over()) return 0.5;
      let lo = 0.5, hi = 1;
      for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; put(mid); if (over()) hi = mid; else lo = mid; }
      put(lo);
      return lo;
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'));
    rows.push({ page: i + 1, title: s.title, html: true, fit: Math.round(fit * 100) / 100, codeWrap: code.before, codeWrapLeft: code.after, codeFit: Math.round(code.fit * 100) / 100, overflow: m.over > 0 || m.sh > 722 || m.sw > 1282, overEls: m.over, smallShare: m.total ? Math.round((m.small / m.total) * 100) : 0, chars: m.chars });
  }
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  edge.kill();
}
const made = rows.filter((r) => r.html);
const sum = {
  pages: rows.length,
  html: made.length,
  overflow: made.filter((r) => r.overflow).map((r) => r.page),
  shrunk: made.filter((r) => r.fit < 1).map((r) => `${r.page}:${r.fit}`),
  codeWrap: made.filter((r) => r.codeWrap).map((r) => `${r.page}:${r.codeWrap}行`),
  codeShrunk: made.filter((r) => r.codeFit < 1).map((r) => `${r.page}:${r.codeFit}${r.codeWrapLeft ? '(还折' + r.codeWrapLeft + '行)' : ''}`),
  smallText: made.filter((r) => r.smallShare > 50).map((r) => r.page),
  nearlyEmpty: made.filter((r) => r.chars < 8).map((r) => r.page),
  chars: made.length ? Math.round(made.reduce((n, r) => n + r.chars, 0) / made.length) : 0,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ sum, rows }, null, 1));
console.log(JSON.stringify(sum));

// 尺子：课件做成的幻灯片（2026-11-17）。每页照课件样式放进 1280×720 的画布，用无头 Edge 量：
//   跑出画布的页（内容比画布高或宽）、字太小的页（正文小于 20px 的字占多数）、几乎空着的页；再拼一张总览图给人看。
// 用法：node tools/slide-measure/ruler.mjs <课件.json 或 备课尺子输出的 pN.json> <样式.css> <输出目录>
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [deckFile, cssFile, outDir] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(deckFile, 'utf8'));
const deck = raw.deck || raw;
const css = readFileSync(cssFile, 'utf8');
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
  const slides = deck.slides || [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (!s.html) { rows.push({ page: i + 1, title: s.title, html: false }); continue; }
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden}${css}</style></head><body><div class="slide">${s.html}</div></body></html>`;
    await run(`document.open(); document.write(${JSON.stringify(doc)}); document.close(); new Promise(r => setTimeout(r, 300))`);
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
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'));
    rows.push({ page: i + 1, title: s.title, html: true, overflow: m.over > 0 || m.sh > 722 || m.sw > 1282, overEls: m.over, smallShare: m.total ? Math.round((m.small / m.total) * 100) : 0, chars: m.chars });
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
  smallText: made.filter((r) => r.smallShare > 50).map((r) => r.page),
  nearlyEmpty: made.filter((r) => r.chars < 8).map((r) => r.page),
  chars: made.length ? Math.round(made.reduce((n, r) => n + r.chars, 0) / made.length) : 0,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ sum, rows }, null, 1));
console.log(JSON.stringify(sum));

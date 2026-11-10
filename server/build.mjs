// 生产构建：把服务端打包成单个 ESM 文件，部署时无需 node_modules
import { build } from 'esbuild';
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// 注意：dist/web 由前端构建产出，这里只清理服务端产物
for (const p of ['dist/server.mjs', 'dist/server.mjs.map', 'dist/ct.mjs', 'dist/kb-owner.mjs', 'dist/kb-owner.mjs.map', 'dist/intake-worker.mjs', 'dist/intake-worker.mjs.map', 'dist/assets', 'dist/seed-content'])
  rmSync(p, { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  banner,
  logLevel: 'info',
});
// 整理助手敲的 ct 命令：很小的一个脚本，转给服务器
await build({
  entryPoints: ['src/kb/agent/ct-cli.ts'],
  outfile: 'dist/ct.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'info',
});
// 读资料线程单独打包：文档、表格、幻灯片、PDF 和解压的读取库都在这里，服务主体不加载它们
await build({
  entryPoints: ['src/kb/intake/worker.ts'],
  outfile: 'dist/intake-worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  banner,
  logLevel: 'info',
});
// 读取库要用的附带文件：7-Zip 程序、PDF 中日韩字形表和标准字体、PDF 扫描图片解码程序
const require = createRequire(import.meta.url);
const pdf = dirname(require.resolve('pdfjs-dist/package.json'));
mkdirSync('dist/assets/pdf/wasm', { recursive: true });
cpSync(join(dirname(require.resolve('7z-wasm/package.json')), '7zz.wasm'), 'dist/assets/7zz.wasm');
cpSync(join(pdf, 'cmaps'), 'dist/assets/pdf/cmaps', { recursive: true });
cpSync(join(pdf, 'standard_fonts'), 'dist/assets/pdf/standard_fonts', { recursive: true });
for (const f of ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm', 'openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js'])
  if (existsSync(join(pdf, 'wasm', f))) cpSync(join(pdf, 'wasm', f), join('dist/assets/pdf/wasm', f));
if (existsSync('seed-content')) cpSync('seed-content', 'dist/seed-content', { recursive: true });
await build({
  entryPoints: ['../tools/kb-owner.ts'], outfile: 'dist/kb-owner.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
  banner,
  logLevel:'info',
});
console.log('server bundle ready');

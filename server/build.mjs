// 生产构建：把服务端打包成单个 ESM 文件，部署时无需 node_modules
import { build } from 'esbuild';
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';

// 注意：dist/web 由前端构建产出，这里只清理服务端产物
for (const p of ['dist/server.mjs', 'dist/server.mjs.map', 'dist/kb-owner.mjs', 'dist/kb-owner.mjs.map', 'dist/seed-content']) rmSync(p, { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
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
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
if (existsSync('seed-content')) cpSync('seed-content', 'dist/seed-content', { recursive: true });
await build({
  entryPoints: ['../tools/kb-owner.ts'], outfile: 'dist/kb-owner.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
  banner: {js:"import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"},
  logLevel:'info',
});
console.log('server bundle ready');

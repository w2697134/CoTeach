import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { csrfMiddleware, sessionMiddleware, type AppEnv } from './auth.js';
import { config, isProd } from './config.js';
import { kbRoutes, courseRoutes, keeperRoutes } from './kb/routes.js';
import { lookupTurn } from './kb/keeper.js';
import { runCommand } from './kb/agent/commands.js';
import { HttpError } from './lib/http.js';
import { teacherError } from './kb/teacher-text.js';
import { authRoutes } from './routes/auth.js';
import { classRoutes } from './classes/routes.js';
import { homeworkRoutes } from './classes/homework.js';
import { adminRoutes } from './routes/admin.js';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    await next();
  });

  // 整理助手干活时敲的 ct 命令从这里进来：只认本机，只认这一轮的口令
  app.post('/internal/agent/cmd', async (c) => {
    const addr = String((c.env as any)?.incoming?.socket?.remoteAddress || '');
    if (!/^(127\.|::1$|::ffff:127\.)/.test(addr)) return c.json({ ok: false, text: '不允许' }, 403);
    const turn = lookupTurn(c.req.header('x-agent-token') || '');
    if (!turn) return c.json({ ok: false, text: '这一轮已经结束了' }, 403);
    const d = await c.req.json().catch(() => ({}));
    const args = Array.isArray(d?.args) ? d.args.slice(0, 20).map((a: unknown) => String(a ?? '').slice(0, 4000)) : [];
    return c.json(await runCommand(turn, args));
  });

  // 接口返回的 JSON 压缩了再发；推送和原件下载不压
  app.use('/api/*', compress({ contentTypeFilter: /^application\/json/ }));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const t0 = Date.now();
    await next();
    const ms = Date.now() - t0;
    if (!isProd || ms > 3000 || c.res.status >= 500) console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });
  app.use('/api/*', sessionMiddleware);
  app.use('/api/*', csrfMiddleware);

  app.route('/api/auth', authRoutes);
  app.route('/api/courses', courseRoutes);
  app.route('/api/knowledge', kbRoutes);
  app.route('/api/keeper', keeperRoutes);
  app.route('/api/classes', classRoutes);
  app.route('/api/homework', homeworkRoutes);
  app.route('/api/admin', adminRoutes);

  app.get('/api/health', (c) => c.json({ ok: true, time: Date.now() }));
  app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json(
        { error: ['teacher', 'admin'].includes(c.get('user')?.role || '') ? teacherError(err, c.req.method) : err.message, code: err.code },
        err.status as any,
      );
    console.error('[error]', c.req.method, c.req.path, err);
    return c.json(
      {
        error: '操作未完成，请稍后重试',
      },
      500,
    );
  });

  // 前端静态资源 + SPA 回退
  app.use('/assets/*', compress());
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
  };
  app.get('*', (c) => {
    const url = decodeURIComponent(new URL(c.req.url).pathname);
    const rel = normalize(url).replace(/^([/\\])+/, '');
    if (rel.includes('..')) return c.text('Not found', 404);
    let file = join(config.webDir, rel);
    const isAsset = rel.startsWith('assets');
    if (!rel || !existsSync(file) || !extname(file)) {
      if (isAsset) return c.text('Not found', 404);
      file = join(config.webDir, 'index.html');
      if (!existsSync(file)) return c.html('<h3>前端尚未构建：请先执行 pnpm build</h3>');
    }
    const buf = readFileSync(file);
    const ext = extname(file);
    c.header('Content-Type', mime[ext] || 'application/octet-stream');
    if (isAsset) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(new Uint8Array(buf));
    }
    const etag = `"${createHash('sha1').update(buf).digest('base64url').slice(0, 16)}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=86400, stale-while-revalidate=604800');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.body(new Uint8Array(buf));
  });

  return app;
}

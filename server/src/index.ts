import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { recoverRuns } from './kb/keeper.js';
import { recoverIntakes } from './kb/intake/service.js';

// 不显示 node:sqlite 的实验特性警告
process.removeAllListeners('warning');
process.on('warning', w => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

await bootstrap();
recoverRuns();
recoverIntakes();

const app = createApp();
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  console.log(`[coteach] 已启动 http://${info.address}:${info.port} (${config.env})`);
}) as Server;
// 老师那边到服务器来回一次约 0.3 秒，重新连上约 0.9 秒。默认空闲 5 秒就断开，看一会儿再点又得重连，所以留一分钟
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { recoverRuns } from './kb/keeper.js';

// 不显示 node:sqlite 的实验特性警告
process.removeAllListeners('warning');
process.on('warning', w => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

await bootstrap();
recoverRuns();

const app = createApp();
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  console.log(`[coteach] 已启动 http://${info.address}:${info.port} (${config.env})`);
});

import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { recoverRuns } from './kb/keeper.js';
import { recoverIntakes } from './kb/intake/service.js';
import { recoverStuRuns } from './assistant/buddy.js';
import { recoverSpecialistRuns } from './assistant/specialists.js';
import { recoverLessons } from './prep/make.js';
import { backfillPacks, recoverPackJobs } from './assistant/pack-jobs.js';
import { recoverGrades } from './grading/jobs.js';
import { recoverRubrics } from './grading/rubric.js';
import { watchDemoRequest } from './demo/seed.js';

// 不显示 node:sqlite 的实验特性警告
process.removeAllListeners('warning');
process.on('warning', w => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

await bootstrap();
// 学伴、替老师回学伴的助教做到一半的先标好（整理助手那边的 recoverRuns 会把所有在跑的标成中断，这里换成它们自己的说法）
recoverStuRuns();
recoverSpecialistRuns();
recoverLessons();
recoverRuns();
recoverIntakes();
recoverPackJobs();
recoverRubrics();
recoverGrades();
// 数据目录里放了 seed-demo.json 就建演示班
watchDemoRequest();
backfillPacks();

const app = createApp();
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  console.log(`[coteach] 已启动 http://${info.address}:${info.port} (${config.env})`);
}) as Server;
// 老师那边到服务器来回一次约 0.3 秒，重新连上约 0.9 秒。默认空闲 5 秒就断开，看一会儿再点又得重连，所以留一分钟
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

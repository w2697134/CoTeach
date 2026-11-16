/**
 * 备课的接口（老师）：列出备过的课、开始备一节、看一份、下载 Word。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { audit, requireRole, type AppEnv } from '../auth.js';
import { body, intParam } from '../lib/http.js';
import { planDocx, planFor, plansOf, startPlan } from './prep.js';

export const prepRoutes = new Hono<AppEnv>();

prepRoutes.get('/', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const cls = Number(c.req.query('class') || 0) || undefined;
  return c.json({ plans: plansOf(u.id, cls) });
});

prepRoutes.post('/', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const d = await body(c, z.object({ classId: z.number().int().positive(), topic: z.string().trim().max(200).nullable().optional() }));
  const id = startPlan(d.classId, u.id, d.topic ?? null);
  audit(c, 'prep.start', `class:${d.classId}`);
  return c.json({ id, plan: planFor(u.id, id) });
});

prepRoutes.get('/:id', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  return c.json(planFor(u.id, intParam(c)));
});

prepRoutes.get('/:id/docx', async (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const f = await planDocx(planFor(u.id, intParam(c)));
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="plan.docx"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    },
  });
});

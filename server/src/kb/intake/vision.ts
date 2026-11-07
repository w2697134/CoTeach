import { db, now } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { chat } from '../../llm/index.js';
import type { ToolSpec } from '../../llm/types.js';
import type { VisionImage } from './images.js';

/**
 * 图片、扫描件里的字请 DeepSeek V4.1 Flash 看图转写，按两栏交：有没有字、字本身。
 * 2026-11-07 对照过：只用这句话时有字的图逐字正确、表格保留行列，
 * 但界面截图转写前会加一句「以下是图片中所有文字的转写：」，没有字的插画会写一段描述，被当成资料存下。
 * 试过改这句话（「只输出图片里的文字…没有文字就什么都不输出」），表格被拆成一格一行、没字的图仍回一句话，没采用。
 * 改成按两栏交以后，开场白和描述进不了正文；字那一栏的说明写了表格用 Markdown 表格，不写的话表格会变成一行行的。
 * 同一张图（按内容指纹）只认一次，中断后接着读、重交同一份资料都不再花钱。
 */
export const VISION_PROMPT = '把图片里的文字原样转写出来。';
export const VISION_TOOL: ToolSpec = {
  name: 'transcribe',
  description: '交回图片里的文字。',
  parameters: {
    type: 'object',
    properties: {
      has_text: { type: 'boolean', description: '图片里有没有文字' },
      text: { type: 'string', description: '原样转写的文字，表格写成 Markdown 表格' },
    },
    required: ['has_text', 'text'],
  },
};
/** 改了交代就换版本号，旧结果不再沿用 */
export const VISION_METHOD = 'flash-v2';

export class VisionUnavailable extends Error {
  constructor(
    public reason: string,
    public advice: string,
  ) {
    super(reason);
  }
}

let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  while (running >= limit) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function cachedVision(key: string): string | undefined {
  return db.value<string>('SELECT text FROM kb_vision_cache WHERE image_hash=? AND method=?', key, VISION_METHOD);
}

export async function readImage(image: VisionImage, key: string, ctx: { userId: number; signal?: AbortSignal; concurrency: number }): Promise<string> {
  const hit = cachedVision(key);
  if (hit !== undefined) return hit;
  const model = db.get<{ id: number }>(
    "SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.model='deepseek-flash' AND m.enabled=1 AND p.enabled=1 ORDER BY m.id LIMIT 1",
  );
  if (!model) throw new VisionUnavailable('图片里的字暂时认不了：整理服务没有接好', '请联系管理员检查后，再点「接着读」');
  return slot(ctx.concurrency, async () => {
    const again = cachedVision(key);
    if (again !== undefined) return again;
    let text: string;
    try {
      const r = await chat({
        agentKey: 'keeper',
        modelRowId: model.id,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', mime: image.mime, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString('base64') },
              { type: 'text', text: VISION_PROMPT },
            ],
          },
        ],
        temperature: 0,
        maxTokens: 8000,
        tools: [VISION_TOOL],
        userId: ctx.userId,
        purpose: 'kb:read',
        signal: ctx.signal,
      });
      // 说没有字就是空的；没按两栏交（直接回了正文）就照旧用正文
      const call = r.toolCalls.find((t) => t.name === VISION_TOOL.name);
      text = call ? (call.args.has_text === false ? '' : String(call.args.text ?? '').trim()) : r.text.trim();
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const status = err instanceof HttpError ? err.status : 0;
      const message = String((err as Error)?.message || '');
      if (status === 429 && /上限/.test(message)) throw new VisionUnavailable('今天认图片的次数用完了', '明天再点「接着读」');
      if (/402|余额|insufficient.*balance/i.test(message)) throw new VisionUnavailable('图片里的字暂时认不了：整理服务余额不足', '请联系管理员充值后，再点「接着读」');
      throw new VisionUnavailable('图片里的字暂时认不了：整理服务暂时连不上', '稍后点「接着读」');
    }
    db.run('INSERT OR REPLACE INTO kb_vision_cache(image_hash,method,text,created_at) VALUES(?,?,?,?)', key, VISION_METHOD, text, now());
    return text;
  });
}

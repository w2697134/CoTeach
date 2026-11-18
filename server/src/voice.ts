import { Hono } from 'hono';
import { me, type AppEnv } from './auth.js';
import { config } from './config.js';
import { bad, HttpError, rateLimit } from './lib/http.js';

/**
 * 语音输入：浏览器录一段话传上来，交给阿里云百炼的 qwen3-asr-flash 认成字，
 * 字放进输入框，老师（学生）改了再发。录音不落盘、不记日志，只转一次手。数字照写成阿拉伯数字（「计科二五零一」→「计科2501」）。
 */
export const voiceRoutes = new Hono<AppEnv>();

const MAX_BYTES = 6 * 1024 * 1024;
const TYPES = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|x-m4a|m4a)$/;
const URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const CONTEXT = 'CoTeach 教学平台。常说的词：CoT 助教、CoT 学伴、课程、备课、课件、教案、课堂练习、课后作业、签到、选人、通知、收件箱、知识库、学情、批改、讲评、Python、计科。';

/** 页面问一下语音输入开没开（没配 key 就不摆话筒） */
voiceRoutes.get('/status', (c) => {
  me(c);
  return c.json({ on: !!config.dashscopeKey });
});

voiceRoutes.post('/asr', async (c) => {
  const u = me(c);
  if (!config.dashscopeKey) throw new HttpError(503, '语音输入还没开通', 'voice_off');
  rateLimit(`asr:${u.id}`, 120, 60 * 60_000);
  // 页面的上传都是 application/octet-stream，录音的格式写在 ?type= 上
  const type = (c.req.query('type') || c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES.test(type)) throw bad('录音的格式认不出来');
  if (Number(c.req.header('content-length') || 0) > MAX_BYTES) throw bad('一次说一分钟以内');
  const bytes = Buffer.from(await c.req.arrayBuffer());
  if (bytes.length < 800) throw bad('没录到声音');
  if (bytes.length > MAX_BYTES) throw bad('一次说一分钟以内');
  return c.json({ text: await recognize(bytes, type) });
});

async function recognize(bytes: Buffer, type: string): Promise<string> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.dashscopeKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-asr-flash',
      input: {
        messages: [
          // 给识别提个醒：平台里常说的词（「CoT 助教」不提醒会听成「卡特助教」）
          { role: 'system', content: [{ text: CONTEXT }] },
          { role: 'user', content: [{ audio: `data:${type};base64,${bytes.toString('base64')}` }] },
        ],
      },
      parameters: { asr_options: { enable_itn: true } },
    }),
    signal: AbortSignal.timeout(45_000),
  }).catch((e: Error & { cause?: { code?: string } }) => {
    console.warn('[asr] 连不上', e?.cause?.code || e?.name || '');
    return null;
  });
  if (!res) throw new HttpError(502, '语音识别连不上，过一会儿再试', 'asr_unreachable');
  const data = (await res.json().catch(() => null)) as {
    code?: string;
    output?: { choices?: { message?: { content?: { text?: string }[] } }[] };
  } | null;
  if (!res.ok) {
    // 只记状态和错误码，不记录音、不记 key
    console.warn('[asr]', res.status, data?.code || '');
    throw new HttpError(502, '没听清，再说一遍试试', 'asr_failed');
  }
  return (data?.output?.choices?.[0]?.message?.content || [])
    .map((x) => x.text || '')
    .join('')
    .trim();
}

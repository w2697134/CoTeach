import { hashText, isTextEntry } from './repo.js';
import type { Workspace } from './workspace.js';
import { bad } from '../lib/http.js';
import { streamChat, type Msg, type ToolCall, type ToolSpec } from '../llm/index.js';

export interface EvidenceFinding {
  text: string;
  sources: { path: string; quote: string }[];
}
export const evidencePrompt = `你正在核对一个班级的封存记录，辨认可供以后教学参考的知识和经验。
依据是这些记录里实际发生的教学做法及效果，或有记录支持的知识理解共性。保留原意与适用范围，每条都引用支持它的原句。
这一步只核对本班资料，不写知识库。把有依据的经验通过 submit_evidence 交回；没有新的可复用经验时提交空列表。`;
const submitTool: ToolSpec = {
  name: 'submit_evidence',
  description: '交回本班记录支持的可复用经验及原句；没有这样的记录时交回空列表。',
  parameters: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            sources: {
              type: 'array',
              items: { type: 'object', properties: { path: { type: 'string' }, quote: { type: 'string' } }, required: ['path', 'quote'] },
            },
          },
          required: ['text', 'sources'],
        },
      },
    },
    required: ['findings'],
  },
};

export function validateEvidence(value: unknown, source: Workspace): EvidenceFinding[] {
  if (!Array.isArray(value)) throw bad('核对结果需要是列表');
  return value.map((item) => {
    if (!item || typeof item.text !== 'string' || !item.text.trim() || !Array.isArray(item.sources) || !item.sources.length)
      throw bad('每条经验需要有原文依据');
    const sources = item.sources.map((citation: any) => {
      if (typeof citation?.path !== 'string' || typeof citation?.quote !== 'string' || !citation.quote.trim())
        throw bad('请提供来源和原句');
      const entry = source.entry(citation.path);
      if (!entry || !isTextEntry(entry)) throw bad('请引用本班封存记录中的文字');
      const text = source.read(citation.path);
      if (text === null || !text.includes(citation.quote)) throw bad('引用的原句不在这份封存记录中，请重新核对');
      return { path: citation.path, quote: citation.quote };
    });
    return { text: item.text, sources };
  });
}

/** 来源核对阶段没有长期库读取能力，防止把查重材料当成本学期的观察。 */
export async function collectEvidence(options: {
  source: Workspace;
  sourceName: string;
  modelRowId: number;
  userId: number;
  signal: AbortSignal;
  readTools: ToolSpec[];
  read: (call: ToolCall) => Promise<{ content: string; event: Record<string, unknown> }>;
  record: (event: Record<string, unknown>) => void;
}): Promise<{ findings: EvidenceFinding[]; steps: number }> {
  const messages: Msg[] = [
    { role: 'system', content: evidencePrompt + '\n封存来源：' + options.sourceName },
    { role: 'user', content: '核对本班封存记录中的可复用经验。' },
  ];
  const names = new Set(options.readTools.map((t) => t.name));
  for (let step = 0; step < 20; step++) {
    options.signal.throwIfAborted();
    let text = '';
    const calls: ToolCall[] = [];
    for await (const delta of streamChat({
      agentKey: 'keeper',
      modelRowId: options.modelRowId,
      messages,
      tools: [...options.readTools, submitTool],
      temperature: 0.3,
      maxTokens: 8192,
      userId: options.userId,
      purpose: 'kb:summary-evidence',
      signal: options.signal,
    })) {
      if (delta.type === 'text') text += delta.text;
      else if (delta.type === 'tool') calls.push(delta.call);
    }
    messages.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) });
    if (!calls.length) {
      messages.push({ role: 'user', content: '请用提交工具交回核对结果。' });
      continue;
    }
    for (const call of calls) {
      let content: string;
      try {
        if (call.name === 'submit_evidence') {
          const findings = validateEvidence(call.args?.findings, options.source);
          // 保存可回查的指纹，不把私有原句再复制进长期工作记录。
          options.record({
            name: 'source_evidence',
            label: '核对来源',
            count: findings.length,
            sources: findings.flatMap((f) =>
              f.sources.map((s) => ({ fileId: options.source.entry(s.path)?.id, quoteHash: hashText(s.quote) })),
            ),
          });
          return { findings, steps: step + 1 };
        }
        if (!names.has(call.name)) throw bad('当前步骤只读取封存资料');
        const result = await options.read(call);
        content = result.content;
        options.record(result.event);
      } catch (err) {
        content = (err as Error).message;
        options.record({ name: call.name, label: '核对来源', error: content });
      }
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
    }
  }
  throw new Error('这次来源核对未完成，请重试');
}

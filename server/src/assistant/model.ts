/**
 * 调模型的那一步。老师的 CoT 助教、学生的 CoT 学伴、替老师回学伴和写班级资料包的助教都走这里；测试里换成写好的回答。
 */
import { getSetting } from '../db/index.js';
import { streamChat } from '../llm/index.js';
import type { Effort, Msg, ToolCall, ToolSpec } from '../llm/types.js';

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  /** 模型这一步的思考（开着思考时才有），要记下来往后原样传回去 */
  reasoning?: string;
}
/** 谁在调：老师的助教（ta）、学生的学伴（stu）、替老师回学伴和写资料包的助教（helper）、批作业写讲评的助教（grader） */
export type Agent = 'ta' | 'stu' | 'helper' | 'grader';
export type ModelStep = (o: {
  agent: Agent;
  messages: Msg[];
  tools: ToolSpec[];
  userId: number;
  signal: AbortSignal;
  onText: (t: string) => void;
  /** 记在调用记录里的用途，不传是「谁:chat」 */
  purpose?: string;
}) => Promise<StepResult>;

/**
 * 想不想、想多深。
 * DeepSeek 只有 low / high / max 三档，它把 medium 当 high 算，所以默认 high；各自的设置项可改（off 是不想）。
 */
const THINK_KEY: Record<Agent, string> = { ta: 'ta_think', stu: 'stu_think', helper: 'helper_think', grader: 'grader_think' };
export const thinkOf = (agent: Agent) => getSetting<'off' | Effort>(THINK_KEY[agent], 'high');
/**
 * 主模型（Gemini）多久没动静就换 DeepSeek：跟人对话的等一分钟，批作业、写讲评这种后台的活等五分钟。
 * Gemini 接口只有一个号、同时最多两个请求，还跟别的项目共用，忙的时候要排队。
 */
const WAIT_MS: Record<Agent, number> = { ta: 60_000, stu: 60_000, helper: 90_000, grader: 300_000 };

const deepseekStep: ModelStep = async (o) => {
  let text = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  const think = thinkOf(o.agent);
  for await (const d of streamChat({
    agentKey: o.agent,
    messages: o.messages,
    tools: o.tools,
    userId: o.userId,
    purpose: o.purpose || `${o.agent}:chat`,
    signal: o.signal,
    countQuota: false,
    think,
    firstTokenMs: WAIT_MS[o.agent],
    // 想的字也算在这个上限里：开着思考放宽（只按实际用的算钱）
    maxTokens: think === 'off' ? 4000 : 32000,
  })) {
    if (d.type === 'text') {
      text += d.text;
      o.onText(d.text);
    } else if (d.type === 'reasoning') reasoning += d.text;
    else if (d.type === 'tool') toolCalls.push(d.call);
    else if (d.type === 'model') {
      // 换了备用模型重来：前面的不算
      text = '';
      reasoning = '';
      toolCalls.length = 0;
    }
  }
  return { text, toolCalls, ...(reasoning ? { reasoning } : {}) };
};

let step: ModelStep = deepseekStep;
/** 测试用：换成写好的模型回答；传 null 换回 DeepSeek */
export function setModelStep(fn: ModelStep | null) {
  step = fn ?? deepseekStep;
}
export const modelStep: ModelStep = (o) => step(o);

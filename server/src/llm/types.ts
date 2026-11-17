/** 统一的大模型调用抽象：屏蔽 OpenAI / Anthropic / Gemini 协议差异 */
export type Protocol = 'openai' | 'anthropic' | 'gemini';

export interface ProviderConn {
  kind: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

export type Part = { type: 'text'; text: string } | { type: 'image'; mime: string; data: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  raw: string;
  /** 协议私有字段（如 Gemini 的 thoughtSignature），回传历史时需要原样带上 */
  extra?: Record<string, unknown>;
}

export interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Part[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /** 模型这一步的思考：DeepSeek 开着思考又带工具时，按它的文档原样传回去（只有 OpenAI 协议的接口会发） */
  reasoning?: string;
}

/** 思考开到哪一档（DeepSeek：low / high / max；它把 medium 当 high） */
export type Effort = 'low' | 'high' | 'max';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatParams {
  model: string;
  messages: Msg[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** 是否开启深度思考；不传时按服务商默认 */
  thinking?: boolean;
  /** 开着思考时开到哪一档；不传按服务商默认 */
  effort?: Effort;
  signal?: AbortSignal;
}

export type Delta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; call: ToolCall }
  /**
   * 工具调用写到一半：text 是到现在为止写出来的参数 JSON（没写完）。
   * wrapped 为 true 时 text 是 Gemini 接口那种整步的 JSON（{say, calls:[{tool, args}]}），name 不知道。
   * 只是预览：不算模型已经出了内容（出错照样能重试、换备用模型），最后照样会有完整的 tool。
   */
  | { type: 'partial'; name: string; text: string; wrapped?: boolean }
  | { type: 'usage'; input: number; output: number }
  | { type: 'finish'; reason: string };

export interface RemoteModel {
  id: string;
  label?: string;
  contextWindow?: number;
  ownedBy?: string;
}

export interface Adapter {
  stream(conn: ProviderConn, params: ChatParams): AsyncGenerator<Delta>;
  listModels(conn: ProviderConn, signal?: AbortSignal): Promise<RemoteModel[]>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public status = 0,
    public retryable = false,
    public body = '',
  ) {
    super(message);
  }
}

export function textOf(content: string | Part[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(p => p.type === 'text')
    .map(p => (p as { text: string }).text)
    .join('\n');
}

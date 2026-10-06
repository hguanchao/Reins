/**
 * 模型调用层的公共类型。
 *
 * 设计意图:适配器只负责「协议⇄流式块」的翻译,上层只认识这里的统一形状;
 * 端点的个性化信息全部来自 providers.json,类型中不出现任何产商概念。
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role = 'tool' 时关联的调用 id。 */
  toolCallId?: string;
  /** role = 'assistant' 时携带的工具调用。 */
  toolCalls?: ToolCall[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: string };

export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 解析完成的模型端点:密钥与 header 均已就绪,可直接发起请求。 */
export interface ResolvedModel {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: ModelCost;
  headers?: Record<string, string>;
  apiKey?: string;
}

export interface StreamRequest {
  model: ResolvedModel;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  reasoningEffort?: string;
  temperature?: number;
  signal?: AbortSignal;
}

/** 适配器运行参数:重试、代理与可注入的 fetch(便于测试)。 */
export interface AdapterRuntime {
  maxRetries: number;
  proxy?: string;
  fetchImpl?: typeof fetch;
  /** 重试等待实现;默认真实计时,测试可注入空实现。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface ProviderAdapter {
  readonly api: string;
  stream(request: StreamRequest, runtime: AdapterRuntime): AsyncIterable<StreamChunk>;
}

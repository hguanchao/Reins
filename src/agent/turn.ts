import type {
  AdapterRuntime,
  ProviderAdapter,
  StreamRequest,
  ToolCall,
  Usage,
} from '../llm/types.ts';

/**
 * 单轮模型请求:把流式块收集为一轮完整结果。
 *
 * 设计意图:把「流式 → 完整」的收集过程独立出来,
 * 代理循环只关心结果,不关心块协议。
 */

export interface ModelTurnResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string;
}

export interface CollectTurnParams {
  adapter: ProviderAdapter;
  runtime: AdapterRuntime;
  request: StreamRequest;
  onText?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
}

export async function collectModelTurn(params: CollectTurnParams): Promise<ModelTurnResult> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = 'stop';

  for await (const chunk of params.adapter.stream(params.request, params.runtime)) {
    if (chunk.type === 'text') {
      text += chunk.text;
      params.onText?.(chunk.text);
    } else if (chunk.type === 'tool_call') {
      toolCalls.push(chunk.toolCall);
      params.onToolCall?.(chunk.toolCall);
    } else if (chunk.type === 'usage') {
      usage = chunk.usage;
    } else if (chunk.type === 'done') {
      finishReason = chunk.finishReason;
    }
  }
  return { text, toolCalls, usage, finishReason };
}

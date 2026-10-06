/**
 * Server-Sent Events 解析。
 *
 * 设计意图:把「字节流 → 事件帧」的翻译独立出来,供各协议适配器复用;
 * 只依赖 Web 标准的 ReadableStream,测试中可直接构造输入。
 */

export interface SseEvent {
  event: string | undefined;
  data: string;
}

/** 把 SSE 字节流解析为事件序列。 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const source = stream as unknown as AsyncIterable<Uint8Array>;
  let buffer = '';

  const drain = function* (): Generator<SseEvent> {
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseEventFrame(raw);
      if (parsed !== null) {
        yield parsed;
      }
      boundary = buffer.indexOf('\n\n');
    }
  };

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    yield* drain();
  }
  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');
  yield* drain();
  // 流结束时若还有未以空行结尾的完整事件,也交付出去
  const last = parseEventFrame(buffer);
  if (last !== null) {
    yield last;
  }
}

function parseEventFrame(raw: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    }
  }
  if (dataLines.length === 0 && event === undefined) {
    return null;
  }
  return { event, data: dataLines.join('\n') };
}

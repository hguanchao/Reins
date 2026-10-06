import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSseStream, type SseEvent } from '../../src/llm/sse.ts';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }
  return events;
}

describe('SSE 解析', () => {
  it('单块内解析多个事件', async () => {
    const events = await collect(streamOf('data: a\n\ndata: b\n\ndata: [DONE]\n\n'));
    assert.deepEqual(
      events.map((event) => event.data),
      ['a', 'b', '[DONE]'],
    );
  });

  it('事件跨块分割也能还原', async () => {
    const events = await collect(streamOf('data: {"a', '":1}\n\n'));
    assert.equal(events[0]?.data, '{"a":1}');
  });

  it('注释行被忽略', async () => {
    const events = await collect(streamOf(': keepalive\n\ndata: x\n\n'));
    assert.deepEqual(
      events.map((event) => event.data),
      ['x'],
    );
  });

  it('多行 data 以换行合并', async () => {
    const events = await collect(streamOf('data: line1\ndata: line2\n\n'));
    assert.equal(events[0]?.data, 'line1\nline2');
  });

  it('兼容 CRLF 行尾', async () => {
    const events = await collect(streamOf('data: a\r\n\r\ndata: b\r\n\r\n'));
    assert.deepEqual(
      events.map((event) => event.data),
      ['a', 'b'],
    );
  });

  it('event 字段被保留', async () => {
    const events = await collect(streamOf('event: ping\ndata: hello\n\n'));
    assert.equal(events[0]?.event, 'ping');
    assert.equal(events[0]?.data, 'hello');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COMPACT_THRESHOLD, buildCompactionPrompt, formatTranscript, shouldCompact } from '../../src/session/compaction.ts';
import type { SessionEntry } from '../../src/session/store.ts';

describe('会话压缩策略', () => {
  it('按阈值判断是否压缩', () => {
    const window = 10000;
    assert.equal(shouldCompact(window * DEFAULT_COMPACT_THRESHOLD, window), true);
    assert.equal(shouldCompact(window * DEFAULT_COMPACT_THRESHOLD - 1, window), false);
    assert.equal(shouldCompact(100, 0), false);
    assert.equal(shouldCompact(6000, window, 0.5), true);
  });

  it('压缩提示词包含必要的保留项', () => {
    const prompt = buildCompactionPrompt('TRANSCRIPT-CONTENT');
    assert.ok(prompt.includes('TRANSCRIPT-CONTENT'));
    assert.ok(prompt.includes('未完成事项'));
    assert.ok(prompt.includes('下一步计划'));
  });

  it('格式化会话条目为摘要文本', () => {
    const entries: SessionEntry[] = [
      { id: '1', parentId: null, ts: '', type: 'user', text: '任务' },
      {
        id: '2',
        parentId: '1',
        ts: '',
        type: 'assistant',
        text: '好的',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
      },
      {
        id: '3',
        parentId: '2',
        ts: '',
        type: 'tool_result',
        toolCallId: 'c1',
        name: 'read',
        content: '文件内容',
        isError: false,
      },
      { id: '4', parentId: '3', ts: '', type: 'summary', text: '旧摘要' },
    ];
    const text = formatTranscript(entries);
    assert.ok(text.includes('【用户】任务'));
    assert.ok(text.includes('(工具调用:read)'));
    assert.ok(text.includes('【工具结果:read】文件内容'));
    assert.ok(text.includes('【历史摘要】旧摘要'));
  });

  it('超长记录保留尾部', () => {
    const entries: SessionEntry[] = [
      { id: '1', parentId: null, ts: '', type: 'user', text: 'x'.repeat(300_000) },
    ];
    const text = formatTranscript(entries);
    assert.ok(text.startsWith('…(较早内容已截断)…'));
  });
});

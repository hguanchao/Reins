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
    // 结构化检查点:各节必须齐全,模型才不会漏项
    for (const section of ['## Goal', '## Progress', '## Key decisions', '## Next steps', '## Critical context']) {
      assert.ok(prompt.includes(section), `缺少小节:${section}`);
    }
    assert.ok(prompt.includes('Preserve exact file paths'));
    // 提示词面向模型,统一英文
    assert.equal(/[\u4e00-\u9fff]/.test(prompt), false);
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
    assert.ok(text.includes('[user] 任务'));
    assert.ok(text.includes('(tool calls: read)'));
    assert.ok(text.includes('[tool_result: read] 文件内容'));
    assert.ok(text.includes('[earlier summary] 旧摘要'));
  });

  it('超长记录保留尾部', () => {
    const entries: SessionEntry[] = [
      { id: '1', parentId: null, ts: '', type: 'user', text: 'x'.repeat(300_000) },
    ];
    const text = formatTranscript(entries);
    assert.ok(text.startsWith('…(earlier content truncated)…'));
  });
});

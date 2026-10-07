import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSystemPrompt } from '../../src/context/system.ts';

describe('系统提示词组装', () => {
  it('包含工作区与模型信息', () => {
    const prompt = buildSystemPrompt({
      workspace: '/tmp/ws',
      model: 'demo/model-a',
      projectDoc: null,
    });
    assert.ok(prompt.includes('/tmp/ws'));
    assert.ok(prompt.includes('demo/model-a'));
    assert.ok(prompt.includes('Read before you edit'));
    // 提示词面向模型,统一英文
    assert.equal(/[\u4e00-\u9fff]/.test(prompt), false);
  });

  it('有项目文档时包裹注入', () => {
    const prompt = buildSystemPrompt({
      workspace: '/tmp/ws',
      model: 'm',
      projectDoc: { path: '/tmp/ws/REINS.md', content: '约定:两个空格缩进' },
    });
    assert.ok(prompt.includes('<project_instructions path="/tmp/ws/REINS.md">'));
    assert.ok(prompt.includes('两个空格缩进'));
    assert.ok(prompt.includes('</project_instructions>'));
  });

  it('无项目文档时不出现文档块', () => {
    const prompt = buildSystemPrompt({ workspace: '/tmp/ws', model: 'm', projectDoc: null });
    assert.equal(prompt.includes('<project_instructions'), false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/util/errors.ts';
import { DEFAULT_MAX_RETRIES, DEFAULT_SPILL_THRESHOLD, isReasoningEffort, parseConfig, resolveReasoningEffort } from '../../src/config/schema.ts';

describe('config.toml 校验', () => {
  it('思考强度档位守卫:六个合法值通过,其余拒绝', () => {
    for (const value of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(isReasoningEffort(value), true, `${value} 应为合法档位`);
    }
    for (const value of ['default', 'HIGH', 'xhigh ', '', 'me dium']) {
      assert.equal(isReasoningEffort(value), false, `${value} 应为非法档位`);
    }
  });

  it('输入解析:精确命中与唯一前缀命中,歧义或无命中拒绝', () => {
    assert.equal(resolveReasoningEffort('high'), 'high');
    assert.equal(resolveReasoningEffort('xh'), 'xhigh');
    assert.equal(resolveReasoningEffort('o'), 'off');
    // m 同时命中 medium 与 max,前缀歧义不采纳
    assert.equal(resolveReasoningEffort('m'), undefined);
    assert.equal(resolveReasoningEffort('z'), undefined);
    assert.equal(resolveReasoningEffort(''), undefined);
  });

  it('最小配置应用默认值', () => {
    const config = parseConfig({ provider: 'p', model: 'm' });
    assert.equal(config.provider, 'p');
    assert.equal(config.model, 'm');
    assert.equal(config.maxRetries, DEFAULT_MAX_RETRIES);
    assert.equal(config.approval, 'ask');
    assert.equal(config.sandbox, 'off');
    assert.equal(config.spillThreshold, DEFAULT_SPILL_THRESHOLD);
    assert.equal(config.ui.notify, 'auto');
    assert.deepEqual(config.permissions, { deny: [], ask: [], allow: [] });
    assert.deepEqual(config.mcpServers, {});
  });

  it('缺少必填字段时汇总报错', () => {
    assert.throws(
      () => parseConfig({}),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('provider') &&
        error.message.includes('model'),
    );
  });

  it('枚举越界时报出候选值', () => {
    assert.throws(
      () => parseConfig({ provider: 'p', model: 'm', approval: 'whatever' }),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes('ask | auto | yolo'),
    );
  });

  it('解析权限规则与请求参数', () => {
    const config = parseConfig({
      provider: 'p',
      model: 'm',
      context_window: 128000,
      max_tokens: 4096,
      reasoning_effort: 'high',
      max_retries: 0,
      proxy: '',
      compact_model: 'small',
      review_model: 'judge',
      permissions: { deny: ['bash(rm *)'], ask: ['bash(git push *)'], allow: ['bash(npm *)'] },
      max_turns: 15,
      spill_threshold: 0,
    });
    assert.equal(config.contextWindow, 128000);
    assert.equal(config.maxTokens, 4096);
    assert.equal(config.reasoningEffort, 'high');
    assert.equal(config.maxRetries, 0);
    assert.equal(config.proxy, '');
    assert.equal(config.compactModel, 'small');
    assert.equal(config.reviewModel, 'judge');
    assert.deepEqual(config.permissions.deny, ['bash(rm *)']);
    assert.equal(config.maxTurns, 15);
    assert.equal(config.spillThreshold, 0);
  });

  it('MCP server:stdio / http / 仅禁用三种形态', () => {
    const config = parseConfig({
      provider: 'p',
      model: 'm',
      mcp_servers: {
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        docs: { type: 'http', url: 'https://example.com/mcp', call_timeout_ms: 120000 },
        offsite: { disabled: true },
      },
    });
    assert.equal(config.mcpServers['context7']?.command, 'npx');
    assert.equal(config.mcpServers['docs']?.type, 'http');
    assert.equal(config.mcpServers['offsite']?.disabled, true);
  });

  it('MCP server:url 缺 type、http 缺 url、空条目均报错', () => {
    assert.throws(
      () =>
        parseConfig({
          provider: 'p',
          model: 'm',
          mcp_servers: { a: { url: 'https://x' }, b: { type: 'http' }, c: {} },
        }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('mcp_servers.a') &&
        error.message.includes('mcp_servers.b') &&
        error.message.includes('mcp_servers.c'),
    );
  });

  it('数值范围被校验', () => {
    assert.throws(
      () => parseConfig({ provider: 'p', model: 'm', max_retries: -1 }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('max_retries'),
    );
  });

  it('主题:只接受预设名', () => {
    const config = parseConfig({ provider: 'p', model: 'm', ui: { theme: 'light' } });
    assert.equal(config.ui.theme, 'light');
  });

  it('主题:未知预设报错', () => {
    assert.throws(
      () => parseConfig({ provider: 'p', model: 'm', ui: { theme: 'solarized' } }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('ui.theme'),
    );
  });

  it('主题:已移除的 [ui.colors] 显式报错,而不是静默忽略', () => {
    assert.throws(
      () => parseConfig({ provider: 'p', model: 'm', ui: { colors: { accent: '#8ab4f8' } } }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('ui.colors') &&
        error.message.includes('不可配置'),
    );
  });
});

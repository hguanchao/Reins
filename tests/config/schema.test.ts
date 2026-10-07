import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/util/errors.ts';
import { DEFAULT_MAX_RETRIES, DEFAULT_SPILL_THRESHOLD, parseConfig } from '../../src/config/schema.ts';

describe('config.toml 校验', () => {
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

  it('主题:预设与角色颜色覆盖', () => {
    const config = parseConfig({
      provider: 'p',
      model: 'm',
      ui: { theme: 'light', colors: { accent: '#8ab4f8', fail: 'bold magenta' } },
    });
    assert.equal(config.ui.theme, 'light');
    assert.equal(config.ui.colors?.accent, '#8ab4f8');
    assert.equal(config.ui.colors?.fail, 'bold magenta');
  });

  it('主题:未知预设、未知角色与非法颜色均报错', () => {
    assert.throws(
      () => parseConfig({ provider: 'p', model: 'm', ui: { theme: 'solarized' } }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('ui.theme'),
    );
    assert.throws(
      () => parseConfig({ provider: 'p', model: 'm', ui: { colors: { brand: 'red' } } }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('ui.colors.brand'),
    );
    assert.throws(
      () => parseConfig({ provider: 'p', model: 'm', ui: { colors: { accent: 'not-a-color' } } }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('ui.colors.accent'),
    );
  });
});

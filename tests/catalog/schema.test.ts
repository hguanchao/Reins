import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/util/errors.ts';
import { SUPPORTED_APIS, parseCatalog } from '../../src/catalog/schema.ts';

describe('providers.json 校验', () => {
  it('合法目录通过并保留字段', () => {
    const catalog = parseCatalog({
      providers: {
        demo: {
          baseUrl: 'https://api.example.com/v1',
          api: 'openai-completions',
          apiKey: '$DEMO_KEY',
          models: [
            {
              id: 'demo-model',
              name: 'Demo',
              contextWindow: 128000,
              maxTokens: 8192,
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 1, output: 2, cacheRead: 0.1 },
            },
          ],
        },
      },
    });
    const model = catalog.providers['demo']?.models[0];
    assert.equal(model?.id, 'demo-model');
    assert.equal(model?.cost?.cacheRead, 0.1);
  });

  it('provider 缺字段时逐项报错', () => {
    assert.throws(
      () => parseCatalog({ providers: { broken: { models: [] } } }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('baseUrl') &&
        error.message.includes('api') &&
        error.message.includes('至少声明一个模型'),
    );
  });

  it('不支持的协议报错并列出候选', () => {
    assert.throws(
      () =>
        parseCatalog({
          providers: {
            x: { baseUrl: 'https://x', api: 'not-a-real-api', models: [{ id: 'm' }] },
          },
        }),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes(SUPPORTED_APIS.join(' | ')),
    );
  });

  it('模型缺 id、input 非法值、cost 缺项都会报错', () => {
    assert.throws(
      () =>
        parseCatalog({
          providers: {
            x: {
              baseUrl: 'https://x',
              api: 'openai-completions',
              models: [{ input: ['audio', 'text'], cost: { input: 1 } }],
            },
          },
        }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('models[0].id') &&
        error.message.includes('audio') &&
        error.message.includes('cost.output'),
    );
  });

  it('顶层结构错误直接拒绝', () => {
    assert.throws(() => parseCatalog([]), ConfigError);
    assert.throws(() => parseCatalog('nope'), ConfigError);
  });

  it('同一 provider 内模型 id 重复时报错', () => {
    assert.throws(
      () =>
        parseCatalog({
          providers: {
            x: {
              baseUrl: 'https://x',
              api: 'openai-completions',
              models: [{ id: 'dup' }, { id: 'dup' }],
            },
          },
        }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('models[1].id') &&
        error.message.includes('重复'),
    );
  });
});

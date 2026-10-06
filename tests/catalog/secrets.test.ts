import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/util/errors.ts';
import {
  parseEnvReference,
  resolveValue,
  type SecretContext,
} from '../../src/catalog/secrets.ts';
import { resolveAuth } from '../../src/catalog/load.ts';
import type { ProviderSpec } from '../../src/catalog/schema.ts';

function fakeContext(overrides: Partial<SecretContext> = {}): SecretContext {
  return {
    env: { DEMO_KEY: 'env-value' },
    run: async (command: string) => `ran:${command}`,
    ...overrides,
  };
}

describe('密钥解析', () => {
  it('识别环境变量引用', () => {
    assert.equal(parseEnvReference('$DEMO_KEY'), 'DEMO_KEY');
    assert.equal(parseEnvReference('${DEMO_KEY}'), 'DEMO_KEY');
    assert.equal(parseEnvReference('plain'), null);
    assert.equal(parseEnvReference('$1BAD'), null);
  });

  it('三种形态:字面量 / 环境变量 / 命令', async () => {
    const ctx = fakeContext();
    assert.equal(await resolveValue('literal-key', '测试', ctx), 'literal-key');
    assert.equal(await resolveValue('$DEMO_KEY', '测试', ctx), 'env-value');
    assert.equal(await resolveValue('!echo hello', '测试', ctx), 'ran:echo hello');
  });

  it('环境变量缺失时报错且提示设置方法', async () => {
    await assert.rejects(
      () => resolveValue('$MISSING_KEY', 'provider "x" 的 apiKey', fakeContext()),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('MISSING_KEY') &&
        (error.hint ?? '').includes('export MISSING_KEY'),
    );
  });

  it('命令失败与空命令被拒绝', async () => {
    const failing = fakeContext({
      run: async () => {
        throw new Error('not found');
      },
    });
    await assert.rejects(() => resolveValue('!bad-cmd', '测试', failing), ConfigError);
    await assert.rejects(() => resolveValue('!', '测试', fakeContext()), ConfigError);
  });

  it('resolveAuth 同时解析 apiKey 与 headers', async () => {
    const provider: ProviderSpec = {
      baseUrl: 'https://x',
      api: 'openai-completions',
      apiKey: '$DEMO_KEY',
      headers: { 'X-From': '!echo header-value', 'X-Plain': 'v' },
      models: [{ id: 'm' }],
    };
    const auth = await resolveAuth(provider, 'demo', fakeContext());
    assert.equal(auth.apiKey, 'env-value');
    assert.equal(auth.headers['X-From'], 'ran:echo header-value');
    assert.equal(auth.headers['X-Plain'], 'v');
  });

  it('未声明 apiKey 时返回 undefined(无鉴权端点)', async () => {
    const provider: ProviderSpec = { baseUrl: 'https://x', api: 'openai-completions', models: [{ id: 'm' }] };
    const auth = await resolveAuth(provider, 'demo', fakeContext());
    assert.equal(auth.apiKey, undefined);
  });
});

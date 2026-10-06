import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findModelTarget, findProvider, resolveProvider } from '../../src/catalog/load.ts';
import { parseCatalog } from '../../src/catalog/schema.ts';
import { ConfigError } from '../../src/util/errors.ts';

const catalog = parseCatalog({
  providers: {
    Alpha: {
      baseUrl: 'https://alpha.example/v1',
      api: 'openai-completions',
      models: [{ id: 'm1' }, { id: 'shared' }],
    },
    Beta: {
      baseUrl: 'https://beta.example/v1',
      api: 'anthropic-messages',
      models: [{ id: 'm2' }, { id: 'shared' }],
    },
  },
});

describe('provider 解析', () => {
  it('大小写不敏感,返回规范名称', () => {
    const found = findProvider(catalog, 'alpha');
    assert.equal(found?.name, 'Alpha');
    assert.equal(findProvider(catalog, 'ALPHA')?.name, 'Alpha');
    assert.equal(findProvider(catalog, 'missing'), undefined);
    assert.equal(resolveProvider(catalog, 'beta').baseUrl, 'https://beta.example/v1');
  });

  it('未命中时给出候选列表', () => {
    assert.throws(
      () => resolveProvider(catalog, 'nope'),
      (error: unknown) => error instanceof ConfigError && (error.hint ?? '').includes('Alpha、Beta'),
    );
  });
});

describe('模型引用解析', () => {
  it('provider/model 形式优先,且 provider 大小写不敏感', () => {
    assert.deepEqual(findModelTarget(catalog, 'alpha/m1'), {
      kind: 'found',
      provider: 'Alpha',
      modelId: 'm1',
    });
  });

  it('仅给模型 id 时全目录搜索', () => {
    assert.deepEqual(findModelTarget(catalog, 'm2'), {
      kind: 'found',
      provider: 'Beta',
      modelId: 'm2',
    });
  });

  it('多命中时返回候选', () => {
    const result = findModelTarget(catalog, 'shared');
    assert.equal(result.kind, 'ambiguous');
    if (result.kind === 'ambiguous') {
      assert.deepEqual(
        result.options.map((option) => option.provider).sort(),
        ['Alpha', 'Beta'],
      );
    }
  });

  it('带 provider 的引用可消除歧义;未知引用返回 none', () => {
    assert.deepEqual(findModelTarget(catalog, 'Beta/shared'), {
      kind: 'found',
      provider: 'Beta',
      modelId: 'shared',
    });
    assert.deepEqual(findModelTarget(catalog, 'unknown'), { kind: 'none' });
    assert.deepEqual(findModelTarget(catalog, ''), { kind: 'none' });
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/util/errors.ts';
import { Checker } from '../../src/util/schema.ts';

describe('字段校验器', () => {
  it('必填缺失时记录问题', () => {
    const checker = new Checker('demo.toml');
    const value = checker.string({}, 'name', 'name', { required: true });
    assert.equal(value, undefined);
    assert.equal(checker.hasErrors(), true);
  });

  it('枚举与数值范围被校验', () => {
    const checker = new Checker('demo.toml');
    assert.equal(checker.string({ mode: 'x' }, 'mode', 'mode', { values: ['a', 'b'] }), undefined);
    assert.equal(checker.number({ n: 1.5 }, 'n', 'n', { integer: true }), undefined);
    assert.equal(checker.number({ n: 0 }, 'n', 'n', { min: 1 }), undefined);
    assert.equal(checker.issues.length, 3);
  });

  it('合法值原样返回', () => {
    const checker = new Checker('demo.toml');
    assert.equal(checker.string({ s: 'ok' }, 's', 's'), 'ok');
    assert.equal(checker.number({ n: 3 }, 'n', 'n'), 3);
    assert.equal(checker.boolean({ b: false }, 'b', 'b'), false);
    assert.deepEqual(checker.stringArray({ list: ['a', 'b'] }, 'list', 'list'), ['a', 'b']);
    assert.deepEqual(checker.stringMap({ headers: { 'X-A': '1' } }, 'headers', 'headers'), {
      'X-A': '1',
    });
    assert.equal(checker.hasErrors(), false);
  });

  it('数组元素类型错误带上标号', () => {
    const checker = new Checker('demo.toml');
    checker.stringArray({ list: ['a', 2] }, 'list', 'list');
    assert.ok(checker.issues.some((issue) => issue.includes('list[1]')));
  });

  it('done 汇总抛出配置错误', () => {
    const checker = new Checker('demo.toml');
    checker.string({}, 'a', 'a', { required: true });
    assert.throws(
      () => checker.done(),
      (error: unknown) => error instanceof ConfigError && error.message.includes('demo.toml'),
    );
  });

  it('done 无问题时静默', () => {
    const checker = new Checker('demo.toml');
    assert.doesNotThrow(() => checker.done());
  });

  it('非有限数字被拒绝', () => {
    const checker = new Checker('demo.toml');
    assert.equal(checker.number({ n: Number.POSITIVE_INFINITY }, 'n', 'n'), undefined);
    assert.equal(checker.number({ n: Number.NaN }, 'n', 'n'), undefined);
    assert.equal(checker.issues.length, 2);
  });
});

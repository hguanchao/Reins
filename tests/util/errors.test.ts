import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, ReinsError, ToolError, describeError } from '../../src/util/errors.ts';

describe('错误类型', () => {
  it('携带错误码与提示', () => {
    const error = new ReinsError('demo', '出错了', '试试别的');
    assert.equal(error.code, 'demo');
    assert.equal(error.message, '出错了');
    assert.equal(error.hint, '试试别的');
    assert.ok(error instanceof Error);
  });

  it('子类继承基础错误', () => {
    assert.ok(new ConfigError('配置坏了') instanceof ReinsError);
    assert.equal(new ToolError('工具坏了').code, 'tool');
  });

  it('describeError 拼接提示', () => {
    assert.equal(describeError(new ToolError('坏了', '修一下')), '坏了(修一下)');
    assert.equal(describeError(new Error('普通错误')), '普通错误');
    assert.equal(describeError('字符串错误'), '字符串错误');
  });
});

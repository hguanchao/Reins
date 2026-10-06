import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SUPPORTED_APIS } from '../../src/catalog/schema.ts';
import { createAdapter, supportedApis } from '../../src/llm/stream.ts';

describe('协议适配器注册表', () => {
  it('schema 声明的支持协议与适配器实现一一对应', () => {
    assert.deepEqual([...SUPPORTED_APIS].sort(), [...supportedApis()].sort());
  });

  it('未知协议给出可读错误', () => {
    assert.throws(() => createAdapter('not-a-real-api'), /暂不支持/);
  });
});

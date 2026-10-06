import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../src/util/errors.ts';
import {
  ToolRegistry,
  optionalNumber,
  requireString,
  type Tool,
} from '../../src/tools/registry.ts';

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} 工具`,
    parameters: { type: 'object' },
    permissionKind: 'bash',
    targetOf: () => ({}),
    execute: async () => ({ content: 'ok', isError: false }),
  };
}

describe('工具注册表', () => {
  it('注册、查询与规格导出', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('alpha'));
    assert.equal(registry.get('alpha')?.description, 'alpha 工具');
    assert.equal(registry.get('missing'), undefined);
    assert.deepEqual(
      registry.toToolSpecs().map((spec) => spec.name),
      ['alpha'],
    );
  });

  it('重名注册被拒绝', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('dup'));
    assert.throws(() => registry.register(makeTool('dup')), ToolError);
  });

  it('参数读取助手的行为', () => {
    assert.equal(requireString({ path: 'a.ts' }, 'path', 'read'), 'a.ts');
    assert.throws(() => requireString({}, 'path', 'read'), ToolError);
    assert.throws(() => requireString({ path: '  ' }, 'path', 'read'), ToolError);
    assert.equal(optionalNumber({ n: 3 }, 'n', 'x'), 3);
    assert.equal(optionalNumber({}, 'n', 'x'), undefined);
    assert.throws(() => optionalNumber({ n: 'x' }, 'n', 'x'), ToolError);
  });
});

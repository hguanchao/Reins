import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Sandbox } from '../../src/permissions/sandbox.ts';

const workspace = join(process.cwd(), 'fake-workspace');

describe('沙箱边界', () => {
  it('off 不限制', () => {
    const sandbox = new Sandbox('off', workspace);
    assert.equal(sandbox.checkPath('write', join(workspace, '..', 'elsewhere', 'a.txt')), null);
  });

  it('workspace 限制写入范围,读不受限', () => {
    const sandbox = new Sandbox('workspace', workspace);
    assert.equal(sandbox.checkPath('write', join(workspace, 'src', 'a.ts')), null);
    assert.equal(sandbox.checkPath('write', join(workspace, '..', 'x.ts'))?.verdict, 'deny');
    assert.equal(sandbox.checkPath('read', join(workspace, '..', 'x.ts')), null);
  });

  it('read-only 禁止一切写,读不受限', () => {
    const sandbox = new Sandbox('read-only', workspace);
    assert.equal(sandbox.checkPath('write', join(workspace, 'src', 'a.ts'))?.verdict, 'deny');
    assert.equal(sandbox.checkPath('read', join(workspace, '..', 'x.ts')), null);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../../src/cli/args.ts';

describe('参数解析', () => {
  it('子命令与位置参数', () => {
    const args = parseArgs(['run', '写个', '测试']);
    assert.equal(args.command, 'run');
    assert.deepEqual(args.positionals, ['写个', '测试']);
  });

  it('--key value、--key=value 与布尔 --key 三种形态', () => {
    const args = parseArgs(['doctor', '--workspace', '.', '--no-network']);
    assert.equal(args.flags['workspace'], '.');
    assert.equal(args.flags['no-network'], true);
    const withEquals = parseArgs(['run', '--workspace=.']);
    assert.equal(withEquals.flags['workspace'], '.');
  });

  it('-- 之后全部视为位置参数', () => {
    const args = parseArgs(['run', '--', '--not-a-flag']);
    assert.deepEqual(args.positionals, ['--not-a-flag']);
  });

  it('缺省子命令为 help', () => {
    assert.equal(parseArgs([]).command, 'help');
    assert.equal(parseArgs(['--verbose']).command, 'help');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseChatCommand } from '../../src/cli/commands/chat.ts';

describe('交互模式输入解析', () => {
  it('空行与斜杠命令', () => {
    assert.equal(parseChatCommand('').type, 'empty');
    assert.equal(parseChatCommand('   ').type, 'empty');
    assert.equal(parseChatCommand('/exit').type, 'exit');
    assert.equal(parseChatCommand('/quit').type, 'exit');
    assert.equal(parseChatCommand('/help').type, 'help');
    assert.equal(parseChatCommand('/session').type, 'session');
  });

  it('普通文本作为任务,首尾空白被裁剪', () => {
    const command = parseChatCommand('  修复 bug  ');
    assert.equal(command.type, 'prompt');
    assert.equal(command.type === 'prompt' ? command.text : '', '修复 bug');
  });

  it('未知斜杠输入按普通文本处理', () => {
    assert.equal(parseChatCommand('/unknown cmd').type, 'prompt');
  });
});

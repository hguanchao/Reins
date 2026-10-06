import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  completeChatInput,
  decideInterrupt,
  parseChatCommand,
} from '../../src/cli/commands/chat.ts';

describe('交互模式输入解析', () => {
  it('空行与斜杠命令', () => {
    assert.equal(parseChatCommand('').type, 'empty');
    assert.equal(parseChatCommand('   ').type, 'empty');
    assert.equal(parseChatCommand('/exit').type, 'exit');
    assert.equal(parseChatCommand('/quit').type, 'exit');
    assert.equal(parseChatCommand('/help').type, 'help');
    assert.equal(parseChatCommand('/session').type, 'session');
    assert.equal(parseChatCommand('/status').type, 'status');
    assert.equal(parseChatCommand('/new').type, 'new');
    assert.equal(parseChatCommand('/clear').type, 'new');
    assert.equal(parseChatCommand('/compact').type, 'compact');
    assert.equal(parseChatCommand('/mcp').type, 'mcp');
    assert.equal(parseChatCommand('/mcps').type, 'mcp');
  });

  it('带参数的命令', () => {
    const model = parseChatCommand('/model hybgzs/z-ai/glm-5.3');
    assert.equal(model.type, 'model');
    assert.equal(model.type === 'model' ? model.target : undefined, 'hybgzs/z-ai/glm-5.3');
    const bare = parseChatCommand('/model');
    assert.equal(bare.type, 'model');
    assert.equal(bare.type === 'model' ? bare.target : 'x', undefined);

    const resume = parseChatCommand('/resume s-abc');
    assert.equal(resume.type, 'resume');
    assert.equal(resume.type === 'resume' ? resume.id : undefined, 's-abc');
    assert.equal(parseChatCommand('/sessions').type, 'resume');
  });

  it('普通文本作为任务,首尾空白被裁剪', () => {
    const command = parseChatCommand('  修复 bug  ');
    assert.equal(command.type, 'prompt');
    assert.equal(command.type === 'prompt' ? command.text : '', '修复 bug');
  });

  it('未知斜杠输入按普通文本处理', () => {
    assert.equal(parseChatCommand('/unknown cmd').type, 'prompt');
    assert.equal(parseChatCommand('/tmp/file.txt').type, 'prompt');
  });
});

describe('中断决策', () => {
  it('运行中优先中断', () => {
    assert.equal(decideInterrupt({ running: true, hasInput: false }), 'abort');
    assert.equal(decideInterrupt({ running: true, hasInput: true }), 'abort');
  });

  it('空闲时先清空输入,空行再退出', () => {
    assert.equal(decideInterrupt({ running: false, hasInput: true }), 'clear');
    assert.equal(decideInterrupt({ running: false, hasInput: false }), 'exit');
  });
});

describe('斜杠命令补全', () => {
  it('斜杠前缀补全命令', () => {
    const [matches, line] = completeChatInput('/mo');
    assert.deepEqual(matches, ['/model']);
    assert.equal(line, '/mo');
  });

  it('补全不进入参数区域', () => {
    const [matches] = completeChatInput('/model foo');
    assert.deepEqual(matches, []);
  });

  it('非斜杠输入不补全', () => {
    assert.deepEqual(completeChatInput('hello'), [[], 'hello']);
  });
});

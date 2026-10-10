import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHAT_COMMANDS,
  completeChatInput,
  decideInterrupt,
  parseChatCommand,
} from '../../src/cli/commands/chat.ts';
import { CHAT_COMMAND_DESCRIPTIONS } from '../../src/cli/commands/chat-commands.ts';

describe('交互模式输入解析', () => {
  it('空行与斜杠命令', () => {
    assert.equal(parseChatCommand('').type, 'empty');
    assert.equal(parseChatCommand('   ').type, 'empty');
    assert.equal(parseChatCommand('/quit').type, 'exit');
    assert.equal(parseChatCommand('/help').type, 'help');
    assert.equal(parseChatCommand('/hotkeys').type, 'help');
    assert.equal(parseChatCommand('/new').type, 'new');
    assert.equal(parseChatCommand('/compact').type, 'compact');
    assert.equal(parseChatCommand('/mcp').type, 'mcp');
    assert.equal(parseChatCommand('/mcps').type, 'mcp');
    assert.equal(parseChatCommand('/effort').type, 'effort');
  });

  it('带参数的命令', () => {
    const model = parseChatCommand('/model hybgzs/z-ai/glm-5.3');
    assert.equal(model.type, 'model');
    assert.equal(model.type === 'model' ? model.target : undefined, 'hybgzs/z-ai/glm-5.3');
    const bare = parseChatCommand('/model');
    assert.equal(bare.type, 'model');
    assert.equal(bare.type === 'model' ? bare.target : 'x', undefined);

    const effort = parseChatCommand('/effort high');
    assert.equal(effort.type, 'effort');
    assert.equal(effort.type === 'effort' ? effort.value : undefined, 'high');
    const bareEffort = parseChatCommand('/effort');
    assert.equal(bareEffort.type, 'effort');
    assert.equal(bareEffort.type === 'effort' ? bareEffort.value : 'x', undefined);

    const resume = parseChatCommand('/sessions s-abc');
    assert.equal(resume.type, 'resume');
    assert.equal(resume.type === 'resume' ? resume.id : undefined, 's-abc');
    const bareResume = parseChatCommand('/sessions');
    assert.equal(bareResume.type, 'resume');
    assert.equal(bareResume.type === 'resume' ? bareResume.id : 'x', undefined);
  });

  it('普通文本作为任务,首尾空白被裁剪', () => {
    const command = parseChatCommand('  修复 bug  ');
    assert.equal(command.type, 'prompt');
    assert.equal(command.type === 'prompt' ? command.text : '', '修复 bug');
  });

  it('未知斜杠输入按普通文本处理', () => {
    assert.equal(parseChatCommand('/unknown cmd').type, 'prompt');
    assert.equal(parseChatCommand('/tmp/file.txt').type, 'prompt');
    // 已移除的命令(/exit、/clear、/resume、/session、/status)不再特殊化,按普通文本交给模型
    for (const removed of ['/exit', '/clear', '/resume', '/session', '/status']) {
      assert.equal(parseChatCommand(removed).type, 'prompt', `${removed} 应按普通文本处理`);
    }
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
  it('/effort 已注册且补全菜单有说明', () => {
    assert.ok(CHAT_COMMANDS.includes('/effort'));
    assert.equal(CHAT_COMMAND_DESCRIPTIONS['/effort'], '查看或切换思考强度');
    const [matches] = completeChatInput('/ef');
    assert.deepEqual(matches, ['/effort']);
  });

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

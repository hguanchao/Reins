import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConsoleUi, SilentUi } from '../../src/ui/printer.ts';

describe('控制台呈现', () => {
  it('文本原样流出,工具事件折叠成行', () => {
    const pieces: string[] = [];
    const ui = new ConsoleUi((text) => void pieces.push(text));
    ui.onAssistantText('你好');
    ui.onToolCall({ id: 'c1', name: 'read', arguments: '{"path":"a"}' });
    ui.onToolResult('read', '第一行\n第二行', false);
    ui.onToolResult('bash', '失败了', true);
    ui.onNotice('注意');
    const all = pieces.join('');
    assert.ok(all.includes('你好'));
    assert.ok(all.includes('[工具] read'));
    assert.ok(all.includes('[完成] read: 第一行 …'));
    assert.ok(all.includes('[失败] bash: 失败了'));
    assert.ok(all.includes('[提示] 注意'));
  });

  it('静默实现不抛出', () => {
    const ui = new SilentUi();
    assert.doesNotThrow(() => {
      ui.onAssistantText('x');
      ui.onToolCall({ id: 'c', name: 'n', arguments: '{}' });
      ui.onToolResult('n', 'c', false);
      ui.onNotice('m');
    });
  });
});

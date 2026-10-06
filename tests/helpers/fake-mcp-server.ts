/**
 * 测试用假 MCP server 的源码(纯 JavaScript,由 node 直接执行)。
 *
 * 支持:initialize 握手、tools/list、tools/call(echo 工具)。
 */
export const FAKE_MCP_SERVER_SOURCE = `
'use strict';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== '') {
      handle(JSON.parse(line));
    }
    index = buffer.indexOf('\\n');
  }
});
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  if (message.method === 'notifications/initialized') {
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
    return;
  }
  if (message.method === 'tools/call') {
    const args = message.params && message.params.arguments ? message.params.arguments : {};
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + String(args.text) }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
}
`;

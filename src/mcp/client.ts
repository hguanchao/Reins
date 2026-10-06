import { spawn, type ChildProcess } from 'node:child_process';
import { ReinsError } from '../util/errors.ts';

/**
 * MCP 客户端与传输层。
 *
 * 设计意图:JSON-RPC 逻辑与传输解耦——stdio 与 http 各自实现最小传输契约,
 * 客户端只管请求/响应配对、超时与关闭;连接失败给出可读原因,不抛出未处理异常。
 */

export interface JsonRpcMessage {
  [key: string]: unknown;
}

/** 传输契约:发送消息、接收消息、感知关闭。 */
export interface McpTransport {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): Promise<void>;
}

/** 控制类请求(握手、列表)的固定超时。 */
const CONTROL_TIMEOUT_MS = 15_000;
/** 工具调用的默认超时。 */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (value: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpToolDefinition {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown> | undefined;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly callTimeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closedReason: string | undefined;

  constructor(transport: McpTransport, options: { callTimeoutMs?: number } = {}) {
    this.transport = transport;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.transport.onMessage((message) => this.dispatch(message));
    this.transport.onClose((reason) => this.failAll(reason));
  }

  /** 执行 initialize 握手并发出 initialized 通知。 */
  async initialize(clientName: string, clientVersion: string): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
    this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** 列出服务端工具。 */
  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request('tools/list', {});
    const rawTools = result['tools'];
    if (!Array.isArray(rawTools)) {
      return [];
    }
    const tools: McpToolDefinition[] = [];
    for (const item of rawTools) {
      if (!isRecord(item) || typeof item['name'] !== 'string' || item['name'] === '') {
        continue;
      }
      tools.push({
        name: item['name'],
        description: typeof item['description'] === 'string' ? item['description'] : undefined,
        inputSchema: isRecord(item['inputSchema']) ? item['inputSchema'] : undefined,
      });
    }
    return tools;
  }

  /** 调用一个工具,把内容块拼接为纯文本。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }, this.callTimeoutMs);
    const content = Array.isArray(result['content']) ? result['content'] : [];
    const parts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        parts.push(block['text']);
      } else {
        parts.push(`[${String(block['type'])}]`);
      }
    }
    return {
      text: parts.length === 0 ? '(无内容)' : parts.join('\n'),
      isError: result['isError'] === true,
    };
  }

  async close(): Promise<void> {
    this.failAll('客户端关闭');
    await this.transport.close();
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<JsonRpcMessage> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new ReinsError('mcp', `连接已关闭:${this.closedReason}`));
    }
    const id = (this.sequence += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ReinsError('mcp', `MCP 请求超时(${timeoutMs}ms):${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private dispatch(message: JsonRpcMessage): void {
    const id = message['id'];
    if (typeof id !== 'number') {
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const error = message['error'];
    if (isRecord(error)) {
      const text = typeof error['message'] === 'string' ? error['message'] : '未知错误';
      entry.reject(new ReinsError('mcp', `MCP 错误:${text}`));
      return;
    }
    const result = message['result'];
    entry.resolve(isRecord(result) ? result : {});
  }

  private failAll(reason: string): void {
    if (this.closedReason === undefined) {
      this.closedReason = reason;
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new ReinsError('mcp', `连接中断:${reason}`));
      this.pending.delete(id);
    }
  }
}

/** stdio 传输:以子进程运行 server,按行分隔的 JSON-RPC。 */
export class StdioTransport implements McpTransport {
  private readonly child: ChildProcess;
  private messageHandler: ((message: JsonRpcMessage) => void) | undefined;
  private closeHandler: ((reason: string) => void) | undefined;
  private buffer = '';
  private stderrTail = '';
  private closed = false;

  constructor(command: string, args: string[]) {
    // Windows 下裸命令(npx 等)需要 shell;显式路径直接执行。
    // 需要 shell 时自行拼好命令行,不再把 args 交给 shell(避免弃用告警与注入面)
    const useShell = process.platform === 'win32' && !/[\\/]/.test(command);
    this.child = useShell
      ? spawn([command, ...args].map(quoteShellArg).join(' '), {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: true,
        })
      : spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    this.child.on('error', (error) => this.markClosed(`启动失败:${error.message}`));
    this.child.on('close', (code) => {
      const tail = this.stderrTail.trim();
      const detail = tail === '' ? '' : `:${tail}`;
      this.markClosed(`进程退出(代码 ${code ?? '未知'})${detail}`);
    });
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  send(message: JsonRpcMessage): void {
    if (this.closed) {
      return;
    }
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.markClosed('主动关闭');
    if (child.exitCode !== null || child.killed) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.end();
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') {
        const parsed = tryParseObject(line);
        if (parsed !== undefined) {
          this.messageHandler?.(parsed);
        }
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private markClosed(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeHandler?.(reason);
  }
}

/** http 传输:POST JSON-RPC;响应支持 application/json 与 text/event-stream。 */
export class HttpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private messageHandler: ((message: JsonRpcMessage) => void) | undefined;
  private closeHandler: ((reason: string) => void) | undefined;
  private closed = false;

  constructor(url: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  send(message: JsonRpcMessage): void {
    void this.post(message);
  }

  async close(): Promise<void> {
    this.markClosed('主动关闭');
  }

  private async post(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        this.markClosed(`HTTP ${response.status}`);
        return;
      }
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      if (contentType.includes('text/event-stream')) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '') {
            continue;
          }
          const parsed = tryParseObject(payload);
          if (parsed !== undefined) {
            this.messageHandler?.(parsed);
          }
        }
        return;
      }
      const trimmed = text.trim();
      if (trimmed !== '') {
        const parsed = tryParseObject(trimmed);
        if (parsed !== undefined) {
          this.messageHandler?.(parsed);
        }
      }
    } catch (error) {
      this.markClosed(error instanceof Error ? error.message : String(error));
    }
  }

  private markClosed(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeHandler?.(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 为 cmd.exe 转义参数:普通字符原样,含特殊字符时整体加引号。 */
function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

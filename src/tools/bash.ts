import { spawn, type ChildProcess } from 'node:child_process';
import {
  optionalNumber,
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './registry.ts';

/**
 * 命令执行工具。
 *
 * 设计意图:非交互式执行、超时保护、输出截断;
 * 非零退出码不视为工具错误——那是模型需要看到的信息,而不是异常。
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 200_000;

export class BashTool implements Tool {
  readonly name = 'bash';
  readonly description = '在工作区执行 shell 命令(非交互式),返回退出码与输出。';
  readonly parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout_ms: { type: 'number', description: `超时毫秒数(默认 ${DEFAULT_TIMEOUT_MS},上限 ${MAX_TIMEOUT_MS})` },
    },
    required: ['command'],
    additionalProperties: false,
  };
  readonly permissionKind = 'bash' as const;

  targetOf(input: Record<string, unknown>, _ctx: ToolContext) {
    return { command: requireString(input, 'command', this.name) };
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = requireString(input, 'command', this.name);
    const timeoutMs = Math.min(
      optionalNumber(input, 'timeout_ms', this.name) ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const outcome = await runShell(command, {
      cwd: ctx.workspace,
      timeoutMs,
      signal: ctx.signal,
    });
    return { content: outcome.content, isError: outcome.failed };
  }
}

interface RunShellOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface ShellOutcome {
  content: string;
  failed: boolean;
}

/** 执行 shell 命令并回收输出;永不抛出,失败信息作为内容返回。 */
export function runShell(command: string, options: RunShellOptions): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      signal: options.signal,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // 自行管理超时:必须终止整棵进程树,否则 shell 的子进程会挂住管道导致 close 迟迟不来
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
    }, options.timeoutMs);

    const finish = (outcome: ShellOutcome) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      stdout = clip(stdout + data.toString());
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr = clip(stderr + data.toString());
    });
    child.on('error', (error) => {
      finish({ content: `命令执行失败:${error.message}`, failed: true });
    });
    child.on('close', (code, signal) => {
      const status = timedOut
        ? `执行超时(${options.timeoutMs}ms),进程已被终止`
        : code !== null
          ? `退出码:${code}`
          : `进程被信号终止:${signal ?? '未知'}`;
      const parts: string[] = [status];
      if (stdout !== '') {
        parts.push('', 'stdout:', stdout);
      }
      if (stderr !== '') {
        parts.push('', 'stderr:', stderr);
      }
      if (stdout === '' && stderr === '') {
        parts.push('(无输出)');
      }
      finish({ content: parts.join('\n'), failed: false });
    });
  });
}

/** 终止进程树:Windows 用 taskkill /T,其他平台直接 SIGKILL。 */
function terminateTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      child.kill();
    }
  } else {
    child.kill('SIGKILL');
  }
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return `${text.slice(0, half)}\n...(输出过长,已截断)...\n${text.slice(-half)}`;
}

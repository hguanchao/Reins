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
  readonly description =
    'Execute a shell command in the workspace (non-interactive) and return its exit code and output.';
  readonly parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      timeout_ms: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Non-positive values fall back to the default.`,
      },
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
    // 非正数或非有限值按未指定处理:0 会被 setTimeout 立即触发,命令刚启动就被杀掉
    const requested = optionalNumber(input, 'timeout_ms', this.name);
    const timeoutMs =
      requested === undefined || !Number.isFinite(requested) || requested <= 0
        ? DEFAULT_TIMEOUT_MS
        : Math.min(Math.floor(requested), MAX_TIMEOUT_MS);
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
      // POSIX 下自成进程组,终止时才能连同子进程一起杀掉(shell 的子进程会挂住管道)
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    // 自行管理超时:必须终止整棵进程树,否则 shell 的子进程会挂住管道导致 close 迟迟不来
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
      // 兜底:极端情况下 close 仍不来(如孙进程霸占 stdout),不能让 Promise 永久挂起
      timers.push(
        setTimeout(() => {
          finish({ content: `执行超时(${options.timeoutMs}ms),进程未能及时退出`, failed: true });
        }, 2000),
      );
    }, options.timeoutMs);
    timers.push(timer);

    const finish = (outcome: ShellOutcome) => {
      if (!settled) {
        settled = true;
        for (const pending of timers) {
          clearTimeout(pending);
        }
        options.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      }
    };

    // 中止时同样要连坐整棵进程树:spawn 的 signal 只终止直接子进程
    const onAbort = (): void => {
      terminateTree(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      stdout = clip(stdout + data);
    });
    child.stderr?.on('data', (data: string) => {
      stderr = clip(stderr + data);
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

/** 终止进程树:Windows 用 taskkill /T,其他平台对进程组发 SIGKILL。 */
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
    try {
      // 负 pid 表示整个进程组(spawn 时已 detached)
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return `${text.slice(0, half)}\n...(输出过长,已截断)...\n${text.slice(-half)}`;
}

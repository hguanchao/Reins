import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { loadCatalogFile } from '../../catalog/load.ts';
import { loadLayeredConfig } from '../../config/layers.ts';
import { formatUsage } from '../../llm/usage.ts';
import { createAgentRuntime } from '../../agent/run.ts';
import { ConsoleUi } from '../../ui/printer.ts';
import { describeError } from '../../util/errors.ts';
import { absolutize, reinsHome } from '../../util/paths.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/**
 * chat 子命令:交互式会话。
 *
 * 设计意图:一个运行时承载多轮对话——会话与连接跨轮持久,工具审批复用同一输入通道;
 * 斜杠命令保持最小集,其余都交给自然语言。
 */

export type ChatCommand =
  | { type: 'exit' }
  | { type: 'help' }
  | { type: 'session' }
  | { type: 'empty' }
  | { type: 'prompt'; text: string };

/** 解析一行输入:斜杠命令或普通任务文本。 */
export function parseChatCommand(input: string): ChatCommand {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { type: 'empty' };
  }
  if (trimmed === '/exit' || trimmed === '/quit') {
    return { type: 'exit' };
  }
  if (trimmed === '/help') {
    return { type: 'help' };
  }
  if (trimmed === '/session') {
    return { type: 'session' };
  }
  return { type: 'prompt', text: trimmed };
}

const CHAT_HELP = ['/help     显示帮助', '/session  显示当前会话文件', '/exit     退出'].join(
  '\n',
);

export async function chatCommand(args: ParsedArgs, io: CommandIo = defaultIo): Promise<number> {
  if (process.stdin.isTTY !== true) {
    io.err('chat 需要交互式终端;非交互场景请使用 reins run "任务"。');
    return 1;
  }
  const home = reinsHome();
  const workspace =
    typeof args.flags['workspace'] === 'string'
      ? absolutize(args.flags['workspace'])
      : process.cwd();
  const { config } = await loadLayeredConfig({ home, cwd: workspace });
  const catalog = await loadCatalogFile(join(home, 'providers.json'));

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const runtime = await createAgentRuntime({
      config,
      catalog,
      workspace,
      home,
      ui: new ConsoleUi(),
      approval: {
        approver: {
          async ask(target, decision) {
            const what = target.command ?? target.path ?? target.server ?? target.domain ?? '';
            const suffix = what === '' ? '' : ` ${what}`;
            const answer = await rl.question(
              `\n[审批] ${target.tool}${suffix}(${decision.reason})——允许? [y/N] `,
            );
            return answer.trim().toLowerCase().startsWith('y') ? 'allow' : 'deny';
          },
        },
      },
    });
    try {
      io.err(`Reins 交互模式 · 会话 ${runtime.session.id}`);
      io.err('输入任务开始对话;/help 查看命令,/exit 退出。');
      io.err('');

      for (;;) {
        let line: string;
        try {
          line = await rl.question('> ');
        } catch {
          break;
        }
        const command = parseChatCommand(line);
        if (command.type === 'exit') {
          break;
        }
        if (command.type === 'empty') {
          continue;
        }
        if (command.type === 'help') {
          io.err(CHAT_HELP);
          continue;
        }
        if (command.type === 'session') {
          io.err(`会话文件:${runtime.session.path}`);
          continue;
        }
        try {
          const result = await runtime.agent.run(command.text);
          io.err(`\n· ${result.turns} 轮 · ${formatUsage(result.usage, undefined)}`);
        } catch (error) {
          io.err(`错误:${describeError(error)}`);
        }
      }
      return 0;
    } finally {
      await runtime.close();
    }
  } finally {
    rl.close();
  }
}

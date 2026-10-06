import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { loadCatalogFile, resolveModel, resolveProvider } from '../../catalog/load.ts';
import { loadLayeredConfig } from '../../config/layers.ts';
import { formatUsage } from '../../llm/usage.ts';
import type { Approver } from '../../permissions/approval.ts';
import { ConsoleUi } from '../../ui/printer.ts';
import { notify } from '../../ui/notify.ts';
import { absolutize, reinsHome } from '../../util/paths.ts';
import { runTask } from '../../agent/run.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';
import { resolveSessionFile } from './sessions.ts';

/**
 * run 子命令:执行一次任务。
 *
 * 交互终端下提供人工审批通道;非交互环境按「保守拒绝」语义运行。
 */
export async function runCommand(args: ParsedArgs, io: CommandIo = defaultIo): Promise<number> {
  const prompt = args.positionals.join(' ').trim();
  if (prompt === '') {
    io.err('用法:reins run "任务描述" [--workspace 目录] [--session 会话文件]');
    return 1;
  }
  const home = reinsHome();
  const workspace =
    typeof args.flags['workspace'] === 'string'
      ? absolutize(args.flags['workspace'])
      : process.cwd();
  const resume = typeof args.flags['resume'] === 'string' ? args.flags['resume'] : undefined;
  const sessionFile =
    resume !== undefined
      ? await resolveSessionFile(home, resume)
      : typeof args.flags['session'] === 'string'
        ? absolutize(args.flags['session'])
        : undefined;

  const { config, files } = await loadLayeredConfig({ home, cwd: workspace });
  const catalog = await loadCatalogFile(join(home, 'providers.json'));

  io.err(`· 配置:${files.join('、')}`);
  io.err(`· 工作区:${workspace}`);
  io.err(`· 模型:${config.provider}/${config.model}`);
  io.err('');

  const ui = new ConsoleUi();
  const approver = createTerminalApprover();
  const { result, session } = await runTask(prompt, {
    config,
    catalog,
    workspace,
    home,
    ui,
    sessionFile,
    approval: approver === undefined ? {} : { approver },
  });

  const provider = resolveProvider(catalog, config.provider);
  const model = resolveModel(provider, config.provider, config.model);
  io.err('');
  io.err(`· 完成:${result.turns} 轮`);
  io.err(`· 用量:${formatUsage(result.usage, model.cost)}`);
  io.err(`· 会话:${session.path}`);

  notify(config.ui.notify, 'Reins 任务完成');
  return 0;
}

/** 交互式审批:仅在 TTY 下启用。 */
function createTerminalApprover(): Approver | undefined {
  if (process.stdin.isTTY !== true) {
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    async ask(target, decision) {
      const what = target.command ?? target.path ?? target.server ?? target.domain ?? '';
      const suffix = what === '' ? '' : ` ${what}`;
      const answer = await rl.question(
        `\n[审批] ${target.tool}${suffix}(${decision.reason})——允许? [y/N] `,
      );
      return answer.trim().toLowerCase().startsWith('y') ? 'allow' : 'deny';
    },
  };
}

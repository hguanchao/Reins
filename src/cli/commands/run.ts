import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { loadCatalogFile, resolveModel, resolveProvider } from '../../catalog/load.ts';
import { ensureHomeConfig } from '../../config/ensure.ts';
import { loadLayeredConfig } from '../../config/layers.ts';
import { ignoredNotice, resolveTrustForCli } from '../trust.ts';
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
export async function runCommand(
  args: ParsedArgs,
  io: CommandIo = defaultIo,
  home = reinsHome(),
): Promise<number> {
  const prompt = args.positionals.join(' ').trim();
  if (prompt === '') {
    io.err('用法:reins run "任务描述" [--workspace 目录] [--resume 会话 id]');
    return 1;
  }
  const workspace =
    typeof args.flags['workspace'] === 'string'
      ? absolutize(args.flags['workspace'])
      : process.cwd();

  // 启动时自动补全配置文件;首次创建时提示编辑而不是继续执行
  const ensured = await ensureHomeConfig(home);
  if (ensured.created.length > 0) {
    io.err(`已创建默认配置:${ensured.created.join('、')}`);
    io.err('请先编辑 providers.json 填入你的端点与密钥,然后重新运行。');
    return 1;
  }

  const resume = typeof args.flags['resume'] === 'string' ? args.flags['resume'] : undefined;
  const sessionFile =
    resume !== undefined
      ? await resolveSessionFile(home, resume)
      : typeof args.flags['session'] === 'string'
        ? absolutize(args.flags['session'])
        : undefined;

  const resolution = await resolveTrustForCli({
    home,
    workspace,
    force: args.flags['trust'] === true,
    allowPrompt: true,
  });
  if (resolution.reason === 'declined') {
    io.err('未信任该目录,已退出;项目层配置与项目说明文件未加载。');
    return 1;
  }
  const ignored = await ignoredNotice(resolution);
  if (ignored !== undefined) {
    io.err(`警告:${ignored}`);
  }

  const { config, files } = await loadLayeredConfig({
    home,
    cwd: workspace,
    projectLayer: resolution.projectAllowed ? 'allow' : 'ignore',
  });
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
    projectTrusted: resolution.projectAllowed,
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

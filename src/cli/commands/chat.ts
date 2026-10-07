import { createInterface } from 'node:readline/promises';
import type { Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';
import { findModelTarget, loadCatalogFile } from '../../catalog/load.ts';
import type { Catalog } from '../../catalog/schema.ts';
import { ensureHomeConfig } from '../../config/ensure.ts';
import { loadLayeredConfig } from '../../config/layers.ts';
import type { Config } from '../../config/schema.ts';
import { createAgentRuntime, type AgentRuntime } from '../../agent/run.ts';
import { formatUsage } from '../../llm/usage.ts';
import { ConsoleUi } from '../../ui/printer.ts';
import { describeError } from '../../util/errors.ts';
import { absolutize, reinsHome } from '../../util/paths.ts';
import { startTui } from '../../tui/app.ts';
import { latestSessionFile, listSessionSummaries, resolveSessionFile } from './sessions.ts';
import {
  CHAT_COMMANDS,
  CHAT_HELP_TEXT,
  completeChatInput,
  decideInterrupt,
  parseChatCommand,
} from './chat-commands.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';
import { ignoredNotice, resolveTrustForCli } from '../trust.ts';

export {
  CHAT_COMMANDS,
  completeChatInput,
  decideInterrupt,
  parseChatCommand,
} from './chat-commands.ts';
export type { ChatCommand } from './chat-commands.ts';

/**
 * chat 子命令:交互式会话。
 *
 * 默认进入全屏 TUI;--plain 回退到纯文本模式(保留原有行为)。
 */
export async function chatCommand(
  args: ParsedArgs,
  io: CommandIo = defaultIo,
  home = reinsHome(),
): Promise<number> {
  if (process.stdin.isTTY !== true) {
    io.err('chat 需要交互式终端;非交互场景请使用 reins run "任务"。');
    return 1;
  }
  if (args.flags['plain'] !== true && process.stdout.isTTY === true) {
    return await startTui(args, io, home);
  }
  return await runPlainChat(args, io, home);
}

/** 纯文本交互模式。 */
async function runPlainChat(args: ParsedArgs, io: CommandIo, home: string): Promise<number> {
  const workspace =
    typeof args.flags['workspace'] === 'string'
      ? absolutize(args.flags['workspace'])
      : process.cwd();

  const ensured = await ensureHomeConfig(home);
  if (ensured.created.length > 0) {
    io.err(`已创建默认配置:${ensured.created.join('、')}`);
    io.err('提示:请编辑 providers.json 填入你的端点与密钥。');
  }

  // 信任先于一切:未信任就不加载项目层,也不注入项目说明文件
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
  const projectLayer = resolution.projectAllowed ? 'allow' : 'ignore';

  let resumeFile: string | undefined;
  try {
    const flag = args.flags['resume'];
    if (flag !== undefined) {
      if (flag === true || flag === '') {
        resumeFile = await latestSessionFile(home);
      } else {
        resumeFile = await resolveSessionFile(home, String(flag));
      }
      if (resumeFile === undefined) {
        io.err('未找到可恢复的会话,将开始新会话。');
      }
    }
  } catch (error) {
    io.err(`警告:${describeError(error)}`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    historySize: 200,
    removeHistoryDuplicates: true,
    completer: (line: string) => completeChatInput(line),
  });
  const raw = rl as unknown as ReadlineInterface;
  const ui = new ConsoleUi();

  let runtime: AgentRuntime | undefined;
  let catalog: Catalog | undefined;
  let currentConfig: Config | undefined;
  let running = false;
  let activeRun: AbortController | undefined;

  const approver = {
    async ask(target: { tool: string; command?: string; path?: string; server?: string; domain?: string }, decision: { reason: string }) {
      const what = target.command ?? target.path ?? target.server ?? target.domain ?? '';
      const suffix = what === '' ? '' : ` ${what}`;
      const answer = await rl.question(
        `\n[审批] ${target.tool}${suffix}(${decision.reason})——允许? [y/N] `,
      );
      return answer.trim().toLowerCase().startsWith('y') ? ('allow' as const) : ('deny' as const);
    },
  };

  const startup = async (): Promise<void> => {
    const layered = await loadLayeredConfig({ home, cwd: workspace, projectLayer });
    currentConfig = layered.config;
    catalog = await loadCatalogFile(join(home, 'providers.json'));
    runtime = await createAgentRuntime({
      config: currentConfig,
      catalog,
      workspace,
      home,
      ui,
      sessionFile: resumeFile,
      projectTrusted: projectLayer === 'allow',
      approval: { approver },
    });
    resumeFile = undefined;
  };

  const rebuild = async (options: {
    provider?: string;
    model?: string;
    sessionFile?: string;
    freshSession?: boolean;
  }): Promise<void> => {
    const layered = await loadLayeredConfig({ home, cwd: workspace, projectLayer });
    currentConfig = {
      ...layered.config,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    };
    catalog = await loadCatalogFile(join(home, 'providers.json'));
    const sessionFile =
      options.freshSession === true ? undefined : (options.sessionFile ?? runtime?.session.path);
    await runtime?.close();
    runtime = undefined;
    runtime = await createAgentRuntime({
      config: currentConfig,
      catalog,
      workspace,
      home,
      ui,
      sessionFile,
      projectTrusted: projectLayer === 'allow',
      approval: { approver },
    });
  };

  const ensureRuntime = async (): Promise<AgentRuntime> => {
    if (runtime !== undefined) {
      return runtime;
    }
    await startup();
    if (runtime === undefined) {
      throw new Error('运行时未就绪');
    }
    return runtime;
  };

  rl.on('SIGINT', () => {
    const decision = decideInterrupt({ running, hasInput: (raw.line ?? '').length > 0 });
    if (decision === 'abort') {
      activeRun?.abort();
      io.err('\n(中断中…)');
      return;
    }
    if (decision === 'clear') {
      try {
        raw.write(null, { ctrl: true, name: 'u' });
      } catch {
        // 忽略清行失败
      }
      return;
    }
    rl.close();
  });
  (process.stdin as unknown as NodeJS.EventEmitter).on(
    'keypress',
    (_str: string, key: { name?: string } | undefined) => {
      if (running && key?.name === 'escape') {
        activeRun?.abort();
      }
    },
  );

  try {
    await startup().catch((error: unknown) => {
      io.err(`警告:${describeError(error)}`);
      io.err('(修复配置后直接输入任务即可重试)');
    });

    io.err(`Reins 交互模式${runtime !== undefined ? ` · 会话 ${runtime.session.id}` : ''}`);
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
        io.err(CHAT_HELP_TEXT);
        continue;
      }
      if (command.type === 'session') {
        io.err(runtime !== undefined ? `会话文件:${runtime.session.path}` : '(暂无会话)');
        continue;
      }
      if (command.type === 'status') {
        if (runtime === undefined || currentConfig === undefined) {
          io.err('(尚未就绪:配置未加载)');
        } else {
          const entries = runtime.session.activeBranch().length;
          const mcp =
            runtime.mcp.length === 0
              ? '未配置'
              : runtime.mcp
                  .map((status) => `${status.name}(${status.ok ? `${status.toolCount ?? 0} 工具` : '未连接'})`)
                  .join('、');
          io.err(`会话   ${runtime.session.id} · ${entries} 条记录`);
          io.err(`模型   ${currentConfig.provider}/${currentConfig.model}`);
          io.err(`工作区 ${workspace}`);
          io.err(`审批   ${currentConfig.approval} · 沙箱 ${currentConfig.sandbox}`);
          io.err(`MCP    ${mcp}`);
          io.err(`文件   ${runtime.session.path}`);
        }
        continue;
      }
      if (command.type === 'mcp') {
        if (runtime === undefined) {
          io.err('(尚未就绪)');
        } else if (runtime.mcp.length === 0) {
          io.err('未配置 MCP 服务器(见 config.toml 的 [mcp_servers])。');
        } else {
          for (const status of runtime.mcp) {
            io.err(
              status.ok
                ? `  √ ${status.name} · ${status.toolCount ?? 0} 个工具`
                : `  × ${status.name} · ${status.error ?? '未知原因'}`,
            );
          }
        }
        continue;
      }
      if (command.type === 'new') {
        try {
          await rebuild({ freshSession: true });
          io.err(`已开始新会话:${runtime?.session.id}`);
        } catch (error) {
          io.err(`错误:${describeError(error)}`);
        }
        continue;
      }
      if (command.type === 'compact') {
        if (runtime === undefined) {
          io.err('(尚未就绪)');
          continue;
        }
        try {
          const done = await runtime.agent.compact();
          if (!done) {
            io.err('当前没有可压缩的内容。');
          }
        } catch (error) {
          io.err(`错误:${describeError(error)}`);
        }
        continue;
      }
      if (command.type === 'model') {
        if (catalog === undefined) {
          io.err('(尚未就绪:产商目录未加载)');
          continue;
        }
        if (command.target === undefined) {
          for (const [name, spec] of Object.entries(catalog.providers)) {
            for (const model of spec.models) {
              const mark = currentConfig?.provider === name && currentConfig.model === model.id ? ' *' : '';
              io.err(`  ${name}/${model.id}${mark}`);
            }
          }
          io.err('用法:/model <provider/model-id>');
          continue;
        }
        const target = findModelTarget(catalog, command.target);
        if (target.kind === 'found') {
          try {
            await rebuild({ provider: target.provider, model: target.modelId });
            io.err(`已切换模型:${target.provider}/${target.modelId}`);
          } catch (error) {
            io.err(`错误:${describeError(error)}`);
          }
        } else if (target.kind === 'ambiguous') {
          io.err('匹配到多个模型,请带上 provider:');
          for (const option of target.options) {
            io.err(`  ${option.provider}/${option.modelId}`);
          }
        } else {
          io.err(`未找到模型:${command.target}(用 /model 查看可选)`);
        }
        continue;
      }
      if (command.type === 'resume') {
        if (command.id === undefined) {
          const summaries = await listSessionSummaries(home);
          if (summaries.length === 0) {
            io.err('还没有任何会话。');
          }
          for (const summary of summaries.slice(0, 10)) {
            io.err(`  ${summary.sessionId}  ${summary.createdAt.replace('T', ' ').slice(0, 19)}  ${summary.preview}`);
          }
          io.err('用法:/resume <会话 id>(或 reins resume 恢复最近一次)');
          continue;
        }
        try {
          await rebuild({ sessionFile: await resolveSessionFile(home, command.id) });
          io.err(`已恢复会话:${runtime?.session.id}`);
        } catch (error) {
          io.err(`错误:${describeError(error)}`);
        }
        continue;
      }

      // 普通任务
      running = true;
      const controller = new AbortController();
      activeRun = controller;
      try {
        const active = await ensureRuntime();
        const result = await active.agent.run(command.text, { signal: controller.signal });
        io.err(`\n· ${result.turns} 轮 · ${formatUsage(result.usage, undefined)}`);
      } catch (error) {
        if (controller.signal.aborted) {
          io.err('\n(已中断)');
        } else {
          io.err(`错误:${describeError(error)}`);
          io.err('(修复配置后直接输入任务即可重试)');
        }
      } finally {
        running = false;
        activeRun = undefined;
      }
    }
    return 0;
  } finally {
    rl.close();
    await runtime?.close();
  }
}

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
import { latestSessionFile, listSessionSummaries, resolveSessionFile } from './sessions.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/**
 * chat 子命令:交互式会话。
 *
 * 设计意图:一个运行时承载多轮对话;斜杠命令与快捷键对齐主流 agent 的
 * 共同约定,降低切换成本;启动时不因配置问题退出,只警告并在输入任务时重试。
 */

export type ChatCommand =
  | { type: 'exit' }
  | { type: 'help' }
  | { type: 'session' }
  | { type: 'status' }
  | { type: 'new' }
  | { type: 'compact' }
  | { type: 'mcp' }
  | { type: 'model'; target: string | undefined }
  | { type: 'resume'; id: string | undefined }
  | { type: 'empty' }
  | { type: 'prompt'; text: string };

/** 可补全的斜杠命令集合。 */
export const CHAT_COMMANDS: readonly string[] = [
  '/clear',
  '/compact',
  '/exit',
  '/help',
  '/mcp',
  '/model',
  '/new',
  '/quit',
  '/resume',
  '/session',
  '/sessions',
  '/status',
];

/** 解析一行输入:斜杠命令或普通任务文本(未知斜杠按普通文本处理)。 */
export function parseChatCommand(input: string): ChatCommand {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { type: 'empty' };
  }
  if (!trimmed.startsWith('/')) {
    return { type: 'prompt', text: trimmed };
  }
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim() === '' ? undefined : rest.join(' ').trim();
  switch ((name ?? '').toLowerCase()) {
    case 'exit':
    case 'quit':
      return { type: 'exit' };
    case 'help':
    case 'hotkeys':
      return { type: 'help' };
    case 'session':
      return { type: 'session' };
    case 'status':
      return { type: 'status' };
    case 'new':
    case 'clear':
      return { type: 'new' };
    case 'compact':
      return { type: 'compact' };
    case 'mcp':
    case 'mcps':
      return { type: 'mcp' };
    case 'model':
    case 'm':
      return { type: 'model', target: arg };
    case 'resume':
    case 'sessions':
      return { type: 'resume', id: arg };
    default:
      return { type: 'prompt', text: trimmed };
  }
}

/** 补全斜杠命令;非斜杠输入不补全。 */
export function completeChatInput(line: string): [string[], string] {
  if (!line.startsWith('/') || line.includes(' ')) {
    return [[], line];
  }
  const matches = CHAT_COMMANDS.filter((command) => command.startsWith(line));
  return [matches, line];
}

/** 中断决策:运行中优先中断,空闲时先清空输入,空行再退出。 */
export function decideInterrupt(state: { running: boolean; hasInput: boolean }): 'abort' | 'clear' | 'exit' {
  if (state.running) {
    return 'abort';
  }
  if (state.hasInput) {
    return 'clear';
  }
  return 'exit';
}

const HELP_TEXT = [
  '/help                 显示帮助',
  '/new(/clear)          开始新会话',
  '/model [provider/model-id]  查看或切换模型',
  '/compact              立即压缩上下文',
  '/status               显示会话与模型状态',
  '/mcp(/mcps)           显示 MCP 服务器状态',
  '/resume(/sessions) [会话 id]  恢复会话;无 id 时列出',
  '/session              显示当前会话文件',
  '/exit(/quit)          退出',
  '',
  '快捷键:↑/↓ 历史 · Tab 补全 · Ctrl+C/Esc 中断 · 空行 Ctrl+D 退出',
].join('\n');

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

  // 启动时自动补全配置文件(缺失则创建模板;已存在的不动)
  const ensured = await ensureHomeConfig(home);
  if (ensured.created.length > 0) {
    io.err(`已创建默认配置:${ensured.created.join('、')}`);
    io.err('提示:请编辑 providers.json 填入你的端点与密钥。');
  }

  // 恢复目标:resume 命令或 --resume 标志
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
    const layered = await loadLayeredConfig({ home, cwd: workspace });
    currentConfig = layered.config;
    catalog = await loadCatalogFile(join(home, 'providers.json'));
    runtime = await createAgentRuntime({
      config: currentConfig,
      catalog,
      workspace,
      home,
      ui,
      sessionFile: resumeFile,
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
    const layered = await loadLayeredConfig({ home, cwd: workspace });
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
        io.err(HELP_TEXT);
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
          const mcp = runtime.mcp.length === 0 ? '未配置' : runtime.mcp.map((s) => `${s.name}(${s.ok ? `${s.toolCount ?? 0} 工具` : '未连接'})`).join('、');
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
            io.err(status.ok ? `  ✓ ${status.name} · ${status.toolCount ?? 0} 个工具` : `  ✗ ${status.name} · ${status.error ?? '未知原因'}`);
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

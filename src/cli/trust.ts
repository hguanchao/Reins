import { createInterface } from 'node:readline/promises';
import { recordTrust, resolveProjectTrust, type TrustResolution } from '../config/trust.ts';
import type { CommandIo } from './args.ts';

/**
 * 命令行侧的信任解析。
 *
 * 与 TUI 的差别只在提问方式:这里用 readline,且诊断类命令(doctor / config)
 * 不提问——它们只报告状态,不该为了看一眼配置而要求授权。
 */

export interface CliTrustOptions {
  home: string;
  workspace: string;
  /** 命令行 --trust:跳过询问并记下信任。 */
  force: boolean;
  /** 是否允许提问;诊断类命令传 false,此时按未信任处理。 */
  allowPrompt: boolean;
  io: CommandIo;
}

/** 解析项目信任;需要时用 readline 提问,结果写回全局 config.toml。 */
export async function resolveTrustForCli(options: CliTrustOptions): Promise<TrustResolution> {
  const interactive = options.allowPrompt && process.stdin.isTTY === true;
  return await resolveProjectTrust({
    home: options.home,
    workspace: options.workspace,
    interactive,
    force: options.force,
    prompt: askViaReadline,
    record: (pattern) => recordTrust(options.home, pattern),
  });
}

/** 用 readline 问一次:把会被覆盖的项摆出来,让用户知道自己在信任什么。 */
async function askViaReadline(resolution: TrustResolution): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write('\n该项目带有 .reins/config.toml,会覆盖全局配置:\n');
    for (const row of resolution.overrides) {
      process.stderr.write(`  ${row.label}  ${row.detail}\n`);
    }
    process.stderr.write('不信任时:项目配置与项目级 AGENTS.md 都不生效。\n');
    const answer = await rl.question(`信任 ${resolution.key} 并继续? [y/N] `);
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}

/** 项目层被忽略时给出可读原因与授权方法;被信任时返回 undefined。 */
export function ignoredNotice(resolution: TrustResolution): string | undefined {
  if (resolution.projectAllowed) {
    return undefined;
  }
  const why =
    resolution.reason === 'non-interactive' ? '当前没有可交互终端,按未信任处理' : '该项目未被信任';
  return `${why}:已忽略 .reins/config.toml 与项目级 AGENTS.md。把 ${resolution.key} 加入 ~/.reins/config.toml 的 [trust].trusted 可授权(或用 --trust)。`;
}

/** 一行信任状态,供 config / doctor 这类诊断命令输出。 */
export function trustLine(resolution: TrustResolution): string {
  if (!resolution.projectAllowed) {
    return `信任  项目层未加载(把 ${resolution.key} 加入 ~/.reins/config.toml 的 [trust].trusted 可授权)`;
  }
  return resolution.reason === 'matched'
    ? `信任  项目层已加载(命中 ${resolution.pattern})`
    : '信任  项目层已加载(无会生效的配置)';
}

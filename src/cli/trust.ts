import { createInterface } from 'node:readline/promises';
import { basename } from 'node:path';
import { existingProjectDocs } from '../context/agents-md.ts';
import { recordTrust, resolveProjectTrust, type TrustResolution } from '../config/trust.ts';

/**
 * 命令行侧的目录信任解析。
 *
 * 与 TUI 的差别只在提问方式:这里用 readline,且诊断类命令(doctor / config)
 * 不提问——它们只报告状态,不该为了看一眼配置而要求授权。
 */

export interface CliTrustOptions {
  home: string;
  workspace: string;
  /** 命令行 --trust:跳过询问,先记下信任再执行。 */
  force: boolean;
  /** 是否允许提问;诊断类命令传 false,此时按未信任处理。 */
  allowPrompt: boolean;
}

/** 解析目录信任;需要时用 readline 提问,结果写回全局 config.toml。 */
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

/** 用 readline 问一次:把会被采纳的内容摆出来,让用户知道自己在信任什么。 */
async function askViaReadline(resolution: TrustResolution): Promise<boolean> {
  const docs = await existingProjectDocs(resolution.key);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`\n要信任 ${resolution.key} 吗?该目录的内容会被采纳:\n`);
    if (resolution.overrides.length > 0) {
      process.stderr.write('  覆盖全局配置:\n');
      for (const row of resolution.overrides) {
        process.stderr.write(`    ${row.label}  ${row.detail}\n`);
      }
    }
    if (docs.length > 0) {
      process.stderr.write('  注入项目说明文件:\n');
      for (const doc of docs) {
        process.stderr.write(`    ${basename(doc)}\n`);
      }
    }
    if (resolution.overrides.length === 0 && docs.length === 0) {
      process.stderr.write('  (该目录没有项目层配置,也没有说明文件)\n');
    }
    process.stderr.write('不信任时:只加载全局配置,项目层配置与说明文件都不生效。\n');
    return (await rl.question('信任并继续? [y/N] ')).trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}

/** 未被信任时会被忽略的内容;空列表意味着「未信任不改变任何行为」。 */
async function ignoredItems(resolution: TrustResolution): Promise<string[]> {
  const docs = (await existingProjectDocs(resolution.key)).map((file) => basename(file));
  return [...(resolution.projectConfigFound ? ['.reins/config.toml'] : []), ...docs];
}

/**
 * 有东西真的被忽略时给出可读原因与授权方法。
 *
 * 未信任是陌生目录的常态而非故障,所以只在确实忽略了什么时报警。
 */
export async function ignoredNotice(resolution: TrustResolution): Promise<string | undefined> {
  if (resolution.projectAllowed) {
    return undefined;
  }
  const items = await ignoredItems(resolution);
  if (items.length === 0) {
    return undefined;
  }
  const why =
    resolution.reason === 'non-interactive' ? '当前没有可交互终端,按未信任处理' : '该目录未被信任';
  return `${why}:已忽略 ${items.join('、')},只加载全局配置。把 ${resolution.key} 加入 ~/.reins/config.toml 的 [trust].trusted 可授权(或用 --trust)。`;
}

/** 一行信任状态,供 config / doctor 这类诊断命令输出。 */
export async function trustLine(resolution: TrustResolution): Promise<string> {
  if (!resolution.projectAllowed) {
    const items = await ignoredItems(resolution);
    const impact = items.length > 0 ? `${items.join('、')} 未加载` : '该目录没有项目层配置与说明文件';
    return `信任  未信任该目录(${impact}),只加载全局配置(把 ${resolution.key} 加入 ~/.reins/config.toml 的 [trust].trusted 可授权)`;
  }
  if (resolution.reason === 'matched') {
    return `信任  项目层已加载(命中 ${resolution.pattern})`;
  }
  if (resolution.reason === 'unrecordable') {
    return '信任  项目层已加载($HOME 或盘根不作信任键,按信任处理)';
  }
  return `信任  项目层已加载(本次记下 ${resolution.key})`;
}

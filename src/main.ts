#!/usr/bin/env node
import { parseArgs } from './cli/args.ts';
import { runCommand } from './cli/commands/run.ts';
import { doctorCommand } from './cli/commands/doctor.ts';
import { configCommand } from './cli/commands/config.ts';
import { modelsCommand } from './cli/commands/models.ts';
import { sessionsCommand } from './cli/commands/sessions.ts';
import { initCommand } from './cli/commands/init.ts';
import { describeError, ReinsError } from './util/errors.ts';

/**
 * 进程入口:解析子命令并分发。
 *
 * 约定:业务失败返回非零退出码;可预期的错误只打印一行可读信息,不输出堆栈。
 */

const HELP = [
  'Reins — 可控优先的编程智能体',
  '',
  '用法:',
  '  reins run "任务描述" [--workspace 目录] [--resume 会话 id]     执行一次任务',
  '  reins sessions list [--limit 数量]                            列出历史会话',
  '  reins doctor [--no-network]                                   自检配置与端点连通性',
  '  reins config check|show                                       校验 / 展示解析后的配置',
  '  reins models list [--provider 名称]                           列出产商与模型',
  '  reins init [--force]                                          交互式初始化配置',
  '  reins help                                                    显示帮助',
  '  reins version                                                 显示版本',
  '',
  '环境变量:',
  '  REINS_HOME   覆盖配置目录(默认 ~/.reins)',
].join('\n');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let code = 0;
  try {
    switch (args.command) {
      case 'run':
        code = await runCommand(args);
        break;
      case 'doctor':
        code = await doctorCommand(args);
        break;
      case 'config':
        code = await configCommand(args);
        break;
      case 'models':
        code = await modelsCommand(args);
        break;
      case 'sessions':
        code = await sessionsCommand(args);
        break;
      case 'init':
        code = await initCommand(args);
        break;
      case 'version':
        console.log('reins 0.0.1');
        break;
      case 'help':
        console.log(HELP);
        break;
      default:
        console.error(`未知子命令:${args.command}`);
        console.error(HELP);
        code = 1;
    }
  } catch (error) {
    if (error instanceof ReinsError) {
      console.error(`错误:${error.message}`);
      if (error.hint !== undefined) {
        console.error(`提示:${error.hint}`);
      }
    } else {
      console.error(`错误:${describeError(error)}`);
    }
    code = 1;
  }
  process.exitCode = code;
}

void main();

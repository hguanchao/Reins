import { loadLayeredConfig } from '../../config/layers.ts';
import { absolutize, reinsHome } from '../../util/paths.ts';
import { describeError } from '../../util/errors.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/** config 子命令:check 校验配置,show 打印解析后的最终配置。 */
export async function configCommand(args: ParsedArgs, io: CommandIo = defaultIo): Promise<number> {
  const action = args.positionals[0] ?? 'check';
  const home = reinsHome();
  const workspace =
    typeof args.flags['workspace'] === 'string'
      ? absolutize(args.flags['workspace'])
      : process.cwd();

  if (action === 'check') {
    try {
      const { config, files } = await loadLayeredConfig({ home, cwd: workspace });
      io.out(`配置有效(${files.join('、')})`);
      io.out(`provider=${config.provider} model=${config.model} approval=${config.approval}`);
      return 0;
    } catch (error) {
      io.out(describeError(error));
      return 1;
    }
  }

  if (action === 'show') {
    try {
      const { config } = await loadLayeredConfig({ home, cwd: workspace });
      io.out(JSON.stringify(config, null, 2));
      return 0;
    } catch (error) {
      io.out(describeError(error));
      return 1;
    }
  }

  io.err(`未知子命令:config ${action}(可用:check、show)`);
  return 1;
}

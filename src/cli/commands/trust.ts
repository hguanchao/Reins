import { join } from 'node:path';
import { readTomlFile } from '../../config/load.ts';
import { forgetTrust, readTrustPatterns, recordTrust } from '../../config/trust.ts';
import { describeError } from '../../util/errors.ts';
import { absolutize, reinsHome } from '../../util/paths.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/**
 * trust 子命令:查看、添加、移除被信任的目录。
 *
 * 记录就是全局 config.toml 的 [trust].trusted——与手写配置同一份数据,
 * 这里只是省去手改的麻烦并保证格式正确。加目录时写它的绝对路径。
 */
export async function trustCommand(
  args: ParsedArgs,
  io: CommandIo = defaultIo,
  home = reinsHome(),
): Promise<number> {
  const action = args.positionals[0] ?? 'list';
  const file = join(home, 'config.toml');

  if (action === 'list') {
    try {
      const patterns = readTrustPatterns(await readTomlFile(file));
      if (patterns.length === 0) {
        io.out('尚未信任任何目录。');
        io.out('授权:reins trust add <目录>,或直接编辑 ~/.reins/config.toml 的 [trust].trusted');
        return 0;
      }
      for (const pattern of patterns) {
        io.out(`  ${pattern}`);
      }
      return 0;
    } catch (error) {
      io.err(describeError(error));
      return 1;
    }
  }

  if (action !== 'add' && action !== 'remove') {
    io.err(`未知子命令:trust ${action}(可用:list、add、remove)`);
    return 1;
  }
  const target = args.positionals[1];
  if (target === undefined || target.trim() === '') {
    io.err(`用法:reins trust ${action} <目录>`);
    return 1;
  }
  const pattern = absolutize(target);
  try {
    if (action === 'add') {
      await recordTrust(home, pattern);
      io.out(`已信任:${pattern}`);
    } else {
      await forgetTrust(home, pattern);
      io.out(`已撤销:${pattern}`);
    }
    return 0;
  } catch (error) {
    io.err(describeError(error));
    return 1;
  }
}

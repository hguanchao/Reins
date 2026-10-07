import { join } from 'node:path';
import { loadCatalogFile } from '../../catalog/load.ts';
import { reinsHome } from '../../util/paths.ts';
import { describeError } from '../../util/errors.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/** models 子命令:列出产商与模型。 */
export async function modelsCommand(
  args: ParsedArgs,
  io: CommandIo = defaultIo,
  home = reinsHome(),
): Promise<number> {
  const file = join(home, 'providers.json');
  try {
    const catalog = await loadCatalogFile(file);
    const filter = typeof args.flags['provider'] === 'string' ? args.flags['provider'] : undefined;
    const entries = Object.entries(catalog.providers).filter(
      ([name]) => filter === undefined || name === filter,
    );
    if (entries.length === 0) {
      io.out(filter === undefined ? '产商目录为空。' : `未找到 provider:${filter}`);
      return filter === undefined ? 0 : 1;
    }
    for (const [name, provider] of entries) {
      io.out(`${name}(${provider.api},${provider.baseUrl})`);
      for (const model of provider.models) {
        const suffix = model.contextWindow !== undefined ? ` [ctx ${model.contextWindow}]` : '';
        io.out(`  - ${model.id}${suffix}`);
      }
    }
    return 0;
  } catch (error) {
    io.out(describeError(error));
    return 1;
  }
}

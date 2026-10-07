import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { pathExists, writeTextFile } from '../../util/fsx.ts';
import { reinsHome } from '../../util/paths.ts';
import { defaultIo, type CommandIo, type ParsedArgs } from '../args.ts';

/**
 * init 子命令:交互式生成 providers.json 与 config.toml。
 *
 * 设计意图:零内置产商意味着首跑必须靠配置;向导把这一步压缩到几十秒,
 * 并在终端里明确告知下一步要做什么。
 */
export async function initCommand(
  args: ParsedArgs,
  io: CommandIo = defaultIo,
  home = reinsHome(),
): Promise<number> {
  if (process.stdin.isTTY !== true) {
    io.err('init 需要交互式终端;也可以参考 README 手动创建 providers.json 与 config.toml。');
    return 1;
  }
  const providersFile = join(home, 'providers.json');
  const configFile = join(home, 'config.toml');
  const force = args.flags['force'] === true;
  if (!force && ((await pathExists(providersFile)) || (await pathExists(configFile)))) {
    io.err(`配置已存在(${home});如需覆盖请加 --force。`);
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    io.out('初始化 Reins 配置(回车使用括号内默认值)');
    const name = (await rl.question('provider 名称 [example-openai]: ')).trim() || 'example-openai';
    const baseUrl =
      (await rl.question('baseUrl(OpenAI 兼容端点)[https://api.openai.com/v1]: ')).trim() ||
      'https://api.openai.com/v1';
    const envVar =
      (await rl.question('API key 环境变量名 [OPENAI_API_KEY]: ')).trim() || 'OPENAI_API_KEY';
    const modelIds = (await rl.question('模型 id(逗号分隔)[gpt-5.2]: '))
      .trim()
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const resolvedIds = modelIds.length > 0 ? modelIds : ['gpt-5.2'];
    const contextRaw = (await rl.question('模型上下文窗口(可留空): ')).trim();
    const contextWindow = contextRaw === '' ? undefined : Number(contextRaw);

    const catalog = {
      providers: {
        [name]: {
          baseUrl,
          api: 'openai-completions',
          apiKey: `$${envVar}`,
          models: resolvedIds.map((id) =>
            contextWindow !== undefined && Number.isFinite(contextWindow)
              ? { id, contextWindow }
              : { id },
          ),
        },
      },
    };
    await writeTextFile(providersFile, `${JSON.stringify(catalog, null, 2)}\n`);

    const configToml = [
      `provider = "${name}"`,
      `model = "${resolvedIds[0]}"`,
      '',
      '[permissions]',
      'deny = []',
      'ask = []',
      'allow = []',
      '',
    ].join('\n');
    await writeTextFile(configFile, configToml);

    io.out(`已写入:${providersFile}`);
    io.out(`已写入:${configFile}`);
    io.out(`下一步:设置环境变量 ${envVar},然后运行 reins doctor 验证。`);
    return 0;
  } finally {
    rl.close();
  }
}

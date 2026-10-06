/**
 * 命令行参数解析。
 *
 * 约定:首个普通词是子命令,其余普通词是位置参数;
 * `--key value`、`--key=value` 与 `--key`(布尔)三种形态都支持。
 */

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface CommandIo {
  out(text: string): void;
  err(text: string): void;
}

export const defaultIo: CommandIo = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      flags[token.slice(1)] = true;
      continue;
    }
    if (command === '') {
      command = token;
      continue;
    }
    positionals.push(token);
  }

  if (command === '') {
    command = 'help';
  }
  return { command, positionals, flags };
}

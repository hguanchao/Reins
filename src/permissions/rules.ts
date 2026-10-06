import { ConfigError } from '../util/errors.ts';
import { absolutize, expandHome } from '../util/paths.ts';

/**
 * 权限规则解析。
 *
 * 设计意图:用户用一眼可读的文本表达规则——`bash(rm *)`、`read(~/.ssh/**)`、
 * `mcp(context7)`、`web_fetch(domain:*.internal.example)`。
 * 匹配语义按工具类型区分:命令按 shell 通配、路径按文件通配(并支持对文件名兜底)、
 * 域名不区分大小写。
 */

/** 一次工具调用提取出的可匹配特征。 */
export interface RuleTarget {
  tool: string;
  command?: string;
  path?: string;
  domain?: string;
  server?: string;
}

export interface ParsedRule {
  raw: string;
  tool: string;
  pattern: string;
  match(target: RuleTarget): boolean;
}

/** 路径类工具集合。 */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep']);

/** 是否为受支持的规则工具名。 */
export const RULE_TOOLS: readonly string[] = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'web_fetch',
  'mcp',
];

/** 解析一条规则文本;格式非法时抛出配置错误。 */
export function parseRule(raw: string): ParsedRule {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*(.*?)\s*\))?$/.exec(raw.trim());
  if (!match) {
    throw new ConfigError(
      `权限规则格式不合法:"${raw}"`,
      '形如 bash(rm *)、read(~/.ssh/**)、mcp(context7)、web_fetch(domain:*.example.com)。',
    );
  }
  const tool = match[1] as string;
  const pattern = match[2] ?? '';

  return {
    raw,
    tool,
    pattern,
    match(target: RuleTarget): boolean {
      if (target.tool !== tool) {
        return false;
      }
      if (pattern === '') {
        return true;
      }
      if (tool === 'bash') {
        return target.command !== undefined && shellGlobMatch(pattern, target.command);
      }
      if (PATH_TOOLS.has(tool)) {
        return target.path !== undefined && pathGlobMatch(pattern, target.path);
      }
      if (tool === 'web_fetch') {
        const domainPattern = pattern.startsWith('domain:') ? pattern.slice('domain:'.length) : pattern;
        return target.domain !== undefined && shellGlobMatch(domainPattern, target.domain, true);
      }
      if (tool === 'mcp') {
        return target.server !== undefined && shellGlobMatch(pattern, target.server);
      }
      const candidate = target.command ?? target.path ?? target.server ?? target.domain;
      return candidate !== undefined && shellGlobMatch(pattern, candidate);
    },
  };
}

/** shell 风格通配:`*` 匹配任意字符(含分隔符),`?` 匹配单字符。 */
export function shellGlobMatch(pattern: string, value: string, caseInsensitive = false): boolean {
  const regex = globToRegExp(pattern, { crossSeparator: true, caseInsensitive });
  return regex.test(value);
}

/** 路径风格通配:`*` 不跨分隔符,`**` 跨分隔符;支持 ~ 展开与文件名兜底匹配。 */
export function pathGlobMatch(pattern: string, value: string): boolean {
  const expanded = normalizeSlashes(expandHome(pattern));
  const target = normalizeSlashes(absolutize(value));
  const caseInsensitive = process.platform === 'win32';
  const regex = globToRegExp(expanded, { crossSeparator: false, caseInsensitive });
  if (!expanded.includes('/')) {
    // 不含路径分隔符的模式视为文件名匹配,例如 *.env 命中任意目录下的 .env
    const base = target.slice(target.lastIndexOf('/') + 1);
    return regex.test(base);
  }
  if (isAbsoluteLike(expanded)) {
    return regex.test(target);
  }
  // 相对路径模式对目标逐段做后缀匹配:src/*.ts 命中 <任意前缀>/src/a.ts,
  // 但不跨目录(src/deep/a.ts 不命中)
  return matchAnySuffix(target, regex);
}

function isAbsoluteLike(pattern: string): boolean {
  return pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern);
}

function matchAnySuffix(target: string, regex: RegExp): boolean {
  let index = 0;
  for (;;) {
    if (regex.test(target.slice(index))) {
      return true;
    }
    const next = target.indexOf('/', index + 1);
    if (next === -1) {
      return false;
    }
    index = next + 1;
  }
}

function globToRegExp(
  pattern: string,
  options: { crossSeparator: boolean; caseInsensitive: boolean },
): RegExp {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (!options.crossSeparator && pattern[index + 1] === '*') {
        out += '.*';
        index += 1;
        continue;
      }
      const isLast = index === pattern.length - 1;
      if (options.crossSeparator && isLast && out.endsWith(' ')) {
        // 末尾的 " *" 表示「可带任意参数」:不带参数(无空格)同样命中
        out = `${out.slice(0, -1)}(?: .*)?`;
        continue;
      }
      out += options.crossSeparator ? '.*' : '[^/]*';
      continue;
    }
    if (char === '?') {
      out += options.crossSeparator ? '.' : '[^/]';
      continue;
    }
    out += escapeRegExpChar(char);
  }
  out += '$';
  return new RegExp(out, options.caseInsensitive ? 'i' : '');
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

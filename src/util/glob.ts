/**
 * 通配匹配原语。
 *
 * 设计意图:shell 风格与路径风格是两套语义,集中在此供工具与权限共用;
 * 只做纯字符串匹配,不接触文件系统,便于测试与推理。
 */

export interface GlobOptions {
  /** true:shell 风格(`*` 跨分隔符);false:路径风格(`*` 不跨,`**` 跨)。 */
  crossSeparator: boolean;
  caseInsensitive?: boolean;
}

/** 把通配模式编译为正则(锚定整串)。 */
export function globToRegExp(pattern: string, options: GlobOptions): RegExp {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (options.crossSeparator) {
        const isLast = index === pattern.length - 1;
        if (isLast && out.endsWith(' ')) {
          // 末尾的 " *" 表示「可带任意参数」:不带参数(无空格)同样命中
          out = `${out.slice(0, -1)}(?: .*)?`;
          continue;
        }
        out += '.*';
        continue;
      }
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          // **/ 匹配零个或多个路径段,例如 src/**/*.ts 命中 src/a.ts
          out += '(?:.*/)?';
          index += 2;
          continue;
        }
        out += '.*';
        index += 1;
        continue;
      }
      out += '[^/]*';
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

/** shell 风格匹配:命令、域名、server 名等。 */
export function shellGlobMatch(pattern: string, value: string, caseInsensitive = false): boolean {
  return globToRegExp(pattern, { crossSeparator: true, caseInsensitive }).test(value);
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

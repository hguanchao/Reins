import { parse as parseToml } from 'smol-toml';
import { ConfigError } from '../util/errors.ts';

/**
 * 定点编辑全局 config.toml 的 [trust].trusted。
 *
 * 设计意图:Reins 只有解析器、没有保格式的 TOML 写入器,而 config.toml 是用户手写
 * 并带注释的文件——整体序列化会把注释与排版一并抹掉。所以取值交给解析器(可靠),
 * 只用手工文本定位改动那一处,其余逐字节不动。
 */

const SECTION_HEADER = /^\s*\[\s*([^\]]*?)\s*\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const TRUSTED_KEY = /^\s*trusted\s*=\s*(.*)$/;
const ARRAY_CLOSE = /^\s*\]\s*,?\s*(?:#.*)?$/;
const INLINE_TRUST = /^\s*trust\s*=/;

/** 序列化为 TOML 字符串:路径优先用字面串,免去反斜杠转义。 */
export function tomlString(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 解析数组项行里的字符串字面量;不是字符串项时返回 undefined。 */
function parseStringItem(line: string): string | undefined {
  const literal = /^\s*'([^']*)'\s*,?\s*(?:#.*)?$/.exec(line);
  if (literal !== null) {
    return literal[1];
  }
  const basic = /^\s*"((?:[^"\\]|\\.)*)"\s*,?\s*(?:#.*)?$/.exec(line);
  if (basic === null) {
    return undefined;
  }
  // 只需还原路径里会出现的两种转义,其余原样保留
  return (basic[1] ?? '').replace(/\\(["\\])/g, '$1');
}

/** 段头里的键名去掉包裹引号。 */
function normalizeKey(raw: string): string {
  const trimmed = raw.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

interface Section {
  header: number;
  end: number;
}

/** 定位 [trust] 段:段头行与段体结束行(不含)。 */
function findSection(lines: readonly string[]): Section | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const match = SECTION_HEADER.exec(lines[index] ?? '');
    if (match === null || normalizeKey(match[1] ?? '') !== 'trust') {
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !ANY_HEADER.test(lines[end] ?? '')) {
      end += 1;
    }
    return { header: index, end };
  }
  return undefined;
}

interface TrustedValue {
  /** `trusted` 键所在行;段内没有这个键时为 -1。 */
  keyLine: number;
  /** 值的结束行(不含);单行时等于 keyLine + 1。 */
  valueEnd: number;
  multiline: boolean;
}

/** 在段内定位 trusted 的赋值区间。 */
function findTrusted(lines: readonly string[], section: Section): TrustedValue {
  for (let index = section.header + 1; index < section.end; index += 1) {
    const match = TRUSTED_KEY.exec(lines[index] ?? '');
    if (match === null) {
      continue;
    }
    const inline = (match[1] ?? '').trim();
    if (inline.startsWith('[') && !inline.includes(']')) {
      let close = index + 1;
      while (close < section.end && !ARRAY_CLOSE.test(lines[close] ?? '')) {
        close += 1;
      }
      return { keyLine: index, valueEnd: close + 1, multiline: true };
    }
    return { keyLine: index, valueEnd: index + 1, multiline: false };
  }
  return { keyLine: -1, valueEnd: -1, multiline: false };
}

/** 读出当前的 trusted 列表;结构不合法时报出可读错误。 */
function readTrusted(text: string): { section?: Section; items: string[] } {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`config.toml 解析失败,无法写入信任记录:${detail}`, '请先修正 TOML 语法。');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('config.toml 的顶层结构应为键值表,无法写入信任记录');
  }
  const trust = (raw as Record<string, unknown>)['trust'];
  if (trust === undefined) {
    return { items: [] };
  }
  if (typeof trust !== 'object' || trust === null || Array.isArray(trust)) {
    throw new ConfigError(
      '[trust] 应为配置节,无法写入信任记录',
      '请把它写成 [trust] 段,而不是内联表或数组。',
    );
  }
  const trusted = (trust as Record<string, unknown>)['trusted'];
  if (trusted === undefined) {
    return { items: [] };
  }
  if (!Array.isArray(trusted) || trusted.some((item) => typeof item !== 'string')) {
    throw new ConfigError(
      '[trust].trusted 应为字符串数组',
      '形如 trusted = ["~/work/**", "E:/Projects/Reins"]。',
    );
  }
  return { items: trusted as string[] };
}

interface Split {
  lines: string[];
  eol: string;
  trailing: boolean;
}

function splitLines(text: string): Split {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (trailing) {
    lines.pop();
  }
  return { lines, eol, trailing };
}

function joinLines(split: Split, lines: readonly string[]): string {
  const body = lines.join(split.eol);
  return split.trailing || lines.length === 0 ? `${body}${split.eol}` : body;
}

/** 确保 [trust] 段与 trusted 键存在,返回可写入的行数组与赋值区间。 */
function ensureTrusted(text: string, items: readonly string[]): { split: Split; lines: string[]; value: TrustedValue } {
  const split = splitLines(text);
  const lines = [...split.lines];
  // 顶层写成内联表时无法追加段头(会撞 TOML 重复键),直接报错让用户手改;
  // 只扫第一个段头之前的部分,避免误伤其他段里的同名键
  const firstHeader = lines.findIndex((line) => ANY_HEADER.test(line));
  const topLevel = firstHeader === -1 ? lines : lines.slice(0, firstHeader);
  if (topLevel.some((line) => INLINE_TRUST.test(line))) {
    throw new ConfigError(
      'config.toml 把 trust 写成了内联表,无法定点写入',
      '请改成 [trust] 段后重试。',
    );
  }
  let section = findSection(lines);
  if (section === undefined) {
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') {
      lines.push('');
    }
    lines.push('[trust]', `trusted = [${items.map(tomlString).join(', ')}]`);
    section = { header: lines.length - 2, end: lines.length };
    return { split, lines, value: { keyLine: lines.length - 1, valueEnd: lines.length, multiline: false } };
  }
  const value = findTrusted(lines, section);
  if (value.keyLine === -1) {
    lines.splice(section.header + 1, 0, `trusted = [${items.map(tomlString).join(', ')}]`);
    return {
      split,
      lines,
      value: { keyLine: section.header + 1, valueEnd: section.header + 2, multiline: false },
    };
  }
  return { split, lines, value };
}

/** 把路径加入 [trust].trusted;已存在时原样返回。 */
export function addTrustPattern(text: string, pattern: string): string {
  const current = readTrusted(text);
  if (current.items.includes(pattern)) {
    return text;
  }
  const next = [...current.items, pattern];
  const { split, lines, value } = ensureTrusted(text, next);
  if (value.multiline) {
    // 保留用户的多行风格,只在收尾 ] 前插一行
    lines.splice(value.valueEnd - 1, 0, `  ${tomlString(pattern)},`);
    return joinLines(split, lines);
  }
  lines.splice(value.keyLine, value.valueEnd - value.keyLine, `trusted = [${next.map(tomlString).join(', ')}]`);
  return joinLines(split, lines);
}

/** 从 [trust].trusted 移除;不存在时原样返回。 */
export function removeTrustPattern(text: string, pattern: string): string {
  const current = readTrusted(text);
  if (!current.items.includes(pattern)) {
    return text;
  }
  const next = current.items.filter((item) => item !== pattern);
  const { split, lines, value } = ensureTrusted(text, next);
  if (value.multiline) {
    const index = lines.findIndex(
      (line, position) => position > value.keyLine && position < value.valueEnd - 1 && parseStringItem(line) === pattern,
    );
    if (index !== -1) {
      lines.splice(index, 1);
      return joinLines(split, lines);
    }
  }
  lines.splice(value.keyLine, value.valueEnd - value.keyLine, `trusted = [${next.map(tomlString).join(', ')}]`);
  return joinLines(split, lines);
}

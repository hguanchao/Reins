import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathExists, readTextFile, writeTextFile } from '../util/fsx.ts';
import { globToRegExp } from '../util/glob.ts';
import { absolutize, expandHome, normalizeSlashes } from '../util/paths.ts';
import { readTomlFile } from './load.ts';
import { addTrustPattern, removeTrustPattern } from './trust-edit.ts';

/**
 * 项目信任:判定是否加载项目层配置与项目级文档。
 *
 * 设计意图:项目目录里的 .reins/config.toml 能覆盖审批、沙箱、权限与 MCP——
 * 克隆一个仓库就等于让仓库决定这些。所以它必须先被信任:判定是纯函数,
 * 记录放在全局 config.toml 的 [trust].trusted(路径模式数组)。
 */

/** 判定依据,用于提示与审计。 */
export type TrustReason =
  | 'matched'
  | 'recorded'
  | 'no-config'
  | 'unrecordable'
  | 'non-interactive'
  | 'declined';

export interface TrustInputs {
  /** 命中 [trust].trusted 中的某个模式。 */
  patternMatched: boolean;
  /** 项目目录能否作为信任键记录(非 $HOME／文件系统根)。 */
  keyRecordable: boolean;
  /** 项目层是否有会生效的键。 */
  projectConfigPresent: boolean;
  /** 是否有可交互终端。 */
  interactive: boolean;
}

/**
 * 信任判定。优先级照 grok-build:
 *
 * 1. 命中 trusted 模式 → 信任。
 * 2. 键不可记录($HOME／文件系统根)→ 信任:存不下来的键若门控会永远重复询问;
 *    而且 cwd 就是 $HOME 时,项目层文件恰好就是全局配置本身,合并等于没合并。
 * 3. 项目层没有会生效的键 → 信任:没有东西需要信任。
 * 4. 交互终端 → 询问。
 * 5. 否则(无 TTY)→ 未信任。
 *
 * 第 2、3 条是临时结论,调用方**不得缓存**:配置可能在这次判定之后才出现
 * (git pull、或代理写入),缓存会让它绕过信任。
 */
export function decideTrust(inputs: TrustInputs): 'trusted' | 'untrusted' | 'prompt' {
  if (inputs.patternMatched || !inputs.keyRecordable || !inputs.projectConfigPresent) {
    return 'trusted';
  }
  return inputs.interactive ? 'prompt' : 'untrusted';
}

/**
 * 信任模式是否命中项目目录。
 *
 * 与权限规则的路径匹配有意不同:不做「不含分隔符就按文件名匹配任意目录」的回退——
 * 那对权限合理,对信任太松(trusted = ["Reins"] 会信任任何叫 Reins 的文件夹)。
 * 另外以 /** 结尾的模式同时命中该目录本身,否则「信任 work 下所有项目」会漏掉 work 自己。
 */
export function trustPatternMatch(pattern: string, projectDir: string): boolean {
  const expanded = normalizeSlashes(expandHome(pattern.trim()));
  const target = normalizeSlashes(absolutize(projectDir));
  const options = { crossSeparator: false, caseInsensitive: process.platform === 'win32' };
  if (globToRegExp(expanded, options).test(target)) {
    return true;
  }
  return expanded.endsWith('/**') && globToRegExp(expanded.slice(0, -3), options).test(target);
}

/** $HOME 与文件系统根不能作为信任键:覆盖过宽,存下来等于信任一切。 */
export function isRecordableRoot(projectDir: string): boolean {
  const dir = stripTrailingSlash(normalizeSlashes(absolutize(projectDir)));
  const home = stripTrailingSlash(normalizeSlashes(homedir()));
  const same = process.platform === 'win32' ? dir.toLowerCase() === home.toLowerCase() : dir === home;
  if (same) {
    return false;
  }
  return dir !== '' && dir !== '/' && !/^[A-Za-z]:$/.test(dir);
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/**
 * 项目层是否含有会生效的键。
 *
 * 空数组与空表不算(permissions.deny = [] 这类空配置不该触发询问);解析失败由调用方
 * 按「有」处理——畸形配置同样是仓库可控内容,应当 fail-closed。
 */
export function projectLayerHasContent(raw: Record<string, unknown>): boolean {
  return Object.values(raw).some(isEffectiveValue);
}

function isEffectiveValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(isEffectiveValue);
  }
  return true;
}

/** 从全局配置里读出信任模式列表;结构不对时返回空。 */
export function readTrustPatterns(globalRaw: Record<string, unknown>): string[] {
  const trust = globalRaw['trust'];
  if (typeof trust !== 'object' || trust === null || Array.isArray(trust)) {
    return [];
  }
  const trusted = (trust as Record<string, unknown>)['trusted'];
  return Array.isArray(trusted) ? trusted.filter((item): item is string => typeof item === 'string') : [];
}

/** 信任页上的一行覆盖项。 */
export interface OverrideRow {
  label: string;
  detail: string;
}

/** 安全相关键与中文标签,按此顺序列出。 */
const OVERRIDE_KEYS: readonly (readonly [string, string])[] = [
  ['approval', '审批模式'],
  ['sandbox', '沙箱'],
  ['permissions', '权限规则'],
  ['mcp_servers', 'MCP 服务器'],
  ['proxy', '出站代理'],
  ['review_model', '审查模型'],
  ['provider', '模型端点'],
  ['model', '模型'],
];

/** 未声明时的有效默认值,写出来比「未设置」更接近真实后果。 */
const DEFAULTS: Readonly<Record<string, string>> = {
  approval: 'ask(默认)',
  sandbox: 'off(默认)',
};

/**
 * 列出项目层会覆盖的项,供信任页展示。
 *
 * 只列**真的会变**的:信任页要回答「我在信任什么」,把 off → off 这种原样重写
 * 也列出来是噪音。安全相关键逐条给「全局 → 项目层」,其余键归为一句计数。
 */
export function describeOverrides(
  globalRaw: Record<string, unknown>,
  projectRaw: Record<string, unknown>,
): OverrideRow[] {
  const rows: OverrideRow[] = [];
  const covered = new Set<string>();
  for (const [key, label] of OVERRIDE_KEYS) {
    if (!(key in projectRaw)) {
      continue;
    }
    covered.add(key);
    const detail = describeKey(key, globalRaw[key], projectRaw[key]);
    if (detail !== undefined) {
      rows.push({ label, detail });
    }
  }
  const others = Object.keys(projectRaw).filter(
    (key) => !covered.has(key) && isEffectiveValue(projectRaw[key]),
  );
  if (others.length > 0) {
    rows.push({ label: '其他', detail: `${others.length} 项(界面、上下文等)` });
  }
  return rows;
}

/** 返回这一项的「全局 → 项目层」描述;没有实际变化时返回 undefined。 */
function describeKey(key: string, before: unknown, after: unknown): string | undefined {
  if (key === 'permissions') {
    return describePermissions(before, after);
  }
  if (key === 'mcp_servers') {
    return describeMcp(before, after);
  }
  const from = scalar(before, key);
  const to = scalar(after, key);
  return from === to ? undefined : `${from} → ${to}`;
}

function scalar(value: unknown, key: string): string {
  if (value === undefined) {
    return DEFAULTS[key] ?? '(未设置)';
  }
  if (typeof value === 'string') {
    return value === '' ? '(空)' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '(已设置)';
}

/** 权限规则按三个列表的条数变化描述;没有变化时返回 undefined。 */
function describePermissions(before: unknown, after: unknown): string | undefined {
  const changes: string[] = [];
  for (const name of ['deny', 'ask', 'allow']) {
    const from = ruleCount(before, name);
    const to = ruleCount(after, name);
    if (from !== to) {
      changes.push(`${name} ${from} 条 → ${to} 条`);
    }
  }
  return changes.length > 0 ? changes.join(' · ') : undefined;
}

function ruleCount(value: unknown, name: string): number {
  if (typeof value !== 'object' || value === null) {
    return 0;
  }
  const list = (value as Record<string, unknown>)[name];
  return Array.isArray(list) ? list.length : 0;
}

/** MCP 服务器按新增/改写计数;stdio 型会被真实拉起,必须点明。没有变化时返回 undefined。 */
function describeMcp(before: unknown, after: unknown): string | undefined {
  const beforeKeys = new Set(objectKeys(before));
  const afterKeys = objectKeys(after);
  const added = afterKeys.filter((key) => !beforeKeys.has(key)).length;
  const changed = afterKeys.filter(
    (key) => beforeKeys.has(key) && JSON.stringify(readKey(before, key)) !== JSON.stringify(readKey(after, key)),
  ).length;
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`新增 ${added} 个`);
  }
  if (changed > 0) {
    parts.push(`改写 ${changed} 个`);
  }
  return parts.length > 0 ? `${parts.join(' · ')}(会执行其声明的命令)` : undefined;
}

function objectKeys(value: unknown): string[] {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
}

function readKey(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** 判定结果。 */
export interface TrustResolution {
  /** 项目层是否可用。 */
  projectAllowed: boolean;
  reason: TrustReason;
  /** 命中的模式,或本次记下的路径。 */
  pattern?: string;
  /** 信任键(项目目录绝对路径)。 */
  key: string;
  /** 供信任页展示的覆盖清单。 */
  overrides: OverrideRow[];
}

export interface ResolveTrustOptions {
  home: string;
  workspace: string;
  interactive: boolean;
  /** 命令行 --trust:跳过询问,先记下信任再执行。 */
  force?: boolean;
  /** 需要询问时调用;返回用户是否信任。 */
  prompt?: (resolution: TrustResolution) => Promise<boolean>;
  /** 写入信任记录;省略时只信任本次(不持久化)。 */
  record?: (pattern: string) => Promise<void>;
}

/** 读取全局配置(只为拿信任表与覆盖基线);缺失或损坏时按空处理。 */
async function readGlobalRaw(home: string): Promise<Record<string, unknown>> {
  try {
    return await readTomlFile(join(home, 'config.toml'));
  } catch {
    return {};
  }
}

interface ProjectLayer {
  present: boolean;
  raw: Record<string, unknown>;
  malformed: boolean;
}

/** 读取项目层配置;解析失败也视为「存在」,由调用方 fail-closed。 */
async function readProjectLayer(file: string): Promise<ProjectLayer> {
  if (!(await pathExists(file))) {
    return { present: false, raw: {}, malformed: false };
  }
  try {
    return { present: true, raw: await readTomlFile(file), malformed: false };
  } catch {
    return { present: true, raw: {}, malformed: true };
  }
}

/**
 * 解析项目信任:读全局信任表 → 判定 → 必要时询问 → 记录。
 *
 * 临时结论(no-config / unrecordable)每次重新判定,不做任何缓存。
 */
export async function resolveProjectTrust(options: ResolveTrustOptions): Promise<TrustResolution> {
  const key = absolutize(options.workspace);
  const globalRaw = await readGlobalRaw(options.home);
  const layer = await readProjectLayer(join(key, '.reins', 'config.toml'));
  const overrides: OverrideRow[] = layer.malformed
    ? [{ label: '项目配置', detail: '解析失败,按「有配置」处理' }]
    : describeOverrides(globalRaw, layer.raw);
  const projectConfigPresent = layer.malformed || (layer.present && projectLayerHasContent(layer.raw));
  const keyRecordable = isRecordableRoot(key);
  const matched = readTrustPatterns(globalRaw).find((pattern) => trustPatternMatch(pattern, key));
  const base: TrustResolution = {
    projectAllowed: false,
    reason: 'non-interactive',
    key,
    overrides,
  };

  if (options.force === true && keyRecordable) {
    await options.record?.(key);
    return { ...base, projectAllowed: true, reason: 'recorded', pattern: key };
  }

  const outcome = decideTrust({
    patternMatched: matched !== undefined,
    keyRecordable,
    projectConfigPresent,
    interactive: options.interactive,
  });
  if (outcome === 'trusted') {
    return {
      ...base,
      projectAllowed: true,
      reason: matched !== undefined ? 'matched' : keyRecordable ? 'no-config' : 'unrecordable',
      pattern: matched,
    };
  }
  if (outcome === 'untrusted') {
    return base;
  }
  const accepted = (await options.prompt?.(base)) ?? false;
  if (!accepted) {
    return { ...base, reason: 'declined' };
  }
  await options.record?.(key);
  return { ...base, projectAllowed: true, reason: 'recorded', pattern: key };
}

/** 把路径写进全局 config.toml 的 [trust].trusted。 */
export async function recordTrust(home: string, pattern: string): Promise<void> {
  const file = join(home, 'config.toml');
  await writeTextFile(file, addTrustPattern(await readTextFile(file), pattern));
}

/** 从全局 config.toml 的 [trust].trusted 移除路径。 */
export async function forgetTrust(home: string, pattern: string): Promise<void> {
  const file = join(home, 'config.toml');
  await writeTextFile(file, removeTrustPattern(await readTextFile(file), pattern));
}

import { join } from 'node:path';
import { isFile, readTextFile } from '../util/fsx.ts';

/**
 * 项目文档发现:工作区根目录的 REINS.md 优先,其次 AGENTS.md。
 *
 * 设计意图:把团队约定注入系统提示词,让模型先读后改;
 * 文档过长时截断,避免挤占上下文。
 */

export interface ProjectDoc {
  path: string;
  content: string;
}

const DOC_CANDIDATES: readonly string[] = ['REINS.md', 'AGENTS.md'];
const DEFAULT_MAX_CHARS = 60_000;

export interface DiscoverOptions {
  maxChars?: number;
}

/**
 * 列出目录里存在的说明文件(绝对路径),保持优先级顺序。
 *
 * 信任页要用它回答「信任这个目录会往里注入什么」——只看文件名,不读内容。
 */
export async function existingProjectDocs(workspace: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of DOC_CANDIDATES) {
    const file = join(workspace, name);
    if (await isFile(file)) {
      found.push(file);
    }
  }
  return found;
}

export async function discoverProjectDoc(
  workspace: string,
  options: DiscoverOptions = {},
): Promise<ProjectDoc | null> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  for (const name of DOC_CANDIDATES) {
    const file = join(workspace, name);
    if (!(await isFile(file))) {
      continue;
    }
    let content = await readTextFile(file);
    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n\n(文档过长,已截断)`;
    }
    return { path: file, content };
  }
  return null;
}

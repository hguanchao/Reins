import { ToolRegistry } from './registry.ts';
import { ReadTool } from './read.ts';
import { WriteTool } from './write.ts';
import { EditTool } from './edit.ts';
import { BashTool } from './bash.ts';
import { GrepTool } from './grep.ts';
import { GlobTool } from './glob.ts';

/** 组装默认工具集;新增工具只需在此登记。 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadTool());
  registry.register(new WriteTool());
  registry.register(new EditTool());
  registry.register(new BashTool());
  registry.register(new GrepTool());
  registry.register(new GlobTool());
  return registry;
}

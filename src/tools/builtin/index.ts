import type { AnyToolDefinition } from "../contract.ts";
import { createBashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

/**
 * 宿主自带的四个核心工具。
 *
 * 它们是「能改代码」这件事本身：read 是模型唯一的内容入口，write 与 edit 构成修改的最小闭环，
 * bash 具备任意执行能力。其余工具（查找、检索之类的便利手段）随包分发在插件里，可以被替换。
 */
export function createCoreTools(
	options: { readonly shellPath?: string } = {},
): readonly AnyToolDefinition[] {
	return [readTool, writeTool, editTool, createBashTool(options.shellPath)];
}

export { createBashTool, editTool, readTool, writeTool };

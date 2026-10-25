import type { AnyToolDefinition } from "../contract.ts";
import { createJobOutputTool, createKillJobTool, type JobManager } from "../jobs.ts";
import { createBashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { presentPlanTool } from "./plan.ts";
import { readTool } from "./read.ts";
import { todoTool } from "./todo.ts";
import { writeTool } from "./write.ts";

/**
 * 宿主自带的核心工具。
 *
 * 它们是「能改代码」这件事本身：read 是模型唯一的内容入口，write 与 edit 构成修改的最小闭环，
 * bash 具备任意执行能力。todo 只与对话内容交互，把多步工作的进度留在界面上。其余工具（查找、
 * 检索之类的便利手段）随包分发在插件里，可以被替换。
 */
export function createCoreTools(
	options: { readonly shellPath?: string; readonly jobs?: JobManager } = {},
): readonly AnyToolDefinition[] {
	return [
		readTool,
		writeTool,
		editTool,
		createBashTool(options.shellPath, options.jobs),
		todoTool,
		presentPlanTool,
		...(options.jobs === undefined
			? []
			: [createJobOutputTool(options.jobs), createKillJobTool(options.jobs)]),
	];
}

export { createBashTool, editTool, presentPlanTool, readTool, todoTool, writeTool };

import type { AnyToolDefinition } from "../contract.ts";
import { createJobOutputTool, createKillJobTool, type JobManager } from "../jobs.ts";
import { createTerminalTools, type TerminalManager } from "../terminal.ts";
import { createBashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { patchTool } from "./patch.ts";
import { presentPlanTool } from "./plan.ts";
import { readTool } from "./read.ts";
import { todoTool } from "./todo.ts";
import { webFetchTool } from "./web-fetch.ts";
import { writeTool } from "./write.ts";

/**
 * 宿主自带的核心工具。
 *
 * 它们是「能改代码」这件事本身：read 是模型唯一的内容入口，write 与 edit 构成修改的最小闭环，
 * bash 具备任意执行能力。todo 只与对话内容交互，把多步工作的进度留在界面上。
 *
 * 查找类工具（ls、find、grep）用 bash 也能近似做出来，但仍然内置：它们是模型摸清仓库结构的
 * 常规手段，缺了之后每一轮都得绕远路。它们与其余核心工具一样，不可被插件替换。
 */
export function createCoreTools(
	options: {
		readonly shellPath?: string;
		readonly jobs?: JobManager;
		readonly terminals?: TerminalManager;
	} = {},
): readonly AnyToolDefinition[] {
	return [
		readTool,
		writeTool,
		editTool,
		patchTool,
		createBashTool(options.shellPath, options.jobs),
		...(options.terminals === undefined ? [] : createTerminalTools(options.terminals)),
		todoTool,
		presentPlanTool,
		lsTool,
		findTool,
		grepTool,
		webFetchTool,
		...(options.jobs === undefined
			? []
			: [createJobOutputTool(options.jobs), createKillJobTool(options.jobs)]),
	];
}

export { createBashTool, editTool, findTool, grepTool, lsTool, patchTool, presentPlanTool, readTool, todoTool, webFetchTool, writeTool };

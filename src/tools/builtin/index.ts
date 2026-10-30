import type { AnyToolDefinition } from "#src/tools/contract.ts";
import { createBashTool } from "#src/tools/builtin/bash.ts";
import { editTool } from "#src/tools/builtin/edit.ts";
import { findTool } from "#src/tools/builtin/find.ts";
import { grepTool } from "#src/tools/builtin/grep.ts";
import { lsTool } from "#src/tools/builtin/ls.ts";
import { patchTool } from "#src/tools/builtin/patch.ts";
import { presentPlanTool } from "#src/tools/builtin/plan.ts";
import { createPwshTool } from "#src/tools/builtin/pwsh.ts";
import { readTool } from "#src/tools/builtin/read.ts";
import { todoTool } from "#src/tools/builtin/todo.ts";
import { webFetchTool } from "#src/tools/builtin/web-fetch.ts";
import { writeTool } from "#src/tools/builtin/write.ts";

/**
 * 宿主自带的核心工具。
 *
 * 它们是「能改代码」这件事本身：read 是模型唯一的内容入口，write 与 edit 构成修改的最小闭环，
 * bash 与 pwsh 具备任意执行能力。todo 只与对话内容交互，把多步工作的进度留在界面上。
 *
 * 查找类工具（ls、find、grep）用 bash 也能近似做出来，但仍然内置：它们是模型摸清仓库结构的
 * 常规手段，缺了之后每一轮都得绕远路。它们与其余核心工具一样，不可被插件替换。
 */
export function createCoreTools(
	options: { readonly shellPath?: string; readonly platform?: NodeJS.Platform } = {},
): readonly AnyToolDefinition[] {
	// 原生 Windows 方言只在 Windows 上出现：别处 bash 已经够用，多一个工具只会让模型在两种
	// shell 之间犹豫，而它多半选错那个不存在的解释器。
	const nativeShell = (options.platform ?? process.platform) === "win32";
	return [
		readTool,
		writeTool,
		editTool,
		patchTool,
		createBashTool(options.shellPath),
		...(nativeShell ? [createPwshTool()] : []),
		todoTool,
		presentPlanTool,
		lsTool,
		findTool,
		grepTool,
		webFetchTool,
	];
}

export { createBashTool, createPwshTool, editTool, findTool, grepTool, lsTool, patchTool, presentPlanTool, readTool, todoTool, webFetchTool, writeTool };

import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";

/**
 * 任务列表工具。
 *
 * 整表替换式：每次调用携带完整列表,「当前任务列表」就是会话里最后一次调用的参数。
 * 状态因此只存在于对话本身——续聊与界面回填都直接复用会话重放，工具不持有任何跨调用
 * 状态，也不碰文件系统。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		explanation: {
			type: "string",
			description: "Optional short note explaining this update.",
		},
		todos: {
			type: "array",
			description: "The COMPLETE task list; it replaces the previous list entirely.",
			items: {
				type: "object",
				properties: {
					content: { type: "string", description: "What the task is — a short imperative line." },
					status: {
						type: "string",
						enum: ["pending", "in_progress", "completed", "failed"],
						description:
							"pending (not started), in_progress (being worked on now), completed (done), failed (cannot be completed).",
					},
				},
				required: ["content", "status"],
			},
		},
	},
	required: ["todos"],
} as const satisfies JsonSchema;

type TodoStatus = "pending" | "in_progress" | "completed" | "failed";

type TodoArgs = {
	readonly explanation?: string;
	readonly todos: readonly { readonly content: string; readonly status: TodoStatus }[];
};

export const todoTool: ToolDefinition<TodoArgs> = {
	name: "todo",
	summary: "Record and update the task list for multi-step work",
	description:
		"Track a task list for multi-step work and show progress; use it for three or more distinct steps and " +
		"skip single-step tasks. Every call replaces the whole list, so send the COMPLETE current list each " +
		"time. Keep exactly one task in_progress while work is going on, mark tasks completed as soon as they " +
		"are done, mark a task failed only when it cannot be completed, and finish with every task completed " +
		"or failed. Do not restate the list in your reply.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args }): Promise<ToolResult> {
		// 空白内容读不出任务是什么：宁可让模型改一次，也不要替它猜一个能跑的形状
		if (args.todos.some((item) => item.content.trim().length === 0)) {
			return { content: "Invalid todos: every content must be a non-empty string.", isError: true };
		}
		if (args.todos.length === 0) return { content: "Task list cleared." };
		const done = args.todos.filter((item) => item.status === "completed").length;
		return { content: `Task list updated: ${done} of ${args.todos.length} done.` };
	},
};

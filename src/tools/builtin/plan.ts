import type { ToolDefinition, ToolResult } from "../contract.ts";
import type { JsonSchema } from "../schema.ts";

/**
 * 计划提交工具。
 *
 * Plan 模式只读，模型的产出不是代码而是一份计划。计划作为工具参数进入会话：界面据此
 * 打开审批页，历史也能从同一份调用里恢复。它不写文件，因此不需要为计划开路径例外。
 */

const PARAMETERS = {
	type: "object",
	properties: {
		plan: {
			type: "string",
			description:
				"The complete plan in Markdown. Include a short summary, the files to change, ordered " +
				"implementation steps, verification, and assumptions that affect implementation.",
		},
	},
	required: ["plan"],
} as const satisfies JsonSchema;

type PresentPlanArgs = {
	readonly plan: string;
};

export const presentPlanTool: ToolDefinition<PresentPlanArgs> = {
	name: "present_plan",
	summary: "Submit the final plan for approval; available only in Plan mode",
	description:
		"Submit the final plan for the user's approval. Call it once you have finished exploring and the " +
		"plan is decision-complete; do not use it for a progress update or before resolving discoverable " +
		"questions. It is available only in Plan mode. After it succeeds, stop and wait for the user's " +
		"decision instead of continuing to work.",
	parameters: PARAMETERS,
	annotations: { readOnly: true, destructive: false, openWorld: false },

	async execute({ args }): Promise<ToolResult> {
		if (args.plan.trim().length === 0) {
			return {
				content: "The plan is empty. Write the complete plan in Markdown before submitting it.",
				isError: true,
			};
		}
		return {
			content: "Plan submitted for review. Stop here and wait for the user's decision.",
		};
	},
};

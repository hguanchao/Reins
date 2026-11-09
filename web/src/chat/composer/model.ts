import type { ApprovalMode, SkillInfo, ThinkingLevel, UsageSummary } from "../../protocol.ts";

/**
 * 输入卡的纯逻辑与共享常量。
 *
 * 补全候选、分组、命中率与档名不依赖 React，单独放一层便于独立验证，
 * 也让各浮层组件只关心自己的渲染与交互。
 */

export const APPROVAL_LABELS: Record<ApprovalMode, string> = {
	ask: "逐次询问",
	auto: "自动审查",
	yolo: "直接放行",
};

export const EFFORT_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};

/** 输入卡起始两行；高度上限 132px 由样式封顶，超出即内部滚动。 */
export const MIN_LINES = 2;

/** 排队的一条消息：只在本机会话内存在，清空后整条收起。 */
export interface QueuedMessage {
	readonly id: string;
	readonly text: string;
}

export interface MentionItem {
	readonly token: string;
	readonly description: string;
}

export interface MentionState {
	readonly kind: "file" | "skill" | "command";
	readonly query: string;
	readonly start: number;
	readonly files: readonly string[];
	readonly index: number;
}

/** 会话内命令：只有真实接上的动作才列进来。 */
export const COMMANDS: readonly { readonly token: string; readonly description: string }[] = [
	{ token: "/compact", description: "压缩上下文，把长会话换成摘要继续" },
	{ token: "/clear", description: "新建任务，开一段干净的会话" },
	{ token: "/settings", description: "打开设置" },
];


/** 缓存命中率只统计输入侧；输出不经过缓存，不参与计算。 */
export function hitRate(usage: UsageSummary): number | undefined {
	const inputSide = usage.input + usage.cacheRead + usage.cacheWrite;
	return inputSide > 0 ? Math.round((usage.cacheRead / inputSide) * 100) : undefined;
}


export function mentionItems(state: MentionState | undefined, skills: readonly SkillInfo[]): readonly MentionItem[] {
	if (state === undefined) return [];
	const needle = state.query.toLowerCase();
	if (state.kind === "file") {
		return state.files.map((path) => ({ token: path, description: "" }));
	}
	if (state.kind === "skill") {
		return skills
			.filter((skill) => skill.name.toLowerCase().includes(needle))
			.slice(0, 8)
			.map((skill) => ({ token: skill.name, description: skill.description }));
	}
	const commands = COMMANDS.filter((command) => command.token.includes(needle)).map((command) => ({
		token: command.token,
		description: command.description,
	}));
	const matched = skills
		.filter((skill) => skill.name.toLowerCase().includes(needle))
		.slice(0, 6)
		.map((skill) => ({ token: skill.name, description: skill.description }));
	return [...commands, ...matched];
}


/** 分组只在 `/` 时出现：命令在上、技能在下。 */
export function groupMentions(
	state: MentionState | undefined,
	items: readonly MentionItem[],
): readonly { readonly label: string; readonly items: readonly MentionItem[] }[] {
	if (state === undefined) return [];
	if (state.kind === "command") {
		const commands = items.filter((item) => item.token.startsWith("/"));
		const skills = items.filter((item) => !item.token.startsWith("/"));
		return [
			{ label: "命令", items: commands },
			{ label: "技能", items: skills },
		].filter((group) => group.items.length > 0);
	}
	return [{ label: state.kind === "file" ? "文件" : "技能", items }];
}


export function serverStatusLabel(status: string): string {
	switch (status) {
		case "connected":
			return "已连接";
		case "connecting":
			return "连接中";
		case "unreachable":
			return "连接失败";
		case "disabled":
			return "已禁用";
		default:
			return "未连接";
	}
}

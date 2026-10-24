import type { ApprovalMode } from "../config/config-file.ts";
import type { PermissionScope, ToolAnnotations } from "../tools/contract.ts";

/**
 * 审批判定。
 *
 * 这条链留在宿主里，不下放给插件：它是安全检查而不是功能，插件可以加规则，但不能改判定的
 * 顺序，也不能让某次调用直接通过。
 *
 * 决策分两类：能立刻定的（放行、拒绝），和需要外部参与的（问使用者、问审查模型）。这里只
 * 产出结论，怎么落实由调用方决定——判定保持是纯函数，才测得清楚。
 */

/**
 * 审批规则。
 *
 * 规则能表达的结论只有「拒绝」与「需要询问」这两种加严的结果，没有「放行」。这是刻意的：
 * 一条来自插件的规则若能放行，就等于让插件决定什么事可以绕过安全检查。
 */
export interface PermissionRule {
	readonly decision: "deny" | "ask";
	readonly reason: string;
	/** 命中即按 decision 处理 */
	matches(tool: string, args: Record<string, unknown>): boolean;
}

export type PermissionDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly reason: string }
	/** 交给使用者确认 */
	| { readonly kind: "ask"; readonly reason: string }
	/** 交给审查模型判定 */
	| { readonly kind: "review"; readonly reason: string };

export class PermissionPolicy {
	/** 审批方式可在会话内切换（Shift+Tab），所以可变；判定每次读当前值，切换即时生效。 */
	#mode: ApprovalMode;
	readonly #rules: PermissionRule[] = [];
	/** 本会话内使用者明确放行的范围；只存在于当前进程，退出即失效 */
	readonly #sessionAllowed = new Set<string>();

	constructor(mode: ApprovalMode) {
		this.#mode = mode;
	}

	/** 当前审批方式；界面徽标逐帧读取，不在界面侧拍快照。 */
	get mode(): ApprovalMode {
		return this.#mode;
	}

	/**
	 * 切换审批方式。
	 *
	 * 只改本进程的判定，不回写配置文件：放宽审批（尤其降到 yolo）不该因为一次快捷键
	 * 就悄悄持久化，重启后回到使用者写定的取值。
	 */
	setMode(mode: ApprovalMode): void {
		this.#mode = mode;
	}

	/** 追加一条加严规则。装载插件期间由宿主调用。 */
	addRule(rule: PermissionRule): void {
		this.#rules.push(rule);
	}

	/** 记住一次「本会话总是允许」。范围由工具在调用时给出。 */
	allowForSession(tool: string, scope: PermissionScope): void {
		this.#sessionAllowed.add(sessionKey(tool, scope.key));
	}

	ruleCount(): number {
		return this.#rules.length;
	}

	/**
	 * 判定一次工具调用。
	 *
	 * 顺序：规则 → 会话放行 → 只读工具 → 审批方式。规则排在最前，因为它们表达的是「明令
	 * 禁止」，不该被审批方式绕过；会话放行是使用者在本会话里明确说过的「总是允许」，排在
	 * 插件规则之后即明令加严仍然优先；只读工具直接放行，是因为每读一个文件都问一次只会
	 * 让人养成无脑同意的习惯，等到真正危险的那次也一样会同意。
	 *
	 * 只读标注只对核心工具生效：插件可以自己声明这个字段，若据此直接放行，插件就等于
	 * 给自己开了免审批通道。
	 */
	decide(
		tool: string,
		annotations: ToolAnnotations,
		args: Record<string, unknown>,
		source: "core" | "bundled" | "plugin" = "core",
		scopeKey?: string,
	): PermissionDecision {
		for (const rule of this.#rules) {
			if (!rule.matches(tool, args)) continue;
			return { kind: rule.decision, reason: rule.reason };
		}

		// 使用者的会话放行排在插件规则之后：明令加严的规则仍然优先
		if (scopeKey !== undefined && this.#sessionAllowed.has(sessionKey(tool, scopeKey))) {
			return { kind: "allow" };
		}

		// 只读标注只对核心与随包插件生效：外部插件可以自己声明这个字段，若据此直接放行，
		// 插件就等于给自己开了免审批通道。
		if (annotations.readOnly && source !== "plugin") return { kind: "allow" };

		const reason = `${tool} modifies state`;
		switch (this.#mode) {
			case "yolo":
				return { kind: "allow" };
			case "auto":
				return { kind: "review", reason };
			default:
				return { kind: "ask", reason };
		}
	}
}

/** 征求使用者同意时展示的内容。 */
export interface ApprovalRequest {
	/** 原始工具标识，用于权限匹配；界面展示前必须经 displayToolName 转成展示名 */
	readonly tool: string;
	/** 风险标签：destructive / external；没有风险时为空串 */
	readonly risk: string;
	readonly detail: string;
	/** 「总是允许」的完整说明；undefined 表示这次不能记住 */
	readonly saveLabel?: string;
	/** 动作行里的短标签 */
	readonly saveShort?: string;
}

export type ApprovalAnswer = "once" | "always" | "deny";

export interface Confirmer {
	(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

export interface ReviewOutcome {
	readonly allowed: boolean;
	readonly reason: string;
}

/** 审查模型。抽成接口是为了让判定的落实可以单独测，不必先接一个真模型。 */
export interface ApprovalReviewer {
	review(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ReviewOutcome>;
}

export interface GateRequest {
	readonly tool: string;
	readonly annotations: ToolAnnotations;
	readonly args: Record<string, unknown>;
	/** 工具来源：只读标注只在核心与随包插件上可信 */
	readonly source: "core" | "bundled" | "plugin";
	/** 本会话可记住的放行范围；undefined 表示这次调用只能逐次批准 */
	readonly scope: PermissionScope | undefined;
	readonly signal: AbortSignal;
}

export interface GateOutcome {
	readonly allowed: boolean;
	/** 拒绝的理由；放行时为空。它会被写进工具结果，让模型知道为什么没做成。 */
	readonly reason: string;
}

export interface GateOptions {
	readonly policy: PermissionPolicy;
	/** 非交互模式下没有可询问的对象，此时为 undefined */
	readonly confirmer?: Confirmer;
	/** 审批方式为 auto 时使用 */
	readonly reviewer?: ApprovalReviewer;
}

/** 把判定落到具体动作上：能定的直接定，需要外部参与的去问。 */
export class PermissionGate {
	readonly #options: GateOptions;

	constructor(options: GateOptions) {
		this.#options = options;
	}

	async check(request: GateRequest): Promise<GateOutcome> {
		const decision = this.#options.policy.decide(
			request.tool,
			request.annotations,
			request.args,
			request.source,
			request.scope?.key,
		);

		switch (decision.kind) {
			case "allow":
				return { allowed: true, reason: "" };
			case "deny":
				return { allowed: false, reason: decision.reason };
			case "ask":
				return this.#ask(request, decision.reason);
			case "review":
				return this.#review(request, decision.reason);
		}
	}

	async #ask(request: GateRequest, reason: string): Promise<GateOutcome> {
		const confirmer = this.#options.confirmer;
		if (confirmer === undefined) {
			// 没有人看着的时候就按拒绝处理：默认放行等于把「无人值守」变成「随意改动」
			return {
				allowed: false,
				reason: `${reason}, but there is no one to ask; set approval to auto or yolo in config.toml`,
			};
		}

		const answer = await confirmer({
			tool: request.tool,
			risk: riskLabel(request.annotations),
			detail: describeCall(request.tool, request.args),
			saveLabel: request.scope?.label,
			saveShort: request.scope?.short ?? request.scope?.label,
		});
		if (answer === "always") {
			if (request.scope === undefined) {
				return { allowed: false, reason: `${reason}, but this call cannot be remembered; approve it once or deny it` };
			}
			this.#options.policy.allowForSession(request.tool, request.scope);
			return { allowed: true, reason: "" };
		}
		if (answer === "once") return { allowed: true, reason: "" };
		return { allowed: false, reason: `${reason}, but the user did not approve` };
	}

	async #review(request: GateRequest, reason: string): Promise<GateOutcome> {
		const reviewer = this.#options.reviewer;
		if (reviewer === undefined) {
			return { allowed: false, reason: `${reason}, but approval is auto and no reviewer model is available; denied` };
		}

		const outcome = await reviewer.review(request.tool, request.args, request.signal);
		return { allowed: outcome.allowed, reason: outcome.reason };
	}
}

/** 审批提示里参数摘要的长度上限:确认动作要一眼读完。 */
const CALL_SUMMARY_LIMIT = 400;

/** 给确认面板看的调用摘要。bash 与文件工具直接给命令/路径，其余压成一行 JSON。 */
function describeCall(tool: string, args: Record<string, unknown>): string {
	if (tool === "bash" && typeof args["command"] === "string") return args["command"];
	if ((tool === "edit" || tool === "write") && typeof args["path"] === "string") return args["path"];

	const text = JSON.stringify(args);
	return text.length > CALL_SUMMARY_LIMIT ? `${text.slice(0, CALL_SUMMARY_LIMIT)}…` : text;
}

function riskLabel(annotations: ToolAnnotations): string {
	if (annotations.destructive) return "destructive";
	if (annotations.openWorld) return "external";
	return "";
}

function sessionKey(tool: string, scope: string): string {
	// 分隔符不可能出现在工具名或范围里，避免 tool=a/scope=b 与 tool=a\0b 之类拼出同一个键
	return `${tool}\u0000${scope}`;
}

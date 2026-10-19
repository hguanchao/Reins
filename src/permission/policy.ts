import type { ApprovalMode } from "../config/config-file.ts";
import type { ToolAnnotations } from "../tools/contract.ts";

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
	readonly #mode: ApprovalMode;
	readonly #rules: PermissionRule[] = [];

	constructor(mode: ApprovalMode) {
		this.#mode = mode;
	}

	/** 追加一条加严规则。装载插件期间由宿主调用。 */
	addRule(rule: PermissionRule): void {
		this.#rules.push(rule);
	}

	ruleCount(): number {
		return this.#rules.length;
	}

	/**
	 * 判定一次工具调用。
	 *
	 * 顺序：规则 → 只读工具 → 审批方式。规则排在最前，因为它们表达的是「明令禁止」，
	 * 不该被审批方式绕过；只读工具直接放行，是因为每读一个文件都问一次只会让人养成
	 * 无脑同意的习惯，等到真正危险的那次也一样会同意。
	 */
	decide(tool: string, annotations: ToolAnnotations, args: Record<string, unknown>): PermissionDecision {
		for (const rule of this.#rules) {
			if (!rule.matches(tool, args)) continue;
			return { kind: rule.decision, reason: rule.reason };
		}

		if (annotations.readOnly) return { kind: "allow" };

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

/** 征求使用者同意。返回是否允许。 */
export interface Confirmer {
	(question: string, detail: string): Promise<boolean>;
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
		const decision = this.#options.policy.decide(request.tool, request.annotations, request.args);

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

		const allowed = await confirmer(`Allow ${request.tool} to run?`, describeCall(request.args));
		return allowed ? { allowed: true, reason: "" } : { allowed: false, reason: `${reason}, but the user did not approve` };
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

/** 给确认框看的调用摘要。太长的话截断，确认框本身不该需要滚动。 */
function describeCall(args: Record<string, unknown>): string {
	const text = JSON.stringify(args, null, 2);
	return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

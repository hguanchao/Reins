import type { LlmClient } from "../llm/client.ts";
import { assistantText } from "../llm/messages.ts";
import type { ApprovalReviewer, ReviewOutcome } from "./policy.ts";

/**
 * 由模型审查一次工具调用是否可以自动放行。
 *
 * 用在审批方式为 auto 的场合：没有人逐个确认，又要比「一律放行」多一道判断。审查者只看到
 * 这一次调用，看不到任务的前因后果，所以判断标准围绕「这一下会不会造成难以挽回的影响」，
 * 而不是「这符不符合任务意图」——后者它无从判断。
 *
 * 解析不出结论时一律按拒绝处理：审查环节本来就该在不确定时收紧，而不是放开。
 */

const REVIEW_SYSTEM_PROMPT = `你在审查一次工具调用能否自动放行。你只看到这一次调用，看不到任务的来龙去脉，所以按「这一下会不会造成难以挽回的影响」判断，而不是按「它像不像在完成某件事」。

应当放行：
- 读取、列出、检索类操作
- 在工作区内创建或修改文件
- 运行只读取状态或只在工作区内产生影响的命令，例如构建、测试、查看版本状态

应当拒绝：
- 删除或覆盖工作区之外的内容
- 改动版本历史，例如强制切换、丢弃未提交的改动
- 把工作区内容发往外部服务
- 改动与当前任务无关的持久状态，例如系统配置、包管理器的全局安装
- 你看不出这条命令会做什么

拿不准就拒绝。多看一眼的代价远小于一次不可逆的改动。

只输出一个 JSON 对象，不要任何其他内容：
{"allow": true 或 false, "reason": "一句话说明理由"}`;

export interface ReviewerOptions {
	readonly client: LlmClient;
	/** provider 内的模型 id */
	readonly model: string;
	readonly maxTokens: number | undefined;
	/** 审查提示里要写清工作区在哪，否则判断不了「工作区之外」 */
	readonly workspaceRoot: string;
}

/** 参数原样塞给审查模型，但要有上限：一个几千行的文件内容不该占满审查的上下文。 */
const MAX_ARGUMENT_CHARS = 4000;

export class ModelReviewer implements ApprovalReviewer {
	readonly #options: ReviewerOptions;

	constructor(options: ReviewerOptions) {
		this.#options = options;
	}

	async review(
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ReviewOutcome> {
		const request = {
			model: this.#options.model,
			system: REVIEW_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [
						`工作区：${this.#options.workspaceRoot}`,
						`工具：${tool}`,
						`参数：${truncate(JSON.stringify(args, null, 2))}`,
					].join("\n\n"),
				},
			],
			tools: [],
			maxTokens: this.#options.maxTokens,
			effort: undefined,
			signal,
		};

		let text: string;
		try {
			const stream = this.#options.client.stream(request);
			for await (const event of stream) {
				// 审查只关心最终结论，增量不必处理
				void event;
			}
			const result = await stream.result();
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				return reject(`审查未能完成：${result.errorMessage ?? result.stopReason}`);
			}
			text = assistantText({ role: "assistant", content: result.content });
		} catch (error) {
			return reject(`审查未能完成：${error instanceof Error ? error.message : String(error)}`);
		}

		return parseVerdict(text);
	}
}

function reject(reason: string): ReviewOutcome {
	return { allowed: false, reason };
}

function truncate(text: string): string {
	return text.length > MAX_ARGUMENT_CHARS ? `${text.slice(0, MAX_ARGUMENT_CHARS)}…` : text;
}

/**
 * 解析审查结论。
 *
 * 模型有时会把 JSON 包在说明文字或代码围栏里，所以先整体解析，不成再取第一对花括号之间的
 * 内容。两条路都走不通就按拒绝处理。
 */
export function parseVerdict(text: string): ReviewOutcome {
	const direct = tryParse(text.trim());
	if (direct !== undefined) return direct;

	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		const inner = tryParse(text.slice(start, end + 1));
		if (inner !== undefined) return inner;
	}

	return reject("审查模型的回答无法解析，按拒绝处理");
}

function tryParse(candidate: string): ReviewOutcome | undefined {
	if (candidate.length === 0) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as { allow?: unknown; reason?: unknown };
	if (typeof record.allow !== "boolean") return undefined;

	const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : "审查模型未给出理由";
	return { allowed: record.allow, reason };
}

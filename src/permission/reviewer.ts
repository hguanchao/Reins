import { describeError } from "../shared/describe-error.ts";
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

const REVIEW_SYSTEM_PROMPT = `You are reviewing whether one tool call may be auto-approved. You only see this one call and not the task behind it, so judge by "could this cause an impact that is hard to undo", not by "does it look like it is getting the job done".

Approve:
- read, list and search operations
- creating or modifying files inside the workspace
- commands that only read state or only affect the workspace, such as builds, tests and status checks

Deny:
- deleting or overwriting anything outside the workspace
- rewriting version history, such as force-switching or discarding uncommitted changes
- sending workspace content to an external service
- changing persistent state unrelated to the current task, such as system configuration or global package installs
- calls whose effect you cannot tell

When in doubt, deny. A second look costs far less than an irreversible change.

Output one JSON object and nothing else:
{"allow": true or false, "reason": "one sentence explaining why"}`;

interface ReviewerOptions {
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
						`Workspace: ${this.#options.workspaceRoot}`,
						`Tool: ${tool}`,
						`Arguments: ${truncate(JSON.stringify(args, null, 2))}`,
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
				return reject(`Review did not finish: ${result.errorMessage ?? result.stopReason}`);
			}
			text = assistantText({ role: "assistant", content: result.content });
		} catch (error) {
			return reject(`Review did not finish: ${describeError(error)}`);
		}

		return parseVerdict(text);
	}
}

function reject(reason: string): ReviewOutcome {
	return { allowed: false, reason };
}

function truncate(text: string): string {
	if (text.length <= MAX_ARGUMENT_CHARS) return text;
	// 必须明说被截断：否则把危险内容放在截断点之后的参数，在审查者眼里是一段无害前缀。
	return `${text.slice(0, MAX_ARGUMENT_CHARS)}\n…[arguments truncated at ${MAX_ARGUMENT_CHARS} characters; the rest is not shown]`;
}

/**
 * 解析审查结论。
 *
 * 模型有时会把 JSON 包在说明文字或代码围栏里，所以先整体解析，不成再找围栏里的 JSON。
 *
 * 兜底那一步只认**围栏**，不认「第一对花括号」：审查提示把工具参数原样喂给模型，而参数
 * 由被审查的内容控制。若从整段回复里抓第一对花括号，一句拒绝说明里引用的
 * `{"allow": true}` 就会被当成结论，把拒绝读成允许。围栏是模型主动圈出结论的标记，
 * 参数里的花括号不会带它。
 */
export function parseVerdict(text: string): ReviewOutcome {
	const direct = tryParse(text.trim());
	if (direct !== undefined) return direct;

	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced !== null) {
		const inner = tryParse((fenced[1] ?? "").trim());
		if (inner !== undefined) return inner;
	}

	return reject("Reviewer reply could not be parsed; denying");
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

	const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : "Reviewer gave no reason";
	return { allowed: record.allow, reason };
}

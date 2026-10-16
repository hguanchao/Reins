import type { AgentEvent } from "../../agent/events.ts";
import {
	concat,
	mapLine,
	mergeStyles,
	plain,
	styled,
	wrapLine,
	type Line,
	type Style,
} from "../../tui/index.ts";
import { formatDuration, spinnerLine } from "../../tui/widgets/spinner.ts";
import { renderMarkdown } from "./markdown.ts";

/**
 * 会话的显示状态。
 *
 * 分成两半：已经提交的行写进终端滚动区后就不再重画；活动块是还在变的内容——正在流式输出的
 * 回答、正在跑的工具、推理预览。事件进来只改状态，什么时候画、画多少由界面决定。
 *
 * 流式输出的回答按 markdown 渲染，并且跟踪「已经交出去几行」：重新渲染整段文本后再跳过前面
 * 已提交的部分，得到的就是还没显示的尾部。这样不必去维护文本偏移量与行号之间的换算。
 */

/** 推理内容只留最后几行做预览。它是模型的草稿，占满屏幕会把正文挤走。 */
const REASONING_PREVIEW_LINES = 3;

/** 工具参数在界面上只显示个大概，完整内容在会话文件里。 */
const ARGS_LIMIT = 60;

const DIM: Style = { dim: true };
const PROMPT: Style = { color: "cyan" };
const OK: Style = { color: "green" };
const BAD: Style = { color: "red" };
const WARN: Style = { color: "yellow" };

/** 模型产出的缩进：使用者的问题在两列，回答与工具调用整体再缩进两列。 */
const MODEL_INDENT = "  ";

export interface LiveOptions {
	/**
	 * 活动块最多占几行，超出的部分从上往下丢弃。
	 *
	 * 整屏绘制时不传：显示哪一段由调用方自己从全部行里挑，这里折了反而丢内容。
	 */
	readonly maxLines?: number;
	/** 当前时刻，用来推进指示器与耗时 */
	readonly now: number;
}

interface RunningTool {
	readonly callId: string;
	readonly name: string;
	readonly args: string;
	readonly startedAt: number;
	update: string | undefined;
}

export class Transcript {
	#width: number;
	#streaming = "";
	/** 流式文本里已经交出去的行数 */
	#committedStreamLines = 0;
	#reasoning = "";
	#running: RunningTool[] = [];

	constructor(width: number) {
		this.#width = Math.max(1, width);
	}

	/** 窗口尺寸变了，后续按新宽度重排。已经提交的行不受影响。 */
	resize(width: number): void {
		this.#width = Math.max(1, width);
	}

	/** 使用者提交了一句话：把它作为一行回显出来。 */
	userTurn(text: string): readonly Line[] {
		// 使用者的消息顶格在两列，提示符算在缩进里；模型产出整体再缩进两列，一问一答靠这个区分
		return wrapLine(plain(text), {
			width: this.#width,
			firstIndent: [...plain("  "), ...styled("› ", PROMPT)],
			restIndent: plain("    "),
		});
	}

	/** 处理一个事件，返回因此要提交进滚动区的行。 */
	handle(event: AgentEvent, now: number): readonly Line[] {
		switch (event.type) {
			case "text_delta":
				this.#streaming += event.text;
				return [];
			case "reasoning_delta":
				this.#reasoning += event.text;
				return [];
			case "tool_start":
				this.#running.push({
					callId: event.callId,
					name: event.name,
					args: summarizeArgs(event.args),
					startedAt: now,
					update: undefined,
				});
				// 回答写到一半就去调工具时，先把已经写完的部分定下来
				return this.#drainStream();
			case "tool_update": {
				const tool = this.#running.find((item) => item.callId === event.callId);
				if (tool !== undefined) tool.update = event.text;
				return [];
			}
			case "tool_end": {
				const index = this.#running.findIndex((item) => item.callId === event.callId);
				const tool = index < 0 ? undefined : this.#running.splice(index, 1)[0];
				return [...this.#drainStream(), ...this.#toolResult(event, tool)];
			}
			case "error":
				return [...this.#drainStream(), ...this.#wrap(styled(`出错：${event.message}`, BAD))];
			case "aborted":
				return [...this.#drainStream(), ...this.#wrap(styled("已中止", WARN))];
			case "compaction_start":
				// 摘要要花一会儿，先把已经写出来的回答定下来，再说明为什么停下来
				return [
					...this.#drainStream(),
					...this.#wrap(
						styled(
							`上下文偏长，正在把前面 ${event.messages} 条换成摘要（约 ${event.tokensBefore} token）`,
							WARN,
						),
					),
				];
			case "compaction_end":
				return this.#wrap(
					styled(`已压缩上下文：约 ${event.tokensBefore} → ${event.tokensAfter} token，历史仍在会话文件里`, DIM),
				);
			case "compaction_failed":
				return this.#wrap(styled(`压缩没有成功，上下文照原样继续：${event.message}`, WARN));
			case "run_end":
				return this.flush();
			default:
				return [];
		}
	}

	/** 活动块：推理预览、还没定型的回答、正在跑的工具。 */
	live(options: LiveOptions): readonly Line[] {
		const lines: Line[] = [];

		if (this.#reasoning.length > 0) {
			const preview = this.#wrap(mapLine(plain(this.#reasoning), (style) => mergeStyles(style, DIM)));
			const tail = preview.slice(-REASONING_PREVIEW_LINES);
			lines.push(concat(styled("· ", DIM), tail[0] ?? []));
			for (const line of tail.slice(1)) lines.push(line);
		}

		if (this.#streaming.length > 0) {
			const rendered = renderMarkdown(this.#streaming, { width: this.#width });
			lines.push(...rendered.lines.slice(this.#committedStreamLines));
		}

		for (const tool of this.#running) lines.push(this.#runningToolLine(tool, options.now));

		// 顶部溢出时丢上面：正在写的内容与正在跑的工具比早先的预览更值得看
		if (options.maxLines !== undefined && lines.length > options.maxLines) {
			return [styled("…", DIM), ...lines.slice(lines.length - options.maxLines + 1)];
		}
		return lines;
	}

	/** 本轮结束：把剩下的回答、推理与工具痕迹收干净。 */
	flush(): readonly Line[] {
		const lines = this.#drainStream();
		this.#reasoning = "";
		return lines;
	}

	/** 本轮中止或出错后，工具卡片不该留在屏幕上。 */
	clearRunning(): void {
		this.#running = [];
	}

	#drainStream(): readonly Line[] {
		if (this.#streaming.length === 0) return [];
		const rendered = renderMarkdown(this.#streaming, { width: this.#width });
		const rest = rendered.lines.slice(this.#committedStreamLines);
		this.#streaming = "";
		this.#committedStreamLines = 0;
		return rest;
	}

	#runningToolLine(tool: RunningTool, now: number): Line {
		const head = spinnerLine(`${tool.name} ${tool.args}`.trim(), now - tool.startedAt);
		if (tool.update === undefined || tool.update.length === 0) return head;

		// 阶段性输出只显示最后一行：它是给「还在动」这件事作证的
		const last = tool.update.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? "";
		return last.length === 0 ? head : concat(head, styled(` · ${last}`, DIM));
	}

	#toolResult(event: Extract<AgentEvent, { type: "tool_end" }>, tool: RunningTool | undefined): readonly Line[] {
		const mark = event.isError ? styled("✗ ", BAD) : styled("✓ ", OK);
		const label = `${event.name} ${tool?.args ?? ""}`.trim();
		const detail = event.isError
			? `失败 ${formatDuration(event.durationMs)}：${event.summary}`
			: formatDuration(event.durationMs);

		return this.#wrap([...mark, ...plain(`${label} `), ...styled(detail, DIM)]);
	}

	/** 折行到当前宽度，带模型产出的缩进。 */
	#wrap(line: Line): readonly Line[] {
		return wrapLine(line, {
			width: this.#width,
			firstIndent: plain(MODEL_INDENT),
			restIndent: plain(`${MODEL_INDENT}  `),
		});
	}
}

function summarizeArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	if (text === undefined || text === "{}") return "";
	return text.length > ARGS_LIMIT ? `${text.slice(0, ARGS_LIMIT)}…` : text;
}

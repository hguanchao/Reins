import type { AgentEvent } from "../../agent/events.ts";
import {
	alignEnds,
	concat,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	styled,
	truncateLine,
	wrapLine,
	type Line,
} from "../../tui/index.ts";
import { formatDuration } from "../../tui/widgets/spinner.ts";
import { formatTokens } from "./format.ts";
import { renderMarkdown } from "./markdown.ts";
import { ACCENT, BAD, BAND, DIM, FAINT, TEXT } from "./theme.ts";

/**
 * 会话的显示状态。
 *
 * 每一类内容在这里有自己的形状：使用者的消息整行铺底并带「› 」前缀，模型的回答与工具调用
 * 从顶格开始，工具名与耗时压暗，只有失败才用红色。区分靠的是形状与深浅，不是满屏的彩色。
 *
 * 内容分两半：定稿的行（写进会话区的历史）与活动块（还在变的部分——正在流式输出的回答、
 * 正在跑的工具、推理预览）。事件进来只改状态，什么时候画、画多少由界面决定。
 *
 * 流式输出的回答按 markdown 渲染，并且跟踪「已经交出去几行」：重新渲染整段文本后再跳过前面
 * 已提交的部分，得到的就是还没显示的尾部。这样不必去维护文本偏移量与行号之间的换算。
 */

/** 推理内容只留最后几行做预览。它是模型的草稿，占满屏幕会把正文挤走。 */
const REASONING_PREVIEW_LINES = 3;

/** 工具参数在界面上只显示个大概，完整内容在会话文件里。 */
const ARGS_LIMIT = 60;

/** 块的左侧竖线：推理预览靠它标出范围。 */
const BAR = "┃";

/** 工具行/思考行的前缀，与正文区分开。 */
const TOOL_MARK = "◆ ";
const THOUGHT_MARK = "◇ ";

/** 正在跑的工具，菱形多久明暗换一次。快于此只是闪。 */
const PULSE_MS = 400;

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
	#reasoningStartedAt: number | undefined;
	#running: RunningTool[] = [];

	constructor(width: number) {
		this.#width = Math.max(1, width);
	}

	/** 窗口尺寸变了，后续按新宽度重排。已经提交的行不受影响。 */
	resize(width: number): void {
		this.#width = Math.max(1, width);
	}

	/** 使用者提交了一句话：整行铺底写进会话，一眼能在历史里找到自己说过的话。 */
	userTurn(text: string): readonly Line[] {
		const lines = wrapLine(plain(text), {
			width: this.#width,
			firstIndent: styled("› ", ACCENT),
			restIndent: plain("  "),
		});
		return lines.map((line) => this.#band(line));
	}

	/** 处理一个事件，返回因此要提交进会话区的行。 */
	handle(event: AgentEvent, now: number): readonly Line[] {
		switch (event.type) {
			case "text_delta":
				this.#streaming += event.text;
				return this.#closeThinking(now);
			case "reasoning_delta":
				this.#reasoningStartedAt ??= now;
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
				// 回答写到一半就去调工具时：先给思考收尾，再把已经写完的部分定下来
				return [...this.#closeThinking(now), ...this.#drainStream()];
			case "tool_update": {
				const tool = this.#running.find((item) => item.callId === event.callId);
				if (tool !== undefined) tool.update = event.text;
				return [];
			}
			case "tool_end": {
				const index = this.#running.findIndex((item) => item.callId === event.callId);
				const tool = index < 0 ? undefined : this.#running.splice(index, 1)[0];
				return [...this.#closeThinking(now), ...this.#drainStream(), ...this.#toolResult(event, tool)];
			}
			case "error":
				return [
					...this.#closeThinking(now),
					...this.#drainStream(),
					...this.#wrap(styled(`✗ Error: ${event.message}`, BAD)),
				];
			case "aborted":
				return [...this.#closeThinking(now), ...this.#drainStream(), ...this.#wrap(styled("◇ Cancelled", DIM))];
			case "compaction_start":
				// 摘要要花一会儿，先把已经写出来的回答定下来，再说明为什么停下来
				return [
					...this.#closeThinking(now),
					...this.#drainStream(),
					...this.#wrap(
						styled(
							`Context is long; summarizing the previous ${event.messages} messages (~${formatTokens(event.tokensBefore)} tokens)`,
							DIM,
						),
					),
				];
			case "compaction_end":
				return this.#wrap(
					styled(
						`Context compacted: ${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens; the full history is still in the session file`,
						DIM,
					),
				);
			case "compaction_failed":
				return this.#wrap(styled(`Compaction failed; continuing with the full context: ${event.message}`, DIM));
			case "run_end":
				return this.flush(now);
			default:
				return [];
		}
	}

	/** 活动块：推理预览、还没定型的回答、正在跑的工具。 */
	live(options: LiveOptions): readonly Line[] {
		const lines: Line[] = [];

		if (this.#reasoning.length > 0) {
			lines.push(concat(styled(THOUGHT_MARK, FAINT), styled("Thinking…", DIM)));
			// 竖线作为缩进参与折行：它是块的一部分，不能挤到宽度之外
			const preview = wrapLine(mapLine(plain(this.#reasoning), (style) => mergeStyles(style, DIM)), {
				width: this.#width,
				firstIndent: styled(`${BAR} `, FAINT),
				restIndent: styled(`${BAR} `, FAINT),
			});
			lines.push(...preview.slice(-REASONING_PREVIEW_LINES));
		}

		if (this.#streaming.length > 0) {
			lines.push(...this.#renderStream().slice(this.#committedStreamLines));
		}

		for (const tool of this.#running) lines.push(this.#runningToolLine(tool, options.now));

		// 顶部溢出时丢上面：正在写的内容与正在跑的工具比早先的预览更值得看
		if (options.maxLines !== undefined && lines.length > options.maxLines) {
			return [styled("…", DIM), ...lines.slice(lines.length - options.maxLines + 1)];
		}
		return lines;
	}

	/** 本轮结束：把剩下的回答与思考收干净。 */
	flush(now: number): readonly Line[] {
		return [...this.#closeThinking(now), ...this.#drainStream()];
	}

	/** 本轮中止或出错后，工具痕迹不该留在屏幕上。 */
	clearRunning(): void {
		this.#running = [];
	}

	/** 整行铺底：底色要盖住文字，所以先把样式并到每个片段上，再补满到整屏宽。 */
	#band(line: Line): Line {
		return padLine(mapLine(line, (style) => mergeStyles(style, BAND)), this.#width, BAND);
	}

	/** 推理收尾：把「想了多久」定成一行留在会话里，草稿本身不留。 */
	#closeThinking(now: number): readonly Line[] {
		if (this.#reasoning.length === 0) return [];
		const elapsed = now - (this.#reasoningStartedAt ?? now);
		this.#reasoning = "";
		this.#reasoningStartedAt = undefined;
		return [concat(styled(THOUGHT_MARK, FAINT), styled(`Thought for ${formatDuration(elapsed)}`, DIM))];
	}

	#drainStream(): readonly Line[] {
		if (this.#streaming.length === 0) return [];
		const rest = this.#renderStream().slice(this.#committedStreamLines);
		this.#streaming = "";
		this.#committedStreamLines = 0;
		return rest;
	}

	/** 把还没定型的回答画出来。markdown 按整幅宽度排版，模型的产出与正文一样从顶格开始。 */
	#renderStream(): readonly Line[] {
		return renderMarkdown(this.#streaming, { width: Math.max(1, this.#width) }).lines;
	}

	/** 正在跑的工具：菱形明暗交替，右边带上最近一行输出。 */
	#runningToolLine(tool: RunningTool, now: number): Line {
		const lit = Math.floor(now / PULSE_MS) % 2 === 0;
		const head = concat(
			styled(TOOL_MARK, lit ? ACCENT : FAINT),
			styled(tool.name, TEXT),
			plain(tool.args.length === 0 ? "" : ` ${tool.args}`),
		);

		const tail = lastOutputLine(tool.update);
		if (tail === undefined) return head;
		return alignEnds(head, truncateLine(styled(tail, DIM), Math.max(1, Math.floor(this.#width / 3))), this.#width);
	}

	#toolResult(event: Extract<AgentEvent, { type: "tool_end" }>, tool: RunningTool | undefined): readonly Line[] {
		const mark = event.isError ? BAD : FAINT;
		const args = tool?.args ?? "";
		const head = concat(styled(TOOL_MARK, mark), styled(event.name, event.isError ? BAD : TEXT), plain(args === "" ? "" : ` ${args}`));
		const header = alignEnds(head, styled(formatDuration(event.durationMs), DIM), this.#width);
		// 成功时一行就够；失败时把原因单独说一行——这是使用者唯一需要知道的东西
		return event.isError ? [header, ...this.#wrap(styled(event.summary, BAD))] : [header];
	}

	/** 折行到当前宽度。 */
	#wrap(line: Line): readonly Line[] {
		return wrapLine(line, { width: this.#width });
	}
}

/** 把工具参数压成一行：界面上只显示个大概。 */
function summarizeArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	if (text === undefined || text === "{}") return "";
	return text.length > ARGS_LIMIT ? `${text.slice(0, ARGS_LIMIT)}…` : text;
}

/** 阶段性输出的最后一行：它是给「还在动」这件事作证的。 */
function lastOutputLine(update: string | undefined): string | undefined {
	if (update === undefined) return undefined;
	const lines = update.split("\n").filter((line) => line.trim().length > 0);
	return lines.at(-1);
}

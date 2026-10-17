import type { AgentEvent } from "../../agent/events.ts";
import {
	alignEnds,
	concat,
	lineText,
	mapLine,
	mergeStyles,
	padLine,
	plain,
	styled,
	truncateLine,
	wrapLine,
	type Line,
	type Rgb,
	type Style,
} from "../../tui/index.ts";
import { formatDuration } from "../../tui/widgets/spinner.ts";
import { formatTokens } from "./format.ts";
import {
	ACCENT_WIDTH,
	BLOCK_PAD_LEFT,
	BLOCK_PAD_RIGHT,
	entryContentWidth,
} from "./layout.ts";
import { renderMarkdown } from "./markdown.ts";
import { ACCENT, BAD, BAND, DIM, FAINT, TEXT, THEME } from "./theme.ts";

/**
 * 会话的显示状态。
 *
 * 主区按「块」排版：最左边一列竖线标出块的类型，正文前留两列；使用者的消息整块铺底并在
 * 上下各留一行，模型正文与工具行从同一列开始。右侧留两列给回合轨道与滚动条。
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

/** 块的左侧竖线：思考与工具块靠它标出范围。 */
const BAR = "┃";

/** 工具行/思考行的前缀，与正文区分开。 */
const TOOL_MARK = "◆ ";
const THOUGHT_MARK = "◇ ";

/** 正在跑的块：沿块内行号传播的明暗波，周期约四分之一秒。 */
const PULSE_RADIANS_PER_MS = 1 / 240;
const PULSE_MIN = 0.35;

/** 工具行的右端离块右缘的距离：耗时对齐到这里。 */
const HEADER_WIDTH = (entryWidth: number): number => Math.max(1, entryWidth - BLOCK_PAD_RIGHT);

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
	/** 条目总宽：竖线、左右留白与正文一起。 */
	#width: number;
	#streaming = "";
	/** 流式文本里已经交出去的行数 */
	#committedStreamLines = 0;
	#reasoning = "";
	#reasoningStartedAt: number | undefined;
	#running: RunningTool[] = [];
	/** 上一条交出去的行是不是空行；块与块之间只补一次空行。 */
	#lastBlank = true;

	constructor(width: number) {
		this.#width = Math.max(1, width);
	}

	/** 窗口尺寸变了，后续按新宽度重排。已经提交的行不受影响。 */
	resize(width: number): void {
		this.#width = Math.max(1, width);
	}

	/**
	 * 使用者提交了一句话：整块铺底并上下各留一行，正文在块内居中；多行消息整块增高，不截断。
	 *
	 * `width` 是条目总宽（含竖线列与左右留白），由界面按当前终端宽度算好传入。
	 */
	userTurn(text: string, width: number): readonly Line[] {
		const inner = entryContentWidth(width);
		const lines = wrapLine(plain(text), {
			width: inner,
			firstIndent: styled("› ", ACCENT),
			restIndent: plain("  "),
		});
		const prefix = plain(" ".repeat(ACCENT_WIDTH + BLOCK_PAD_LEFT));
		const band = (line: Line): Line => this.#band(concat(prefix, line), width);
		const blank = this.#band(plain(""), width);
		this.#lastBlank = true;
		return [blank, ...lines.map(band), blank];
	}

	/** 处理一个事件，返回因此要提交进会话区的行。 */
	handle(event: AgentEvent, now: number): readonly Line[] {
		const lines = this.#dispatch(event, now);
		this.#track(lines);
		return lines;
	}

	#dispatch(event: AgentEvent, now: number): readonly Line[] {
		switch (event.type) {
			case "text_delta":
				this.#streaming += event.text;
				return this.#join([this.#closeThinking(now)]);
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
				return this.#join([this.#closeThinking(now), this.#drainStream()]);
			case "tool_update": {
				const tool = this.#running.find((item) => item.callId === event.callId);
				if (tool !== undefined) tool.update = event.text;
				return [];
			}
			case "tool_end": {
				const index = this.#running.findIndex((item) => item.callId === event.callId);
				const tool = index < 0 ? undefined : this.#running.splice(index, 1)[0];
				return this.#join([this.#closeThinking(now), this.#drainStream(), this.#toolResult(event, tool)]);
			}
			case "error":
				return this.#join([
					this.#closeThinking(now),
					this.#drainStream(),
					this.#message(styled(`✗ Error: ${event.message}`, BAD), BAD),
				]);
			case "aborted":
				return this.#join([
					this.#closeThinking(now),
					this.#drainStream(),
					this.#message(styled("◇ Cancelled", DIM), undefined),
				]);
			case "compaction_start":
				// 摘要要花一会儿，先把已经写出来的回答定下来，再说明为什么停下来
				return this.#join([
					this.#closeThinking(now),
					this.#drainStream(),
					this.#message(
						styled(
							`Context is long; summarizing the previous ${event.messages} messages (~${formatTokens(event.tokensBefore)} tokens)`,
							DIM,
						),
						undefined,
					),
				]);
			case "compaction_end":
				return this.#join([
					this.#message(
						styled(
							`Context compacted: ${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens; the full history is still in the session file`,
							DIM,
						),
						undefined,
					),
				]);
			case "compaction_failed":
				return this.#join([
					this.#message(
						styled(`Compaction failed; continuing with the full context: ${event.message}`, DIM),
						undefined,
					),
				]);
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
			const accent = pulseStyle(options.now, 0);
			lines.push(blockLine(rail(accent), concat(styled(THOUGHT_MARK, accent), styled("Thinking…", DIM))));
			const preview = wrapLine(mapLine(plain(this.#reasoning), (style) => mergeStyles(style, DIM)), {
				width: this.#contentWidth(),
			});
			lines.push(
				...preview
					.slice(-REASONING_PREVIEW_LINES)
					.map((line, index) => blockLine(rail(pulseStyle(options.now, index + 1)), line)),
			);
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
		const lines = this.#join([this.#closeThinking(now), this.#drainStream()]);
		this.#track(lines);
		return lines;
	}

	/** 本轮中止或出错后，工具痕迹不该留在屏幕上。 */
	clearRunning(): void {
		this.#running = [];
	}

	/**
	 * 把这次事件产生的几个块拼起来，块与块之间补一行空白。
	 *
	 * 上一块自己已经以空行收尾（用户消息的上下留白、markdown 的空段落）时不重复补。
	 */
	#join(parts: readonly (readonly Line[])[]): readonly Line[] {
		const lines: Line[] = [];
		let blank = this.#lastBlank;
		for (const part of parts) {
			if (part.length === 0) continue;
			if (!blank) lines.push(plain(""));
			lines.push(...part);
			blank = lineText(part[part.length - 1]).trim().length === 0;
		}
		return lines;
	}

	#track(lines: readonly Line[]): void {
		const last = lines[lines.length - 1];
		if (last !== undefined) this.#lastBlank = lineText(last).trim().length === 0;
	}

	/** 整行铺底：底色要盖住文字，所以先把样式并到每个片段上，再补满到条目总宽。 */
	#band(line: Line, width: number): Line {
		return padLine(mapLine(line, (style) => mergeStyles(style, BAND)), width, BAND);
	}

	/** 推理收尾：把「想了多久」定成一行留在会话里，草稿本身不留。 */
	#closeThinking(now: number): readonly Line[] {
		if (this.#reasoning.length === 0) return [];
		const elapsed = now - (this.#reasoningStartedAt ?? now);
		this.#reasoning = "";
		this.#reasoningStartedAt = undefined;
		// 收尾后是折叠状态：按参考实现的做法，折叠块不画竖线
		return [blockLine(plain(" "), concat(styled(THOUGHT_MARK, FAINT), styled(`Thought for ${formatDuration(elapsed)}`, DIM)))];
	}

	#drainStream(): readonly Line[] {
		if (this.#streaming.length === 0) return [];
		const rest = this.#renderStream().slice(this.#committedStreamLines);
		this.#streaming = "";
		this.#committedStreamLines = 0;
		return rest;
	}

	/** 把还没定型的回答画出来。markdown 按正文宽度排版，再补上块左侧的竖线列与留白。 */
	#renderStream(): readonly Line[] {
		return renderMarkdown(this.#streaming, { width: this.#contentWidth() }).lines.map(agentLine);
	}

	/** 正在跑的工具：竖线与菱形带上明暗波，右边带上最近一行输出。 */
	#runningToolLine(tool: RunningTool, now: number): Line {
		const accent = pulseStyle(now);
		const head = blockLine(
			rail(accent),
			concat(
				styled(TOOL_MARK, accent),
				styled(tool.name, TEXT),
				plain(tool.args.length === 0 ? "" : ` ${tool.args}`),
			),
		);

		const tail = lastOutputLine(tool.update);
		if (tail === undefined) return head;
		return alignEnds(head, truncateLine(styled(tail, DIM), Math.max(1, Math.floor(this.#contentWidth() / 3))), HEADER_WIDTH(this.#width));
	}

	#toolResult(event: Extract<AgentEvent, { type: "tool_end" }>, tool: RunningTool | undefined): readonly Line[] {
		const accent = event.isError ? BAD : FAINT;
		const args = tool?.args ?? "";
		const head = blockLine(
			rail(accent),
			concat(
				styled(TOOL_MARK, event.isError ? BAD : FAINT),
				styled(event.name, event.isError ? BAD : TEXT),
				plain(args === "" ? "" : ` ${args}`),
			),
		);
		const header = alignEnds(head, styled(formatDuration(event.durationMs), DIM), HEADER_WIDTH(this.#width));
		// 成功时一行就够；失败时把原因单独说一行——这是使用者唯一需要知道的东西
		return event.isError ? [header, ...this.#message(styled(event.summary, BAD), BAD)] : [header];
	}

	/** 把一条系统消息折到正文宽度，再补上块的左侧竖线列。 */
	#message(line: Line, accent: Style | undefined): readonly Line[] {
		return wrapLine(line, { width: this.#contentWidth() }).map((wrapped) => blockLine(rail(accent), wrapped));
	}

	#contentWidth(): number {
		return entryContentWidth(this.#width);
	}
}

/** 块的左竖线；没有颜色时留一格空白，正文列不会因为块类型而漂移。 */
function rail(style: Style | undefined): Line {
	return style === undefined ? plain(" ") : styled(BAR, style);
}

/** 运行中块的强调色：沿行号错开相位的明暗波。 */
function pulseStyle(now: number, row = 0): Style {
	const wave = (Math.sin(now * PULSE_RADIANS_PER_MS + row * 0.9) + 1) / 2;
	return { color: blend(THEME.base, THEME.accent, PULSE_MIN + (1 - PULSE_MIN) * wave) };
}

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
	return [
		Math.round(from[0] + (to[0] - from[0]) * amount),
		Math.round(from[1] + (to[1] - from[1]) * amount),
		Math.round(from[2] + (to[2] - from[2]) * amount),
	];
}

/** 竖线、正文前留白与正文。 */
function blockLine(accent: Line, content: Line): Line {
	return concat(accent, plain(" ".repeat(BLOCK_PAD_LEFT)), content);
}

/** 模型正文没有竖线，但仍保留竖线列与左留白，和工具行从同一列开始。 */
function agentLine(line: Line): Line {
	return line.length === 0 ? [] : blockLine(plain(" "), line);
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

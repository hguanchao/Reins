import { Check, Copy, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState, type ReactElement } from "react";

import { groupTurns, type Turn } from "../transcript/blocks.ts";
import { groupToolRuns, type Line, type ToolLine } from "../transcript/lines.ts";
import { MarkdownView } from "../transcript/markdown-view.tsx";
import { ThinkingBlock } from "./thinking-block.tsx";
import { ToolRun } from "./tool-call-row.tsx";
import { NoticeLine, UserMessage } from "./user-message.tsx";

/** 一轮里的块：一条普通行，或一段连续的工具调用。 */
type Block =
	| { readonly kind: "line"; readonly line: Exclude<Line, ToolLine> }
	| { readonly kind: "tools"; readonly items: readonly ToolLine[] };

function blocksOf(turn: Turn): readonly Block[] {
	const blocks: Block[] = [];
	for (const block of groupToolRuns(turn.lines)) {
		if (block.kind === "tools") {
			blocks.push({ kind: "tools", items: block.items });
			continue;
		}
		if (block.line.kind === "tool") continue;
		blocks.push({ kind: "line", line: block.line });
	}
	return blocks;
}

/** 思考块的摘要：取首句，压到 24 字内，读起来像一条注记而不是第二段正文。 */
function thinkSummary(text: string): string {
	const firstLine = text.replaceAll("\r\n", "\n").trim().split("\n")[0] ?? "";
	const clean = firstLine.replace(/^[#>*\-\s]+/, "");
	return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}

function TurnActions({
	text,
	onRegenerate,
}: {
	readonly text: string | undefined;
	readonly onRegenerate: ((text: string) => void) | undefined;
}): ReactElement {
	const [copied, setCopied] = useState(false);
	const [vote, setVote] = useState<"up" | "down" | undefined>(undefined);

	const copy = (): void => {
		if (text === undefined) return;
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		});
	};

	return (
		<div className="turn-actions">
			{text === undefined ? null : (
				<button type="button" onClick={copy} title={copied ? "已复制" : "复制"} aria-label="复制">
					{copied ? <Check className="ic-12" /> : <Copy className="ic-12" />}
				</button>
			)}
			{text !== undefined && onRegenerate !== undefined ? (
				<button
					type="button"
					onClick={() => onRegenerate(text)}
					title="重新生成：把这条提问再发一次"
					aria-label="重新生成"
				>
					<RefreshCw className="ic-12" />
				</button>
			) : null}
			<button
				type="button"
				onClick={() => setVote((value) => (value === "up" ? undefined : "up"))}
				aria-pressed={vote === "up"}
				title="这轮回答有用"
				aria-label="赞"
				style={vote === "up" ? { color: "var(--ink)", background: "var(--wash)" } : undefined}
			>
				<ThumbsUp className="ic-12" />
			</button>
			<button
				type="button"
				onClick={() => setVote((value) => (value === "down" ? undefined : "down"))}
				aria-pressed={vote === "down"}
				title="这轮回答没解决问题"
				aria-label="踩"
				style={vote === "down" ? { color: "var(--ink)", background: "var(--wash)" } : undefined}
			>
				<ThumbsDown className="ic-12" />
			</button>
		</div>
	);
}

function TurnView({
	turn,
	askIndex,
	running,
	onRegenerate,
}: {
	readonly turn: Turn;
	readonly askIndex: number | undefined;
	readonly running: boolean;
	readonly onRegenerate: ((text: string) => void) | undefined;
}): ReactElement {
	const blocks = blocksOf(turn);
	// 轮末操作条只出现在跑完的回合上，运行中的回答不该有「重新生成」
	const answerText = turn.lines
		.filter((line): line is Extract<Line, { kind: "assistant" }> => line.kind === "assistant")
		.map((line) => line.text)
		.join("\n\n")
		.trim();
	const streaming = turn.lines.some(
		(line) => (line.kind === "assistant" || line.kind === "thinking") && line.open,
	);

	return (
		<div className="turn">
			{turn.ask === undefined ? null : <UserMessage text={turn.ask.text} lineIndex={askIndex ?? 0} />}
			<div className="say">
				{blocks.map((block, position) =>
					block.kind === "tools" ? (
						<ToolRun key={`tools-${position}`} items={block.items} />
					) : block.line.kind === "assistant" ? (
						block.line.text.length === 0 ? null : (
							<div key={`say-${position}`} style={{ marginBottom: 11 }}>
								<MarkdownView text={block.line.text} streaming={block.line.open} />
							</div>
						)
					) : block.line.kind === "thinking" ? (
						<ThinkingBlock
							key={`think-${position}`}
							text={block.line.text}
							streaming={block.line.open}
							summary={thinkSummary(block.line.text)}
						/>
					) : block.line.kind === "notice" ? (
						<NoticeLine key={`notice-${position}`} text={block.line.text} tone={block.line.tone} />
					) : null,
				)}
				{streaming || running ? null : (
					<TurnActions text={answerText.length === 0 ? undefined : answerText} onRegenerate={onRegenerate} />
				)}
			</div>
		</div>
	);
}

/**
 * 会话流。
 *
 * 按提问切回合，轮内按「提问 → 回答 → 工具 → 思考」铺排；工具调用连续出现时并成一段，
 * 由工具卡自己决定折叠成一行还是内联 diff。这里不做视觉装饰，排版交给 CSS。
 */
export function TranscriptView({
	lines,
	running,
	onRegenerate,
}: {
	readonly lines: readonly Line[];
	readonly running: boolean;
	onRegenerate?: (text: string) => void;
}): ReactElement {
	const turns = groupTurns(lines);
	const indexes = new Map<Line, number>(lines.map((line, index): [Line, number] => [line, index]));
	return (
		<div className="flow" aria-live="polite">
			{turns.map((turn) => (
				<TurnView
					key={turn.index}
					turn={turn}
					askIndex={turn.ask === undefined ? undefined : indexes.get(turn.ask)}
					running={running}
					onRegenerate={onRegenerate}
				/>
			))}
		</div>
	);
}

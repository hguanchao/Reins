import { Files, FolderTree, LoaderCircle, Search, CircleX } from "lucide-react";
import { useState, type ReactElement } from "react";

import { DiffView } from "../components/diff-view.tsx";
import { toolCardsExpanded } from "../state/preferences.ts";
import { formatDuration } from "../lib/format.ts";
import type { ToolLine } from "../transcript/lines.ts";
import { splitToolRun, toolAction, type ToolBlock, type ToolGroup } from "../transcript/blocks.ts";
import { detailText, diffOf, toolDiffStats, toolIcon, toolPrimary, toolOutput, toolVerb } from "./tool-meta.ts";

/** 路径用等宽字，其余保持正常语气：一眼能分出「动作」与「对象」。 */
function Summary({
	name,
	args,
}: {
	readonly name: string;
	readonly args: Record<string, unknown> | undefined;
}): ReactElement {
	const primary = toolPrimary(name, args);
	const action = toolAction(name);
	if (action === "skill") {
		return (
			<span className="sum">
				执行 技能 <span className="path">{primary ?? ""}</span>
			</span>
		);
	}
	if (action === "mcp") {
		return (
			<span className="sum">
				调用 连接器 <span className="path">{primary ?? name.replace(/^mcp__[^_]+__/, "")}</span>
			</span>
		);
	}
	if (primary === undefined) return <span className="sum">{toolVerb(name)}</span>;
	return (
		<span className="sum">
			{toolVerb(name)} <span className="path">{primary}</span>
		</span>
	);
}

/**
 * 单条工具卡。
 *
 * 单行 30px，网格 `图标 | 摘要 | 读数`，不画折叠箭头——整行可点即操作。写入类把 diff
 * 直接摊在行下（再点一次收起），读取与运行类点开才看输出。
 */
export function ToolCallRow({ line }: { readonly line: ToolLine }): ReactElement {
	const [open, setOpen] = useState(toolCardsExpanded);
	const Icon = toolIcon(line.name);
	const diff = diffOf(line.details);
	const body = toolOutput(line.content, line.detail);
	const stats = toolDiffStats(line.details);
	const inline = diff !== undefined;
	const clickable = inline || body.length > 0;
	const duration = line.durationMs === undefined ? undefined : formatDuration(line.durationMs);

	return (
		<>
			<button
				type="button"
				onClick={clickable ? () => setOpen((value) => !value) : undefined}
				aria-expanded={clickable ? open : undefined}
				title={clickable ? (inline ? "收起/展开改动" : "展开输出") : undefined}
				className={`tool${line.running ? " running" : ""}${line.isError ? " failed" : ""}`}
			>
				<span className="ti">
					<Icon className="ic ic-14" />
				</span>
				<Summary name={line.name} args={line.args} />
				<span className="ts">
					{line.isError ? (
						<span className="err">
							<CircleX className="ic ic-12" />
							{line.summary ?? "执行失败"}
						</span>
					) : line.running ? (
						<>
							<LoaderCircle className="ic ic-12 spin" />
							{duration === undefined ? null : <span className="dur">{duration}</span>}
						</>
					) : (
						<>
							{stats.added === 0 && stats.removed === 0 ? null : (
								<>
									<span className="add">+{stats.added}</span>
									{stats.removed === 0 ? null : <span className="del">−{stats.removed}</span>}
								</>
							)}
							{duration === undefined ? null : <span className="dur">{duration}</span>}
						</>
					)}
				</span>
			</button>

			{inline ? (
				open ? null : <DiffView diff={diff} />
			) : open ? (
				<pre className="tool-output">{body.length === 0 ? detailText(line.details) : body}</pre>
			) : null}
		</>
	);
}

/** 连续同类读取折叠成一行摘要；点开展开逐行明细。 */
function GroupRow({ group }: { readonly group: ToolGroup }): ReactElement {
	const [open, setOpen] = useState(toolCardsExpanded);
	const running = group.items.some((item) => item.running);
	const failed = group.items.some((item) => item.isError);
	const durationMs = group.items.reduce((total, item) => total + (item.durationMs ?? 0), 0);
	const Icon = group.lists > 0 ? FolderTree : group.searches > 0 ? Search : Files;

	const parts: string[] = [];
	if (group.reads > 0) parts.push(`读取 ${group.reads} 个文件`);
	if (group.searches > 0) parts.push(`搜索 ${group.searches} 处`);
	if (group.lists > 0) parts.push(`列目录 ${group.lists} 次`);

	return (
		<div className={`tgroup${open ? " open" : ""}`}>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				title="展开明细"
				className={`tool${running ? " running" : ""}${failed ? " failed" : ""}`}
			>
				<span className="ti">
					<Icon className="ic ic-14" />
				</span>
				<span className="sum">{parts.join(" · ")}</span>
				<span className="ts">
					{running ? <LoaderCircle className="ic ic-12 spin" /> : null}
					{durationMs === 0 ? null : <span className="dur">{formatDuration(durationMs)}</span>}
				</span>
			</button>
			<div className="tchildren">
				{group.items.map((item) => (
					<ToolCallRow key={item.callId} line={item} />
				))}
			</div>
		</div>
	);
}

/** 一段连续工具调用：先按动作分流，再决定并组还是独立成行。 */
export function ToolRun({ items }: { readonly items: readonly ToolLine[] }): ReactElement {
	const blocks: readonly ToolBlock[] = splitToolRun(items);
	return (
		<div className="tools">
			{blocks.map((block) =>
				block.kind === "group" ? (
					<GroupRow key={block.items[0]?.callId ?? "group"} group={block} />
				) : (
					<ToolCallRow key={block.line.callId} line={block.line} />
				),
			)}
		</div>
	);
}

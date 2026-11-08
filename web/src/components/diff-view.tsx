import { FileText } from "lucide-react";
import type { ReactElement } from "react";

import { parseDiff, type DiffRow } from "../transcript/diff.ts";

/** diff 单行：行号一列 + 代码列，增删只靠底色区分，不加号列。 */
function Row({ row }: { readonly row: DiffRow }): ReactElement {
	return (
		<div className={`dl ${row.kind === "ctx" ? "" : row.kind}`}>
			<span className="ln">{row.no}</span>
			<span className="cd">{row.text.length === 0 ? " " : row.text}</span>
		</div>
	);
}

/**
 * 内联 diff。
 *
 * 对齐主流 agent 工具：单列行号（连续不跳号）+ 代码列，没有加减号列也没有 hunk 头。
 * 内容行数超过上限时只显示前若干行，并在末尾说明省略了多少行。
 */
export function DiffView({
	diff,
	maxRows = 40,
	showHeader = true,
	onMore,
}: {
	readonly diff: string;
	readonly maxRows?: number;
	readonly showHeader?: boolean;
	readonly onMore?: () => void;
}): ReactElement {
	const sections = parseDiff(diff, maxRows);
	return (
		<>
			{sections.map((section, index) => (
				<div key={`${section.path ?? "diff"}-${index}`} className="diff">
					{showHeader ? (
						<div className="diff-h">
							<FileText className="ic ic-12" />
							<span>{section.path ?? "diff"}</span>
							<span className="stat">
								<span className="num">+{section.added}</span>
								{section.removed === 0 ? null : (
									<span className="num" style={{ color: "var(--ink-3)" }}>
										−{section.removed}
									</span>
								)}
							</span>
						</div>
					) : null}
					<div className="diff-b">
						{section.rows.map((row, position) => (
							<Row key={`${row.no}-${position}`} row={row} />
						))}
						{section.hidden === 0 ? null : (
							<button type="button" className="dmore" onClick={onMore} disabled={onMore === undefined}>
								⋯ 其余 {section.hidden} 行未显示
							</button>
						)}
					</div>
				</div>
			))}
		</>
	);
}

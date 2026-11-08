import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import type { FileTreeEntry, GitFileChange, GitStatus } from "../protocol.ts";

/**
 * 文件面板。
 *
 * 一棵按层加载的树：目录展开时才请求下一层，.gitignore 由服务端处理。变更标记只用等宽
 * 单字母（M/A/D）而不是彩色圆点——这套系统里没有语义色。
 */
export function FilesPane({
	git,
	onOpenFile,
}: {
	readonly git: GitStatus | null;
	onOpenFile(path: string): void;
}): ReactElement {
	const [children, setChildren] = useState<Record<string, readonly FileTreeEntry[]>>({});
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));
	const [error, setError] = useState<string | undefined>(undefined);

	const changes = useMemo(() => {
		const map = new Map<string, GitFileChange>();
		for (const file of git?.files ?? []) map.set(file.path, file);
		return map;
	}, [git]);

	const load = useCallback((path: string): void => {
		void api
			.fileTree(path)
			.then((tree) => {
				setChildren((current) => ({ ...current, [path]: tree.entries }));
				setError(undefined);
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : String(cause));
			});
	}, []);

	useEffect(() => {
		load("");
	}, [load]);

	const toggle = (path: string): void => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
				if (children[path] === undefined) load(path);
			}
			return next;
		});
	};

	const renderLevel = (parent: string, depth: number): ReactElement[] => {
		const entries = children[parent];
		if (entries === undefined) return [];
		if (entries.length === 0) {
			return [
				<div
					key={`empty-${parent}`}
					className="tree-row"
					style={{ paddingLeft: 10 + depth * 14, color: "var(--ink-4)" }}
				>
					空目录
				</div>,
			];
		}
		return entries.map((entry) => {
			const directory = entry.kind === "directory";
			const open = expanded.has(entry.path);
			const change = changes.get(entry.path);
			return (
				<div key={entry.path}>
					<button
						type="button"
						onClick={() => (directory ? toggle(entry.path) : onOpenFile(entry.path))}
						className="tree-row"
						style={{ paddingLeft: 4 + depth * 14 }}
					>
						{directory ? (
							open ? (
								<ChevronDown className="ic-12" style={{ color: "var(--ink-4)" }} />
							) : (
								<ChevronRight className="ic-12" style={{ color: "var(--ink-4)" }} />
							)
						) : (
							<span style={{ width: 12, flex: "none" }} />
						)}
						{directory ? (
							open ? (
								<FolderOpen className="ic-14" />
							) : (
								<Folder className="ic-14" />
							)
						) : (
							FileIcon(entry.name)
						)}
						<span className="min-w-0 flex-1 truncate">{entry.name}</span>
						{change === undefined ? null : <span className="badge">{gitLetter(change)}</span>}
					</button>
					{directory && open ? renderLevel(entry.path, depth + 1) : null}
				</div>
			);
		});
	};

	return (
		<>
			{error === undefined ? null : (
				<div className="panel-sec" style={{ letterSpacing: 0, color: "var(--ink)" }}>
					{error}
				</div>
			)}
			<div className="panel-sec">
				工作区
				<span className="n">{git?.branch ?? "—"}</span>
			</div>
			<div className="tree">{renderLevel("", 0)}</div>
		</>
	);
}

function FileIcon(name: string): ReactElement {
	const code = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|py|go|rs|java|sh|yml|yaml|toml)$/i.test(name);
	return code ? <FileCode2 className="ic-14" /> : <FileText className="ic-14" />;
}

function gitLetter(change: GitFileChange): string {
	if (change.kind === "untracked") return "U";
	if (change.kind === "added") return "A";
	if (change.kind === "deleted") return "D";
	if (change.kind === "renamed") return "R";
	if (change.kind === "modified") return "M";
	if (change.kind === "conflicted") return "!";
	return "?";
}

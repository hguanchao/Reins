import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import type { FileTreeEntry, GitFileChange, GitStatus } from "../protocol.ts";

/**
 * 文件面板。
 *
 * 上半是按层加载的树：目录展开时才请求下一层，.gitignore 由服务端处理。下半是「变更」
 * 分组，一眼看到这次改了哪些文件。变更标记只用等宽单字母（M/A/D）而不是彩色圆点——
 * 这套系统里没有语义色。选中的文件名加「rename」强调。
 */
export function FilesPane({
	git,
	workspace,
}: {
	readonly git: GitStatus | null;
	readonly workspace: string;
}): ReactElement {
	const [children, setChildren] = useState<Record<string, readonly FileTreeEntry[]>>({});
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));
	const [selected, setSelected] = useState<string | undefined>(undefined);
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
						aria-selected={selected === entry.path}
						onClick={() => (directory ? toggle(entry.path) : setSelected(entry.path))}
						className="tree-row"
						style={{ paddingLeft: 4 + depth * 14 }}
					>
						{directory ? (
							open ? (
								<ChevronDown className="ic ic-12" style={{ color: "var(--ink-4)" }} />
							) : (
								<ChevronRight className="ic ic-12" style={{ color: "var(--ink-4)" }} />
							)
						) : (
							<span style={{ width: 12, flex: "none" }} />
						)}
						{directory ? (
							open ? (
								<FolderOpen className="ic ic-14" />
							) : (
								<Folder className="ic ic-14" />
							)
						) : (
							FileIcon(entry.name)
						)}
						<span className={`min-w-0 flex-1 truncate${selected === entry.path ? " rename" : ""}`}>
							{entry.name}
						</span>
						{change === undefined ? null : <span className="badge">{gitLetter(change)}</span>}
					</button>
					{directory && open ? renderLevel(entry.path, depth + 1) : null}
				</div>
			);
		});
	};

	const modified = git?.files.filter((file) => file.kind === "modified" || file.kind === "conflicted") ?? [];
	const added = git?.files.filter((file) => file.kind === "added" || file.kind === "untracked") ?? [];

	return (
		<>
			{error === undefined ? null : (
				<div className="panel-sec" style={{ letterSpacing: 0, color: "var(--ink)" }}>
					{error}
				</div>
			)}
			<div className="panel-sec">
				工作区
				<span className="n">{workspace.length === 0 ? "—" : workspace}</span>
			</div>
			<div className="tree">{renderLevel("", 0)}</div>

			{git === null || git.files.length === 0 ? null : (
				<>
					<div className="panel-sec">
						变更
						<span className="n">
							{modified.length} MODIFIED · {added.length} NEW
						</span>
					</div>
					<div className="tree" style={{ paddingTop: 2 }}>
						{git.files.map((file) => (
							<button
								key={file.path}
								type="button"
								aria-selected={selected === file.path}
								onClick={() => setSelected(file.path)}
								className="git-row"
							>
								<span className="st-mk">{gitLetter(file)}</span>
								<span className="fn">
									{splitPath(file.path).map((part, index) =>
										part.em ? <em key={index}>{part.text}</em> : <span key={index}>{part.text}</span>,
									)}
								</span>
							</button>
						))}
					</div>
				</>
			)}
		</>
	);
}

/** 变更行拆成 目录 / 文件名(强调) / 扩展名 三段；文件名是扫读锚点，用 <em> 提示。 */
function splitPath(path: string): readonly { readonly text: string; readonly em: boolean }[] {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const directory = slash === -1 ? "" : path.slice(0, slash + 1);
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return [{ text: directory, em: false }, { text: name, em: true }];
	return [
		{ text: directory, em: false },
		{ text: name.slice(0, dot), em: true },
		{ text: name.slice(dot), em: false },
	];
}

function FileIcon(name: string): ReactElement {
	const code = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|py|go|rs|java|sh|yml|yaml|toml)$/i.test(name);
	return code ? <FileCode2 className="ic ic-14" /> : <FileText className="ic ic-14" />;
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

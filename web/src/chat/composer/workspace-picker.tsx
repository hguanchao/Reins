import { FolderOpen, Plus, Search } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { api } from "../../api.ts";
import { cn } from "../../components/ui/cn.ts";
import { desktopBridge } from "../../platform.ts";

/** 工作区浮层：搜索 + 最近工作空间 + 新建 / 打开本地文件夹。 */
export function WorkspacePicker({
	name,
	onPick,
	onNewWorkspace,
}: {
	readonly name: string;
	onPick(path: string | null): void;
	onNewWorkspace(): void;
}): ReactElement {
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<readonly { readonly path: string; readonly name: string }[]>([]);
	const bridge = desktopBridge();

	useEffect(() => {
		void api
			.workspaces()
			.then(setItems)
			.catch(() => {});
	}, []);

	const filtered = items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));

	return (
		<>
			<div className="wsp-search">
				<Search className="ic ic-12" aria-hidden="true" />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索工作区"
					aria-label="搜索工作区"
				/>
			</div>
			<div className="wsp-list">
				{filtered.length === 0 ? (
					<div className="pop-i" style={{ pointerEvents: "none", color: "var(--ink-3)" }}>
						没有匹配的工作区
					</div>
				) : (
					filtered.map((item) => (
						<button
							key={item.path}
							type="button"
							className={cn("pop-i", item.name === name && "on")}
							onClick={() => onPick(item.path)}
						>
							<FolderOpen className="ic ic-14" />
							<span className="n">{item.name}</span>
						</button>
					))
				)}
			</div>
			<div className="pop-sep" />
			{bridge === undefined ? null : (
				<>
					<button type="button" className="pop-i" onClick={onNewWorkspace}>
						<Plus className="ic ic-14" />
						新建工作空间
					</button>
					<button
						type="button"
						className="pop-i"
						onClick={() => {
							void bridge.chooseWorkspace().then((chosen) => {
								if (chosen) onPick(null);
							});
						}}
					>
						<FolderOpen className="ic ic-14" />
						打开本地文件夹…
					</button>
				</>
			)}
			</>
	);
}

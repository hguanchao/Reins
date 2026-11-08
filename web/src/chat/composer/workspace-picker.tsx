import { FolderOpen, Plus, ZapOff } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { api } from "../../api.ts";
import { cn } from "../../components/ui/cn.ts";
import { desktopBridge } from "../../platform.ts";

/** 工作区浮层：搜索 + 最近工作空间 + 打开本地文件夹。 */
export function WorkspacePicker({
	name,
	onPick,
}: {
	readonly name: string;
	onPick(path: string | null): void;
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
				<svg className="ic-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
					<path d="m21 21-4.34-4.34" />
					<circle cx="11" cy="11" r="8" />
				</svg>
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
							<FolderOpen className="ic-14" />
							<span className="n">{item.name}</span>
						</button>
					))
				)}
			</div>
			<div className="pop-sep" />
			{bridge === undefined ? null : (
				<button
					type="button"
					className="pop-i"
					onClick={() => {
						void bridge.chooseWorkspace().then((chosen) => {
							if (chosen) onPick(null);
						});
					}}
				>
					<Plus className="ic-14" />
					打开本地文件夹…
				</button>
			)}
			<button type="button" className="pop-i" onClick={() => onPick(null)}>
				<ZapOff className="ic-14" />
				不绑定工作区
			</button>
		</>
	);
}

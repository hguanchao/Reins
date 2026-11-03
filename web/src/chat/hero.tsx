import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { BrandMark } from "../components/brand-mark.tsx";
import { Menu } from "../components/ui/index.ts";
import { desktopBridge } from "../platform.ts";

/** 新会话欢迎页：鱼形标题、工作区选择与输入卡。 */
export function Hero({
	workspace,
	composer,
}: {
	readonly workspace: string;
	readonly composer: ReactNode;
}): ReactElement {
	const bridge = desktopBridge();
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6">
			<div className="flex w-full max-w-[calc(var(--chat-content-width)_+_32px)] flex-col gap-3 pb-8">
				<div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-3 text-[26px] leading-8 font-medium text-foreground">
					<BrandMark size={34} className="text-foreground" />
					<span className="flex min-w-0 flex-wrap items-center justify-center gap-x-[7px] gap-y-1">
						<span>探索未至之境</span>
						<span className="mt-0.5 self-start rounded-full border-[0.5px] border-border bg-[var(--business-blue-soft)] px-[7px] pb-px pt-[1px] font-mono text-[12px] leading-[18px] font-medium text-(--business-blue)">
							预览版
						</span>
					</span>
				</div>

				<div className="flex min-w-0 flex-col gap-3">
					<div className="flex items-center pl-2">
						<Menu
							align="start"
							trigger={({ toggle, open }) => (
								<button
									type="button"
									onClick={toggle}
									aria-label="选择工作区"
									aria-haspopup="menu"
									aria-expanded={open}
									className="flex min-h-7 max-w-[min(100%,360px)] items-center gap-1 rounded-sm px-2 text-[13px] leading-5 font-medium text-foreground transition-colors hover:bg-surface-hover aria-expanded:bg-surface-hover"
								>
									{workspace.length === 0 ? (
										<Folder className="size-4 shrink-0" />
									) : (
										<FolderOpen className="size-4 shrink-0" />
									)}
									<span className="min-w-0 truncate">{workspace || "选择工作区"}</span>
									<ChevronDown className="size-3 shrink-0 text-foreground-subtlest" />
								</button>
							)}
							entries={[
								{ type: "label", label: "工作区" },
								{
									type: "item",
									key: "current",
									label: workspace || "当前工作区",
									checked: workspace.length > 0,
									onSelect: () => {},
								},
								{ type: "separator" },
								{
									type: "item",
									key: "open",
									label: bridge === undefined ? "打开其他工作区（桌面端可用）" : "打开其他工作区…",
									disabled: bridge === undefined,
									onSelect: () => {
										void bridge?.chooseWorkspace();
									},
								},
							]}
						/>
					</div>
					{composer}
				</div>
			</div>
		</div>
	);
}

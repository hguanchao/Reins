import { PanelLeft } from "lucide-react";
import type { ReactElement } from "react";

/** 桌面壳注入的窗口能力;浏览器里不存在,菜单条随之隐藏。 */
declare global {
	interface Window {
		reinsDesktop?: { showMenu(kind: "edit" | "window" | "help" | "about"): void };
	}
}

const ITEMS: readonly { kind: "edit" | "window" | "help" | "about"; label: string }[] = [
	{ kind: "edit", label: "编辑" },
	{ kind: "window", label: "窗口" },
	{ kind: "help", label: "帮助" },
	{ kind: "about", label: "关于" },
];

/**
 * 顶部菜单条:无边框窗下它就是最顶行,最左是收起/展开侧栏,点按菜单名弹出原生菜单。
 * 整条是拖拽区(可拖动窗口);浏览器里没有桌面壳,整条不渲染。
 */
export function MenuStrip({ onToggleSidebar }: { onToggleSidebar: () => void }): ReactElement | null {
	if (window.reinsDesktop === undefined) return null;
	return (
		<div className="menustrip">
			<button type="button" className="icon-btn" title="收起/展开侧栏" onClick={onToggleSidebar}>
				<PanelLeft size={16} />
			</button>
			{ITEMS.map((item) => (
				<button
					type="button"
					key={item.kind}
					onClick={() => {
						window.reinsDesktop?.showMenu(item.kind);
					}}
				>
					{item.label}
				</button>
			))}
			<span className="strip-fill" />
		</div>
	);
}

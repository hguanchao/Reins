import { Minus, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { desktopBridge } from "../platform.ts";

/** 主流的窗口按钮图标：最大化是单方框，还原是两个错位方框。 */
function MaximizeIcon({ className }: { readonly className?: string }): ReactElement {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
			className={className}
			aria-hidden="true"
		>
			<rect x="3.5" y="3.5" width="9" height="9" />
		</svg>
	);
}

function RestoreIcon({ className }: { readonly className?: string }): ReactElement {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
			className={className}
			aria-hidden="true"
		>
			<rect x="5.5" y="2.5" width="8" height="8" />
			<path d="M2.5 5.5h8v8h-8z" />
		</svg>
	);
}

/** 渲染层绘制的窗口按钮；浏览器里没有桌面桥，整组不渲染。 */
export function WindowControls(): ReactElement | null {
	const bridge = desktopBridge();
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		if (bridge === undefined) return;
		void bridge.isMaximized().then(setMaximized).catch(() => {});
		return bridge.onMaximizedChange(setMaximized);
	}, [bridge]);

	if (bridge === undefined) return null;
	return (
		<div className="no-drag flex h-full items-stretch">
			<button
				type="button"
				aria-label="最小化"
				title="最小化"
				onClick={() => bridge.minimize()}
				className="flex w-11 items-center justify-center text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
			>
				<Minus className="size-3.5" />
			</button>
			<button
				type="button"
				aria-label={maximized ? "还原" : "最大化"}
				title={maximized ? "还原" : "最大化"}
				onClick={() => bridge.toggleMaximize()}
				className="flex w-11 items-center justify-center text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
			>
				{maximized ? <RestoreIcon className="size-3" /> : <MaximizeIcon className="size-3" />}
			</button>
			<button
				type="button"
				aria-label="关闭"
				title="关闭"
				onClick={() => bridge.close()}
				className="flex w-11 items-center justify-center text-foreground-subtle transition-colors hover:bg-[#e81123] hover:text-white"
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

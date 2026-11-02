import type { ReactElement, ReactNode } from "react";

/** 主体布局：侧栏齐边、主区白底；Side Pane 打开时以分隔线贴在右侧。 */
export function AppShell({
	sidebar,
	children,
	sidePane,
}: {
	readonly sidebar: ReactNode;
	readonly children: ReactNode;
	readonly sidePane?: ReactNode;
}): ReactElement {
	return (
		<div className="flex min-h-0 w-full flex-1 overflow-hidden bg-background">
			{sidebar}
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">{children}</div>
			{sidePane}
		</div>
	);
}

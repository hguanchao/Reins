import type { ReactElement } from "react";

/** 内容列顶栏:当前任务标题 + 用量与连接状态;与整窗白底连成一体,靠留白分层。 */
export function Header({
	title,
	totalTokens,
	connected,
}: {
	title: string;
	totalTokens: number;
	connected: boolean;
}): ReactElement {
	return (
		<header>
			<span className="title">{title}</span>
			<span className="spacer" />
			{totalTokens > 0 && <span className="tokens">{totalTokens.toLocaleString()} tok</span>}
			<span className={"conn" + (connected ? " on" : "")}>{connected ? "connected" : "reconnecting"}</span>
		</header>
	);
}

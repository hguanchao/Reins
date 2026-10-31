import type { ReactElement } from "react";

/** 内容列顶栏:标识、会话标识、用量与连接状态。 */
export function Header({
	sessionId,
	totalTokens,
	connected,
}: {
	sessionId: string;
	totalTokens: number;
	connected: boolean;
}): ReactElement {
	return (
		<header>
			<span className="brand">Reins</span>
			<span className="meta">{sessionId}</span>
			<span className="spacer" />
			{totalTokens > 0 && <span className="tokens">{totalTokens.toLocaleString()} tok</span>}
			<span className={"conn" + (connected ? " on" : "")}>{connected ? "connected" : "reconnecting"}</span>
		</header>
	);
}

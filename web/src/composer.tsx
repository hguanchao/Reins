import { useState, type KeyboardEvent, type ReactElement } from "react";

/** 输入区:Enter 发送、Shift+Enter 换行;回合进行中换成停止按钮。 */
export function Composer({
	running,
	onSend,
	onStop,
}: {
	running: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
}): ReactElement {
	const [text, setText] = useState("");

	const submit = (): void => {
		if (running || text.trim().length === 0) return;
		onSend(text);
		setText("");
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="composer">
			<textarea
				value={text}
				placeholder={running ? "回合进行中…" : "输入消息,Enter 发送,Shift+Enter 换行"}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={onKeyDown}
				rows={2}
			/>
			{running ? (
				<button className="stop" onClick={onStop}>
					停止
				</button>
			) : (
				<button onClick={submit} disabled={text.trim().length === 0}>
					发送
				</button>
			)}
		</div>
	);
}

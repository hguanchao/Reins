import { useState, type KeyboardEvent, type ReactElement } from "react";

/** 输入区:圆角卡壳,Enter 发送、Shift+Enter 换行、Esc 中断;圆形发送钮。 */
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
		if (event.key === "Escape" && running) {
			event.preventDefault();
			onStop();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="composer">
			<div className="shell">
				<textarea
					value={text}
					placeholder={running ? "回合进行中,Esc 可中断…" : "输入消息,Enter 发送,Shift+Enter 换行"}
					rows={1}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
				/>
				<div className="row">
					<span className="hint">Enter 发送 · Shift+Enter 换行{running ? " · Esc 中断" : ""}</span>
					{running ? (
						<button type="button" className="stop" title="中断当前回合 (Esc)" onClick={onStop}>
							<i />
						</button>
					) : (
						<button
							type="button"
							className="send"
							title="发送 (Enter)"
							disabled={text.trim().length === 0}
							onClick={submit}
						>
							↑
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

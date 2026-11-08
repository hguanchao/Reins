import { CircleAlert, Info } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

/** 全局提示；模块级队列让任何组件都能在不接 context 的情况下报一句。 */
export type ToastTone = "info" | "error";

interface ToastItem {
	readonly id: number;
	readonly message: string;
	readonly tone: ToastTone;
}

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function publish(): void {
	for (const listener of listeners) listener();
}

export function toast(message: string, tone: ToastTone = "info"): void {
	const id = nextId;
	nextId += 1;
	items = [...items, { id, message, tone }];
	publish();
	window.setTimeout(() => {
		items = items.filter((item) => item.id !== id);
		publish();
	}, 4000);
}

/** 提示只报结果，不抢焦点；错误态用图标与浮层描边走墨，不整块染色。 */
export function ToastHost(): ReactElement {
	const [snapshot, setSnapshot] = useState<readonly ToastItem[]>(items);

	useEffect(() => {
		const listener = (): void => setSnapshot(items);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);

	return createPortal(
		<div className="toast-host" aria-live="polite">
			{snapshot.map((item) => {
				const Icon = item.tone === "error" ? CircleAlert : Info;
				return (
					<div key={item.id} role="status" className="toast" data-tone={item.tone}>
						<Icon className="ic-14" />
						<span className="min-w-0 break-words">{item.message}</span>
					</div>
				);
			})}
		</div>,
		document.body,
	);
}

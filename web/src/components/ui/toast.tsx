import { CircleAlert, Info } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { cn } from "./cn.ts";

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
		<div className="pointer-events-none fixed right-4 top-16 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
			{snapshot.map((item) => {
				const Icon = item.tone === "error" ? CircleAlert : Info;
				return (
					<div
						key={item.id}
						role="status"
						className={cn(
							"pointer-events-auto flex items-start gap-2 rounded-2xl border bg-toast/80 px-4 py-3 text-ui-base shadow-lg backdrop-blur-xl animate-rise",
							item.tone === "error" ? "border-destructive/30 text-destructive" : "border-border text-foreground",
						)}
					>
						<Icon className="mt-0.5 size-4 shrink-0" />
						<span className="min-w-0 break-words">{item.message}</span>
					</div>
				);
			})}
		</div>,
		document.body,
	);
}

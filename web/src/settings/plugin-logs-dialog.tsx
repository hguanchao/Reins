import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, Dialog } from "../components/ui/index.ts";
import type { PluginLogLevel, PluginLogLine } from "../protocol.ts";

const LOG_COLORS: Record<PluginLogLevel, string> = {
	debug: "text-foreground-subtlest",
	info: "text-foreground-subtle",
	warn: "text-warning",
	error: "text-destructive",
};

function formatLogTime(at: string): string {
	const date = new Date(at);
	return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 插件运行日志：打开时轮询，关闭即停。 */
export function PluginLogsDialog({
	name,
	onClose,
}: {
	readonly name: string | undefined;
	onClose(): void;
}): ReactElement {
	const [logs, setLogs] = useState<readonly PluginLogLine[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [version, setVersion] = useState(0);

	useEffect(() => {
		if (name === undefined) return;
		setLogs([]);
		let cancelled = false;
		const load = (initial: boolean): void => {
			if (initial) {
				setLoading(true);
				setError(undefined);
			}
			void api
				.pluginLogs(name)
				.then((lines) => {
					if (cancelled) return;
					setLogs(lines);
					setError(undefined);
				})
				.catch((cause: unknown) => {
					if (cancelled) return;
					setError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					if (!cancelled && initial) setLoading(false);
				});
		};
		load(true);
		const timer = window.setInterval(() => load(false), 2000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [name, version]);

	return (
		<Dialog
			open={name !== undefined}
			onClose={onClose}
			title={name === undefined ? "插件日志" : `插件日志 · ${name}`}
			className="max-w-[720px]!"
			footer={
				<Button variant="outline" size="sm" onClick={onClose}>
					关闭
				</Button>
			}
		>
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-[11px] leading-4 text-foreground-subtlest">
						最近 {logs.length} 条 · 每 2 秒刷新 · 重启后清空
					</span>
					<Button
						variant="outline"
						size="sm"
						className="h-7 rounded-md px-2.5 text-[12px]"
						onClick={() => setVersion((value) => value + 1)}
					>
						刷新
					</Button>
				</div>
				{loading ? (
					<div className="rounded-xl border-[0.5px] border-border bg-card px-4 py-5 text-[12px] leading-[18px] text-foreground-subtlest">
						正在读取日志…
					</div>
				) : error !== undefined ? (
					<div className="rounded-xl border-[0.5px] border-border bg-card px-4 py-5 text-[12px] leading-[18px] text-destructive">
						{error}
					</div>
				) : logs.length === 0 ? (
					<div className="rounded-xl border-[0.5px] border-border bg-card px-4 py-5 text-[12px] leading-[18px] text-foreground-subtlest">
						还没有日志。插件装载与运行期的输出会出现在这里。
					</div>
				) : (
					<div className="flex max-h-[420px] flex-col gap-1 overflow-y-auto rounded-xl border-[0.5px] border-border bg-card p-3 font-mono text-[11px] leading-[18px]">
						{logs.map((line, index) => (
							<div key={`${line.at}-${index}`} className="flex gap-2">
								<span className="shrink-0 text-foreground-subtlest">{formatLogTime(line.at)}</span>
								<span className={`w-10 shrink-0 uppercase ${LOG_COLORS[line.level]}`}>
									{line.level}
								</span>
								<span className="min-w-0 whitespace-pre-wrap break-all text-foreground-subtle">
									{line.message}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</Dialog>
	);
}

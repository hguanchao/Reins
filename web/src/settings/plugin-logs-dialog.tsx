import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Dialog } from "../components/ui/index.ts";
import type { PluginLogLevel, PluginLogLine } from "../protocol.ts";

const LEVEL_COLOR: Record<PluginLogLevel, string> = {
	debug: "var(--ink-4)",
	info: "var(--ink-3)",
	warn: "var(--ink)",
	error: "var(--danger)",
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
			wide
			footer={
				<button type="button" className="b b-line" onClick={onClose}>
					关闭
				</button>
			}
		>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
				<span className="form-hint">最近 {logs.length} 条 · 每 2 秒刷新 · 重启后清空</span>
				<button type="button" className="b b-line b-sm" onClick={() => setVersion((value) => value + 1)}>
					刷新
				</button>
			</div>
			{loading ? (
				<div className="tool-output">正在读取日志…</div>
			) : error !== undefined ? (
				<div className="tool-output" style={{ color: "var(--danger)" }}>
					{error}
				</div>
			) : logs.length === 0 ? (
				<div className="tool-output">还没有日志。插件装载与运行期的输出会出现在这里。</div>
			) : (
				<div
					style={{
						display: "flex",
						maxHeight: 420,
						flexDirection: "column",
						gap: 2,
						overflowY: "auto",
						padding: 10,
						border: "1px solid var(--rule)",
						borderRadius: "var(--r-2)",
						background: "var(--sunken)",
						fontFamily: "var(--mono)",
						fontSize: "var(--fs-11)",
						lineHeight: 1.7,
					}}
				>
					{logs.map((line, index) => (
						<div key={`${line.at}-${index}`} style={{ display: "flex", gap: 8 }}>
							<span style={{ flex: "none", color: "var(--ink-4)" }}>{formatLogTime(line.at)}</span>
							<span
								style={{ flex: "none", width: 40, textTransform: "uppercase", color: LEVEL_COLOR[line.level] }}
							>
								{line.level}
							</span>
							<span
								style={{ minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--ink-2)" }}
							>
								{line.message}
							</span>
						</div>
					))}
				</div>
			)}
		</Dialog>
	);
}

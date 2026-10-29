import { describeError } from "../../shared/describe-error.ts";
import { MCP_ACTION_HEIGHT } from "../page/frame.ts";
import { stripTerminalStyles } from "../transcript/selection.ts";
import type { TuiHost } from "./types.ts";

/**
 * `/mcps` 页的操作。
 *
 * 页面本身只读连接清单；重连与健康检查都是异步的，结果先放到状态行，再追加一条命令记录。
 * 页面保持打开，连接状态会随下一次绘制刷新。
 */

/** 移动选中的 server；到头即停，不循环。选中项始终留在视口内。 */
export function moveMcpCursor(host: TuiHost, delta: number): void {
	const rows = host.options.mcpServers?.() ?? [];
	if (rows.length === 0) return;
	const state = host.state;
	state.mcpCursor = Math.min(rows.length - 1, Math.max(0, state.mcpCursor + delta));

	// 清单比视口长时，选中项会移出屏幕：按选中行的位置把页面滚动跟上
	const lines = host.pageLines("mcps", host.terminalWidth());
	const selectedLine = lines.findIndex((line) => stripTerminalStyles(line).startsWith("› "));
	if (selectedLine >= 0) {
		const visibleRows = Math.max(1, host.mainAreaHeight() - MCP_ACTION_HEIGHT);
		const top = state.pageScrollTop;
		if (selectedLine < top) state.pageScrollTop = selectedLine;
		else if (selectedLine >= top + visibleRows) state.pageScrollTop = selectedLine - visibleRows + 1;
	}
	host.render();
}

function selectedServer(host: TuiHost): string | undefined {
	const rows = host.options.mcpServers?.() ?? [];
	return rows[host.state.mcpCursor]?.name;
}

/** 重连选中的 server；没有 MCP 连接或没有选中项时什么都不做。 */
export function reconnectMcp(host: TuiHost): void {
	const control = host.options.mcpControl;
	const name = selectedServer(host);
	if (control === undefined || name === undefined) return;

	host.resetStatusMeta();
	host.state.mcpStatus = `Reconnecting ${name}...`;
	host.setStatus(`Reconnecting ${name}...`);
	host.render();
	void control
		.reconnect(name)
		.then((message) => {
			if (host.state.finished) return;
			host.state.mcpStatus = message;
			host.setStatus(message, message.startsWith("Could not") ? "warning" : "notice");
			host.scheduleStatusClear();
			host.appendCommandTurn("/mcps", [message]);
		})
		.catch((error) => {
			if (host.state.finished) return;
			host.state.mcpStatus = "MCP reconnect failed";
			host.setStatus("MCP reconnect failed", "error");
			host.appendCommandTurn("/mcps", [
				{ kind: "error", text: `Error: ${describeError(error)}` },
			]);
		});
}

/** 检查全部 MCP 连接；结果逐行写进命令记录。 */
export function healthCheckMcp(host: TuiHost): void {
	const control = host.options.mcpControl;
	if (control === undefined) return;

	host.resetStatusMeta();
	host.state.mcpStatus = "Checking MCP servers...";
	host.setStatus("Checking MCP servers...");
	host.render();
	void control
		.healthCheck()
		.then((results) => {
			if (host.state.finished) return;
			host.state.mcpStatus = "MCP health check complete";
			host.setStatus("MCP health check complete", "notice");
			host.scheduleStatusClear();
			host.appendCommandTurn(
				"/mcps",
				results.length === 0 ? ["No MCP servers configured."] : results,
			);
		})
		.catch((error) => {
			if (host.state.finished) return;
			host.state.mcpStatus = "MCP health check failed";
			host.setStatus("MCP health check failed", "error");
			host.appendCommandTurn("/mcps", [
				{ kind: "error", text: `Error: ${describeError(error)}` },
			]);
		});
}

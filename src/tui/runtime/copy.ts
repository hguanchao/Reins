import type { TuiOutput } from "../options.ts";
import { STATUS_CLEAR_MS } from "./constants.ts";
import type { TuiHost } from "./types.ts";

/**
 * 复制一段文本。
 *
 * 先交给宿主提供的系统剪贴板；写不进去时退到 OSC 52，让终端自己接住（SSH、容器里没有
 * 剪贴板命令时还有这一条路）。成功提示只占用状态行里 token 计量的位置，超时后 token 数
 * 自动回来，不打断当前正在显示的状态文字。
 */
export async function copyText(host: TuiHost, text: string): Promise<void> {
	if (text.trim().length === 0) return;
	let copied = false;
	let viaTerminal = false;
	try {
		copied = (await host.options.clipboard?.copy(text)) ?? false;
	} catch {
		copied = false;
	}
	if (!copied) {
		viaTerminal = writeOsc52(host.state.stdout, text);
		copied = viaTerminal;
	}

	if (!copied) {
		host.setStatus("Copy failed", "warning");
		host.scheduleStatusClear();
		return;
	}

	const state = host.state;
	// OSC 52 只是把序列写进终端，终端是否真的接住无法确认；不能承诺「已复制」
	const label = viaTerminal ? "Copy sent to terminal" : "Copied!";
	// 没有运行时状态行就没有 token 位置可占，退成一条短暂提示
	if (state.statusText === undefined) {
		host.setStatus(label, "notice");
		host.scheduleStatusClear();
		return;
	}

	state.copyNotice = label;
	if (state.copyNoticeTimer !== undefined) clearTimeout(state.copyNoticeTimer);
	state.copyNoticeTimer = setTimeout(() => {
		state.copyNoticeTimer = undefined;
		state.copyNotice = undefined;
		host.render();
	}, STATUS_CLEAR_MS);
	host.render();
}

/** OSC 52：把文本直接交给终端写剪贴板；终端不支持时序列会被忽略。 */
function writeOsc52(stdout: TuiOutput, text: string): boolean {
	try {
		stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
		return true;
	} catch {
		return false;
	}
}

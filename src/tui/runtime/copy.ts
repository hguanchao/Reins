import type { TuiOutput } from "../options.ts";
import type { TuiHost } from "./types.ts";

/**
 * 复制一段文本。
 *
 * 先交给宿主提供的系统剪贴板；写不进去时退到 OSC 52，让终端自己接住（SSH、容器里没有
 * 剪贴板命令时还有这一条路）。复制是瞬时动作，结果只写状态行，不在对话流里留痕。
 */
export function copyText(host: TuiHost, text: string): void {
	if (text.trim().length === 0) return;
	const chars = Array.from(text).length;
	let copied = false;
	try {
		copied = host.options.clipboard?.copy(text) ?? false;
	} catch {
		copied = false;
	}

	if (copied) {
		host.setStatus(`Copied ${chars} chars`, "notice");
	} else if (writeOsc52(host.state.stdout, text)) {
		host.setStatus(`Copy sent to terminal (${chars} chars)`, "notice");
	} else {
		host.setStatus("Copy failed", "warning");
	}
	host.scheduleStatusClear();
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

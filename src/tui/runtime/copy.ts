import type { TuiOutput } from "#src/tui/options.ts";
import { STATUS_CLEAR_MS } from "#src/tui/runtime/constants.ts";
import { saveCopyFallback, shortPath } from "#src/tui/runtime/copy-file.ts";
import { STATUS, copySavedTo, copiedNotice } from "#src/tui/copy.ts";
import type { TuiHost } from "#src/tui/runtime/types.ts";

/**
 * 复制一段文本。
 *
 * 先交给宿主提供的系统剪贴板；写不进去时退到 OSC 52，让终端自己接住（SSH、容器里没有
 * 剪贴板命令时还有这一条路）。两条都走不通时把内容写到兜底文件，提示里给出路径——复制
 * 失败最糟的不是没复制上，而是刚才那段内容彻底没了。
 *
 * 成功提示只占用状态行里 token 计量的位置，超时后 token 数自动回来，不打断当前正在显示
 * 的状态文字。
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
	}

	if (!copied && !viaTerminal) {
		const saved = await saveCopyFallback(text);
		host.setStatus(saved === undefined ? STATUS.copyFailed : copySavedTo(shortPath(saved)), "warning");
		host.scheduleStatusClear();
		return;
	}

	const state = host.state;
	// OSC 52 只是把序列写进终端，终端是否真的接住无法确认；不能承诺「已复制」
	const label = viaTerminal ? STATUS.copySentToTerminal : copiedNotice(codePoints(text));
	// 上一条状态的自动清理计时器会把本次提示连着清掉：提示的生命周期由下面的计时器独占
	if (state.statusClearTimer !== undefined) {
		clearTimeout(state.statusClearTimer);
		state.statusClearTimer = undefined;
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

/** 字符数按码点算：emoji 与中文都记 1，不因为 UTF-16 代理对翻倍。 */
function codePoints(text: string): number {
	return Array.from(text).length;
}

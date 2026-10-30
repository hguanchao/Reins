import { APPROVAL_MODES } from "../../config/file.ts";
import { describeError } from "../../shared/describe-error.ts";
import { FAILURE_ACTIONS, failure } from "../copy.ts";
import {
	decodeKittyKeys,
	mouseEvents,
	pastingAfter,
	shiftTabKey,
	stripPasteContent,
	type MouseInput,
} from "./keys.ts";
import { CTRL_C, FOCUS_IN, FOCUS_OUT } from "../terminal.ts";
import { PASTE_END, PASTE_START } from "./keys.ts";
import { handleApprovalInput } from "./approval.ts";
import { handleModalMenuInput } from "./menus.ts";
import { handlePageInput } from "./pages.ts";
import { handleTranscriptInput } from "./transcript.ts";
import { handleTrustInput } from "./trust.ts";
import type { InputDeps } from "./deps.ts";
import type { TuiHost } from "../runtime/types.ts";
import { INPUT_TAIL_TIMEOUT_MS, PASTE_STALL_TIMEOUT_MS } from "../runtime/constants.ts";

export type { InputDeps } from "./deps.ts";

/**
 * 从一块输入里取出焦点上报的结果。
 *
 * 终端在窗口被切走/切回时发这两个序列，与按键、鼠标混在同一批数据里。它描述的是「这个
 * 程序还能不能收到键盘」，与当前开着哪个面板无关，因此必须在分发的最前面处理——否则
 * 面板打开期间切走窗口，焦点状态会停在离开前的值，回来时界面以为输入框仍然可用。
 *
 * 同一块里可能有多条，以最后一条为准。
 */
function focusOf(text: string): boolean | undefined {
	const lastIn = text.lastIndexOf(FOCUS_IN);
	const lastOut = text.lastIndexOf(FOCUS_OUT);
	if (lastIn < 0 && lastOut < 0) return undefined;
	return lastIn > lastOut;
}

/**
 * 取出粘贴区间之外的文本。
 *
 * 粘贴正文里的转义序列是内容，不是按键、鼠标或焦点事件；按键路径已经用
 * stripPasteContent 防过一轮，鼠标与焦点解析也必须看同一份文本，否则一段剪贴板内容
 * 就能触发菜单点击或在审批卡上点到动作。跨数据块的粘贴由 pasting 记住。
 */
export function interactiveText(text: string, pasting: boolean): string {
	if (!pasting) return stripPasteContent(text);
	const end = text.indexOf(PASTE_END);
	return end < 0 ? "" : stripPasteContent(text.slice(end + PASTE_END.length));
}

/**
 * 找出末尾尚未完成的转义序列。
 *
 * 终端通常把一条序列一次写完，但大段粘贴会把数据切成多块，块边界可能落在
 * `\x1b[201~` 这类标记中间。未完成的尾巴必须留到下一块再解析：按当前块处理的话，
 * 残片会变成正文，粘贴状态也再没有机会复位。
 *
 * 返回尾巴的起始下标；没有未完成序列时返回 -1。只把「确实还缺后续字节」的情况
 * 算作未完成，完整序列与普通文本都不受影响。
 */
export function incompleteEscapeStart(text: string): number {
	const start = text.lastIndexOf("\x1b");
	if (start < 0) return -1;
	const rest = text.slice(start);
	// 单独一个 ESC 就是 Esc 键：不能为了等可能的后续字节把它压后，否则每次按 Esc
	// 都要延迟一帧。真正需要拼接的是已经出现 `[` 或 `O` 前缀的半条序列。
	if (rest === "\x1b") return -1;
	if (rest.startsWith("\x1b[")) {
		// CSI：参数字节之后还需要一个终止字节；带终止字节的序列已经完整
		return /^\x1b\[[0-9;?]*$/.test(rest) ? start : -1;
	}
	if (rest === "\x1bO") return start;
	if (rest.startsWith("\x1b]")) {
		// OSC：以 BEL 或 ST 结束
		return rest.endsWith("\x07") || rest.endsWith("\x1b\\") ? -1 : start;
	}
	return -1;
}

/**
 * 按键与鼠标分发。
 *
 * 顺序是固定的：焦点上报、Ctrl+C 与 Shift+Tab 是全局的；随后按当前最上层的界面接管输入——
 * 审批卡、模态面板、整屏页，最后才是对话流与输入框。
 */
export function createInputHandler(host: TuiHost, deps: InputDeps): (chunk: Buffer) => void {
	const state = host.state;

	/**
	 * 粘贴态的超时兜底。
	 *
	 * 正常粘贴会在每块数据到达时重新计时；只有终端丢了结束标记才会走到这里。
	 * 复位只解除状态，已经插入的正文保留，键盘至少还能继续用。
	 */
	const armPastingTimeout = (): void => {
		if (state.pastingTimer !== undefined) clearTimeout(state.pastingTimer);
		state.pastingTimer = setTimeout(() => {
			state.pastingTimer = undefined;
			if (state.finished) return;
			state.pasting = false;
			deps.render();
		}, PASTE_STALL_TIMEOUT_MS);
	};

	const handleText = (text: string): void => {
		if (state.finished) return;
		// 粘贴状态在这里统一推进：模态分支也要用它，而它们不走编辑器那条路径。
		// 只按当前块剥粘贴内容的话，跨块粘贴的后续块没有起始标记，会被原样当成按键——
		// 审批卡上的一次换行就等于替使用者点了同意。
		const pasting = state.pasting;
		// 开了键盘协议时 Shift+Enter、Ctrl+字母等以 CSI-u 到达；先还原成传统编码，
		// 后续所有分支（Ctrl+C、Shift+Tab、编辑器、面板）就都只认一种形式
		const decoded = decodeKittyKeys(text, pasting);
		state.pasting = pastingAfter(decoded, pasting);
		if (state.pasting) {
			armPastingTimeout();
		} else if (state.pastingTimer !== undefined) {
			clearTimeout(state.pastingTimer);
			state.pastingTimer = undefined;
		}
		const eventText = interactiveText(decoded, pasting);
		// 鼠标事件最多解析一次:同一条数据块会被多个面板分支检查,每次都跑一遍
		// matchAll 是纯浪费;纯键盘块则一次也不解析
		let mouseOfChunk: readonly MouseInput[] | undefined;
		const mouseOf = (): readonly MouseInput[] => {
			// 超屏时画面与命中坐标已经对不上，鼠标先停用，键盘操作不受影响
			if (state.layoutOverflow) return [];
			mouseOfChunk ??= mouseEvents(eventText);
			return mouseOfChunk;
		};

		// 焦点排在所有分支之前：面板打开时切走窗口，回来仍要知道自己失去了焦点。
		// 窗口焦点与输入焦点分开记：点过对话流后输入框已失焦，但窗口仍在前台，
		// 这时回合结束不该被当成「人不在」而响铃。
		const focus = focusOf(eventText);
		if (focus !== undefined) {
			const changed = focus !== state.windowFocused || focus !== state.focused;
			state.windowFocused = focus;
			state.focused = focus;
			// 失焦意味着指针也不在这个窗口上：拖动到一半的滚动条不该继续跟着走
			if (!focus) state.draggingScrollbar = false;
			if (changed) deps.render();
		}

		// 信任页排在所有分支之前：它没给出结论时，界面上的输入框根本不可见，
		// 任何按键都不该落到对话流或命令补全上。
		if (state.trustPrompt !== undefined) {
			// 此时没有任何会话内容需要保护，Ctrl+C 直接退出。连按两次的确认在这里
			// 不合适——信任页没有状态行可以显示，第一次按下看起来像没反应。
			if (decoded.includes(CTRL_C) && !pasting && !decoded.includes(PASTE_START)) {
				deps.cleanup();
				return;
			}
			handleTrustInput(host, deps, eventText);
			return;
		}

		// Ctrl+C 只认真实的按键块:粘贴的内容被括在粘贴标记里,其中的 \x03 是正文,
		// 不能当成中断或退出
		if (decoded.includes(CTRL_C) && !pasting && !decoded.includes(PASTE_START)) {
			deps.onCtrlC();
			return;
		}

		if (shiftTabKey(decoded) && host.options.approvalMode !== undefined) {
			// 全局热键：任何面板下都先于其它分支处理，循环 ask → auto → yolo
			const source = host.options.approvalMode;
			const index = APPROVAL_MODES.indexOf(source.current());
			const next = APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] ?? "ask";
			try {
				source.select(next);
			} catch (error) {
				host.setStatus(failure(FAILURE_ACTIONS.approvalSwitch, describeError(error)), "error");
				host.scheduleStatusClear();
			}
			deps.render();
			return;
		}

		if (state.approvalPrompt !== undefined) {
			// 审批卡只认按键：粘贴内容里的换行或字母不能被当成确认/允许
			handleApprovalInput(host, deps, eventText, mouseOf);
			return;
		}

		if (host.modalMenuOpen()) {
			if (handleModalMenuInput(host, eventText, mouseOf)) return;
		}

		if (state.openPage !== undefined) {
			handlePageInput(host, deps, eventText, mouseOf);
			return;
		}

		handleTranscriptInput(host, deps, decoded, mouseOf, pasting);
	};

	const flushTail = (): void => {
		state.inputTailTimer = undefined;
		const tail = state.inputTail;
		state.inputTail = "";
		if (tail.length > 0) handleText(tail);
	};

	return (chunk: Buffer): void => {
		if (state.finished) return;
		const combined = state.inputTail + state.decoder.write(chunk);
		if (state.inputTailTimer !== undefined) {
			clearTimeout(state.inputTailTimer);
			state.inputTailTimer = undefined;
		}
		const cut = incompleteEscapeStart(combined);
		if (cut < 0) {
			state.inputTail = "";
			handleText(combined);
			return;
		}
		// 末尾还缺后续字节：先处理完整部分，尾巴等下一块或超时兜底
		state.inputTail = combined.slice(cut);
		const complete = combined.slice(0, cut);
		if (complete.length > 0) handleText(complete);
		state.inputTailTimer = setTimeout(flushTail, INPUT_TAIL_TIMEOUT_MS);
	};
}

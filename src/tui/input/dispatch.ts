import { APPROVAL_MODES } from "../../config/file.ts";
import { describeError } from "../../shared/describe-error.ts";
import { mouseEvents, shiftTabKey, stripPasteContent, type MouseInput } from "./keys.ts";
import { CTRL_C, FOCUS_IN, FOCUS_OUT } from "../terminal.ts";
import { PASTE_START } from "./keys.ts";
import { handleApprovalInput } from "./approval.ts";
import { handleModalMenuInput } from "./menus.ts";
import { handlePageInput } from "./pages.ts";
import { handleTranscriptInput } from "./transcript.ts";
import type { InputDeps } from "./deps.ts";
import type { TuiHost } from "../runtime/types.ts";

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
 * 按键与鼠标分发。
 *
 * 顺序是固定的：焦点上报、Ctrl+C 与 Shift+Tab 是全局的；随后按当前最上层的界面接管输入——
 * 审批卡、模态面板、整屏页，最后才是对话流与输入框。
 */
export function createInputHandler(host: TuiHost, deps: InputDeps): (chunk: Buffer) => void {
	return (chunk: Buffer): void => {
		const state = host.state;
		const text = state.decoder.write(chunk);
		// 鼠标事件最多解析一次:同一条数据块会被多个面板分支检查,每次都跑一遍
		// matchAll 是纯浪费;纯键盘块则一次也不解析
		let mouseOfChunk: readonly MouseInput[] | undefined;
		const mouseOf = (): readonly MouseInput[] => {
			mouseOfChunk ??= mouseEvents(text);
			return mouseOfChunk;
		};

		// 焦点排在所有分支之前：面板打开时切走窗口，回来仍要知道自己失去了焦点
		const focus = focusOf(text);
		if (focus !== undefined && focus !== state.focused) {
			state.focused = focus;
			// 失焦意味着指针也不在这个窗口上：拖动到一半的滚动条不该继续跟着走
			if (!focus) state.draggingScrollbar = false;
			deps.render();
		}

		// Ctrl+C 只认真实的按键块:粘贴的内容被括在粘贴标记里,其中的 \x03 是正文,
		// 不能当成中断或退出
		if (text.includes(CTRL_C) && !state.pasting && !text.includes(PASTE_START)) {
			deps.onCtrlC();
			return;
		}

		if (shiftTabKey(text) && host.options.approvalMode !== undefined) {
			// 全局热键：任何面板下都先于其它分支处理，循环 ask → auto → yolo
			const source = host.options.approvalMode;
			const index = APPROVAL_MODES.indexOf(source.current());
			const next = APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] ?? "ask";
			try {
				source.select(next);
			} catch (error) {
				host.setStatus(`Failed to switch approval: ${describeError(error)}`, "error");
				host.scheduleStatusClear();
			}
			deps.render();
			return;
		}

		if (state.approvalPrompt !== undefined) {
			// 审批卡只认按键：粘贴内容里的换行或字母不能被当成确认/允许
			handleApprovalInput(host, deps, stripPasteContent(text), mouseOf);
			return;
		}

		if (host.modalMenuOpen()) {
			if (handleModalMenuInput(host, stripPasteContent(text), mouseOf)) return;
		}

		if (state.openPage !== undefined) {
			handlePageInput(host, deps, stripPasteContent(text), mouseOf);
			return;
		}

		handleTranscriptInput(host, deps, text, mouseOf);
	};
}

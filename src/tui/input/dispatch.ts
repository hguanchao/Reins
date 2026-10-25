import { APPROVAL_MODES } from "../../config/file.ts";
import { describeError } from "../../describe-error.ts";
import { mouseEvents, shiftTabKey, type MouseInput } from "./keys.ts";
import { CTRL_C } from "../terminal.ts";
import { PASTE_START } from "./keys.ts";
import { handleApprovalInput } from "./approval.ts";
import { handleModalMenuInput } from "./menus.ts";
import { handlePageInput } from "./pages.ts";
import { handleTranscriptInput } from "./transcript.ts";
import type { TuiHost } from "../runtime/types.ts";

/** 一次输入分发需要的环境。 */
export interface InputDeps {
	readonly render: () => void;
	readonly onCtrlC: () => void;
}

/**
 * 按键与鼠标分发。
 *
 * 顺序是固定的：Ctrl+C 与 Shift+Tab 是全局热键；随后按当前最上层的界面接管输入——
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
			handleApprovalInput(host, deps, text, mouseOf);
			return;
		}

		if (host.modalMenuOpen()) {
			if (handleModalMenuInput(host, deps, text, mouseOf)) return;
		}

		if (state.openPage !== undefined) {
			handlePageInput(host, deps, text, mouseOf);
			return;
		}

		handleTranscriptInput(host, deps, text, mouseOf);
	};
}

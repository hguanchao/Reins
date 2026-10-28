import { describeError } from "../../shared/describe-error.ts";
import type { TuiHost } from "./types.ts";

/**
 * 信任页的结论落地。
 *
 * 页面先收掉再记录结论：授予信任要写一次配置、可能还要重读一遍，这段时间里界面应该已经
 * 回到可以继续使用的状态，而不是停在一张按不动、也不知道在做什么的页面上。结果用状态行
 * 说一句，成功与失败都留痕。
 */

const SKIPPED = "Workspace config skipped for this run; pass --trust to use it next time";

export function resolveTrust(host: TuiHost, trusted: boolean): void {
	const state = host.state;
	const prompt = state.trustPrompt;
	if (prompt === undefined || prompt.pending) return;

	if (!trusted) {
		state.trustPrompt = undefined;
		host.setStatus(SKIPPED, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	prompt.pending = true;
	host.render();

	const source = host.options.trustPrompt;
	if (source === undefined) {
		state.trustPrompt = undefined;
		host.render();
		return;
	}

	void source.accept().then(
		(lines) => {
			// 记录期间按过 Ctrl+C 就已经收尾离场：这时再画一帧会写到恢复后的主屏上
			if (state.finished) return;
			state.trustPrompt = undefined;
			// 状态行只有一行的位置：多项说明用间隔连起来，不让后面的内容被挤掉
			if (lines.length > 0) {
				host.setStatus(lines.join(" · "), "notice");
				host.scheduleStatusClear();
			}
			host.render();
		},
		(error: unknown) => {
			if (state.finished) return;
			state.trustPrompt = undefined;
			host.setStatus(`Could not record trust: ${describeError(error)}`, "error");
			host.scheduleStatusClear();
			host.render();
		},
	);
}

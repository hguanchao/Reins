import { describeError } from "../../shared/describe-error.ts";
import type { TrustAnswer } from "../page/trust.ts";
import type { TuiHost } from "./types.ts";

/**
 * 信任页的结论落地。
 *
 * 授予与拒绝走两条截然不同的路。授予要先收掉页面再记录结论：写配置、可能还要重读一遍，
 * 这段时间里界面应该已经回到可以继续使用的状态，而不是停在一张按不动、也不知道在做什么的
 * 页面上。拒绝则没有「继续」可言——项目配置正是要被它挡住的东西，放行就等于什么都没挡住，
 * 所以直接收尾退出，退出原因交给装配层说明。
 */

export function resolveTrust(host: TuiHost, answer: TrustAnswer): void {
	const state = host.state;
	const prompt = state.trustPrompt;
	if (prompt === undefined || prompt.pending) return;

	if (answer === "skip") {
		state.trustPrompt = undefined;
		host.options.trustPrompt?.decline();
		host.exit();
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

	// 仅本次信任不落盘：下次启动仍会再问一次，这是「只影响本次」的字面含义
	void source.accept(answer === "trust").then(
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

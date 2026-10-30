import { describeError } from "../../shared/describe-error.ts";
import type { TrustAnswer } from "../page/trust.ts";
import { FAILURE_ACTIONS, STATUS, failure } from "../copy.ts";
import type { TuiHost } from "./types.ts";

/**
 * 信任页的结论落地。
 *
 * 授予与拒绝走两条不同的路。授予要先收掉页面再记录结论：写配置、可能还要重读一遍，这段
 * 时间里界面应该已经回到可以继续使用的状态，而不是停在一张按不动、也不知道在做什么的页面上。
 *
 * 拒绝要看被挡住的是什么：项目配置与规则文件会改变程序行为，少了它们继续干活，等于用一份
 * 「看起来生效、实际没生效」的配置办事，所以直接退出；只有技能目录时不一样——技能是可选
 * 增强，对话本身不依赖它们，跳过后照常进入对话流。
 */

/** 只跳过技能目录时的说明：让使用者知道少了什么，而不是以为项目配置生效了。 */
const SKILLS_SKIPPED = STATUS.skillsSkipped;

export function resolveTrust(host: TuiHost, answer: TrustAnswer): void {
	const state = host.state;
	const prompt = state.trustPrompt;
	if (prompt === undefined || prompt.pending) return;

	if (answer === "skip") {
		state.trustPrompt = undefined;
		if (prompt.files.length === 0) {
			host.setStatus(SKILLS_SKIPPED, "notice");
			host.scheduleStatusClear();
			host.render();
			return;
		}
		// 有文件被挡住：交给装配层说明原因，界面随即收尾退出
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
			host.setStatus(failure(FAILURE_ACTIONS.trust, describeError(error)), "error");
			host.scheduleStatusClear();
			host.render();
		},
	);
}

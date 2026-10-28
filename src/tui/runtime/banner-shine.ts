import { BANNER_FRAME_MS, BANNER_SWEEP_MS } from "../view/banner.ts";
import type { TuiState } from "./types.ts";

/**
 * 启动标志的一次性扫光。
 *
 * 只跑一遍：启动画面停留时间很短，循环播放会像一段永远演不完的动画。进度按墙钟算而不是
 * 数帧——掉帧只会少画几帧，不会把整道光拖长。对话流、整屏页或输入框接管画面后标志不再
 * 可见，扫光随即收掉，不会在后台空转。
 */
export function startBannerShine(state: TuiState, render: () => void): void {
	if (
		state.bannerTimer !== undefined ||
		state.hasInput ||
		state.input.length > 0 ||
		state.openPage !== undefined
	) {
		return;
	}

	const started = Date.now();
	state.bannerShine = 0;
	state.bannerTimer = setInterval(() => {
		if (
			state.finished ||
			state.hasInput ||
			state.input.length > 0 ||
			state.openPage !== undefined
		) {
			stopBannerShine(state);
			return;
		}
		const progress = (Date.now() - started) / BANNER_SWEEP_MS;
		if (progress >= 1) stopBannerShine(state);
		else state.bannerShine = progress;
		render();
	}, BANNER_FRAME_MS);
}

/** 停掉扫光并回到静止画面；收尾、扫完与画面被接管都走这里。 */
export function stopBannerShine(state: TuiState): void {
	if (state.bannerTimer !== undefined) {
		clearInterval(state.bannerTimer);
		state.bannerTimer = undefined;
	}
	state.bannerShine = undefined;
}

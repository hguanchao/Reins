import { buildTranscriptView } from "../transcript.ts";
import type { TranscriptView } from "../transcript.ts";
import { noticeText } from "./notice.ts";
import type { TuiState } from "./types.ts";

/** 对话流缓存失效：内容、宽度或警告变化时才重排。 */
export function markTranscriptDirty(state: TuiState): void {
	state.transcriptDirty = true;
}

/** 宽度、警告或内容变化时重建；其余帧直接复用。 */
export function currentTranscript(state: TuiState, width: number): TranscriptView {
	const notice = noticeText(state);
	if (
		state.transcriptView === undefined ||
		state.transcriptDirty ||
		state.transcriptViewWidth !== width ||
		state.transcriptViewNotice !== notice
	) {
		state.transcriptView = buildTranscriptView(width, state.turns, notice);
		state.transcriptViewWidth = width;
		state.transcriptViewNotice = notice;
		state.transcriptDirty = false;
	}
	return state.transcriptView;
}

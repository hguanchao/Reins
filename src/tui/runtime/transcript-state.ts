import { buildTranscriptView } from "#src/tui/transcript.ts";
import type { TranscriptTurn, TranscriptView } from "#src/tui/transcript.ts";
import { noticeText } from "#src/tui/runtime/notice.ts";
import type { TranscriptPrefix, TuiState } from "#src/tui/runtime/types.ts";

/** 对话流缓存失效：内容、宽度或警告变化时才重排。 */
export function markTranscriptDirty(state: TuiState): void {
	state.transcriptDirty = true;
}

/**
 * 展开/收起后强制丢掉前缀缓存。
 *
 * 展开状态是就地修改的（行对象原地翻转），而前缀缓存只比较回合对象引用，看不见这种
 * 变化。不清掉前缀的话，除最后一轮外的内容会一直显示旧状态，点了像没反应。
 */
export function invalidateTranscriptPrefix(state: TuiState): void {
	state.transcriptPrefix = undefined;
}

/**
 * 宽度、警告或内容变化时重建；其余帧直接复用。
 *
 * 流式输出时内容每帧都在变，但真正变的只有最后一个回合。把前面那些已经写完的回合留在
 * 前缀缓存里，每帧只重排一个回合，长会话下的帧率才不会随历史长度一路掉下去。
 */
export function currentTranscript(state: TuiState, width: number): TranscriptView {
	const notice = noticeText(state);
	if (
		state.transcriptView !== undefined &&
		!state.transcriptDirty &&
		state.transcriptViewWidth === width &&
		state.transcriptViewNotice === notice
	) {
		return state.transcriptView;
	}

	// 最后一个回合可能正在流式增长，不能进缓存
	const frozen = Math.max(0, state.turns.length - 1);
	const prefix = usablePrefix(state.transcriptPrefix, state.turns, width, notice, frozen);

	let prefixView: TranscriptView | undefined;
	if (frozen > 0) {
		prefixView =
			prefix !== undefined && prefix.count === frozen
				? // 前缀已经正好覆盖到冻结点，直接借用，省掉一次整份复制
					prefix.view
				: buildTranscriptView(
						width,
						state.turns.slice(prefix?.count ?? 0, frozen),
						notice,
						prefix === undefined
							? undefined
							: { view: prefix.view, previousHadResponse: replied(prefix.count, state.turns) },
					);
	}

	const view = buildTranscriptView(
		width,
		state.turns.slice(frozen),
		notice,
		prefixView === undefined
			? undefined
			: { view: prefixView, previousHadResponse: replied(frozen, state.turns) },
	);

	state.transcriptPrefix =
		prefixView === undefined
			? undefined
			: // turns 必须存快照：数组是就地追加与就地替换的，存引用的话旧前缀会跟着一起变，
				// 逐项比较就永远相等，改过的回合会被当成没变
				{ turns: [...state.turns], count: frozen, width, notice, view: prefixView };
	state.transcriptView = view;
	state.transcriptViewWidth = width;
	state.transcriptViewNotice = notice;
	state.transcriptDirty = false;
	return view;
}

/** 第 count 个回合（从 1 数）之前那个回合有没有回复。 */
function replied(count: number, turns: readonly TranscriptTurn[]): boolean {
	return count > 0 && (turns[count - 1]?.response.length ?? 0) > 0;
}

/**
 * 前缀还能不能用。
 *
 * 回合对象是整体替换的，引用相等就说明没变。宽度或警告变了则必须整份重排：折行宽度与
 * 顶部提示会影响后面每一行，前缀接上去只会错位。
 */
function usablePrefix(
	prefix: TranscriptPrefix | undefined,
	turns: readonly TranscriptTurn[],
	width: number,
	notice: string | undefined,
	frozen: number,
): TranscriptPrefix | undefined {
	if (prefix === undefined) return undefined;
	if (prefix.width !== width || prefix.notice !== notice) return undefined;
	if (prefix.count > frozen) return undefined;
	for (let index = 0; index < prefix.count; index += 1) {
		if (turns[index] !== prefix.turns[index]) return undefined;
	}
	return prefix;
}

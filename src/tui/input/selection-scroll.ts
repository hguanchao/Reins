import { selectionPoint } from "#src/tui/transcript.ts";
import type { DragScroll, TuiHost, TuiState } from "#src/tui/runtime/types.ts";

/**
 * 拖选到内容区边缘时的持续滚动。
 *
 * 鼠标停在边缘不动时终端不再发移动事件，只靠事件驱动就只能滚一次、还得靠抖动鼠标才
 * 继续；这里用定时器一直往前推，滚到顶或底自己停下。
 */

/** 距上下边缘多少行以内开始滚。 */
const EDGE_ROWS = 2;
/** 每个 tick 的间隔：比一帧略慢，滚起来是连续的而不是一截一截跳。 */
const TICK_MS = 50;

/** 离边缘越远滚得越快：贴着边缘慢慢推，拖到页脚一带就快进。 */
export function dragScrollSpeed(distance: number): number {
	if (distance <= 1) return 1;
	if (distance <= 3) return 2;
	if (distance <= 6) return 3;
	return 5;
}

/** 鼠标所在行落在哪个边缘、离边缘多远；不在边缘区返回 undefined。 */
function edgeOf(row: number, mainHeight: number): { direction: -1 | 1; distance: number } | undefined {
	if (row <= EDGE_ROWS) return { direction: -1, distance: EDGE_ROWS - row + 1 };
	if (row >= mainHeight - EDGE_ROWS + 1) return { direction: 1, distance: row - (mainHeight - EDGE_ROWS) };
	return undefined;
}

/**
 * 按当前鼠标位置起停自动滚动。
 *
 * 方向没变时只更新位置与速度，定时器继续跑；方向变了或离开边缘就重建或停掉。
 */
export function updateDragScroll(
	host: TuiHost,
	state: TuiState,
	row: number,
	column: number,
	mainHeight: number,
): void {
	const edge = edgeOf(row, mainHeight);
	if (edge === undefined || state.selection === undefined) {
		stopDragScroll(state);
		return;
	}
	const speed = dragScrollSpeed(edge.distance);
	const current = state.dragScroll;
	if (current !== undefined && current.direction === edge.direction && current.speed === speed) {
		current.row = row;
		current.column = column;
		return;
	}
	stopDragScroll(state);
	state.dragScroll = {
		direction: edge.direction,
		speed,
		row,
		column,
		timer: setInterval(() => tickDragScroll(host, state), TICK_MS),
	};
	// 刚碰到边缘就先滚一次：不该等满一个 tick 才动
	tickDragScroll(host, state);
}

/** 停掉自动滚动；没有在滚时什么也不做。 */
export function stopDragScroll(state: TuiState): void {
	if (state.dragScroll === undefined) return;
	clearInterval(state.dragScroll.timer);
	state.dragScroll = undefined;
}

function tickDragScroll(host: TuiHost, state: TuiState): void {
	const scroll: DragScroll | undefined = state.dragScroll;
	if (scroll === undefined || state.selection === undefined) {
		stopDragScroll(state);
		return;
	}
	const limit = host.maxScroll();
	const next = Math.max(0, Math.min(limit, state.scrollTop + scroll.direction * scroll.speed));
	if (next === state.scrollTop) {
		// 已经到顶/到底：继续跑只会空转，等鼠标再动时重新启动
		stopDragScroll(state);
		return;
	}
	state.scrollTop = next;
	state.follow = next >= limit;
	// 鼠标可能停在页脚一带：取点前夹回内容区，否则焦点不会跟着滚
	const mainHeight = host.mainAreaHeight();
	const row = Math.min(Math.max(1, scroll.row), mainHeight);
	const point = selectionPoint(
		host.currentTranscript(host.terminalWidth()),
		mainHeight,
		state.scrollTop,
		row,
		scroll.column,
	);
	if (point !== undefined) {
		state.selection = { anchor: state.selection.anchor, focus: point };
	}
	host.render();
}

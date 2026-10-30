/**
 * 对话流渲染的公共入口。
 *
 * 具体实现按职责拆在 transcript/ 下：类型、样式、模型操作、详情排版、工具行、子代理、
 * 视图构建与滚动各自独立。外部（含测试）仍从这里取用，避免调用方依赖内部文件布局。
 */

export {
	appendToolLine,
	attachToolFailure,
	attachToolResult,
	collapseToolGroups,
	describeToolLine,
	findToolByCallId,
	findTopLevelToolByCallId,
	hasRunningSubagent,
	isSubagentCall,
	takeToolForFailure,
	toggleLastExpandable,
	toggleLastToolResult,
} from "#src/tui/transcript/model.ts";
export {
	highlightSelection,
	orderedSelection,
	selectionPoint,
	selectionRange,
	selectionSpans,
	selectionText,
	stripTerminalStyles,
	visibleTextWidth,
} from "#src/tui/transcript/selection.ts";
export {
	scrollbarColumn,
	scrollbarThumb,
	scrollTopForRow,
} from "#src/tui/transcript/scroll.ts";
export {
	buildTranscriptView,
	measureTranscriptView,
	planHeaderInView,
	renderTranscript,
	renderTranscriptView,
	subagentFailureRowInView,
	subagentGroupHeaderInView,
	thinkingBlockInView,
	thinkingHeaderAtRow,
	thinkingHeaderInView,
	todoHeaderInView,
	toolBlockInView,
	toolGroupHeaderAtRow,
	toolGroupHeaderInView,
	toolHeaderAtRow,
	toolHeaderInView,
	transcriptMetrics,
} from "#src/tui/transcript/view.ts";
export type { SelectionPoint, SelectionRegion } from "#src/tui/transcript/selection.ts";
export { PLAIN_LINE_META } from "#src/tui/transcript/types.ts";
export type {
	LineMeta,
	PromptRange,
	SubagentRunView,
	TranscriptLine,
	TranscriptMarkdown,
	TranscriptMetrics,
	TranscriptNote,
	TranscriptPlan,
	TranscriptSubagentGroup,
	TranscriptThinking,
	TranscriptTool,
	TranscriptToolGroup,
	TranscriptTurn,
	TranscriptView,
} from "#src/tui/transcript/types.ts";

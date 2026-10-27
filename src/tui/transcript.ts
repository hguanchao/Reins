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
} from "./transcript/model.ts";
export {
	scrollbarColumn,
	scrollbarThumb,
	scrollTopForRow,
} from "./transcript/scroll.ts";
export {
	buildTranscriptView,
	measureTranscriptView,
	planHeaderInView,
	renderTranscript,
	renderTranscriptView,
	subagentFailureRowInView,
	subagentGroupHeaderInView,
	thinkingHeaderAtRow,
	thinkingHeaderInView,
	todoHeaderInView,
	toolGroupHeaderAtRow,
	toolGroupHeaderInView,
	toolHeaderAtRow,
	toolHeaderInView,
	transcriptMetrics,
} from "./transcript/view.ts";
export type {
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
} from "./transcript/types.ts";

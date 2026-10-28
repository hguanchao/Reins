import { inputView, renderFooter } from "../view/footer.ts";
import { renderMain } from "../view/main.ts";
import { commandNameOf } from "../commands.ts";
import { renderApprovalPanel } from "../panel/approval-panel.ts";
import { renderCommandMenu } from "../panel/command-menu.ts";
import { renderEffortMenu } from "../panel/effort-menu.ts";
import { renderFileMenu } from "../panel/file-menu.ts";
import { renderModelMenu } from "../panel/model-menu.ts";
import { renderSessionMenu } from "../panel/session-menu.ts";
import { renderJobBarLine } from "../page/job.ts";
import { renderTranscriptView, measureTranscriptView, scrollbarColumn, selectionSpans } from "../transcript.ts";
import { scrollButtonPlacement } from "../view/scroll-button.ts";
import { todoPanelLines } from "../view/todo-card.ts";
import { trustPageLines } from "../page/trust.ts";
import { truncateToWidth } from "../render/text.ts";
import { THEME } from "../render/theme.ts";
import {
	BEGIN_SYNCHRONIZED_UPDATE,
	END_SYNCHRONIZED_UPDATE,
	ERASE_BELOW,
	ERASE_LINE,
	HIDE_CURSOR,
	RESET,
	SHOW_CURSOR,
	moveCursor,
} from "../terminal.ts";
import type { AnimationFrame } from "../render/sweep.ts";
import type { FooterInfo } from "../view/footer.ts";
import { SPINNER_FRAMES } from "./constants.ts";
import { menuOpen, terminalWidth, terminalRows } from "./geometry.ts";
import { framedPageFor } from "./pages.ts";
import type { TuiHost } from "./types.ts";

const OVERFLOW_NOTICE = "▸ Terminal too small: some content is hidden";

/**
 * 整帧绘制。
 *
 * 每一行按自己的坐标写，而不是靠换行符顺推。一行的实际列宽取决于终端怎么算其中的字符
 * （歧义宽度字符各终端算 1 列或 2 列），算得比我们宽时终端会替它换行，顺推下去后面的
 * 行就整体错位。按坐标写时溢出的尾巴会被下一行覆盖，只损失这一行末尾一两个字符。
 * 不整屏清空：先擦行再覆盖，旧内容不会在清屏与重绘之间闪一下。
 */
export function render(host: TuiHost): void {
	const { state, options } = host;
	const width = terminalWidth(state);
	const height = terminalRows(state);
	const mainHeight = host.mainAreaHeight();
	const view = host.currentTranscript(width);
	const metrics = measureTranscriptView(view, mainHeight);
	const maxScroll = Math.max(0, metrics.scrollLines - mainHeight);
	if (state.initialScroll || state.follow) {
		state.scrollTop = maxScroll;
		state.initialScroll = false;
	} else {
		state.scrollTop = Math.min(state.scrollTop, maxScroll);
	}

	const now = Date.now();
	const active = state.activeTurn;
	// 状态行里的耗时与用量每帧现算；回合结束后沿用收尾时定格的快照
	const ongoing = state.statusTone === undefined || state.statusTone === "warning";
	const status =
		state.statusText === undefined
			? undefined
			: {
					// 转圈与扫光都表示「还在动」：重试仍在进行，失败、阻断与提示都是静止的
					symbol:
						state.statusTone === "error" || state.statusTone === "notice"
							? ""
							: (SPINNER_FRAMES[state.spinnerFrame] ?? ""),
					text: state.statusText,
					sweep: state.statusTone === undefined ? state.sweepPhase : undefined,
					tone: state.statusTone,
					phaseMs:
						active !== undefined && ongoing ? Math.max(0, now - state.statusPhaseStartedAt) : undefined,
					elapsedMs:
						active !== undefined
							? Math.max(0, now - active.startedAt)
							: state.statusElapsedMs > 0
								? state.statusElapsedMs
								: undefined,
					tokens:
						state.copyNotice === true
							? undefined
							: active !== undefined
								? active.tokensUsed
								: state.statusTokens > 0
									? state.statusTokens
									: undefined,
					tokenLabel: state.copyNotice === true ? "Copied!" : undefined,
				};
	const menuLines = menuLinesOf(host, width, metrics);
	const inputLines = inputView(state.input, width, state.inputCursor);
	// 信任页挡在对话流前面：页脚、状态行与光标都不出现，画面只有这一页
	const trust = state.trustPrompt;
	// 输入以已注册的命令开头时把命令本身着色，参数保持正文色
	const typedCommand = commandNameOf(state.input);
	const commandLength = host.commands().some((item) => item.name === typedCommand)
		? typedCommand.length + 1
		: 0;
	const footer =
		trust !== undefined || state.openPage !== undefined || state.approvalPrompt !== undefined
			? []
			: host.compactFooter()
				? renderFooter(
						width,
						state.input,
						state.focused && !host.modalMenuOpen() && state.openPage === undefined,
						undefined,
						currentInfo(host),
						{ leadingGap: false, showStatus: false, cursor: state.inputCursor, commandLength },
					)
				: renderFooter(width, state.input, state.focused, status, currentInfo(host), {
						cursor: state.inputCursor,
						commandLength,
						queued: state.queued.map((item) => item.text),
					});
	const transcriptShown =
		trust === undefined &&
		state.openPage === undefined &&
		(state.hasInput || host.noticeText() !== undefined);
	// 运行中的行按当前帧重建转圈与扫光；没有动画行时这只是原样返回缓存行
	const animation: AnimationFrame = {
		spinner: SPINNER_FRAMES[state.spinnerFrame] ?? "",
		sweepPhase: state.sweepPhase,
	};
	const selection =
		state.selection !== undefined && selectionSpans(state.selection) ? state.selection : undefined;
	const main =
		trust !== undefined
			? trustPageLines(trust, width, mainHeight)
			: state.openPage !== undefined
				? framedPageFor(host, state.openPage, width, mainHeight)
				: transcriptShown
					? renderTranscriptView(view, mainHeight, state.scrollTop, animation, selection)
					: renderMain(width, mainHeight, options.version, state.bannerShine);
	const mainLines = [...main];
	// 常驻任务面板:贴在页脚上方,任务表存在且非空时显示;Plan 模式隐藏旧任务表
	const panelLines =
		trust === undefined &&
		state.openPage === undefined &&
		state.approvalPrompt === undefined &&
		!host.planning() &&
		state.currentTodo !== undefined
			? [...todoPanelLines(state.currentTodo, width, animation)]
			: [];
	// 后台作业只占一行，放在任务面板与页脚之间；没有运行中作业时不占高度
	const jobBar = host.jobBarHeight() > 0 ? [renderJobBarLine(options.jobs?.list() ?? [], width)] : [];
	// 整屏自上而下：主区域、任务面板、Jobs bar、选择面板、页脚
	const lines = [...mainLines, ...panelLines, ...jobBar, ...menuLines, ...footer];
	const fullInputRow = host.inputTopRow(mainHeight) + inputLines.row;
	state.layoutOverflow = lines.length > height;
	// 内容超屏时从底部保留：输入框与页脚比对话流顶部重要。光标行若被挤出可见区，
	// 窗口再往上挪，保证正在编辑的那一行总能看到。
	let start = Math.max(0, lines.length - height);
	if (height > 0 && fullInputRow - start < 1) start = Math.max(0, fullInputRow - 1);
	start = Math.min(start, Math.max(0, lines.length - 1));
	const visible = lines.slice(start, start + height);
	const inputRow = fullInputRow - start;
	// 顶部让出一行说明内容被裁掉了；光标正好落在第一行时不覆盖它
	if (start > 0 && inputRow !== 1 && visible.length > 0) {
		visible[0] = `${THEME.warning}${truncateToWidth(OVERFLOW_NOTICE, width)}${RESET}`;
	}
	// 选择面板只盖在输入框上方，输入行仍然可见可编辑，光标照常显示；
	// 只有整屏页与审批面板会夺走焦点
	const cursor =
		state.focused &&
		trust === undefined &&
		state.openPage === undefined &&
		state.approvalPrompt === undefined &&
		inputRow >= 1 &&
		inputRow <= height
			? moveCursor(inputRow, inputLines.column) + SHOW_CURSOR
			: "";

	let frame = HIDE_CURSOR + BEGIN_SYNCHRONIZED_UPDATE;
	for (let row = 0; row < visible.length; row += 1) {
		frame += `${moveCursor(row + 1, 1)}${RESET}${ERASE_LINE}${visible[row]}`;
	}
	// 滚动条列最后单独画：它只依赖自己的行列位置，内容怎么换行都不会把它带断
	if (transcriptShown && !state.layoutOverflow) {
		// 用 scrollLines 而不是 totalLines：留白也是能滚到的范围，滑块大小与位置得按
		// 真实量程算，否则滑块几乎满格、怎么滚都不动
		const gutter = scrollbarColumn(mainHeight, metrics.scrollLines, state.scrollTop);
		for (let row = 0; row < gutter.length; row += 1) {
			frame += `${moveCursor(row + 1, width)}${gutter[row]}`;
		}
	}
	// 置底按钮同样单独定位：它盖在对话流最后一行中部，只在真的离开底部时出现
	const showButton =
		!state.layoutOverflow && transcriptShown && !menuOpen(state) && state.scrollTop < maxScroll;
	// 按钮没画出来时悬停状态要一起清掉，否则下次出现会带着上一次的高亮
	if (!showButton) state.buttonHovered = false;
	if (showButton) {
		const button = scrollButtonPlacement(width, mainHeight, state.buttonHovered);
		if (button !== undefined) frame += `${moveCursor(button.row, button.column)}${button.text}`;
	}
	// 终端变高后，上一帧底部的行不在这一帧的覆盖范围内，补一次擦除
	if (visible.length < height) {
		frame += `${moveCursor(visible.length + 1, 1)}${RESET}${ERASE_BELOW}`;
	}
	state.stdout.write(frame + cursor + END_SYNCHRONIZED_UPDATE);
}

function menuLinesOf(host: TuiHost, width: number, _metrics: unknown): readonly string[] {
	const state = host.state;
	if (state.approvalPrompt !== undefined) {
		return renderApprovalPanel(
			width,
			terminalRows(state),
			state.approvalPrompt,
			state.approvalSelection,
			state.approvalExpanded,
			state.approvalScrollTop,
		);
	}
	if (state.modelMenu !== undefined) return renderModelMenu(width, state.modelMenu);
	if (state.effortMenu !== undefined) return renderEffortMenu(width, state.effortMenu);
	if (state.sessionMenu !== undefined) {
		return renderSessionMenu(width, state.sessionMenu);
	}
	if (state.commandMenu !== undefined) return renderCommandMenu(width, state.commandMenu);
	if (state.fileMenu !== undefined) return renderFileMenu(width, state.fileMenu);
	return [];
}

/** 页脚常驻信息。 */
function currentInfo(host: TuiHost): FooterInfo {
	const info = typeof host.options.info === "function" ? host.options.info() : host.options.info;
	const mode = host.options.approvalMode?.current();
	const withPlan = host.options.planMode?.current() === true ? { ...info, planMode: true } : info;
	return mode === undefined ? withPlan : { ...withPlan, approval: mode };
}


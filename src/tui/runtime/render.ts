import { inputView, renderFooter } from "#src/tui/view/footer.ts";
import { commandNameOf } from "#src/tui/commands.ts";
import { renderApprovalPanel } from "#src/tui/panel/approval-panel.ts";
import { renderCommandMenu } from "#src/tui/panel/command-menu.ts";
import { renderEffortMenu } from "#src/tui/panel/effort-menu.ts";
import { renderFileMenu } from "#src/tui/panel/file-menu.ts";
import { renderSkillMenu } from "#src/tui/panel/skill-menu.ts";
import { renderModelMenu } from "#src/tui/panel/model-menu.ts";
import { renderSessionMenu } from "#src/tui/panel/session-menu.ts";
import { renderTranscriptView, measureTranscriptView, scrollbarColumn, selectionSpans } from "#src/tui/transcript.ts";
import { scrollButtonPlacement } from "#src/tui/view/scroll-button.ts";
import { todoPanelLines } from "#src/tui/view/todo-card.ts";
import { trustPageLines } from "#src/tui/page/trust.ts";
import { MCP_ACTION_HEIGHT } from "#src/tui/page/frame.ts";
import { PLAN_ACTION_HEIGHT } from "#src/tui/page/plan.ts";
import { VIEWER_ACTION_HEIGHT } from "#src/tui/page/viewer.ts";
import { truncateToWidth } from "#src/tui/render/text.ts";
import { THEME } from "#src/tui/render/theme.ts";
import {
	BEGIN_SYNCHRONIZED_UPDATE,
	END_SYNCHRONIZED_UPDATE,
	ERASE_BELOW,
	ERASE_LINE,
	HIDE_CURSOR,
	RESET,
	SHOW_CURSOR,
	moveCursor,
} from "#src/tui/terminal.ts";
import type { AnimationFrame } from "#src/tui/render/sweep.ts";
import type { FooterInfo } from "#src/tui/view/footer.ts";
import { SPINNER_FRAMES } from "#src/tui/runtime/constants.ts";
import { TRANSCRIPT } from "#src/tui/copy.ts";
import { menuOpen, menuVisibleLimit, terminalWidth, terminalRows } from "#src/tui/runtime/geometry.ts";
import { framedPageFor } from "#src/tui/runtime/pages.ts";
import type { TuiHost } from "#src/tui/runtime/types.ts";

const OVERFLOW_NOTICE = TRANSCRIPT.terminalTooSmall;

/**
 * 整帧绘制。
 *
 * 每一行按自己的坐标写，而不是靠换行符顺推。一行的实际列宽取决于终端怎么算其中的字符
 * （歧义宽度字符各终端算 1 列或 2 列），算得比我们宽时终端会替它换行，顺推下去后面的
 * 行就整体错位。按坐标写时溢出的尾巴会被下一行覆盖，只损失这一行末尾一两个字符。
 * 不整屏清空：先擦行再覆盖，旧内容不会在清屏与重绘之间闪一下。
 */
export function render(host: TuiHost): void {
	const { state } = host;
	const width = terminalWidth(state);
	const height = terminalRows(state);
	const mainHeight = host.mainAreaHeight();
	// 宽度一变，折行与行号全部重排：旧选区已经指不回原来那段文字，先清掉再重画
	if (state.transcriptViewWidth !== -1 && state.transcriptViewWidth !== width) {
		state.selection = undefined;
	}
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
	// 转圈与扫光都表示「还在动」：重试仍在进行，失败、阻断与提示都是静止的。
	// 空闲期的警告没有刷新帧，画一个转圈符号只会冻在某一帧，看起来像卡住了。
	const spinning =
		state.statusTone === undefined || (state.statusTone === "warning" && active !== undefined);
	const status =
		state.statusText === undefined && state.copyNotice === undefined
			? undefined
			: {
					symbol:
						state.statusText === undefined
							? ""
							: spinning
							  ? (SPINNER_FRAMES[state.spinnerFrame] ?? "")
							  : "",
					text: state.statusText ?? "",
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
						state.copyNotice !== undefined
							? undefined
							: active !== undefined
								? active.tokensUsed
								: state.statusTokens > 0
									? state.statusTokens
									: undefined,
					tokenLabel: state.copyNotice,
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
						// 模态面板只是浮在输入框上方，输入框仍是使用者正在编辑的地方：
						// 保留焦点样式，不要因为面板抢走按键就把边框变灰
						state.focused,
						undefined,
						currentInfo(host),
						{ leadingGap: false, showStatus: false, cursor: state.inputCursor, commandLength },
					)
				: renderFooter(width, state.input, state.focused, status, currentInfo(host), {
						cursor: state.inputCursor,
						commandLength,
						queued: state.queued.map((item) => item.text),
					});
	// 输入框一有字就收起启动画面：欢迎屏只在真正空闲时出现。hasInput 记录已经开始的对话，
	// input.length 覆盖还没提交的普通输入与斜杠命令。
	const transcriptShown =
		trust === undefined &&
		state.openPage === undefined &&
		(state.hasInput || state.input.length > 0 || host.noticeText() !== undefined);
	// 运行中的行按当前帧重建转圈与扫光；没有动画行时这只是原样返回缓存行
	const animation: AnimationFrame = {
		spinner: SPINNER_FRAMES[state.spinnerFrame] ?? "",
		sweepPhase: state.sweepPhase,
	};
	const selection =
		state.selection !== undefined && selectionSpans(state.selection) ? state.selection : undefined;
	const main =
		trust !== undefined
			? trustPageLines(trust, width, mainHeight, state.trustScrollTop)
			: state.openPage !== undefined
				? framedPageFor(host, state.openPage, width, mainHeight)
				: transcriptShown
					? renderTranscriptView(view, mainHeight, state.scrollTop, animation, selection)
					: // 启动画面:没有横幅,主区域留空,第一轮对话开始后才由 transcript 接管
						Array.from({ length: mainHeight }, () => "");
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
	// 整屏自上而下：主区域、任务面板、选择面板、页脚
	const lines = [...mainLines, ...panelLines, ...menuLines, ...footer];
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
	// 整屏页的滚动条：内容超出视口时在最后一列画出位置，和对话流保持同一套指示
	if (state.openPage !== undefined && !state.layoutOverflow) {
		const kind = state.openPage;
		const actionHeight =
			kind === "plan"
				? PLAN_ACTION_HEIGHT
				: kind === "mcps"
					? MCP_ACTION_HEIGHT
					: kind === "viewer"
						? VIEWER_ACTION_HEIGHT
						: 0;
		const contentHeight = Math.max(0, mainHeight - actionHeight);
		const content = host.pageLines(kind, width);
		if (contentHeight > 0 && content.length > contentHeight) {
			const gutter = scrollbarColumn(contentHeight, content.length, state.pageScrollTop);
			for (let row = 0; row < gutter.length; row += 1) {
				frame += `${moveCursor(row + 1, width)}${gutter[row]}`;
			}
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
	// 整屏页独占主区域：页脚高度为 0 时再叠一块菜单会把页面顶部挤出屏幕
	if (state.openPage !== undefined) return [];
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
	if (state.modelMenu !== undefined) return renderModelMenu(width, state.modelMenu, menuVisibleLimit(state));
	if (state.effortMenu !== undefined) return renderEffortMenu(width, state.effortMenu, menuVisibleLimit(state));
	if (state.sessionMenu !== undefined) {
		return renderSessionMenu(width, state.sessionMenu, menuVisibleLimit(state));
	}
	if (state.commandMenu !== undefined) {
		return renderCommandMenu(width, state.commandMenu, menuVisibleLimit(state));
	}
	if (state.fileMenu !== undefined) return renderFileMenu(width, state.fileMenu, menuVisibleLimit(state));
	if (state.skillMenu !== undefined) return renderSkillMenu(width, state.skillMenu, menuVisibleLimit(state));
	return [];
}

/** 页脚常驻信息。 */
function currentInfo(host: TuiHost): FooterInfo {
	const info = typeof host.options.info === "function" ? host.options.info() : host.options.info;
	const mode = host.options.approvalMode?.current();
	const withPlan = host.options.planMode?.current() === true ? { ...info, planMode: true } : info;
	return mode === undefined ? withPlan : { ...withPlan, approval: mode };
}


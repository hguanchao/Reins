import { THEME } from "../render/theme.ts";

/** 用户提示背景，与菜单面板使用同一档浮起表面。 */
export const PROMPT_BG = THEME.surface;
/** 用户提示与回复正文统一使用主文字色。 */
export const MESSAGE_TEXT_COLOR = THEME.textPrimary;
/** 思考摘要比正文弱一档：它是过程的痕迹，不是要读的内容。 */
export const THINKING_COLOR = THEME.textSubtle;
/** 展开后标题标签的提亮色：主文字色 #e6e9ed。 */
export const THINKING_ACTIVE_COLOR = THEME.textPrimary;
/** 思考区块的底色：与用户提示块共用浮起表面，和普通正文分开。 */
export const THINKING_BG = THEME.surface;
/** 工具名与标记比正文弱一档，参数才是要读的内容。 */
export const TOOL_NAME_COLOR = THEME.textSubtle;
/** 工具组头比普通工具名亮一档，作为一组调用的摘要。 */
export const TOOL_GROUP_COLOR = THEME.textSecondary;
/** 失败的行用错误色：出事时那行得能从正文里一眼看见。 */
export const ERROR_COLOR = THEME.error;
/** 启动警告使用警告色，与普通正文区分开。 */
export const NOTICE_COLOR = THEME.warning;
/** 滚动条颜色。 */
export const SCROLLBAR_COLOR = THEME.scrollbar;
export const SCROLLBAR_TRACK = " ";
export const SCROLLBAR_THUMB = "█";
export const RESET = THEME.reset;
/**
 * 实线下划线。
 *
 * 只表示一件事：这一行的参数可以点开（链接）或展开。不用点线——SGR 4:4 要靠终端与字体
 * 同时支持，不支持时退化成实线，反而和链接线混成一样；与其这样，不如只用一种线型。
 */
export const UNDERLINE = "\x1b[4m";

/** 用户提示首行符号前留一列，正文因此比模型回复多缩进一列。 */
export const PROMPT_PREFIX = " › ";
/** 提示续行与首行正文对齐。 */
export const PROMPT_INDENT = "   ";
/** 模型回复的缩进。 */
export const RESPONSE_INDENT = "  ";
/** 运行时收起状态下显示的最后几行思考正文。 */
export const THINKING_TAIL_LINES = 5;
/** 成功工具结果默认最多展开多少行。 */
export const TOOL_RESULT_PREVIEW_LINES = 20;
/**
 * 展开详情最多渲染的行数。
 *
 * 工具结果可能上千行（列一棵含缓存目录的树、读一个大文件），全铺进对话流会把这一轮的其他
 * 内容挤出屏幕。只截显示不截数据：全文仍留在 tool.fullDetail 里。
 */
export const DETAIL_BAND_MAX_LINES = 60;
/** 思考标题的标记：单列火花，与工具行的 ›、失败行的 × 区分。 */
const THINKING_MARKER = "✻";
/** 展开后的菱形标记：工具组头和思考块共用。 */
const EXPANDED_DIAMOND = "◈";
/** 思考标题的缩进；正文缩进到与 Think…/Thought… 的首字对齐。 */
export const THINKING_PREFIX = `${RESPONSE_INDENT}${THINKING_MARKER} `;
export const THINKING_EXPANDED_PREFIX = `${RESPONSE_INDENT}${EXPANDED_DIAMOND} `;
/** 思考正文的左右内边距。 */
export const THINKING_PADDING = 1;
/** 工具调用沿用用户提示的标记，两类条目在同一列起头。 */
export const TOOL_MARKER = "›";
/** 展开后的工具用实心菱形，和折叠态区分。 */
export const TOOL_EXPANDED_MARKER = "◆";
/** 展开的工具组用带心菱形；收起时沿用工具行的 ›。 */
export const TOOL_GROUP_EXPANDED_MARKER = EXPANDED_DIAMOND;
/** 工具组成员比组头多缩进两格。 */
export const TOOL_GROUP_MEMBER_INDENT = `${RESPONSE_INDENT}  `;
/** 错误行的标记：与工具失败行共用，错误消息因此有一致的起头。 */
export const ERROR_MARKER = "×";
/** 子代理组头的固定标签。 */
export const SUBAGENT_GROUP_LABEL = "Subagents";
/** 子代理组清单的缩进:比组头正文深两列,与工具组成员同一节奏。 */
export const SUBAGENT_ITEM_INDENT = `${RESPONSE_INDENT}  `;
/** 清单里任务摘要的显示宽度上限,超出省略。 */
export const SUBAGENT_TASK_WIDTH = 34;
/** 待办与待派发子代理的标记:还没有可汇报的结局。 */
export const SUBAGENT_PENDING_MARKER = "○";
/**
 * 子代理的配色分工:组头标签与清单标签是青色(清单标签加粗),其余文字一律灰——
 * 一屏里抢眼的只有「有几个代理、各自叫什么」。失败是唯一的例外:整行失败色。
 */
export const SUBAGENT_HEAD_COLOR = THEME.accent;
export const SUBAGENT_RUNNING_COLOR = THEME.accent;
export const SUBAGENT_TEXT_COLOR = THEME.textSecondary;
export const SUBAGENT_COUNT_COLOR = THEME.textSecondary;
export const SUBAGENT_FAILED_COLOR = THEME.error;
/** 加粗:清单标签是全行焦点。 */
export const SUBAGENT_BOLD = "\x1b[1m";
/** 计划卡：标记与标签用强调色，标题回到正文色，提示保持弱化。 */
export const PLAN_MARKER_COLOR = THEME.accent;
export const PLAN_TITLE_COLOR = THEME.textPrimary;
export const PLAN_HINT_COLOR = THEME.textSubtle;
export const PLAN_CARD_HINT = "  ·  double-click to view";
export const PROMPT_MAX_LINES = 3;
/** 右侧固定预留一列空隙和一列滚动条。 */
export const GUTTER_WIDTH = 2;
/** 展开详情右侧留出的内边距：正文不贴着色带右缘。 */
export const DETAIL_RIGHT_PADDING = 1;
/** 详情色带相对标题标记列的左侧留白：色带不贴菱形，行号也不与标题文字挤在同一侧。 */
export const DETAIL_BAND_LEFT = 2;
/** 窄终端下正文至少保留的列数：行号与标记必须为它让位，否则这一行什么也读不到。 */
export const MIN_DETAIL_CONTENT = 4;
/**
 * 制表符宽度。
 *
 * 终端只会把光标跳到下一个制表位，不会为跳过的格子补底色；详情色带因此会在缩进处断开。
 * 上屏前统一展开成空格，行宽计算与背景填充才一致。
 */
export const TAB_STOP = 4;

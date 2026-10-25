/** 第一次 Ctrl+C 之后等待第二次的时间；超过就回到未确认状态。 */
export const EXIT_CONFIRM_WINDOW_MS = 2000;
/** 运行时状态前的加载动画。 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 100;
/** 完整页脚除输入行外的固定行数:空白间隔、状态行、上下边框与常驻信息行。 */
export const FULL_FOOTER_FIXED_LINES = 5;
/** 紧凑页脚除输入行外的固定行数:上下边框与常驻信息行。 */
export const COMPACT_FOOTER_FIXED_LINES = 3;
/** 输入行首行相对页脚顶部的 1 基行号:完整页脚排在空行、状态行、上边框之后。 */
export const FULL_FOOTER_INPUT_ROW = 4;
/** 紧凑页脚里输入行紧跟上边框。 */
export const COMPACT_FOOTER_INPUT_ROW = 2;
/** 每帧把扫光往前推多少；整个状态行约 1.25 秒扫一遍。 */
export const SWEEP_STEP = 0.08;
/** 滚轮每格滚动固定行数，保持手感稳定。 */
export const WHEEL_STEP = 3;
/** 同一位置两次按下在这个窗口内算双击。 */
export const DOUBLE_CLICK_MS = 400;
/** 一轮结束后状态行停留的时间。 */
export const STATUS_CLEAR_MS = 1500;

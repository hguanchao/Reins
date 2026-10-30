/** 第一次 Ctrl+C 之后等待第二次的时间；超过就回到未确认状态。 */
export const EXIT_CONFIRM_WINDOW_MS = 2000;
/** 第一次 Esc 之后等待第二次的时间；超过就重新计数，草稿不会被一下按掉。 */
export const CLEAR_CONFIRM_WINDOW_MS = 800;
/** 未完成的转义序列最多等这么久；超过就按普通输入处理，避免按键被无限挂起。 */
export const INPUT_TAIL_TIMEOUT_MS = 50;
/** 粘贴态下长时间没有新数据就复位：终端丢了结束标记时不能把键盘永久锁死。 */
export const PASTE_STALL_TIMEOUT_MS = 10_000;
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
/** 清空后「可以撤销」的提示停留时间：比普通状态久一点，但也不能一直占着状态行。 */
export const UNDO_HINT_MS = 4000;

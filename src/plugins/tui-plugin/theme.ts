import type { Rgb, Style } from "../../tui/index.ts";

/**
 * 界面配色。
 *
 * 颜色属于产品外观，因此定在界面这边而不是终端库里：终端库只认「一行上有哪些样式」，
 * 具体用哪几种颜色由界面决定。
 *
 * 整体是深色：底色近乎黑，正文是浅灰，彩色只留给需要一眼分清的东西——使用者的消息、模型的
 * 产出、成功与失败、路径。这样正文永远是最安静的那一层，界面上抢眼的东西都是有意义的。
 */

const rgb = (red: number, green: number, blue: number): Rgb => [red, green, blue];

export const THEME = {
	/** 屏幕底色 */
	base: rgb(0x14, 0x14, 0x14),
	/** 使用者消息的铺底 */
	band: rgb(0x24, 0x24, 0x24),
	/** 正文 */
	text: rgb(0xe1, 0xe1, 0xe1),
	/** 次要文字：工具名、耗时、说明 */
	muted: rgb(0x6c, 0x6c, 0x6c),
	/** 再淡一层：菱形、竖线、分段符 */
	faint: rgb(0x58, 0x58, 0x58),
	/** 比次要文字亮一档：按键、菜单项 */
	bright: rgb(0xc8, 0xc8, 0xc8),
	/** Markdown 一级标题的青绿 */
	mdTeal: rgb(0x1a, 0xbc, 0x9c),
	/** Markdown 四级标题的中灰 */
	grayBright: rgb(0x78, 0x78, 0x78),
	/** 模型正在说的与正在做的 */
	accent: rgb(0xbb, 0x9a, 0xf7),
	/** 系统类信息：提示、行内代码 */
	system: rgb(0x7a, 0xa2, 0xf7),
	/** 一级标题与强调用的青色 */
	teal: rgb(0x73, 0xda, 0xca),
	/** 行内代码与代码文字 */
	code: rgb(0x3a, 0x95, 0xab),
	/** 代码块底色 */
	codeBg: rgb(0x1c, 0x1c, 0x1c),
	/** 面板里被选中的行 */
	selectBg: rgb(0x36, 0x36, 0x36),
	/** 粘贴 chip 的底色：比正文低一档，提醒它是一段折叠起来的内容 */
	pasteBg: rgb(0x2c, 0x2a, 0x36),
	/** 路径 */
	path: rgb(0xff, 0x9e, 0x64),
	/** 需要注意但不致命的事：没读的配置、被拒绝的发送 */
	warn: rgb(0xff, 0x9e, 0x64),
	/** 成功 */
	ok: rgb(0x9e, 0xce, 0x6a),
	/** 失败 */
	bad: rgb(0xf7, 0x76, 0x8e),
	/** 边框 */
	edge: rgb(0x32, 0x32, 0x37),
	/** 亮一档的边框：轨道刻度、将来的聚焦态 */
	edgeLit: rgb(0x50, 0x50, 0x58),
	/** 滚动条轨道的底色：比屏幕底色还暗一档，让滑块自己浮起来 */
	scrollTrack: rgb(0x11, 0x11, 0x11),
	/** 滚动条滑块：和色带同色，够看见又不抢眼 */
	scrollThumb: rgb(0x24, 0x24, 0x24),
} as const;

export const TEXT: Style = { color: THEME.text };
export const DIM: Style = { color: THEME.muted };
export const FAINT: Style = { color: THEME.faint };
export const BRIGHT: Style = { color: THEME.bright };
export const ACCENT: Style = { color: THEME.accent };
export const SYSTEM: Style = { color: THEME.system };
export const TEAL: Style = { color: THEME.teal };
export const CODE: Style = { color: THEME.code };
export const CODE_BG: Style = { background: THEME.codeBg };
/** 选中行的底色。 */
export const SELECT_BG: Style = { background: THEME.selectBg };
/** 粘贴 chip 的底色。 */
export const PASTE_BG: Style = { background: THEME.pasteBg };
export const PATH: Style = { color: THEME.path };
export const WARN: Style = { color: THEME.warn };
export const OK: Style = { color: THEME.ok };
export const BAD: Style = { color: THEME.bad };
export const EDGE: Style = { color: THEME.edge };
export const EDGE_LIT: Style = { color: THEME.edgeLit };
export const BOLD: Style = { bold: true };
/** 卡片的问句、标题这类要压过正文一头的文字。 */
export const TITLE: Style = { bold: true, color: THEME.text };
/** 整行铺底。 */
export const BAND: Style = { background: THEME.band };
/** 全屏底色：备用屏里每一行都铺满它，界面与非界面的输出才像同一块屏。 */
export const BG: Style = { background: THEME.base };
/** 滚动条滑块：实心块，前后景色同色。 */
export const SCROLL_THUMB: Style = { color: THEME.scrollThumb, background: THEME.scrollThumb };
/** 滚动条轨道：只换底色的空格，在屏幕底色上若隐若现。 */
export const SCROLL_TRACK: Style = { background: THEME.scrollTrack };

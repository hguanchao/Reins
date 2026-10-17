/**
 * 终端设备。
 *
 * 界面对终端的全部依赖都收在这里，测试可以换一个内存实现：整套界面逻辑因此不必真的开一个
 * 伪终端就能验证。切换原始模式、开关光标与括号粘贴也都算设备能力——它们发出的同样是控制
 * 序列，和写内容没有区别。
 */

export interface TerminalSize {
	readonly rows: number;
	readonly cols: number;
}

/** 只写不管模式的那部分终端能力。屏幕层只依赖它，因此可以对着一个哑设备测试。 */
export interface TerminalDevice {
	/** 当前尺寸。 */
	size(): TerminalSize;
	write(text: string): void;
}

export interface Terminal extends TerminalDevice {
	/** 订阅按键数据。数据已经按 UTF-8 解码，但转义序列可能被切在两次回调之间。 */
	onInput(listener: (chunk: string) => void): void;
	onResize(listener: () => void): void;
	/** 进入原始模式：按键立即送达，Ctrl+C 不再变成信号。 */
	setRawMode(enabled: boolean): void;
	setCursorVisible(visible: boolean): void;
	/** 括号粘贴：粘贴的文本被括起来，其中的换行不会被当成回车。 */
	setBracketedPaste(enabled: boolean): void;
	/** 焦点变化上报：终端失去焦点时通知我们，据此决定要不要响铃或弹通知。 */
	setFocusReporting(enabled: boolean): void;
	/**
	 * 鼠标上报。
	 *
	 * 备用屏里没有终端自带的回滚缓冲，滚轮只有终端把它报上来才翻得动主区。代价是鼠标不再
	 * 归终端管——要选中文本得按住 Shift，所以只在该接管的那段时间里开着。
	 */
	setMouseTracking(enabled: boolean): void;
	/**
	 * 备用屏。
	 *
	 * 进入时终端切到一块独立屏幕，退出时原样恢复主屏——对话不会留在使用者的 shell 历史里。
	 * 代价是终端自带的滚动区没了，回看历史要靠自己画。
	 */
	setAlternateScreen(enabled: boolean): void;
}

/** 默认尺寸只用于「输出不是终端」这种启动阶段就会拒绝的情形。 */
const FALLBACK_SIZE: TerminalSize = { rows: 24, cols: 80 };

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const ENABLE_PASTE = "\x1b[?2004h";
const DISABLE_PASTE = "\x1b[?2004l";
const ENABLE_FOCUS = "\x1b[?1004h";
const DISABLE_FOCUS = "\x1b[?1004l";
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
/**
 * 鼠标上报：普通上报加 SGR 编码。
 *
 * 老式编码把按键与坐标各塞进一个字节，列号超过 95 就报不准；SGR 用十进制写坐标，宽屏也
 * 不会错位。
 */
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";

/** 真实终端：进程的标准输入输出。 */
export class ProcessTerminal implements Terminal {
	readonly #input: NodeJS.ReadStream | NodeJS.ReadableStream;
	readonly #output: NodeJS.WriteStream | NodeJS.WritableStream;

	constructor(input: NodeJS.ReadStream | NodeJS.ReadableStream, output: NodeJS.WriteStream | NodeJS.WritableStream) {
		this.#input = input;
		this.#output = output;
	}

	size(): TerminalSize {
		const stream = this.#output as { readonly columns?: number; readonly rows?: number };
		const cols = stream.columns;
		const rows = stream.rows;
		if (cols === undefined || rows === undefined || cols <= 0 || rows <= 0) return FALLBACK_SIZE;
		return { rows, cols };
	}

	write(text: string): void {
		this.#output.write(text);
	}

	onInput(listener: (chunk: string) => void): void {
		// 按字符串解码而不是自己拼 Buffer：多字节字符被切在两次回调之间时，由解码器兜住
		(this.#input as NodeJS.ReadableStream).setEncoding("utf8");
		this.#input.on("data", (chunk) => listener(String(chunk)));
	}

	onResize(listener: () => void): void {
		this.#output.on("resize", listener);
	}

	setRawMode(enabled: boolean): void {
		const input = this.#input as { setRawMode?: (value: boolean) => void };
		if (input.setRawMode === undefined) {
			throw new Error("Standard input is not a terminal; cannot enter raw mode");
		}
		input.setRawMode(enabled);
	}

	setCursorVisible(visible: boolean): void {
		this.write(visible ? SHOW_CURSOR : HIDE_CURSOR);
	}

	setBracketedPaste(enabled: boolean): void {
		this.write(enabled ? ENABLE_PASTE : DISABLE_PASTE);
	}

	setFocusReporting(enabled: boolean): void {
		this.write(enabled ? ENABLE_FOCUS : DISABLE_FOCUS);
	}

	setMouseTracking(enabled: boolean): void {
		this.write(enabled ? ENABLE_MOUSE : DISABLE_MOUSE);
	}

	setAlternateScreen(enabled: boolean): void {
		this.write(enabled ? ENTER_ALT_SCREEN : LEAVE_ALT_SCREEN);
	}
}

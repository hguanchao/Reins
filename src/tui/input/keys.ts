/**
 * 按键解码。
 *
 * 终端把按键发成一串字节，方向键、功能键都是转义序列，而且可能被切在两次读取之间——一次
 * 读取拿到 ESC，下一次才拿到 "[A"。所以这里做成有状态的解码器：拼不完整的序列先留在缓冲
 * 里等下一段数据，宁可慢一个字符，也不能把方向键当成文本插进输入框。
 *
 * 认不出来的序列一律丢掉而不是当文本：终端还会发来鼠标事件、终端自身状态的回复等等，
 * 把它们显示在输入框里是纯粹的噪声。鼠标报告里只有滚轮有用——它是备用屏里唯一能滚动主区的
 * 输入——其余（按下、松开、移动）同样丢掉。
 */

export type KeyName =
	| "enter"
	/** Ctrl+J 或 Alt+Enter：在输入框里插入换行 */
	| "newline"
	| "backspace"
	| "delete"
	| "tab"
	| "escape"
	| "left"
	| "right"
	| "up"
	| "down"
	| "home"
	| "end"
	| "pageup"
	| "pagedown"
	| "ctrl-a"
	| "ctrl-c"
	| "ctrl-d"
	| "ctrl-e"
	| "ctrl-k"
	| "ctrl-l"
	| "ctrl-n"
	| "ctrl-p"
	/** Ctrl+Q：与 Ctrl+D 同为退出键 */
	| "ctrl-q"
	| "ctrl-u"
	| "ctrl-v"
	/** Ctrl+Shift+V：内联粘贴，不生成粘贴 chip */
	| "ctrl-shift-v"
	| "ctrl-w"
	| "ctrl-y"
	| "ctrl-z";

export type KeyEvent =
	| { readonly type: "text"; readonly text: string }
	/** 括号粘贴的内容。里面的换行是粘贴文本的一部分，不是回车。 */
	| { readonly type: "paste"; readonly text: string }
	/** 终端窗口获得或失去焦点 */
	| { readonly type: "focus"; readonly focused: boolean }
	/** 滚轮方向与指针位置 */
	| { readonly type: "wheel"; readonly direction: "up" | "down"; readonly col: number; readonly row: number }
	/** 鼠标按键、拖动与松开；坐标从 1 开始，与终端一致 */
	| {
			readonly type: "mouse";
			readonly action: "down" | "drag" | "up" | "move";
			readonly button: "left" | "middle" | "right" | "none";
			readonly col: number;
			readonly row: number;
	  }
	| { readonly type: "key"; readonly name: KeyName };

const ESCAPE = "\x1b";
const PASTE_END = "\x1b[201~";

/** CSI 序列的终止字符到按键。 */
const CSI_KEYS: ReadonlyMap<string, KeyName> = new Map([
	["A", "up"],
	["B", "down"],
	["C", "right"],
	["D", "left"],
	["H", "home"],
	["F", "end"],
	["1~", "home"],
	["3~", "delete"],
	["4~", "end"],
	["5~", "pageup"],
	["6~", "pagedown"],
	["7~", "home"],
	["8~", "end"],
]);

/** SS3 序列（应用光标键模式）的终止字符到按键。 */
const SS3_KEYS: ReadonlyMap<string, KeyName> = new Map([
	["A", "up"],
	["B", "down"],
	["C", "right"],
	["D", "left"],
	["H", "home"],
	["F", "end"],
]);

const CONTROL_KEYS: ReadonlyMap<string, KeyName> = new Map([
	["\x01", "ctrl-a"],
	["\x03", "ctrl-c"],
	["\x04", "ctrl-d"],
	["\x05", "ctrl-e"],
	["\x0b", "ctrl-k"],
	["\x0c", "ctrl-l"],
	["\x0e", "ctrl-n"],
	["\x10", "ctrl-p"],
	["\x11", "ctrl-q"],
	["\x15", "ctrl-u"],
	["\x16", "ctrl-v"],
	["\x17", "ctrl-w"],
	["\x19", "ctrl-y"],
	["\x1a", "ctrl-z"],
]);

export class KeyDecoder {
	#buffer = "";
	#pasting = false;

	/** 追加一段输入，返回此刻能确定的按键。 */
	push(chunk: string): readonly KeyEvent[] {
		this.#buffer += chunk;
		return this.#drain();
	}

	/**
	 * 收尾。
	 *
	 * 缓冲里只剩一个孤立的 ESC 时，它要么是 Esc 键，要么是一个还没到齐的序列的开头。调用方
	 * 等一小段时间后调用这里，把它按 Esc 处理；更长的残片继续留着，因为下一段数据仍可能补齐它。
	 */
	flush(): readonly KeyEvent[] {
		if (this.#buffer !== ESCAPE) return [];
		this.#buffer = "";
		return [{ type: "key", name: "escape" }];
	}

	#drain(): KeyEvent[] {
		const events: KeyEvent[] = [];

		for (;;) {
			if (this.#buffer.length === 0) break;

			if (this.#pasting) {
				const end = this.#buffer.indexOf(PASTE_END);
				if (end >= 0) {
					if (end > 0) events.push({ type: "paste", text: this.#buffer.slice(0, end) });
					this.#buffer = this.#buffer.slice(end + PASTE_END.length);
					this.#pasting = false;
					continue;
				}
				// 结束标记可能被切在两次数据之间：只压住确实可能是标记开头的那几个字符
				const hold = trailingPrefixLength(this.#buffer, PASTE_END);
				const safe = this.#buffer.length - hold;
				if (safe > 0) {
					events.push({ type: "paste", text: this.#buffer.slice(0, safe) });
					this.#buffer = this.#buffer.slice(safe);
				}
				break;
			}

			const char = this.#buffer[0];
			if (char === ESCAPE) {
				const consumed = this.#decodeEscape(events);
				if (consumed === 0) break;
				this.#buffer = this.#buffer.slice(consumed);
				continue;
			}

			const key = singleKey(char);
			if (key !== undefined) {
				events.push({ type: "key", name: key });
				this.#buffer = this.#buffer.slice(1);
				continue;
			}
			if (isControl(char)) {
				// 没有绑定的控制字符直接丢掉，免得混进输入内容
				this.#buffer = this.#buffer.slice(1);
				continue;
			}

			const end = nextSpecialIndex(this.#buffer);
			events.push({ type: "text", text: this.#buffer.slice(0, end) });
			this.#buffer = this.#buffer.slice(end);
		}

		return events;
	}

	/** 解析一个转义序列；返回消费了几个字符，0 表示还要等更多数据。 */
	#decodeEscape(events: KeyEvent[]): number {
		if (this.#buffer.length === 1) return 0;

		const second = this.#buffer[1];
		if (second === "[") {
			// CSI：参数 + 终止符
			let index = 2;
			while (index < this.#buffer.length) {
				const code = this.#buffer.charCodeAt(index);
				if (code >= 0x40 && code <= 0x7e) break;
				index += 1;
			}
			if (index >= this.#buffer.length) return 0;

				const sequence = this.#buffer.slice(2, index + 1);
				if (sequence === "200~") {
					this.#pasting = true;
					return index + 1;
				}
				if (modifiedEnterKey(sequence)) {
					events.push({ type: "key", name: "newline" });
					return index + 1;
				}
				const modified = modifiedPasteKey(sequence);
				if (modified !== undefined) {
					events.push({ type: "key", name: modified });
					return index + 1;
				}
				if (sequence === "I") events.push({ type: "focus", focused: true });
			else if (sequence === "O") events.push({ type: "focus", focused: false });
			else {
				const mouse = mouseFromSgr(sequence);
				if (mouse !== undefined) {
					if (mouse.action === "event") events.push(mouse.event);
					else {
						events.push({
							type: "wheel",
							direction: mouse.action === "wheel-up" ? "up" : "down",
							col: mouse.col,
							row: mouse.row,
						});
					}
				} else {
					const key = CSI_KEYS.get(sequence);
					if (key !== undefined) events.push({ type: "key", name: key });
				}
			}
			return index + 1;
		}

		if (second === "O") {
			// SS3：ESC O 加一个字符
			if (this.#buffer.length < 3) return 0;
			const key = SS3_KEYS.get(this.#buffer[2]);
			if (key !== undefined) events.push({ type: "key", name: key });
			return 3;
		}

		// ESC 后紧跟回车：Alt+Enter，输入框里按换行处理，不当作 Esc + Enter
		if (second === "\r" || second === "\n") {
			events.push({ type: "key", name: "newline" });
			return 2;
		}

		if (second === "]") {
			// 操作系统命令序列：终端回答自己的状态时用它，一路读到结束标记为止
			const bell = this.#buffer.indexOf("\x07", 2);
			const terminator = this.#buffer.indexOf("\x1b\\", 2);
			if (bell < 0 && terminator < 0) return 0;
			if (bell >= 0 && (terminator < 0 || bell < terminator)) return bell + 1;
			return terminator + 2;
		}

		// 孤立的 ESC 后面跟着普通字符：ESC 就是 Esc 键，后一个字符留给下一轮
		events.push({ type: "key", name: "escape" });
		return 1;
	}
}

function singleKey(char: string): KeyName | undefined {
	if (char === "\r") return "enter";
	if (char === "\n") return "newline";
	if (char === "\x7f" || char === "\x08") return "backspace";
	if (char === "\t") return "tab";
	return CONTROL_KEYS.get(char);
}

/**
 * Shift/Alt+Enter 的带修饰编码。
 *
 * 只有终端主动开启 modifyOtherKeys 或 kitty 键盘协议时才会收到；这一层不主动开启，
 * 免得把普通大写字母也改成 CSI 序列。收到时按换行处理，Ctrl+Enter 仍留给终端。
 */
function modifiedEnterKey(sequence: string): boolean {
	// xterm modifyOtherKeys: CSI 27;修饰;13~
	const xterm = /^27;(\d+);13~$/.exec(sequence);
	if (xterm !== null) return newlineModifier(Number(xterm[1]));

	// kitty: CSI 13;修饰u
	const kitty = /^13;(\d+)(?::\d+)?u$/.exec(sequence);
	if (kitty !== null) return newlineModifier(Number(kitty[1]));

	return false;
}

function newlineModifier(modifier: number): boolean {
	const bits = modifier - 1;
	return (bits & 1) !== 0 || (bits & 2) !== 0;
}

/**
 * 带修饰键的粘贴按键。
 *
 * 终端通常把 Ctrl+Shift+V 自己处理成括号粘贴；只有开启了 kitty 键盘协议或 xterm 的
 * modifyOtherKeys 时才会把组合键原样送进来。这里认这两种写法，认不出就照旧丢掉。
 */
function modifiedPasteKey(sequence: string): KeyName | undefined {
	// kitty: CSI 118;5u（Ctrl+V）、CSI 118;6u（Ctrl+Shift+V）；可能带 ":事件类型"
	const kitty = /^([Vv]|86|118);([56])(?::\d+)?u$/.exec(sequence);
	if (kitty !== null) return kitty[2] === "6" ? "ctrl-shift-v" : "ctrl-v";

	// xterm modifyOtherKeys: CSI 27;6;118~
	const xterm = /^27;([56]);([Vv]|86|118)~$/.exec(sequence);
	if (xterm !== null) return xterm[1] === "6" ? "ctrl-shift-v" : "ctrl-v";

	return undefined;
}

/**
 * SGR 鼠标报告。
 *
 * 序列形如 `<0;12;3M`：按钮编号、列、行。末尾大写 M 表示按下或移动，小写 m 表示松开。
 * 按钮编号的低两位是键（0 左、1 中、2 右），32 位表示按住移动；64/65 是滚轮，与按钮编号
 * 连在一起，不能改。修饰键位（4/8/16）对界面没有意义，忽略。
 */
type SgrMouse =
	| { readonly action: "wheel-up"; readonly col: number; readonly row: number }
	| { readonly action: "wheel-down"; readonly col: number; readonly row: number }
	| {
			readonly action: "event";
			readonly event: Extract<KeyEvent, { type: "mouse" }>;
	  };

function mouseFromSgr(sequence: string): SgrMouse | undefined {
	if (!sequence.startsWith("<")) return undefined;
	const released = sequence.endsWith("m");
	if (!released && !sequence.endsWith("M")) return undefined;

	const [code, col, row] = sequence.slice(1, -1).split(";").map(Number);
	if (!Number.isInteger(code) || !Number.isInteger(col) || !Number.isInteger(row)) return undefined;
	if (col < 1 || row < 1) return undefined;

	if (!released && code === 64) return { action: "wheel-up", col, row };
	if (!released && code === 65) return { action: "wheel-down", col, row };
	// 横向滚轮与其它扩展按钮没有绑定
	if (code >= 64) return undefined;

	const buttonBits = code & 3;
	if (buttonBits === 3) {
		// ?1003 的「无按键移动」：悬停预览用它
		return {
			action: "event",
			event: { type: "mouse", action: "move", button: "none", col, row },
		};
	}
	const button = buttonBits === 0 ? "left" : buttonBits === 1 ? "middle" : "right";
	const moving = (code & 32) !== 0;
	return {
		action: "event",
		event: {
			type: "mouse",
			action: released ? "up" : moving ? "drag" : "down",
			button,
			col,
			row,
		},
	};
}

function isControl(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 0x20 || code === 0x7f;
}

/** 串尾有多长的一段是某个标记的开头。 */
function trailingPrefixLength(text: string, marker: string): number {
	const longest = Math.min(marker.length - 1, text.length);
	for (let length = longest; length > 0; length -= 1) {
		if (marker.startsWith(text.slice(text.length - length))) return length;
	}
	return 0;
}

/** 从串首走到下一个需要单独处理的位置。调用方已确认首字符不是特殊字符。 */
function nextSpecialIndex(text: string): number {
	for (let index = 1; index < text.length; index += 1) {
		const char = text[index];
		if (char === ESCAPE || isControl(char)) return index;
	}
	return text.length;
}

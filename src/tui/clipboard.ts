import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 系统剪贴板。
 *
 * 终端里没有一个可靠的剪贴板接口：本机命令、tmux 缓冲、OSC 52 各有各的盲区。这里不挑一条
 * 路走，而是把当前环境能用的路都试一遍，再按结果给出诚实的反馈。无论剪贴板是否成功，复制
 * 内容都会另存一份文件——SSH 或容器里 OSC 52 被吞掉时，使用者还能从文件里拿到内容。
 */

export type ClipboardDelivery = "confirmed" | "unverified" | "failed";

/** 一次复制实际走过的路径。 */
export interface ClipboardRoute {
	/** 调用平台自带的剪贴板命令。 */
	readonly native: boolean;
	/** 写入 tmux 的粘贴缓冲。 */
	readonly tmux: boolean;
	/** 向终端发 OSC 52。 */
	readonly osc52: boolean;
	/** 在 tmux 里用 DCS passthrough 包住 OSC 52。 */
	readonly passthrough: boolean;
}

export interface ClipboardRouteInput {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly platform?: NodeJS.Platform;
	/** 是否运行在容器里；不传则按环境变量与 /.dockerenv 判断。 */
	readonly container?: boolean;
}

/**
 * 计算复制路径。
 *
 * Linux 一律发 OSC 52；macOS 与 Windows 只在 tmux、SSH、无显示容器或显式包装端里发，避免
 * 本机已经能直写剪贴板时再多发一条序列。`REINS_CLIPBOARD_NO_OSC52` 可以全局关掉。
 */
export function resolveClipboardRoute(input: ClipboardRouteInput = {}): ClipboardRoute {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const tmux = hasValue(env["TMUX"]);
	const remote = hasValue(env["SSH_CONNECTION"]) || hasValue(env["SSH_CLIENT"]) || hasValue(env["SSH_TTY"]);
	const container = input.container ?? isContainer(env);
	const containerWithoutDisplay =
		container && !hasValue(env["DISPLAY"]) && !hasValue(env["WAYLAND_DISPLAY"]);
	const sink = env["REINS_OSC52_SINK"] !== undefined || env["LC_REINS_OSC52_SINK"] !== undefined;
	// kill switch 按「变量存在」生效：设成空串也表示使用者明确要求关掉
	const disabled = env["REINS_CLIPBOARD_NO_OSC52"] !== undefined;
	const osc52 = !disabled && (platform === "linux" || tmux || remote || containerWithoutDisplay || sink);

	return {
		native: true,
		tmux,
		osc52,
		passthrough: osc52 && tmux,
	};
}

export interface CommandResult {
	readonly exitCode: number | null;
	readonly stdout: string;
}

/** 执行一个外部命令；测试可以换成不碰系统剪贴板的实现。 */
export type ClipboardCommand = (
	command: string,
	args: readonly string[],
	input?: string,
) => CommandResult;

export interface ClipboardOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly platform?: NodeJS.Platform;
	readonly home?: string;
	/** 备份文件的固定路径；测试用它避开真实主目录。 */
	readonly copyFile?: string;
	readonly command?: ClipboardCommand;
	/** OSC 52 的输出端，通常是终端写入。 */
	readonly write?: (sequence: string) => void;
	readonly container?: boolean;
}

export interface CopyOutcome {
	readonly delivery: ClipboardDelivery;
	readonly message: string;
	/** 备份文件路径；写失败时没有。 */
	readonly path?: string;
}

export interface ClipboardPort {
	copy(text: string): CopyOutcome;
	readText(): string | undefined;
}

const COMMAND_TIMEOUT_MS = 2000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** Windows 下用 PowerShell 读写，避免 clip.exe 在非系统代码页里弄乱中文。 */
const WINDOWS_SET_SCRIPT =
	"[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text";
const WINDOWS_GET_SCRIPT =
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))";

export class Clipboard implements ClipboardPort {
	readonly #env: Readonly<Record<string, string | undefined>>;
	readonly #platform: NodeJS.Platform;
	readonly #home: string;
	readonly #copyFile: string;
	readonly #command: ClipboardCommand;
	readonly #write: ((sequence: string) => void) | undefined;
	readonly #route: ClipboardRoute;

	constructor(options: ClipboardOptions = {}) {
		this.#env = options.env ?? process.env;
		this.#platform = options.platform ?? process.platform;
		this.#home = options.home ?? homedir();
		this.#copyFile = options.copyFile ?? defaultCopyPath(this.#env, this.#home);
		this.#command = options.command ?? runCommand;
		this.#write = options.write;
		this.#route = resolveClipboardRoute({
			env: this.#env,
			platform: this.#platform,
			container: options.container,
		});
	}

	/**
	 * 复制一段文本。
	 *
	 * 三条写入路径都会尝试，备份文件也总会写。优先级只决定提示语：本机写入最可信；OSC 52
	 * 只能算「已发出」；tmux 缓冲需要使用者自己按键粘贴，因此单独提示。
	 */
	copy(text: string): CopyOutcome {
		const native = this.#writeNative(text);
		const tmux = this.#writeTmux(text);
		const osc52 = this.#writeOsc52(text);
		const path = this.#writeBackup(text);

		if (native) return { delivery: "confirmed", message: "Copied!", path };
		if (osc52) {
			return {
				delivery: "unverified",
				message: path === undefined ? "Copy sent" : `Copy sent, saved to ${displayPath(path, this.#home)}`,
				path,
			};
		}
		if (tmux) return { delivery: "confirmed", message: "Copied to tmux buffer, paste with prefix + ]", path };
		if (path !== undefined) {
			return {
				delivery: "failed",
				message: `Clipboard unreachable: wrote ${displayPath(path, this.#home)}`,
				path,
			};
		}
		return { delivery: "failed", message: "Copy failed" };
	}

	/** 读系统剪贴板；没有任何读取后端成功时返回 undefined。空字符串是合法结果。 */
	readText(): string | undefined {
		for (const [command, args] of this.#readCommands()) {
			const result = this.#command(command, args);
			if (result.exitCode !== 0) continue;
			return result.stdout.replace(/^\uFEFF/, "");
		}
		return undefined;
	}

	#writeNative(text: string): boolean {
		return this.#nativeCommands().some(([command, args]) => this.#command(command, args, text).exitCode === 0);
	}

	#nativeCommands(): readonly (readonly [string, readonly string[]])[] {
		switch (this.#platform) {
			case "darwin":
				return [["pbcopy", []]];
			case "win32":
				return [
					["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SET_SCRIPT]],
					["clip.exe", []],
				];
			default: {
				const commands: (readonly [string, readonly string[]])[] = [];
				if (hasValue(this.#env["WAYLAND_DISPLAY"])) commands.push(["wl-copy", []]);
				commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
				return commands;
			}
		}
	}

	#readCommands(): readonly (readonly [string, readonly string[]])[] {
		switch (this.#platform) {
			case "darwin":
				return [["pbpaste", []]];
			case "win32":
				return [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_GET_SCRIPT]]];
			default: {
				const commands: (readonly [string, readonly string[]])[] = [];
				if (hasValue(this.#env["WAYLAND_DISPLAY"])) commands.push(["wl-paste", ["--no-newline"]]);
				commands.push(["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]]);
				return commands;
			}
		}
	}

	#writeTmux(text: string): boolean {
		if (!this.#route.tmux) return false;
		return this.#command("tmux", ["load-buffer", "-"], text).exitCode === 0;
	}

	#writeOsc52(text: string): boolean {
		if (!this.#route.osc52 || this.#write === undefined) return false;
		const payload = Buffer.from(text, "utf8").toString("base64");
		const sequence = this.#route.passthrough
			? `\x1bPtmux;\x1b\x1b]52;c;${payload}\x07\x1b\\`
			: `\x1b]52;c;${payload}\x07`;
		try {
			this.#write(sequence);
			return true;
		} catch {
			return false;
		}
	}

	#writeBackup(text: string): string | undefined {
		try {
			mkdirSync(dirname(this.#copyFile), { recursive: true });
			writeFileSync(this.#copyFile, text, { encoding: "utf8", mode: 0o600 });
			// 已存在的文件不会被 mode 收窄，复制内容可能敏感，再显式收紧一次
			if (this.#platform !== "win32") chmodSync(this.#copyFile, 0o600);
			return this.#copyFile;
		} catch {
			return undefined;
		}
	}
}

function defaultCopyPath(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	const override = env["REINS_COPY_FILE"];
	if (override !== undefined && override.trim().length > 0) return expandHome(override.trim(), home);
	const configured = env["REINS_HOME"];
	const root = configured !== undefined && configured.length > 0 ? configured : join(home, ".reins");
	return join(root, "last-copy.txt");
}

/** 路径里的主目录缩成 `~`，通知条才放得下。 */
export function displayPath(path: string, home = homedir()): string {
	const normalized = path.replaceAll("\\", "/");
	const root = home.replaceAll("\\", "/").replace(/\/+$/, "");
	if (normalized === root) return "~";
	return normalized.startsWith(`${root}/`) ? `~/${normalized.slice(root.length + 1)}` : normalized;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

function hasValue(value: string | undefined): boolean {
	return value !== undefined && value.length > 0;
}

function isContainer(env: Readonly<Record<string, string | undefined>>): boolean {
	if (hasValue(env["container"]) || env["REINS_CONTAINER"] === "1") return true;
	try {
		return existsSync("/.dockerenv");
	} catch {
		return false;
	}
}

function runCommand(command: string, args: readonly string[], input?: string): CommandResult {
	const result = spawnSync(command, [...args], {
		input,
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
		windowsHide: true,
	});
	return {
		exitCode: result.error === undefined ? result.status : null,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
	};
}

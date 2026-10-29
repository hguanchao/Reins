import { spawn } from "node:child_process";

import type { ClipboardSource } from "../tui/options.ts";

/**
 * 写系统剪贴板。
 *
 * 终端没有统一的剪贴板接口，只能按平台调用现成命令。写不进去时返回 false，由界面退到
 * OSC 52；命令启动失败、超时或非零退出都算失败，不把不确定的结果当成复制成功。
 */

/** 一次外部命令的结果；只关心是否正常退出。 */
export interface ClipboardCommandResult {
	readonly exitCode: number | null;
}

export type ClipboardCommand = (
	command: string,
	args: readonly string[],
	input: string,
) => ClipboardCommandResult | Promise<ClipboardCommandResult>;

export interface ClipboardSourceOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** 测试可以换成不碰系统剪贴板的实现。 */
	readonly command?: ClipboardCommand;
}

const COMMAND_TIMEOUT_MS = 2_000;

/** Windows 用 UTF-8 输入脚本交给 Set-Clipboard，避免 clip.exe 在非系统代码页里弄乱中文。 */
const WINDOWS_POWERSHELL =
	"[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text";

export function createClipboardSource(options: ClipboardSourceOptions = {}): ClipboardSource {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const command = options.command ?? runClipboardCommand;
	const candidates = nativeCommands(platform, env);
	return {
		copy: async (text) => {
			for (const [name, args] of candidates) {
				const result = await command(name, args, text);
				if (result.exitCode === 0) return true;
			}
			return false;
		},
	};
}

function nativeCommands(
	platform: NodeJS.Platform,
	env: Readonly<Record<string, string | undefined>>,
): readonly (readonly [string, readonly string[]])[] {
	switch (platform) {
		case "darwin":
			return [["pbcopy", []]];
		case "win32":
			return [
				// clip.exe 启动最快；PowerShell 作为兜底，Set-Clipboard 对编码更稳
				["cmd.exe", ["/c", "chcp 65001>nul & clip"]],
				["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_POWERSHELL]],
			];
		default: {
			const commands: (readonly [string, readonly string[]])[] = [];
			if (hasValue(env["WAYLAND_DISPLAY"])) commands.push(["wl-copy", []]);
			commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
			return commands;
		}
	}
}

/**
 * 写剪贴板的子进程。
 *
 * 异步 spawn：同步等待会让整个界面在命令慢或挂住时一起冻住，最长 2 秒看不到任何反馈。
 * 超时就杀掉子进程并按失败处理，交给界面退到 OSC 52。
 */
function runClipboardCommand(
	command: string,
	args: readonly string[],
	input: string,
): Promise<ClipboardCommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], {
			windowsHide: true,
			stdio: ["pipe", "ignore", "ignore"],
		});
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ClipboardCommandResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(result);
		};
		timer = setTimeout(() => {
			child.kill();
			finish({ exitCode: null });
		}, COMMAND_TIMEOUT_MS);
		timer.unref();
		child.on("error", () => finish({ exitCode: null }));
		child.on("close", (code) => finish({ exitCode: code }));
		child.stdin.end(input);
	});
}

function hasValue(value: string | undefined): boolean {
	return value !== undefined && value.length > 0;
}

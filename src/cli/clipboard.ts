import { spawnSync } from "node:child_process";

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
) => ClipboardCommandResult;

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
		copy: (text) => candidates.some(([name, args]) => command(name, args, text).exitCode === 0),
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

function runClipboardCommand(
	command: string,
	args: readonly string[],
	input: string,
): ClipboardCommandResult {
	const result = spawnSync(command, [...args], {
		input,
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		windowsHide: true,
	});
	return { exitCode: result.error === undefined ? result.status : null };
}

function hasValue(value: string | undefined): boolean {
	return value !== undefined && value.length > 0;
}

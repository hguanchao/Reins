import type { SandboxInfo } from "../../sandbox/setup.ts";
import { displayWidth, truncateToWidth, wrapWords } from "../render/text.ts";
import { THEME } from "../render/theme.ts";

/**
 * 沙箱说明页。
 *
 * 这一页不提供任何开关：模式来自配置，平台能力来自当前系统。页面只负责把「现在到底保护了
 * 什么、哪一步做不到」讲清楚，避免使用者把「文件写入受限」误当成「命令也被隔离」。
 */

/** 底部固定区：一条分隔线加一行关闭提示。 */
export const SANDBOX_ACTION_HEIGHT = 2;

const TITLE = "Reins — sandbox";
const SECTION = "Sandbox";
const LABEL_WIDTH = 19;
const INDENT = "  ";
const RESET = THEME.reset;

export function sandboxPageLines(info: SandboxInfo, width: number): readonly string[] {
	const columns = Math.max(0, width);
	const lines = [
		coloredTitle(TITLE, columns),
		" ".repeat(columns),
		`${THEME.textSubtle}${truncateToWidth(SECTION, columns)}${RESET}`,
		row("Mode", info.mode, info.mode === "off" ? THEME.textPrimary : THEME.warning, columns),
		row("Platform", platformName(info.platform), THEME.textSecondary, columns),
		row("Path checks", pathChecks(info.mode), pathChecksColor(info.mode), columns),
		row("Command isolation", isolation(info), isolationColor(info), columns),
		" ".repeat(columns),
	];

	if (info.mode === "off") {
		lines.push(...note("Sandbox is off: commands and file writes are not restricted.", THEME.warning, columns));
		lines.push(
			...note("Set sandbox in config.toml to enable path checks and command isolation.", THEME.textSecondary, columns),
		);
		return lines;
	}

	if (!info.confinesCommands) {
		lines.push(...note(`Shell commands are refused while sandbox is ${info.mode}.`, THEME.warning, columns));
		lines.push(
			...note("File tools still enforce write boundaries; there is no fake backend.", THEME.textSecondary, columns),
		);
		lines.push(" ".repeat(columns));
		lines.push(
			...note(
				'Set sandbox = "off" in config.toml to run commands without isolation.',
				THEME.textSecondary,
				columns,
			),
		);
		lines.push(" ".repeat(columns));
		lines.push(...note(missingBackendExplanation(info.platform), THEME.textSubtle, columns));
		return lines;
	}

	const backend = info.backend ?? "platform";
	lines.push(...note(`Commands run under ${backend} isolation.`, THEME.textSecondary, columns));
	lines.push(...note("File tools still enforce write boundaries inside the workspace.", THEME.textSecondary, columns));
	return lines;
}

export function sandboxActionLines(width: number): readonly string[] {
	const columns = Math.max(0, width);
	const rule = `${THEME.border}${"─".repeat(columns)}${RESET}`;
	if (columns === 0) return ["", ""];
	const plain = "Esc close";
	const shown = displayWidth(plain) <= columns ? plain : truncateToWidth(plain, columns);
	const text = shown === plain
		? `${THEME.textSubtle}Esc${RESET} ${THEME.textSecondary}close${RESET}`
		: shown;
	return [rule, `${text}${" ".repeat(Math.max(0, columns - displayWidth(shown)))}`];
}

function row(label: string, value: string, color: string, width: number): string {
	const headPlain = truncateToWidth(`${INDENT}${label.padEnd(LABEL_WIDTH, " ")}`, width);
	const head = `${THEME.textSecondary}${headPlain}${RESET}`;
	const remaining = Math.max(0, width - displayWidth(headPlain));
	return `${head}${color}${truncateToWidth(value, remaining)}${RESET}`;
}

function note(text: string, color: string, width: number): readonly string[] {
	const indent = INDENT.slice(0, width);
	const bodyWidth = Math.max(0, width - displayWidth(indent));
	if (bodyWidth === 0) return [""];
	return wrapWords(text, bodyWidth).map((line) => `${color}${indent}${line}${RESET}`);
}

function pathChecks(mode: SandboxInfo["mode"]): string {
	if (mode === "off") return "disabled";
	return mode === "read-only" ? "writes denied" : "workspace writes only";
}

function pathChecksColor(mode: SandboxInfo["mode"]): string {
	return mode === "off" ? THEME.textSubtle : THEME.success;
}

function isolation(info: SandboxInfo): string {
	if (info.mode === "off") return "not requested";
	return info.backend ?? "unavailable";
}

function isolationColor(info: SandboxInfo): string {
	if (info.mode === "off") return THEME.textSubtle;
	return info.backend === undefined ? THEME.error : THEME.success;
}

function platformName(platform: string): string {
	switch (platform) {
		case "win32":
			return "Windows";
		case "darwin":
			return "macOS";
		case "linux":
			return "Linux";
		default:
			return platform;
	}
}

function missingBackendExplanation(platform: string): string {
	if (platform === "win32") {
		return (
			"A full Windows backend would need a native helper with restricted " +
			"token / AppContainer, ACLs, and firewall rules; it is not part of this round."
		);
	}
	return `No command isolation backend is available for ${platformName(platform)} in this build.`;
}

function coloredTitle(title: string, width: number): string {
	const visible = truncateToWidth(title, width);
	return `${THEME.accent}${visible}${RESET}${" ".repeat(Math.max(0, width - displayWidth(visible)))}`;
}

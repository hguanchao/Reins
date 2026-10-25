import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SandboxInfo } from "../../src/sandbox/setup.ts";
import { SANDBOX_ACTION_HEIGHT, sandboxActionLines, sandboxPageLines } from "../../src/tui/sandbox-page.ts";
import { displayWidth } from "../../src/tui/text.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function info(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
	return {
		mode: "workspace",
		platform: "win32",
		confinesCommands: false,
		...overrides,
	};
}

describe("沙箱说明页", () => {
	it("Windows 无后端时说明路径判定仍在、命令被拒绝", () => {
		const lines = sandboxPageLines(info(), 80);
		const text = lines.map(plain).join("\n");

		assert.equal(plain(lines[0] ?? "").trimEnd(), "Reins — sandbox");
		assert.match(text, /Mode\s+workspace/);
		assert.match(text, /Platform\s+Windows/);
		assert.match(text, /Path checks\s+workspace writes only/);
		assert.match(text, /Command isolation\s+unavailable/);
		assert.match(text, /Shell commands are refused while sandbox is workspace\./);
		assert.match(text, /File tools still enforce write boundaries; there is no fake backend\./);
		assert.match(text, /Set sandbox = "off" in config\.toml/);
		assert.match(text, /restricted token \/\s+AppContainer/);
		for (const line of lines) {
			assert.ok(displayWidth(plain(line)) <= 80);
		}
	});

	it("read-only 与 off 使用各自的路径说明", () => {
		const readOnly = sandboxPageLines(info({ mode: "read-only" }), 80).map(plain).join("\n");
		assert.match(readOnly, /Path checks\s+writes denied/);
		assert.match(readOnly, /refused while sandbox is read-only/);

		const off = sandboxPageLines(info({ mode: "off", confinesCommands: true }), 80).map(plain).join("\n");
		assert.match(off, /Mode\s+off/);
		assert.match(off, /Path checks\s+disabled/);
		assert.match(off, /Command isolation\s+not requested/);
		assert.match(off, /commands and file writes are not restricted/);
		assert.equal(off.includes("refused"), false);
	});

	it("有后端时显示后端标识，不再给出拒绝说明", () => {
		const lines = sandboxPageLines(
			info({ platform: "linux", confinesCommands: true, backend: "bubblewrap" }),
			80,
		);
		const text = lines.map(plain).join("\n");
		assert.match(text, /Platform\s+Linux/);
		assert.match(text, /Command isolation\s+bubblewrap/);
		assert.match(text, /Commands run under bubblewrap isolation\./);
		assert.equal(text.includes("unavailable"), false);
		assert.equal(text.includes("refused"), false);
	});

	it("窄屏不超出宽度", () => {
		for (const width of [40, 24, 12, 1, 0]) {
			const lines = sandboxPageLines(info({ platform: "freebsd" }), width);
			for (const line of lines) {
				assert.ok(displayWidth(plain(line)) <= width, `${plain(line)} / ${width}`);
			}
		}
	});

	it("动作条固定在底部且只提示关闭", () => {
		assert.equal(SANDBOX_ACTION_HEIGHT, 2);
		const lines = sandboxActionLines(60);
		assert.equal(lines.length, 2);
		assert.match(plain(lines[1] ?? ""), /Esc close/);
	});
});

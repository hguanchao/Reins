import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createClipboardSource, type ClipboardCommand } from "../../src/cli/clipboard.ts";

describe("文本剪贴板", () => {
	interface Call {
		readonly command: string;
		readonly args: readonly string[];
		readonly input: string;
	}

	function recorder(failures: number): { readonly calls: Call[]; readonly command: ClipboardCommand } {
		const calls: Call[] = [];
		const command: ClipboardCommand = (name, args, input) => {
			calls.push({ command: name, args, input });
			return { exitCode: calls.length <= failures ? 1 : 0 };
		};
		return { calls, command };
	}

	it("Windows 先试 clip，失败再退到 PowerShell", () => {
		const { calls, command } = recorder(1);
		const source = createClipboardSource({ platform: "win32", env: {}, command });

		assert.equal(source.copy("你好"), true);
		assert.deepEqual(calls.map((call) => call.command), ["cmd.exe", "powershell.exe"]);
		assert.ok(calls[0]?.args.join(" ").includes("clip"));
		assert.equal(calls[0]?.input, "你好");
		assert.equal(calls[1]?.input, "你好");
	});

	it("macOS 用 pbcopy", () => {
		const { calls, command } = recorder(0);
		const source = createClipboardSource({ platform: "darwin", env: {}, command });

		assert.equal(source.copy("hi"), true);
		assert.deepEqual(calls.map((call) => call.command), ["pbcopy"]);
	});

	it("Linux 有 Wayland 时先试 wl-copy，否则先试 xclip", () => {
		const wayland = recorder(0);
		createClipboardSource({
			platform: "linux",
			env: { WAYLAND_DISPLAY: "wayland-0" },
			command: wayland.command,
		}).copy("hi");
		assert.deepEqual(wayland.calls.map((call) => call.command), ["wl-copy"]);

		const x11 = recorder(0);
		createClipboardSource({ platform: "linux", env: {}, command: x11.command }).copy("hi");
		assert.deepEqual(x11.calls.map((call) => call.command), ["xclip"]);
	});

	it("所有本机命令都失败时返回 false，交给界面退到 OSC 52", () => {
		const { calls, command } = recorder(99);
		const source = createClipboardSource({ platform: "linux", env: {}, command });

		assert.equal(source.copy("hi"), false);
		assert.deepEqual(calls.map((call) => call.command), ["xclip", "xsel"]);
	});
});

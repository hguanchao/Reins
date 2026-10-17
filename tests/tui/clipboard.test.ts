import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	Clipboard,
	displayPath,
	resolveClipboardRoute,
	type ClipboardCommand,
	type CommandResult,
} from "../../src/tui/clipboard.ts";

const tempDirs: string[] = [];

function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "reins-clipboard-"));
	tempDirs.push(dir);
	return join(dir, "last-copy.txt");
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function result(exitCode: number, stdout = ""): CommandResult {
	return { exitCode, stdout };
}

interface Recorded {
	readonly command: string;
	readonly args: readonly string[];
	readonly input: string | undefined;
}

/** 按命令名决定成败，并记下每次调用。 */
function recorder(outcomes: Readonly<Record<string, number>>): {
	readonly run: ClipboardCommand;
	readonly calls: Recorded[];
} {
	const calls: Recorded[] = [];
	return {
		calls,
		run(command, args, input) {
			calls.push({ command, args, input });
			const stdout = command === "pbpaste" || command === "powershell.exe" ? "clipboard text" : "";
			return result(outcomes[command] ?? 1, stdout);
		},
	};
}

describe("剪贴板路径", () => {
	it("本机总是尝试 native；Linux 总是发 OSC 52", () => {
		const route = resolveClipboardRoute({ platform: "linux", env: {}, container: false });
		assert.equal(route.native, true);
		assert.equal(route.tmux, false);
		assert.equal(route.osc52, true);
		assert.equal(route.passthrough, false);
	});

	it("macOS 本机不发 OSC 52；在 tmux 或 SSH 里发", () => {
		assert.equal(resolveClipboardRoute({ platform: "darwin", env: {}, container: false }).osc52, false);
		const tmux = resolveClipboardRoute({ platform: "darwin", env: { TMUX: "/tmp/tmux" }, container: false });
		assert.equal(tmux.osc52, true);
		assert.equal(tmux.tmux, true);
		assert.equal(tmux.passthrough, true);
		const remote = resolveClipboardRoute({
			platform: "darwin",
			env: { SSH_CONNECTION: "1 2 3 4" },
			container: false,
		});
		assert.equal(remote.osc52, true);
	});

	it("无显示容器与显式 sink 会打开 OSC 52，kill switch 能全部关掉", () => {
		const container = resolveClipboardRoute({
			platform: "win32",
			env: {},
			container: true,
		});
		assert.equal(container.osc52, true);
		const sink = resolveClipboardRoute({ platform: "win32", env: { REINS_OSC52_SINK: "1" }, container: false });
		assert.equal(sink.osc52, true);
		const disabled = resolveClipboardRoute({
			platform: "linux",
			env: { REINS_CLIPBOARD_NO_OSC52: "1" },
			container: false,
		});
		assert.equal(disabled.osc52, false);
	});
});

describe("剪贴板写入", () => {
	it("native 成功算确认，备份文件仍然写", () => {
		const path = tempFile();
		const fake = recorder({ pbcopy: 0 });
		const clipboard = new Clipboard({
			platform: "darwin",
			env: {},
			home: "/home/me",
			copyFile: path,
			command: fake.run,
			container: false,
		});

		const outcome = clipboard.copy("hello\nworld");
		assert.equal(outcome.delivery, "confirmed");
		assert.equal(outcome.message, "Copied!");
		assert.equal(outcome.path, path);
		assert.equal(readFileSync(path, "utf8"), "hello\nworld");
		assert.deepEqual(fake.calls.map((call) => call.command), ["pbcopy"]);
	});

	it("native 失败时 OSC 52 算已发出，并把备份路径带进提示", () => {
		const path = tempFile();
		const writes: string[] = [];
		const clipboard = new Clipboard({
			platform: "linux",
			env: {},
			home: "/home/me",
			copyFile: path,
			command: recorder({}).run,
			write: (sequence) => writes.push(sequence),
			container: false,
		});

		const outcome = clipboard.copy("hello");
		assert.equal(outcome.delivery, "unverified");
		assert.match(outcome.message, /^Copy sent, saved to /);
		assert.equal(writes.length, 1);
		assert.match(writes[0], /^\x1b\]52;c;aGVsbG8=\x07$/);
	});

	it("tmux 缓冲在 OSC 52 不可用时仍算确认", () => {
		const path = tempFile();
		const fake = recorder({ "tmux": 0 });
		const clipboard = new Clipboard({
			platform: "darwin",
			env: { TMUX: "/tmp/tmux" },
			home: "/home/me",
			copyFile: path,
			command: fake.run,
			container: false,
		});

		const outcome = clipboard.copy("text");
		// 没提供 OSC 52 输出端，所以最终落到 tmux 缓冲
		assert.equal(outcome.delivery, "confirmed");
		assert.equal(outcome.message, "Copied to tmux buffer, paste with prefix + ]");
		const tmux = fake.calls.find((call) => call.command === "tmux");
		assert.deepEqual(tmux?.args, ["load-buffer", "-"]);
		assert.equal(tmux?.input, "text");
	});

	it("所有路径都失败时仍返回备份文件", () => {
		const path = tempFile();
		const clipboard = new Clipboard({
			platform: "win32",
			env: {},
			home: "C:\\Users\\me",
			copyFile: path,
			command: recorder({}).run,
			container: false,
		});

		const outcome = clipboard.copy("secret");
		assert.equal(outcome.delivery, "failed");
		assert.match(outcome.message, /^Clipboard unreachable: wrote /);
		assert.ok(existsSync(path));
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	it("tmux 里的 OSC 52 用 DCS passthrough 包一层", () => {
		const path = tempFile();
		const writes: string[] = [];
		const clipboard = new Clipboard({
			platform: "darwin",
			env: { TMUX: "/tmp/tmux" },
			home: "/home/me",
			copyFile: path,
			command: recorder({}).run,
			write: (sequence) => writes.push(sequence),
			container: false,
		});

		clipboard.copy("hello");
		assert.equal(writes.length, 1);
		assert.equal(writes[0], "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\");
	});

	it("Windows 用 PowerShell 读写，避免控制台代码页", () => {
		const path = tempFile();
		const fake = recorder({ "powershell.exe": 0 });
		const clipboard = new Clipboard({
			platform: "win32",
			env: {},
			home: "C:\\Users\\me",
			copyFile: path,
			command: fake.run,
			container: false,
		});

		clipboard.copy("中文");
		assert.equal(fake.calls[0].command, "cmd.exe");
		assert.match(fake.calls[0].args.join(" "), /clip/);
		assert.equal(fake.calls[1].command, "powershell.exe");
		assert.match(fake.calls[1].args.join(" "), /Set-Clipboard/);
		assert.equal(clipboard.readText(), "clipboard text");
		assert.match(fake.calls[2].args.join(" "), /Get-Clipboard -Raw/);
	});
});

describe("剪贴板读取", () => {
	it("按平台顺序尝试，成功的第一个结果就是答案", () => {
		const fake = recorder({ pbpaste: 0 });
		const clipboard = new Clipboard({
			platform: "darwin",
			env: {},
			copyFile: tempFile(),
			command: fake.run,
			container: false,
		});
		assert.equal(clipboard.readText(), "clipboard text");
		assert.deepEqual(fake.calls.map((call) => call.command), ["pbpaste"]);
	});

	it("所有后端失败时返回 undefined，空输出仍是有效结果", () => {
		const failed = new Clipboard({
			platform: "linux",
			env: {},
			copyFile: tempFile(),
			command: recorder({}).run,
			container: false,
		});
		assert.equal(failed.readText(), undefined);

		const empty = new Clipboard({
			platform: "darwin",
			env: {},
			copyFile: tempFile(),
			command: () => result(0, ""),
			container: false,
		});
		assert.equal(empty.readText(), "");
	});
});

describe("备份路径", () => {
	it("默认放在 REINS_HOME 下，主目录缩写成 ~", () => {
		const home = mkdtempSync(join(tmpdir(), "reins-clipboard-home-"));
		tempDirs.push(home);
		const clipboard = new Clipboard({
			platform: "darwin",
			env: { REINS_HOME: home },
			home,
			command: recorder({ pbcopy: 0 }).run,
			container: false,
		});
		const outcome = clipboard.copy("x");
		assert.equal(outcome.path, join(home, "last-copy.txt"));
		assert.equal(readFileSync(join(home, "last-copy.txt"), "utf8"), "x");
		assert.equal(displayPath("/home/me/.reins/last-copy.txt", "/home/me"), "~/.reins/last-copy.txt");
	});
});

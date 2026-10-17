import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Sandbox, type SandboxBackend, type SandboxPolicy } from "../../src/sandbox/policy.ts";

const ROOT = process.platform === "win32" ? "E:\\w" : "/tmp/w";

function sandbox(mode: SandboxPolicy["mode"], backend: SandboxBackend | undefined = undefined): Sandbox {
	return new Sandbox({ mode, root: ROOT }, backend);
}

const availableBackend: SandboxBackend = {
	id: "fake",
	available: true,
	wrap: (command) => `wrapped(${command})`,
};

const unavailableBackend: SandboxBackend = {
	id: "fake",
	available: false,
	wrap: (command) => `wrapped(${command})`,
};

describe("沙箱判定", () => {
	it("off 模式不判定任何东西", () => {
		const relaxed = sandbox("off");
		assert.doesNotThrow(() => relaxed.assertPathAllowed("write", "/etc/passwd"));
		assert.equal(relaxed.wrapCommand("ls"), "ls");
		assert.equal(relaxed.confinesCommands, true);
	});

	it("read 永远放行,write 被拦", () => {
		const strict = sandbox("read-only");
		strict.assertPathAllowed("read", ROOT);
		strict.assertPathAllowed("read", "/etc/hosts");
		assert.throws(() => strict.assertPathAllowed("write", `${ROOT}\\a.ts`), /read-only and refusing to write/);
	});

	it("workspace 模式:根内可写,根外拒绝", () => {
		const confined = sandbox("workspace");
		confined.assertPathAllowed("write", `${ROOT}\\a.ts`);
		assert.throws(() => confined.assertPathAllowed("write", "E:\\outside\\a.ts"), /confined to the workspace/);
	});

	it("confinesCommands 反映模式与后端", () => {
		assert.equal(sandbox("workspace", undefined).confinesCommands, false);
		assert.equal(sandbox("workspace", unavailableBackend).confinesCommands, false);
		assert.equal(sandbox("workspace", availableBackend).confinesCommands, true);
	});

	it("约束命令:有可用后端时包一层", () => {
		const sandboxWithBackend = sandbox("workspace", availableBackend);
		assert.equal(sandboxWithBackend.wrapCommand("ls -la"), "wrapped(ls -la)");
	});

	it("约束命令:没有后端或后端不可用时报错而不是裸跑", () => {
		assert.throws(() => sandbox("workspace", undefined).wrapCommand("ls"), /no usable isolation backend/);
		assert.throws(() => sandbox("workspace", unavailableBackend).wrapCommand("ls"), /no usable isolation backend/);
	});

	it("后端包不住的命令不运行", () => {
		const picky: SandboxBackend = { id: "picky", available: true, wrap: () => undefined };
		assert.throws(() => sandbox("workspace", picky).wrapCommand("x"), /cannot confine this command/);
	});
});

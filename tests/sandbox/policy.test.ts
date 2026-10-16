import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Sandbox, type SandboxBackend } from "../../src/sandbox/policy.ts";

const ROOT = join("C:", "work", "project");

function backend(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
	return {
		id: "test",
		available: true,
		wrap: (command) => `wrapper ${command}`,
		...overrides,
	};
}

describe("路径判定", () => {
	it("不隔离时不拦任何操作", () => {
		const sandbox = new Sandbox({ mode: "off", root: ROOT }, undefined);
		sandbox.assertPathAllowed("read", join(ROOT, "a.txt"));
		sandbox.assertPathAllowed("write", join("D:", "elsewhere", "a.txt"));
	});

	it("只读模式下读取照常，写入一律被拒", () => {
		const sandbox = new Sandbox({ mode: "read-only", root: ROOT }, undefined);
		sandbox.assertPathAllowed("read", join(ROOT, "a.txt"));

		assert.throws(
			() => sandbox.assertPathAllowed("write", join(ROOT, "a.txt")),
			/只读模式/,
		);
		assert.throws(
			() => sandbox.assertPathAllowed("write", join("D:", "elsewhere", "a.txt")),
			/只读模式/,
		);
	});

	it("工作区模式允许改工作区内的，拒绝改外面的", () => {
		const sandbox = new Sandbox({ mode: "workspace", root: ROOT }, undefined);
		sandbox.assertPathAllowed("write", join(ROOT, "src", "a.txt"));
		sandbox.assertPathAllowed("write", ROOT);
		// 读不受限：工作区模式限制的是写入
		sandbox.assertPathAllowed("read", join("D:", "elsewhere", "a.txt"));

		assert.throws(
			() => sandbox.assertPathAllowed("write", join("D:", "elsewhere", "a.txt")),
			/限制在工作区内/,
		);
	});

	it("拒绝时的提示指向具体设置", () => {
		const sandbox = new Sandbox({ mode: "workspace", root: ROOT }, undefined);
		assert.throws(
			() => sandbox.assertPathAllowed("write", join("D:", "elsewhere", "a.txt")),
			/请调整 config\.toml 里的 sandbox/,
		);
	});
});

describe("命令隔离", () => {
	it("不隔离时命令原样传出，也不碰后端", () => {
		let consulted = false;
		const sandbox = new Sandbox(
			{ mode: "off", root: ROOT },
			backend({
				wrap: (command) => {
					consulted = true;
					return command;
				},
			}),
		);
		assert.equal(sandbox.wrapCommand("echo hi"), "echo hi");
		assert.equal(consulted, false);
	});

	it("有可用后端时命令被包起来", () => {
		const sandbox = new Sandbox({ mode: "workspace", root: ROOT }, backend());
		assert.equal(sandbox.wrapCommand("echo hi"), "wrapper echo hi");
		assert.equal(sandbox.confinesCommands, true);
	});

	it("没有后端时拒绝执行，而不是退回到不隔离", () => {
		const sandbox = new Sandbox({ mode: "workspace", root: ROOT }, undefined);
		assert.throws(
			() => sandbox.wrapCommand("echo hi"),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /没有可用的隔离手段/);
				assert.match(error.message, /不会被执行/);
				assert.match(error.message, /设为 off/);
				return true;
			},
		);
		assert.equal(sandbox.confinesCommands, false);
	});

	it("后端自称不可用时同样拒绝执行", () => {
		const sandbox = new Sandbox({ mode: "read-only", root: ROOT }, backend({ available: false }));
		assert.throws(() => sandbox.wrapCommand("echo hi"), /没有可用的隔离手段/);
	});

	it("后端表示约束不了这条命令时拒绝执行", () => {
		const sandbox = new Sandbox({ mode: "workspace", root: ROOT }, backend({ wrap: () => undefined }));
		assert.throws(() => sandbox.wrapCommand("echo hi"), /无法约束这条命令/);
	});
});

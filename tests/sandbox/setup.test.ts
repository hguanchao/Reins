import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { Sandbox, type SandboxBackend } from "../../src/sandbox/policy.ts";
import { createSandbox } from "../../src/sandbox/setup.ts";
import { verifyCommandIsolation } from "../../src/sandbox/verify.ts";

/**
 * 隔离是否真的生效，靠探针实际试出来。
 *
 * 这些用例用一个替身后端来模拟两种情况：确实拦住了、以及只是看起来拦住了。后者是真正危险
 * 的情形——使用者以为有保护而实际没有。
 */

const parent = mkdtempSync(join(tmpdir(), "reins-sandbox-"));
const root = join(parent, "project");

after(() => {
	rmSync(parent, { recursive: true, force: true });
});

/** 「拦住了」：包装后的命令根本跑不起来。 */
const blockingBackend: SandboxBackend = {
	id: "blocking",
	available: true,
	wrap: () => "reins-probe-should-fail",
};

/** 「没拦住」：包装等于没包，命令照样执行。 */
const ineffectiveBackend: SandboxBackend = {
	id: "ineffective",
	available: true,
	wrap: (command) => command,
};

describe("隔离自检", () => {
	it("隔离确实生效时通过", () => {
		const sandbox = new Sandbox({ mode: "workspace", root }, blockingBackend);
		verifyCommandIsolation(sandbox, root);
	});

	it("隔离没生效时抛出，并说明它为什么危险", () => {
		const sandbox = new Sandbox({ mode: "workspace", root }, ineffectiveBackend);
		assert.throws(
			() => verifyCommandIsolation(sandbox, root),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /命令隔离没有生效/);
				assert.match(error.message, /看起来开着、实际不管用/);
				return true;
			},
		);
	});

	it("探针写入的文件会被清理掉", () => {
		const sandbox = new Sandbox({ mode: "workspace", root }, ineffectiveBackend);
		assert.throws(() => verifyCommandIsolation(sandbox, root));

		const leftovers = readdirSync(parent).filter((name) => name.startsWith(".reins-isolation-probe-"));
		assert.deepEqual(leftovers, []);
	});

	it("连包装都做不到时直接抛出来", () => {
		const sandbox = new Sandbox({ mode: "workspace", root }, undefined);
		assert.throws(() => verifyCommandIsolation(sandbox, root), /没有可用的隔离手段/);
	});
});

describe("沙箱装配", () => {
	it("不隔离时没有需要提示的事项", () => {
		const setup = createSandbox("off", root, []);
		assert.deepEqual(setup.warnings, []);
		setup.sandbox.assertPathAllowed("write", join("D:", "elsewhere"));
	});

	it("要求隔离却没有平台手段时给出明确提示，而路径判定照常生效", () => {
		const setup = createSandbox("workspace", root, []);
		assert.equal(setup.warnings.length, 1);
		assert.match(setup.warnings[0], /没有可用的命令隔离手段/);
		assert.match(setup.warnings[0], /命令会被拒绝执行/);

		// 读写仍然受约束，只是命令跑不了
		setup.sandbox.assertPathAllowed("write", join(root, "a.txt"));
		assert.throws(() => setup.sandbox.assertPathAllowed("write", join("D:", "elsewhere")));
		assert.throws(() => setup.sandbox.wrapCommand("echo hi"), /没有可用的隔离手段/);
	});

	it("有平台手段时先核对它真的有效", () => {
		const setup = createSandbox("workspace", root, [blockingBackend]);
		assert.deepEqual(setup.warnings, []);
	});

	it("平台手段其实无效时装配就失败", () => {
		assert.throws(() => createSandbox("workspace", root, [ineffectiveBackend]), /命令隔离没有生效/);
	});

	it("只挑可用的后端", () => {
		const setup = createSandbox("workspace", root, [
			{ ...ineffectiveBackend, id: "unavailable", available: false },
			blockingBackend,
		]);
		assert.deepEqual(setup.warnings, []);
	});
});

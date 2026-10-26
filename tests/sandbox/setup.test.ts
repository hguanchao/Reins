import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { SandboxBackend } from "../../src/sandbox/policy.ts";
import { createSandbox } from "../../src/sandbox/setup.ts";

const unavailable: SandboxBackend = {
	id: "missing",
	available: false,
	wrap: (command) => command,
};

/**
 * 自检期望被拒绝：普通命令照常跑（冒烟命令要成功），但往工作区外写会被拦住。
 *
 * 真实后端就是这样：沙箱本身能跑命令，只是不许写工作区之外。
 */
const refusingBackend: SandboxBackend = {
	id: "probe-refuse",
	available: true,
	wrap: (command) => (command.startsWith("echo probe >") ? "exit 1" : command),
};

/** 连命令都跑不起来的后端：必须当场报错，不能让每条命令都伪装成普通失败。 */
const brokenBackend: SandboxBackend = {
	id: "probe-broken",
	available: true,
	wrap: () => "exit 1",
};

/** 假后端原样放行：自检必须发现它没有真正隔离。 */
const leakyBackend: SandboxBackend = {
	id: "leaky",
	available: true,
	wrap: (command) => command,
};

function workspaceRoot(): string {
	return mkdtempSync(join(tmpdir(), "reins-sandbox-setup-"));
}

describe("沙箱装配", () => {
	it("off 不告警，也不声称有后端", () => {
		const root = workspaceRoot();
		try {
			const setup = createSandbox("off", root, [refusingBackend]);
			assert.deepEqual(setup.warnings, []);
			assert.equal(setup.info.mode, "off");
			assert.equal(setup.info.platform, process.platform);
			assert.equal(setup.info.backend, undefined);
			assert.equal(setup.info.confinesCommands, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("没有可用后端时给出警告，但路径判定照常保留", () => {
		const root = workspaceRoot();
		try {
			const setup = createSandbox("workspace", root, [unavailable]);
			assert.equal(setup.info.confinesCommands, false);
			assert.equal(setup.info.backend, undefined);
			assert.equal(setup.warnings.length, 1);
			assert.match(setup.warnings[0] ?? "", /no usable command isolation/);
			assert.match(setup.warnings[0] ?? "", /path checks still apply/);
			// 命令被拒绝，但文件写入仍然按工作区边界判定
			assert.throws(() => setup.sandbox.wrapCommand("ls"), /no usable isolation backend/);
			assert.doesNotThrow(() => setup.sandbox.assertPathAllowed("write", join(root, "a.ts")));
			assert.throws(
				() => setup.sandbox.assertPathAllowed("write", join(root, "..", "outside.ts")),
				/confined to the workspace/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("有可用后端时先自检，通过后记录后端标识", () => {
		const root = workspaceRoot();
		try {
			const setup = createSandbox("workspace", root, [unavailable, refusingBackend]);
			assert.deepEqual(setup.warnings, []);
			assert.equal(setup.info.backend, "probe-refuse");
			assert.equal(setup.info.confinesCommands, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("后端声称可用却拦不住时拒绝启动", () => {
		const root = workspaceRoot();
		try {
			assert.throws(() => createSandbox("workspace", root, [leakyBackend]), /isolation is not working/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("后端连命令都跑不起来时当场报错，而不是让每条命令都失败", () => {
		const root = workspaceRoot();
		try {
			assert.throws(
				() => createSandbox("workspace", root, [brokenBackend]),
				/cannot run commands at all/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

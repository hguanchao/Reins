import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { main } from "../../src/cli/bootstrap.ts";

describe("启动全屏界面", () => {
	it("起不来界面时不补配置模板，也不留下文件", async () => {
		// 测试进程的输入输出不是终端，正是「进不了界面」的情形
		const home = mkdtempSync(join(tmpdir(), "reins-tui-"));
		const previousHome = process.env["REINS_HOME"];
		const previousWrite = process.stderr.write.bind(process.stderr);
		let stderr = "";
		process.env["REINS_HOME"] = home;
		process.stderr.write = ((chunk: string) => {
			stderr += chunk;
			return true;
		}) as typeof process.stderr.write;

		try {
			// 不带参数才是全屏界面；带上位置参数会走一次性提问
			assert.equal(await main([]), 1);
		} finally {
			process.stderr.write = previousWrite;
			if (previousHome === undefined) delete process.env["REINS_HOME"];
			else process.env["REINS_HOME"] = previousHome;
		}

		try {
			assert.match(stderr, /needs an interactive terminal/);
			assert.equal(existsSync(join(home, "config.toml")), false);
			assert.equal(existsSync(join(home, "providers.json")), false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

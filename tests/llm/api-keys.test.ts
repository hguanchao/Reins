import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveApiKey } from "../../src/llm/api-keys.ts";

const SIGNAL = new AbortController().signal;

describe("密钥解析", () => {
	it("未配置返回 undefined", async () => {
		assert.equal(await resolveApiKey(undefined, SIGNAL), undefined);
	});

	it("无插值的字面值原样返回", async () => {
		assert.equal(await resolveApiKey("literal-key", SIGNAL), "literal-key");
	});

	it("$NAME 与 ${NAME} 插值", async () => {
		process.env["REINS_TEST_KEY"] = "secret-1234";
		try {
			assert.equal(await resolveApiKey("$REINS_TEST_KEY", SIGNAL), "secret-1234");
			assert.equal(await resolveApiKey("prefix-${REINS_TEST_KEY}-suffix", SIGNAL), "prefix-secret-1234-suffix");
		} finally {
			delete process.env["REINS_TEST_KEY"];
		}
	});

	it("环境变量未设置时报错,不出空串", async () => {
		await assert.rejects(() => resolveApiKey("$REINS_DEFINITELY_MISSING_VAR", SIGNAL), /environment variable REINS_DEFINITELY_MISSING_VAR/);
	});

	it("命令形式:取命令输出作为密钥", async () => {
		const key = await resolveApiKey("!node -e \"process.stdout.write('from-command')\"", SIGNAL);
		assert.equal(key, "from-command");
	});

	it("命令形式:前头叹号后无命令报错", async () => {
		await assert.rejects(() => resolveApiKey("!", SIGNAL), /no command after the leading/);
	});

	it("命令形式:无输出报错", async () => {
		await assert.rejects(() => resolveApiKey("!node -e ''", SIGNAL), /produced no output/);
	});

	it("命令形式:命令失败向上冒泡", async () => {
		await assert.rejects(
			() => resolveApiKey("!node -e \"process.exit(2)\"", SIGNAL),
			(CommandError) => CommandError !== undefined,
		);
	});

	it("字面值里形如 \\$NAME 的部分也按插值处理（非转义语法）", async () => {
		await assert.rejects(() => resolveApiKey("cost $200 worth", SIGNAL), /environment variable 200/);
	});
});

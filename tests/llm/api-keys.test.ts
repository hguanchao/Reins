import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveApiKey } from "../../src/llm/api-keys.ts";

const signal = new AbortController().signal;

describe("密钥解析", () => {
	it("未声明时返回 undefined", async () => {
		assert.equal(await resolveApiKey(undefined, signal), undefined);
	});

	it("字面值原样返回", async () => {
		assert.equal(await resolveApiKey("sk-abc", signal), "sk-abc");
	});

	it("展开环境变量插值的两种写法", async () => {
		process.env["REINS_TEST_KEY"] = "from-env";
		try {
			assert.equal(await resolveApiKey("$REINS_TEST_KEY", signal), "from-env");
			assert.equal(await resolveApiKey("${REINS_TEST_KEY}", signal), "from-env");
			assert.equal(await resolveApiKey("prefix-$REINS_TEST_KEY", signal), "prefix-from-env");
		} finally {
			delete process.env["REINS_TEST_KEY"];
		}
	});

	it("引用的环境变量未设置时报错而不是当成空串", async () => {
		// 空串会让端点回一个认证失败，把「忘了设变量」伪装成「密钥不对」
		await assert.rejects(() => resolveApiKey("${REINS_TEST_MISSING_KEY}", signal), /未设置/);
	});

	it("以 ! 开头的写法执行命令并取标准输出的首尾空白去掉后的内容", async () => {
		const key = await resolveApiKey("!echo  from-command  ", signal);
		assert.equal(key, "from-command");
	});

	it("命令没有输出时报错", async () => {
		await assert.rejects(() => resolveApiKey("!node -e \"\"", signal), /没有输出/);
	});

	it("! 后面没有命令时报错", async () => {
		await assert.rejects(() => resolveApiKey("!   ", signal), /没有命令/);
	});
});

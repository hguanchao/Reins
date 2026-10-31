import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatReadyLine, parseReadyLine } from "#src/web/ready-line.ts";

describe("就绪行协议", () => {
	it("格式化与解析互逆", () => {
		const line = formatReadyLine({ port: 8913, token: "abc_123" });
		assert.equal(line, 'reins-ready {"port":8913,"token":"abc_123"}');
		assert.deepEqual(parseReadyLine(line), { port: 8913, token: "abc_123" });
	});

	it("人话输出不算就绪行", () => {
		assert.equal(parseReadyLine("Reins 界面: http://127.0.0.1:8913/?token=x"), undefined);
		assert.equal(parseReadyLine("reins-ready 不是 JSON"), undefined);
		assert.equal(parseReadyLine(""), undefined);
	});

	it("形状不对的 JSON 一律拒绝", () => {
		assert.equal(parseReadyLine('reins-ready {"port":"8913","token":"x"}'), undefined);
		assert.equal(parseReadyLine('reins-ready {"port":0,"token":"x"}'), undefined);
		assert.equal(parseReadyLine('reins-ready {"port":8913,"token":""}'), undefined);
		assert.equal(parseReadyLine('reins-ready {"port":8913}'), undefined);
		assert.equal(parseReadyLine("reins-ready null"), undefined);
	});
});

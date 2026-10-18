import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findSavedDecision, readTrustedRoots, resolveTrust } from "../../src/workspace/trust.ts";

describe("信任清单匹配", () => {
	it("目录本身与祖先目录建立的信任被子目录继承", () => {
		const roots = ["E:\\w"];
		assert.equal(findSavedDecision(roots, "E:\\w"), true);
		assert.equal(findSavedDecision(roots, "E:\\w\\sub\\deeper"), true);
	});

	it("子目录的信任不反哺祖先", () => {
		assert.equal(findSavedDecision(["E:\\w\\sub"], "E:\\w"), undefined);
	});

	it("清单里没有匹配时返回 undefined", () => {
		assert.equal(findSavedDecision(["E:\\other"], "E:\\w"), undefined);
		assert.equal(findSavedDecision([], "E:\\w"), undefined);
	});
});

describe("信任决议", () => {
	it("没有需要保护的资源时按不信任", async () => {
		const decision = await resolveTrust({ root: "E:\\w", override: undefined, trustedRoots: [], hasProtectedResources: false });
		assert.deepEqual(decision, { trusted: false, source: "none" });
	});

	it("命令行给出的一票优先", async () => {
		const trusted = await resolveTrust({ root: "E:\\w", override: true, trustedRoots: [], hasProtectedResources: true });
		assert.deepEqual(trusted, { trusted: true, source: "flag" });

		const denied = await resolveTrust({ root: "E:\\w", override: false, trustedRoots: [], hasProtectedResources: true });
		assert.deepEqual(denied, { trusted: false, source: "flag" });
	});

	it("已记录的清单次之", async () => {
		const decision = await resolveTrust({
			root: "E:\\w",
			override: undefined,
			trustedRoots: ["E:\\w"],
			hasProtectedResources: true,
		});
		assert.deepEqual(decision, { trusted: true, source: "saved" });
	});

	it("没有命令行结论与记录时默认不信任", async () => {
		const decision = await resolveTrust({ root: "E:\\w", override: undefined, trustedRoots: [], hasProtectedResources: true });
		assert.deepEqual(decision, { trusted: false, source: "default" });
	});
});

describe("读信任清单", () => {
	it("非数组或混入非字符串时只留字符串", () => {
		assert.deepEqual(readTrustedRoots(["/a", 1, null, "/b"]), ["/a", "/b"]);
		assert.deepEqual(readTrustedRoots("x"), []);
		assert.deepEqual(readTrustedRoots(undefined), []);
	});
});

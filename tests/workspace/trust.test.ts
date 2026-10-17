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
	it("没有需要保护的资源时不必问，按不信任", async () => {
		const decision = await resolveTrust({ root: "E:\\w", override: undefined, trustedRoots: [], ask: () => true, hasProtectedResources: false });
		assert.deepEqual(decision, { trusted: false, source: "none" });
	});

	it("命令行给出的一票优先", async () => {
		const trusted = await resolveTrust({ root: "E:\\w", override: true, trustedRoots: [], ask: () => false, hasProtectedResources: true });
		assert.deepEqual(trusted, { trusted: true, source: "flag" });

		const denied = await resolveTrust({ root: "E:\\w", override: false, trustedRoots: [], ask: () => true, hasProtectedResources: true });
		assert.deepEqual(denied, { trusted: false, source: "flag" });
	});

	it("已记录的清单次之:命中即不问", async () => {
		const decision = await resolveTrust({
			root: "E:\\w",
			override: undefined,
			trustedRoots: ["E:\\w"],
			ask: () => false,
			hasProtectedResources: true,
		});
		assert.deepEqual(decision, { trusted: true, source: "saved" });
	});

	it("没有记录且有人可问时问一次", async () => {
		let asked = 0;
		const decision = await resolveTrust({
			root: "E:\\w",
			override: undefined,
			trustedRoots: [],
			ask: () => {
				asked += 1;
				return true;
			},
			hasProtectedResources: true,
		});
		assert.equal(asked, 1);
		assert.deepEqual(decision, { trusted: true, source: "asked" });
	});

	it("无人可问时默认不信任", async () => {
		const decision = await resolveTrust({ root: "E:\\w", override: undefined, trustedRoots: [], ask: undefined, hasProtectedResources: true });
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

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

/**
 * 导入路径的守卫。
 *
 * 约定写在 AGENTS.md 里：一律用 `#src/*`、`#tests/*`，不写相对路径。IDE 的自动导入默认
 * 生成相对路径，靠人记不如靠一条会失败的测试。
 *
 * 用语法树枚举字符串字面量，正则会把注释与普通字符串里的路径也算进来。
 */

const ROOTS = ["src", "tests"];

function moduleSpecifiers(file: string): readonly { readonly line: number; readonly text: string }[] {
	const text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found: { line: number; text: string }[] = [];

	const push = (node: ts.Node | undefined): void => {
		if (node === undefined || !ts.isStringLiteral(node) || !node.text.startsWith(".")) return;
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		found.push({ line: line + 1, text: node.text });
	};

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) push(node.moduleSpecifier);
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) push(node.argument.literal);
		else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			push(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function walk(dir: string): readonly string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return walk(full);
		return full.endsWith(".ts") ? [full] : [];
	});
}

describe("导入路径", () => {
	it("不用相对路径，一律走 #src / #tests 子路径", () => {
		const offenders = ROOTS.flatMap((root) =>
			walk(root).flatMap((file) =>
				moduleSpecifiers(file).map((specifier) => `${file}:${specifier.line} ${specifier.text}`),
			),
		);

		assert.deepEqual(offenders, []);
	});
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnrestrictedSandbox, type SandboxView } from "../../src/sandbox/policy.ts";
import type { SessionReadView } from "../../src/session/port.ts";
import type { ToolContext } from "../../src/tools/contract.ts";
import { WorkspaceBoundary } from "../../src/workspace/boundary.ts";

/**
 * 供工具测试使用的临时工作区。
 *
 * 每个用例一个独立目录，互不干扰；结束后整体删除，不留残留。
 */
export interface TestWorkspace {
	readonly root: string;
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly session: SessionReadView;
	/** 造一个工具上下文。参数用类型断言交给工具，与运行期的实际情形一致。 */
	context<P>(args: P, overrides?: { readonly signal?: AbortSignal }): ToolContext<P>;
	writeFile(relativePath: string, content: string): string;
	writeBytes(relativePath: string, bytes: Buffer): string;
	readFile(relativePath: string): string;
	remove(): void;
}

export function createTestWorkspace(): TestWorkspace {
	const root = mkdtempSync(join(tmpdir(), "reins-tools-"));
	const workspace = new WorkspaceBoundary(root);
	const sandbox = new UnrestrictedSandbox();
	const session: SessionReadView = { id: "test-session", path: null };

	return {
		root,
		workspace,
		sandbox,
		session,
		context<P>(args: P, overrides: { readonly signal?: AbortSignal } = {}): ToolContext<P> {
			return {
				callId: "call-1",
				args,
				signal: overrides.signal ?? new AbortController().signal,
				onUpdate: () => undefined,
				workspace,
				sandbox,
				session,
			};
		},
		writeFile(relativePath: string, content: string): string {
			const absolute = join(root, relativePath);
			writeFileSync(absolute, content, "utf8");
			return absolute;
		},
		writeBytes(relativePath: string, bytes: Buffer): string {
			const absolute = join(root, relativePath);
			writeFileSync(absolute, bytes);
			return absolute;
		},
		readFile(relativePath: string): string {
			return readFileSync(join(root, relativePath), "utf8");
		},
		remove(): void {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** 断言结果是错误，并返回内容便于进一步检查。 */
export function expectFailure(result: { readonly content: string; readonly isError?: boolean }, part: string): string {
	if (result.isError !== true) throw new Error(`期望失败，实际成功：${result.content}`);
	if (!result.content.includes(part)) {
		throw new Error(`期望内容包含「${part}」，实际是「${result.content}」`);
	}
	return result.content;
}

/** 断言结果不是错误。工具会把 isError 明确写成 false，所以不能拿 undefined 判断。 */
export function expectSuccess(result: { readonly content: string; readonly isError?: boolean }): string {
	if (result.isError === true) throw new Error(`期望成功，实际失败：${result.content}`);
	return result.content;
}

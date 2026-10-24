import type { SandboxView } from "../sandbox/policy.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";

/**
 * 文件工具的路径前奏:解析到工作区内、过沙箱边界、换成人可读的显示路径。
 *
 * 六个文件工具共用同一份顺序——先解析、再按解析后的真实路径判边界,六个地方各写一遍
 * 后,迟早有一个把顺序写反。
 */
export function resolveToolPath(
	workspace: WorkspaceBoundary,
	sandbox: SandboxView,
	input: string,
	operation: "read" | "write",
): { readonly absolute: string; readonly display: string } {
	const resolved = workspace.resolve(input);
	sandbox.assertPathAllowed(operation, resolved.absolute);
	return { absolute: resolved.absolute, display: workspace.display(resolved.absolute) };
}

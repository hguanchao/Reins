import type { SandboxView } from "../sandbox/policy.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";

/**
 * 文件工具的路径前奏:解析到工作区内、过沙箱边界、换成人可读的显示路径。
 *
 * 六个文件工具共用同一份顺序——先解析、再按解析后的真实路径判边界,六个地方各写一遍
 * 后,迟早有一个把顺序写反。
 */
/**
 * 写工具的审批范围：同一个绝对路径在会话内只问一次。
 *
 * 展示文案与实际键同为解析后的绝对路径：相对路径换个工作目录含义就变了，拿它当键会把
 * 两次不同的改动当成同一处。
 */
export function writeScope(
	workspace: WorkspaceBoundary,
	input: string,
): { readonly key: string; readonly label: string; readonly short: string } {
	const resolved = workspace.resolve(input);
	const label = workspace.display(resolved.absolute);
	return { key: resolved.absolute, label, short: label };
}

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

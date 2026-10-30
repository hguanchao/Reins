/**
 * 运行时上下文缺失成员的统一处理。
 *
 * pi 与 dsh 的运行时都要把「插件调用了宿主没有的服务」变成明确的错误并记进装载结果，而不是
 * 一个裸的 TypeError。缺失成员返回的既是可调用函数、也是可继续取属性的代理——`ctx.jobs.start`
 * 这样的两段式调用会一路带着完整名字走到调用点，报告里才能看到插件到底想要什么。
 */

export type MissingMarker = (name: string) => void;

/** 用缺失成员的兜底逻辑包一层宿主提供的基础成员。 */
export function contextProxy(
	base: Record<PropertyKey, unknown>,
	prefix: string,
	mark: MissingMarker,
): unknown {
	return new Proxy(base, {
		get(target, property) {
			if (property === "then") return undefined;
			if (property in target) return target[property];
			return missingMember(fullName(prefix, property), mark);
		},
	});
}

function missingMember(fullName: string, mark: MissingMarker): unknown {
	const handler = (..._args: unknown[]): never => {
		mark(fullName);
		throw new Error(`${fullName} is not available in Reins`);
	};
	return new Proxy(handler, {
		get(_target, property) {
			if (property === "then") return undefined;
			return missingMember(`${fullName}.${String(property)}`, mark);
		},
	});
}

function fullName(prefix: string, property: PropertyKey): string {
	return prefix === "" ? String(property) : `${prefix}.${String(property)}`;
}

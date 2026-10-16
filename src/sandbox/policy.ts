/**
 * 沙箱接缝。
 *
 * 工具不自己判断「能不能写这个路径」，一律经过这里。这样把判定留在宿主后，工具无论来自
 * 核心还是插件，都被同一套规则约束，插件也没有机会绕过。
 *
 * 当前只实现不隔离的模式：沙箱开启后的具体限制与各平台的实现随后补上。这里的接口先立起来，
 * 是为了让四个核心工具从一开始就只走这一条判定路径，而不是等到做沙箱时再回头改工具。
 */
export interface SandboxView {
	/**
	 * 判定一次文件操作是否被允许。不允许时抛错，错误信息说明是哪条规则挡住的。
	 * 不隔离时不做任何判定。
	 */
	assertPathAllowed(operation: "read" | "write", absolutePath: string): void;

	/**
	 * 把一条 shell 命令包成真正要执行的命令行。
	 *
	 * 返回字符串而不是参数数组，是因为隔离手段（macOS 的 seatbelt、Linux 的 bubblewrap）
	 * 本身就是以「另一层命令」的形式套在命令前面的，最终仍交给 shell 解析。
	 */
	wrapCommand(command: string): string;
}

/** 不隔离的沙箱：不拦截任何路径，命令行原样传出。 */
export class UnrestrictedSandbox implements SandboxView {
	assertPathAllowed(): void {
		// 未开启隔离时不设限制
	}

	wrapCommand(command: string): string {
		return command;
	}
}

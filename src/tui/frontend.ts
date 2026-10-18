import type { TurnDriver } from "../agent/driver.ts";
import type { AgentEventListener } from "../agent/events.ts";
import type { ApprovalMode, NotifyMode, SandboxMode } from "../config/config-file.ts";
import type { Confirmer } from "../permission/policy.ts";
import type { PluginCommand } from "../plugins/host.ts";
import type { UsageTotals } from "../session/usage.ts";

/**
 * 交互式界面的接缝。
 *
 * 宿主不认识任何具体界面，只要求一样东西：一个能跑起来的交互形态。界面拿走终端，负责渲染、
 * 读键、执行斜杠命令，直到使用者退出；退出前必须把终端恢复原状，否则使用者的 shell 会留在
 * 原始模式里，连回显都没有。
 *
 * 界面拿到的运行时是只读的加上几个明确的动作：它不能改模型、不能改审批方式、不能改沙箱
 * 模式——那些是宿主的决定。能改的只有两处配置（通知方式与信任清单），而且都要落回配置文件
 * 才作数。
 */
export interface InteractiveFrontend {
	/** 接管终端并进入交互循环，直到使用者退出。 */
	run(runtime: InteractiveRuntime): Promise<void>;
}

/** 会话在界面上的样子。 */
export interface SessionView {
	readonly id: string;
	readonly path: string | null;
	/** 已有的条目数。接续一个旧会话时，界面至少要让人知道屏幕之外还有多少历史 */
	readonly entries: number;
}

/** 工作区信任在界面上的样子。 */
export interface TrustView {
	readonly trusted: boolean;
	readonly root: string;
	/** 需要信任才会读取的文件；为空表示这个工作区没有自带配置 */
	readonly files: readonly string[];
}

export interface InteractiveRuntime {
	readonly cwd: string;
	readonly session: SessionView;
	readonly provider: string;
	readonly model: string;
	readonly approval: ApprovalMode;
	readonly sandbox: SandboxMode;
	readonly notify: NotifyMode;
	readonly trust: TrustView;
	/** 插件注册的斜杠命令 */
	readonly commands: readonly PluginCommand[];
	/** 跑一条插件命令，返回它输出的内容 */
	runCommand(name: string, args: string): Promise<readonly string[]>;
	/** 建一次运行的驱动；事件监听由界面提供 */
	createDriver(onEvent: AgentEventListener): TurnDriver;
	/** 本次会话到目前为止的用量。界面在自己的出口处报出来，免得使用者还得再去查一次 */
	sessionUsage(): UsageTotals;
	/** 当前上下文里估算有多少 token：状态行拿它显示上下文占用，和压缩用的是同一个估算 */
	contextTokens(): number;
	/** 界面接管后把审批确认接到界面上；undefined 表示交还给宿主。 */
	setConfirmer(confirmer: Confirmer | undefined): void;
	/** 改通知方式：写回用户配置，本次运行立刻生效。 */
	setNotify(mode: NotifyMode): void;
	/** 改工作区信任：写回用户配置，下次启动生效。 */
	setTrusted(trusted: boolean): void;
}

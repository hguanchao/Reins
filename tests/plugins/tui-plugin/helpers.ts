import type { TurnDriver } from "../../../src/agent/driver.ts";
import type { AgentEvent, AgentEventListener } from "../../../src/agent/events.ts";
import type { ApprovalMode, NotifyMode, SandboxMode } from "../../../src/config/config-file.ts";
import type { Confirmer } from "../../../src/permission/policy.ts";
import type { PluginCommand } from "../../../src/plugins/host.ts";
import type { InteractiveRuntime, SessionView, TrustView } from "../../../src/tui/frontend.ts";

/**
 * 假运行时。
 *
 * 界面只通过几个明确的动作与宿主打交道，因此一个记录调用的对象就够当宿主用了；驱动则按
 * 脚本发事件。有了它，界面的行为可以整段整段地验证，不必真的起一个进程去连模型。
 */

export interface RuntimeScript {
	/** 每次提交后驱动要发的事件 */
	readonly onRun?: (context: {
		readonly prompt: string;
		readonly emit: AgentEventListener;
		readonly signal: AbortSignal;
	}) => Promise<void> | void;
	readonly session?: SessionView;
	readonly provider?: string;
	readonly model?: string;
	readonly approval?: ApprovalMode;
	readonly sandbox?: SandboxMode;
	readonly notify?: NotifyMode;
	readonly trust?: TrustView;
	readonly commands?: readonly PluginCommand[];
	readonly runCommand?: (name: string, args: string) => Promise<readonly string[]>;
}

export interface FakeRuntime {
	readonly runtime: InteractiveRuntime;
	/** 提交过的句子 */
	readonly prompts: string[];
	readonly notifyCalls: NotifyMode[];
	readonly trustCalls: boolean[];
	readonly commandCalls: { readonly name: string; readonly args: string }[];
	/** 当前装上的确认入口；没有安装时为 undefined */
	confirmer(): Confirmer | undefined;
	/** 主动触发一次确认，模拟工具调用时的审批 */
	confirm(question: string, detail: string): Promise<boolean>;
}

export function makeRuntime(script: RuntimeScript = {}): FakeRuntime {
	const prompts: string[] = [];
	const notifyCalls: NotifyMode[] = [];
	const trustCalls: boolean[] = [];
	const commandCalls: { name: string; args: string }[] = [];
	let confirmer: Confirmer | undefined;

	const runtime: InteractiveRuntime = {
		cwd: "/work",
		session: script.session ?? { id: "abc", path: "/work/session.jsonl", entries: 0 },
		provider: script.provider ?? "demo",
		model: script.model ?? "m1",
		approval: script.approval ?? "ask",
		sandbox: script.sandbox ?? "off",
		notify: script.notify ?? "auto",
		trust: script.trust ?? { trusted: true, root: "/work", files: [] },
		commands: script.commands ?? [],
		runCommand: async (name, args) => {
			commandCalls.push({ name, args });
			return script.runCommand === undefined ? [] : script.runCommand(name, args);
		},
		createDriver: (onEvent) =>
			({
				run: async (prompt: string, signal: AbortSignal): Promise<void> => {
					prompts.push(prompt);
					await script.onRun?.({ prompt, emit: onEvent, signal });
				},
			}) as unknown as TurnDriver,
		setConfirmer: (value) => {
			confirmer = value;
		},
		setNotify: (mode) => {
			notifyCalls.push(mode);
		},
		setTrusted: (trusted) => {
			trustCalls.push(trusted);
		},
	};

	return {
		runtime,
		prompts,
		notifyCalls,
		trustCalls,
		commandCalls,
		confirmer: () => confirmer,
		async confirm(question, detail) {
			if (confirmer === undefined) throw new Error("界面还没有装上确认入口");
			return confirmer(question, detail);
		},
	};
}

/** 一段文本流的事件序列。 */
export function textEvents(text: string): AgentEvent[] {
	return text.split("").map((char) => ({ type: "text_delta", text: char }));
}

/** 等一轮微任务与外部的定时器都跑完。 */
export function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

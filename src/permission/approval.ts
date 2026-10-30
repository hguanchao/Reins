/**
 * 审批请求的桥接。
 *
 * 权限门在工具执行线程里同步等待一个布尔值，TUI 则在事件循环里等按键。这个类把两边接起来：
 * 门调用 request 得到一个 Promise，界面通过 pending 取当前请求、通过 resolve 交回结论。
 *
 * 工具调用可能并行发起，所以请求必须排队，一次只向使用者展示一个，避免多个确认框互相覆盖。
 */

import type { ApprovalAnswer, ApprovalRequest } from "#src/permission/policy.ts";

export type ApprovalPrompt = ApprovalRequest;

interface Pending {
	/** 请求标识：界面回传结论时带上它，确认回答的是哪一个请求 */
	readonly id: number;
	readonly prompt: ApprovalPrompt;
	readonly resolve: (answer: ApprovalAnswer) => void;
}

export class ApprovalBroker {
	#active: Pending | undefined;
	readonly #queue: Pending[] = [];
	#nextId = 0;

	/** 交给 PermissionGate 的 confirmer；箭头函数保证可以脱离实例传递。 */
	request = (request: ApprovalPrompt): Promise<ApprovalAnswer> => {
		return new Promise<ApprovalAnswer>((resolve) => {
			this.#nextId += 1;
			const entry: Pending = { id: this.#nextId, prompt: request, resolve };
			if (this.#active === undefined) this.#active = entry;
			else this.#queue.push(entry);
		});
	};

	/** 当前应该展示给使用者的请求；没有时为空。 */
	pending(): ApprovalPrompt | undefined {
		return this.#active?.prompt;
	}

	/** 当前请求的标识；界面把它随结论一起交回。 */
	pendingId(): number | undefined {
		return this.#active?.id;
	}	/**
	 * 交回一个结论，并把下一个等待中的请求提升为当前请求。
	 *
	 * 带上请求标识时先核对：并行调用中一个被中止、另一个顶上来时，界面那一帧还画着旧请求，
	 * 此时按下的键不能被记到使用者从未见过的新请求上。
	 */
	resolve(answer: ApprovalAnswer, id?: number): void {
		const active = this.#active;
		if (active === undefined) return;
		if (id !== undefined && id !== active.id) return;
		active.resolve(answer);
		this.#active = this.#queue.shift();
	}

	/** 中止或退出时，把所有等待中的请求按拒绝处理，避免工具线程永远挂着。 */
	denyAll(): void {
		const active = this.#active;
		this.#active = undefined;
		active?.resolve("deny");
		for (const entry of this.#queue) entry.resolve("deny");
		this.#queue.length = 0;
	}
}

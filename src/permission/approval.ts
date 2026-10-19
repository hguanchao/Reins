/**
 * 审批请求的桥接。
 *
 * 权限门在工具执行线程里同步等待一个布尔值，TUI 则在事件循环里等按键。这个类把两边接起来：
 * 门调用 request 得到一个 Promise，界面通过 pending 取当前请求、通过 resolve 交回结论。
 *
 * 工具调用可能并行发起，所以请求必须排队，一次只向使用者展示一个，避免多个确认框互相覆盖。
 */

export interface ApprovalPrompt {
	readonly question: string;
	readonly detail: string;
}

interface Pending {
	readonly prompt: ApprovalPrompt;
	readonly resolve: (allowed: boolean) => void;
}

export class ApprovalBroker {
	#active: Pending | undefined;
	readonly #queue: Pending[] = [];

	/** 交给 PermissionGate 的 confirmer；箭头函数保证可以脱离实例传递。 */
	request = (question: string, detail: string): Promise<boolean> => {
		return new Promise<boolean>((resolve) => {
			const entry: Pending = { prompt: { question, detail }, resolve };
			if (this.#active === undefined) this.#active = entry;
			else this.#queue.push(entry);
		});
	};

	/** 当前应该展示给使用者的请求；没有时为空。 */
	pending(): ApprovalPrompt | undefined {
		return this.#active?.prompt;
	}

	/** 交回一个结论，并把下一个等待中的请求提升为当前请求。 */
	resolve(allowed: boolean): void {
		const active = this.#active;
		if (active === undefined) return;
		active.resolve(allowed);
		this.#active = this.#queue.shift();
	}

	/** 中止或退出时，把所有等待中的请求按拒绝处理，避免工具线程永远挂着。 */
	denyAll(): void {
		const active = this.#active;
		this.#active = undefined;
		active?.resolve(false);
		for (const entry of this.#queue) entry.resolve(false);
		this.#queue.length = 0;
	}
}

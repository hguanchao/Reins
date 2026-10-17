/**
 * 事件流：既是可异步迭代的事件序列，也是一个最终结果的承诺。
 *
 * 适配器需要「先把流对象同步交出去，再在后台把数据推完」这种形状——调用方拿到流之后立刻
 * 就能开始消费，不必等网络连接建立。所以推送与迭代之间要有一个队列来解耦：有等待者就直接
 * 交给它，没有就排进队列。
 */
export class EventStream<T, R> implements AsyncIterable<T> {
	/**
	 * 只有增量、结果通过 close() 给出的流。
	 *
	 * 适配器走这条路径：结束条件不是某个特定事件，而是后台过程跑完；过程里出的异常也会被
	 * 转成结果，因此不会让 result() 拒绝。
	 */
	static incremental<T, R>(): EventStream<T, R> {
		return new EventStream<T, R>(
			() => false,
			() => {
				throw new Error("this stream only provides its result through close()");
			},
		);
	}

	readonly #pending: T[] = [];
	readonly #waiting: ((value: IteratorResult<T>) => void)[] = [];
	#closed = false;
	readonly #result: Promise<R>;
	#resolveResult!: (value: R) => void;
	readonly #isTerminal: (event: T) => boolean;
	readonly #extractResult: (event: T) => R;

	constructor(isTerminal: (event: T) => boolean, extractResult: (event: T) => R) {
		this.#isTerminal = isTerminal;
		this.#extractResult = extractResult;
		this.#result = new Promise((resolve) => {
			this.#resolveResult = resolve;
		});
	}

	/** 推入一个事件。终结事件之后推入的内容会被忽略。 */
	push(event: T): void {
		if (this.#closed) return;
		if (this.#isTerminal(event)) {
			this.#closed = true;
			this.#resolveResult(this.#extractResult(event));
		}

		const waiter = this.#waiting.shift();
		if (waiter === undefined) this.#pending.push(event);
		else waiter({ value: event, done: false });
	}

	/** 结束流并给出结果。用于推送方在终结事件之外单独收尾的情形。 */
	close(result: R): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#resolveResult(result);
		while (this.#waiting.length > 0) {
			this.#waiting.shift()?.({ value: undefined as never, done: true });
		}
	}

	/** 最终结果。与迭代可以同时进行，两者互不阻塞。 */
	result(): Promise<R> {
		return this.#result;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		for (;;) {
			const queued = this.#pending.shift();
			if (queued !== undefined) {
				yield queued;
				continue;
			}
			if (this.#closed) return;
			const next = await new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve));
			if (next.done === true) return;
			yield next.value;
		}
	}
}

/**
 * 按路径串行化「读—改—写」。
 *
 * 同一轮里模型可以并行发出多个工具调用，如果两个写操作落在同一个文件上，后一个的读取可能
 * 发生在第一个写入之前，于是把第一个的结果盖掉，而两者都不会报错。所以同一个路径上的这类
 * 操作排队执行。
 *
 * 只在进程内生效：同一个文件被两个进程同时改是另一回事，靠文件锁解决，不在这里掺和。
 */
const chains = new Map<string, Promise<void>>();

export function withFileMutation<T>(absolutePath: string, action: () => Promise<T>): Promise<T> {
	const previous = chains.get(absolutePath) ?? Promise.resolve();
	// 前一个操作失败也要继续排队，否则一次失败会让后续同类操作永久卡住
	const run = previous.then(action, action);

	const guarded = run.then(
		() => undefined,
		() => undefined,
	);
	chains.set(absolutePath, guarded);
	void guarded.then(() => {
		// 只在仍是链尾时清理，避免把后来者新挂上的链删掉
		if (chains.get(absolutePath) === guarded) chains.delete(absolutePath);
	});

	return run;
}

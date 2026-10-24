/**
 * 把任意抛出的东西写成人能读的一句话。
 *
 * 各处 catch 到的都是 unknown:错误对象、字符串、甚至 undefined 都可能出现;错误消息
 * 的提取规则只写这一份,别处不再各自猜测。给模型与使用者的报错都要经过它,口径才一致。
 */
export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

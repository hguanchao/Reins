import { exec } from "node:child_process";
import { promisify } from "node:util";

const runShell = promisify(exec);

/** 取密钥命令的最长等待。它只是取一个值，卡住说明这条命令自己有问题。 */
const COMMAND_TIMEOUT_MS = 10_000;

const ENV_REFERENCE = /\$(?:\{(\w+)\}|(\w+))/g;

/**
 * 解析 models.json 里写的 apiKey。
 *
 * 支持三种写法：以 `!` 开头的命令、含 `$NAME` 或 `${NAME}` 的环境变量插值、字面值。
 * 命令形式让密钥可以来自凭据管理器或临时令牌，不必落进配置文件。
 *
 * 环境变量没设置时直接报错而不是替换成空串：空密钥会让端点回一个认证失败，把「忘了设置
 * 变量」伪装成「密钥不对」，排查方向就偏了。
 */
export async function resolveApiKey(
	spec: string | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (spec === undefined) return undefined;

	if (spec.startsWith("!")) {
		const command = spec.slice(1).trim();
		if (command.length === 0) throw new Error("apiKey 的 ! 后面没有命令");
		const { stdout } = await runShell(command, {
			signal,
			timeout: COMMAND_TIMEOUT_MS,
			windowsHide: true,
		});
		const key = stdout.trim();
		if (key.length === 0) throw new Error(`取密钥的命令没有输出：${command}`);
		return key;
	}

	return spec.replace(ENV_REFERENCE, (_match, braced: string | undefined, plain: string | undefined) => {
		const name = braced ?? plain ?? "";
		const value = process.env[name];
		if (value === undefined) throw new Error(`apiKey 引用的环境变量 ${name} 未设置`);
		return value;
	});
}

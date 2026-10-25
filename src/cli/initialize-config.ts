import { describeError } from "../describe-error.ts";
import { initializeConfigFiles } from "../config/initialize.ts";
import type { CliOptions } from "./args.ts";
import { writeStderr } from "./output.ts";

/**
 * 补齐缺失的配置模板。
 *
 * 显式指定了 --config / --providers 时不碰默认位置：使用者已经指明要看哪一份，再创建一份
 * 不会被读取的文件只会让人困惑。模板是启动的默认准备动作，补上了也不出声——报一声反而像
 * 出了问题；创建失败才报告，且不阻止启动，接下来读配置时会给出具体错误。
 */
export function initializeConfig(options: CliOptions): void {
	try {
		initializeConfigFiles({
			config: options.configPath === undefined,
			providers: options.providersPath === undefined,
		});
	} catch (error) {
		writeStderr(
			`reins: could not create configuration templates: ${describeError(error)}\n`,
		);
	}
}

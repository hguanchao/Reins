import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * 进入交互界面之前的那一句询问。
 *
 * 问在界面接管终端之前，是因为答案会决定哪些配置生效，而配置又决定界面按什么规矩跑——先起
 * 界面再问，就得先定一套规则、问完再推翻重来。这一问走标准错误：即使有人把标准输出重定向到
 * 文件，屏幕上照样看得见问题。
 *
 * 读不到答案（输入结束、被中断）时按「不」处理：没人明确同意过的事，不能替人同意。
 */
export async function askYesNo(
	question: string,
	io: { readonly input: Readable; readonly output: Writable } = {
		input: process.stdin,
		output: process.stderr,
	},
): Promise<boolean> {
	const terminal = createInterface({ input: io.input, output: io.output });

	try {
		return await new Promise<boolean>((resolve) => {
			let answered = false;
			const onClose = (): void => {
				if (!answered) resolve(false);
			};
			terminal.once("close", onClose);
			terminal.question(`${question} [y/N] `, (answer) => {
				answered = true;
				terminal.off("close", onClose);
				resolve(isYes(answer));
			});
		});
	} finally {
		terminal.close();
	}
}

/** 只认明确的肯定：y 与 yes（大小写不限）。其余一律按否处理。 */
function isYes(answer: string): boolean {
	const text = answer.trim().toLowerCase();
	return text === "y" || text === "yes";
}

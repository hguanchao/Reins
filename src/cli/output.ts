/**
 * CLI 的标准输出与标准错误。
 *
 * 启动装配的各个模块都要写提示，集中到一处，测试替换或重定向时只有一个入口。
 */

export function writeStdout(text: string): void {
	process.stdout.write(text);
}

export function writeStderr(text: string): void {
	process.stderr.write(text);
}

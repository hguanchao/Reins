/**
 * 启动阶段计时。
 *
 * 启动慢在哪只能由数据回答：配置读取、插件装载、沙箱探测、会话恢复都串在同一条装配路径上，
 * 靠感觉挑一处优化，改的往往是没花时间的那一段。
 *
 * 默认关闭，只在 REINS_DEBUG_STARTUP 有值时输出——每次启动都多打几行，很快就会没人看。
 */

export interface StartupTimer {
	/** 记下这一阶段到此结束；名字说明这一步做了什么 */
	mark(stage: string): void;
	/** 把各阶段耗时写出去；没启用时什么也不做 */
	report(): void;
}

export interface StartupTimerOptions {
	readonly env: Record<string, string | undefined>;
	readonly write: (line: string) => void;
	/** 取当前时间，单位毫秒；测试时替换成可控的假时钟 */
	readonly now?: () => number;
}

/** 阶段名左对齐到这一列，耗时才对得齐 */
const STAGE_WIDTH = 14;

export function createStartupTimer(options: StartupTimerOptions): StartupTimer {
	const enabled = (options.env["REINS_DEBUG_STARTUP"] ?? "") !== "";
	const now = options.now ?? ((): number => performance.now());
	const started = now();
	let last = started;
	const rows: { readonly stage: string; readonly ms: number }[] = [];

	return {
		mark(stage: string): void {
			// 没启用就什么都不记：连时间戳都不取，正常启动不受影响
			if (!enabled) return;
			const at = now();
			rows.push({ stage, ms: at - last });
			last = at;
		},
		report(): void {
			if (!enabled || rows.length === 0) return;
			options.write("startup\n");
			for (const row of rows) {
				options.write(`  ${row.stage.padEnd(STAGE_WIDTH)}${row.ms.toFixed(1)}ms\n`);
			}
			options.write(`  ${"total".padEnd(STAGE_WIDTH)}${(last - started).toFixed(1)}ms\n`);
		},
	};
}

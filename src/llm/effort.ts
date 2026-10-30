import type { ThinkingLevel } from "#src/config/file.ts";
import type { ThinkingLevelMap } from "#src/config/providers-file.ts";

/**
 * 思考等级在请求层的形态。
 *
 * 与配置里的 ThinkingLevel 差一个 off：off 的含义是「不发送任何思考参数」，不是「发送一个
 * 叫 off 的值」。适配器拿到的 effort 要么是一个真实等级，要么是 undefined，不需要自己再
 * 判断 off 该怎么办。
 */
export type ReasoningEffort = Exclude<ThinkingLevel, "off">;

const EFFORT_LADDER: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function isReasoningEffort(value: string): value is ReasoningEffort {
	return EFFORT_LADDER.some((item) => item === value);
}

/**
 * 模型支持的等级。
 *
 * 不支持思考的模型只有 off；其余的看 thinkingLevelMap：显式标为 null 的等级不支持，
 * 没写的等级按支持处理（用 provider 自己的默认取值）。
 */
export function supportedEfforts(reasoning: boolean, map: ThinkingLevelMap): readonly ThinkingLevel[] {
	if (!reasoning) return ["off"];
	return ["off", ...EFFORT_LADDER.filter((effort) => map[effort] !== null)];
}

/**
 * 把请求的等级收敛到模型支持的等级上。
 *
 * 先往下找再往上找：请求 high 而模型只到 medium 时用 medium，比硬套 high 更接近使用者的
 * 意图，也比直接报错更少打断。off 或模型不支持思考时返回 undefined。
 */
export function clampEffort(
	requested: ThinkingLevel,
	reasoning: boolean,
	map: ThinkingLevelMap,
): ReasoningEffort | undefined {
	if (requested === "off" || !reasoning) return undefined;

	const index = EFFORT_LADDER.indexOf(requested);
	if (index === -1) return undefined;

	for (let position = index; position >= 0; position -= 1) {
		const candidate = EFFORT_LADDER[position];
		if (map[candidate] !== null) return candidate;
	}
	for (let position = index + 1; position < EFFORT_LADDER.length; position += 1) {
		const candidate = EFFORT_LADDER[position];
		if (map[candidate] !== null) return candidate;
	}
	return undefined;
}

/**
 * 等级在 provider 那边的取值。
 *
 * providers.json 里写了映射就用映射值，没写就透传等级名——两条主流线上协议的思考等级取值
 * 与这里同名，所以透传在大多数端点上直接可用；取值确实不同的端点由使用者写映射修正。
 */
export function providerEffortValue(effort: ReasoningEffort, map: ThinkingLevelMap): string {
	return map[effort] ?? effort;
}

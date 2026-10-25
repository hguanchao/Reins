import { homedir } from "node:os";
import { basename } from "node:path";
import { describeError } from "../shared/describe-error.ts";

import { estimateTokens } from "../agent/compactor.ts";
import type { Config } from "../config/file.ts";
import { ModelCatalog } from "../config/model-catalog.ts";
import type { ProvidersConfig } from "../config/providers-file.ts";
import { resolveSelection, type ModelSelection } from "../config/selection.ts";
import { updateModelSelection, updateUserConfigValue } from "../config/write-back.ts";
import { clampEffort } from "../llm/effort.ts";
import type { ApprovalReviewer } from "../permission/policy.ts";
import type { Session } from "../session/session.ts";
import { cacheHitRate, lastContextTokens, sumUsage } from "../session/usage.ts";
import type { FooterInfo } from "../tui/view/footer.ts";
import type { EffortMenuSource, ModelMenuSource } from "../tui/options.ts";
import { currentBranch } from "../workspace/git.ts";
import { createReviewer } from "./pipeline.ts";

/**
 * 主目录缩写成 `~`：整屏页展示来源用。
 *
 * 完整绝对路径一行放不下还常折行，而看清单的人只需要知道「来自哪一层」。不在主目录下的
 * 路径原样返回——项目级来源本来就该看出是哪个仓库。
 */
export function abbreviateHome(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}\\`) || path.startsWith(`${home}/`)
		? `~${path.slice(home.length)}`
		: path;
}

/**
 * 审查模型跟随当前选型。
 *
 * 审批为 auto 时，插件的加严规则仍可能把某次调用交回审查模型；/model 切换后应当用新模型
 * 审查，而不是继续用启动时那一个。
 */
export function createDynamicReviewer(
	catalog: ModelCatalog,
	getConfig: () => Config,
	workRoot: string,
): ApprovalReviewer {
	return {
		async review(tool, args, signal) {
			const selection = catalog.selection;
			if (selection === undefined) {
				return { allowed: false, reason: "No model is selected; denied" };
			}
			return createReviewer(getConfig(), selection, workRoot).review(tool, args, signal);
		},
	};
}

/**
 * 模型菜单的宿主实现。
 *
 * 切换本身只改会话内的目录；确认后把 provider/model 写进配置，再用写好的配置重新校验一次。
 * 写盘或校验失败时保持受限状态，并把原因一并交给界面显示。
 */
export function createModelMenuSource(options: {
	readonly catalog: ModelCatalog;
	readonly config: Config;
	readonly providersConfig: ProvidersConfig;
	readonly configFile: string;
	readonly providersFile: string;
	readonly writePath: string;
	readonly onSelection: (selection: ModelSelection) => void;
	readonly onReady: () => void;
}): ModelMenuSource {
	return {
		list: () => options.catalog.options(),
		select: (item) => {
			const outcome = options.catalog.switchTo(item.provider, item.model);
			options.onSelection(outcome.selection);
			const warnings = [...outcome.warnings];

			try {
				updateModelSelection(item.provider, item.model, options.writePath);
			} catch (error) {
				const message = describeError(error);
				return {
					warnings: [...warnings, message],
					ready: false,
					warning: `Warning: ${message}`,
				};
			}

			try {
				// 写回后按完整配置再校验一次：compact_model / review_model 可能仍指向旧 provider
				resolveSelection(
					{ ...options.config, provider: item.provider, model: item.model },
					options.providersConfig,
					options.configFile,
					options.providersFile,
				);
			} catch (error) {
				const message = describeError(error);
				return {
					warnings: [...warnings, message],
					ready: false,
					warning: `Warning: ${message}`,
				};
			}

			options.onReady();
			return { warnings, ready: true, warning: undefined };
		},
	};
}

/**
 * 思考等级菜单的宿主实现。
 *
 * 写入失败直接抛错，由界面显示原因；成功后再更新内存里的配置，页脚随之刷新。
 */
export function createEffortMenuSource(options: {
	readonly getConfig: () => Config;
	readonly writePath: string;
	readonly onConfigChange: (config: Config) => void;
}): EffortMenuSource {
	return {
		current: () => options.getConfig().reasoningEffort,
		select: (level) => {
			updateUserConfigValue(["reasoning_effort"], () => level, options.writePath);
			options.onConfigChange({ ...options.getConfig(), reasoningEffort: level });
		},
	};
}

/**
 * 输入框下方的常驻信息。
 *
 * 全部取自本次运行的配置与会话：模型与思考强度是实际会发出去的那一组，上下文与缓存命中率
 * 来自会话记录，界面不自己猜。接续旧会话时，这两项从历史里算出来；新会话则是零。
 */
export function createFooterInfo(
	workRoot: string,
	config: Config,
	selection: ModelSelection,
	session: Session,
): FooterInfo {
	return {
		project: basename(workRoot),
		branch: currentBranch(workRoot),
		model: selection.model.id,
		effort:
			clampEffort(
				config.reasoningEffort,
				selection.model.reasoning,
				selection.model.thinkingLevelMap,
			) ?? "off",
		contextUsed: contextUsedTokens(session),
		contextWindow: selection.model.contextWindow ?? config.contextWindow,
		cacheHitRate: cacheHitRate(sumUsage(session.entries())),
	};
}

/**
 * 上下文已用规模。
 *
 * 优先取最近一次请求回报的真实规模：字数估算在工具结果多、中文多的时候会偏。压缩之后与还
 * 没发过请求的会话没有可用的回报，只能按消息估算——这正是压缩判断自己的兜底口径。
 */
function contextUsedTokens(session: Session): number {
	return lastContextTokens(session.entries()) ?? estimateTokens(session.state().messages);
}

/**
 * 配置不可用时的常驻信息。
 *
 * 模型与思考强度留空而不是猜一个值：这时没有可用的选型，显示任何具体模型都会让人以为
 * 请求会发到那里。会话本身的计数仍然准确，照常显示。
 */
export function createUnavailableFooterInfo(workRoot: string, session: Session): FooterInfo {
	return {
		project: basename(workRoot),
		branch: currentBranch(workRoot),
		model: "-",
		effort: "-",
		contextUsed: contextUsedTokens(session),
		contextWindow: undefined,
		cacheHitRate: cacheHitRate(sumUsage(session.entries())),
	};
}

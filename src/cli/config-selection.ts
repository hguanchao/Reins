import { statSync } from "node:fs";

import { ConfigError } from "../config/config-error.ts";
import { ConfigFile, type Config } from "../config/config-file.ts";
import { mergeConfigs, mergeProviders } from "../config/merge.ts";
import { loadProviders, type ProvidersConfig } from "../config/providers-file.ts";
import {
	configFilePath,
	projectConfigFilePath,
	projectProvidersFilePath,
	providersFilePath,
} from "../config/paths.ts";
import { resolveSelection, type ModelSelection } from "../config/selection.ts";
import { findProjectResources, recordTrust, resolveTrust, type TrustDecision } from "../workspace/trust.ts";
import type { CliOptions } from "./args.ts";
import { writeStderr } from "./output.ts";

/**
 * 读出生效配置并解析出所使用的模型。
 *
 * 交互与非交互两种启动方式共用同一条校验。返回错误而不是直接退出，让两种模式各自决定
 * 怎么处理：全屏界面把错误留在主区域继续显示，非交互模式没有可展示错误的地方，直接退出。
 */
export type SelectionResult =
	| {
			readonly ok: true;
			/** 工作区是否已取得信任：项目级技能要靠它决定扫不扫 */
			readonly trusted: boolean;
			readonly value: {
				readonly config: Config;
				readonly providersConfig: ProvidersConfig;
				readonly selection: ModelSelection;
			};
	  }
	| {
			/** 配置本身读得动，只是 provider/model 对不上；/model 可以修复 */
			readonly ok: false;
			readonly recoverable: true;
			readonly trusted: boolean;
			readonly config: Config;
			readonly providersConfig: ProvidersConfig;
			readonly error: ConfigError;
	  }
	| { readonly ok: false; readonly recoverable: false; readonly error: ConfigError };

export async function loadSelection(options: CliOptions): Promise<SelectionResult> {
	const configFile = options.configPath ?? configFilePath();
	const providersFile = options.providersPath ?? providersFilePath();

	let effective: Awaited<ReturnType<typeof loadEffectiveConfig>>;
	try {
		effective = await loadEffectiveConfig(options);
	} catch (error) {
		if (error instanceof ConfigError) return { ok: false, recoverable: false, error };
		throw error;
	}

	try {
		return {
			ok: true,
			trusted: effective.trust.trusted,
			value: {
				config: effective.config,
				providersConfig: effective.providersConfig,
				selection: resolveSelection(
					effective.config,
					effective.providersConfig,
					configFile,
					providersFile,
				),
			},
		};
	} catch (error) {
		if (error instanceof ConfigError) {
			return {
				ok: false,
				recoverable: true,
				trusted: effective.trust.trusted,
				config: effective.config,
				providersConfig: effective.providersConfig,
				error,
			};
		}
		throw error;
	}
}

/**
 * 读出生效的配置。
 *
 * 用户级配置总是读；工作区自带的配置要先取得信任。缺少信任时不读，并且明确说出来——安静地
 * 跳过会让人以为项目设置生效了，而实际没有。
 *
 * 命令行显式指定了配置文件时跳过工作区配置：使用者已经指明了要看哪一份，再去叠加一份
 * 目录里的配置只会让「到底生效了什么」变得说不清。
 */
async function loadEffectiveConfig(
	options: CliOptions,
): Promise<{
	readonly config: Config;
	readonly providersConfig: ProvidersConfig;
	/** 实际参与合并的配置文件，按优先级从低到高 */
	readonly sources: readonly string[];
	readonly trust: TrustDecision;
	/** 工作区里需要信任才会读取的文件 */
	readonly resources: readonly string[];
}> {
	const workRoot = process.cwd();
	const userConfigPath = options.configPath ?? configFilePath();
	const userProvidersPath = options.providersPath ?? providersFilePath();
	const userConfig = ConfigFile.load(userConfigPath);
	const userProviders = loadProviders(userProvidersPath);
	const projectResources = findProjectResources(workRoot);
	const resources = projectResources.files;
	// 项目配置与项目级技能都会影响程序行为，任有其一时都得先取得信任
	const protectedResources = [...projectResources.files, ...projectResources.skillDirectories];

	if (options.configPath !== undefined) {
		return {
			config: userConfig.config,
			providersConfig: userProviders,
			sources: [userConfigPath],
			trust: { trusted: false, source: "none" },
			resources,
		};
	}

	const decision = resolveTrust({
		root: workRoot,
		override: options.trust,
		trustedRoots: userConfig.config.plugins.trusted,
		hasProtectedResources: protectedResources.length > 0,
	});

	if (decision.source === "flag") {
		// 命令行给出的结论会被记下来，下次不必再给
		recordTrust(workRoot, decision.trusted);
		writeStderr(`Recorded ${workRoot} as ${decision.trusted ? "trusted" : "untrusted"}\n`);
	}

	if (!decision.trusted) {
		if (protectedResources.length > 0) {
			writeStderr(
				`Skipped the workspace config that needs trust: ${protectedResources.join(", ")}\nPass --trust to use them.\n`,
			);
		}
		return {
			config: userConfig.config,
			providersConfig: userProviders,
			sources: [userConfigPath],
			trust: decision,
			resources,
		};
	}

	const projectConfigPath = projectConfigFilePath(workRoot);
	const projectProvidersPath = projectProvidersFilePath(workRoot);
	const config = resources.includes(projectConfigPath)
		? mergeConfigs(userConfig, ConfigFile.load(projectConfigPath))
		: userConfig.config;
	const providersConfig = resources.includes(projectProvidersPath)
		? mergeProviders(userProviders, loadProviders(projectProvidersPath))
		: userProviders;
	const sources = resources.includes(projectConfigPath)
		? [userConfigPath, projectConfigPath]
		: [userConfigPath];
	return { config, providersConfig, sources, trust: decision, resources };
}

/**
 * 说清楚沙箱管不到哪些东西。
 *
 * 沙箱管的是本程序发出的命令，管不到 MCP server 进程：它是使用者自己配置的本地程序，与插件
 * 同级。这件事不吭声就会被当成「开了沙箱就什么都隔离了」——而按沙箱的语义，`read-only` 是
 * 「不允许写」这样一个承诺。
 */
export function warnUnsandboxedMcpServers(config: Config): void {
	if (config.sandbox === "off") return;
	const stdio = config.mcpServers.filter((server) => !server.disabled && server.type === "stdio");
	if (stdio.length === 0) return;
	writeStderr(
		`Note: sandbox mode is ${config.sandbox}, but these MCP servers are local processes started by reins and are not constrained by the sandbox: ` +
			`${stdio.map((server) => server.name).join(", ")}\n`,
	);
}

export function disabledPlugins(config: Config): ReadonlySet<string> {
	return new Set(config.plugins.disabled);
}

/** 配置文件的「版本」：修改时间与大小。读不到就当它不存在。 */
export function configFileStamp(...paths: readonly string[]): string {
	return paths
		.map((path) => {
			try {
				const info = statSync(path);
				return `${info.mtimeMs}:${info.size}`;
			} catch {
				return "-";
			}
		})
		.join("|");
}

/**
 * 重新读一遍配置，不打印任何东西。
 *
 * 与启动时共用同一套合并规则，但信任结论沿用启动时那一次：界面已经起来了，往 stderr 写
 * 提示会毁屏；而信任是启动期的决定，中途重新问一遍也没有意义。
 */
export function readConfigQuietly(options: CliOptions, workRoot: string, trusted: boolean): Config {
	const userConfig = ConfigFile.load(options.configPath ?? configFilePath());
	if (!trusted) return userConfig.config;
	// 与启动时共用同一份项目资源判定:目录与文件同名、providers.json 存在与否,
	// 两处口径必须一致,否则热重载读到的配置与启动时不是同一套
	const projectPath = projectConfigFilePath(workRoot);
	const resources = findProjectResources(workRoot);
	return resources.files.includes(projectPath)
		? mergeConfigs(userConfig, ConfigFile.load(projectPath))
		: userConfig.config;
}

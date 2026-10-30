import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 配置目录名，放在用户主目录下。 */
const CONFIG_DIR_NAME = ".reins";

const CONFIG_FILE_NAME = "config.toml";
const PROVIDERS_FILE_NAME = "providers.json";

/** 配置目录，可用环境变量覆盖，便于测试与多套配置并存。 */
export function configDir(): string {
	const override = process.env["REINS_HOME"];
	if (override !== undefined && override.length > 0) return override;
	return join(homedir(), CONFIG_DIR_NAME);
}

export function configFilePath(): string {
	return join(configDir(), CONFIG_FILE_NAME);
}

export function providersFilePath(): string {
	return join(configDir(), PROVIDERS_FILE_NAME);
}

/**
 * 溢出结果的落盘目录。
 *
 * 放在系统临时目录而不是配置目录：这些文件是某一次工具调用留下的中间产物，不属于需要
 * 长期保存的状态，交给系统清理即可。
 */
export function spillDir(): string {
	return join(tmpdir(), "reins-spill");
}

/**
 * 外部插件目录。
 *
 * 放在配置目录下：插件是使用者自己的东西，不属于某个具体项目，换目录工作时也该还在。
 */
export function pluginsDir(): string {
	return join(configDir(), "plugins");
}

/**
 * 检查点目录。
 *
 * 放在配置目录下，按项目与会话分目录；里面是独立的 shadow git 仓库，不碰工作区自己的
 * `.git`。检查点属于这个项目的本地历史，不应该混进工作区文件。
 */
export function checkpointsDir(): string {
	return join(configDir(), "checkpoints");
}

/**
 * 技能目录。
 *
 * 与插件同理放在配置目录下：技能是使用者攒下来的工作方式，不该跟着某个项目走。每个技能
 * 占一个子目录，里面放 SKILL.md。
 */
export function skillsDir(): string {
	return join(configDir(), "skills");
}

/**
 * 跨工具的技能目录。
 *
 * `.agents/skills` 是几个终端 agent 共同认的位置，认它等于白捡使用者已经装好的技能，
 * 不必让同一份技能在每个工具里各存一遍。
 */
export function agentsSkillsDir(): string {
	return join(homedir(), ".agents", "skills");
}

/**
 * dsh 的用户级技能目录。
 *
 * dsh 也实现 Agent Skills 规范，用户级技能放在 `~/.dsh/skills`：同一份 SKILL.md，认它就能
 * 直接用上 dsh 使用者已经装好的技能。
 */
export function dshSkillsDir(): string {
	return join(homedir(), ".dsh", "skills");
}

/** 工作区里的技能目录，与 `.reins/config.toml` 同级。 */
export function projectSkillsDir(workRoot: string): string {
	return join(projectDirPath(workRoot), "skills");
}

/** 工作区里的跨工具技能目录。 */
export function projectAgentsSkillsDir(workRoot: string): string {
	return join(workRoot, ".agents", "skills");
}

/** 工作区里的 dsh 技能目录。 */
export function projectDshSkillsDir(workRoot: string): string {
	return join(workRoot, ".dsh", "skills");
}

/**
 * 用户级规则文件的候选清单，按优先级排列。
 *
 * 同目录里 `AGENTS.override.md` 存在时取代 `AGENTS.md` / `CLAUDE.md`；候选路径都列出来，
 * 由读取方决定最终用哪一个，信任判定也能一次看到全部可能影响提示词的文件。
 */
export function userInstructionFiles(): readonly string[] {
	return INSTRUCTION_FILE_NAMES.map((name) => join(configDir(), name));
}

/** 工作区规则文件的候选清单，优先级与用户级相同。 */
export function projectInstructionFiles(workRoot: string): readonly string[] {
	return INSTRUCTION_FILE_NAMES.map((name) => join(workRoot, name));
}

/** 规则文件名：override 优先，其余按 AGENTS.md、CLAUDE.md 的顺序回退。 */
const INSTRUCTION_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"] as const;

/**
 * 会话文件所在目录。
 *
 * 按工作根分目录，同一个目录下的会话聚在一起，换目录工作时各自看到自己的历史。
 *
 * 目录名由「可读前缀 + 路径哈希」组成。只用前缀是有损的：`E:\work\my-project` 与
 * `E:\work\my\project` 都会变成 `E--work-my-project`，两个项目的会话混在一起，
 * `--resume` 可能打开另一个项目的会话。加上哈希之后不同路径必然不同目录。
 */
export function sessionsDir(workRoot: string): string {
	return join(configDir(), "sessions", encodeWorkRoot(workRoot));
}

/** 路径哈希的长度：16 个十六进制字符，碰撞概率可以忽略。 */
const WORK_ROOT_HASH_LENGTH = 16;

/**
 * 会话目录的候选清单，按优先级排列。
 *
 * 第一项是当前编码，其余是历史编码：目录名规则改过一次，旧会话还留在旧目录里。
 * 读取时两处都要看，否则升级之后使用者会以为自己的历史全丢了。
 */
export function sessionDirectories(workRoot: string): readonly string[] {
	const base = join(configDir(), "sessions");
	const directories = [join(base, encodeWorkRoot(workRoot))];
	const legacy = legacyWorkRoot(workRoot);
	if (legacy !== undefined) directories.push(join(base, legacy));
	return directories;
}

/**
 * 把工作根编码成目录名。
 *
 * 保留一段可读前缀便于人工排查；前缀本身有损，唯一性由后面的哈希保证。Windows 上大小写
 * 不敏感，先把路径折成小写再算哈希，`E:\Foo` 与 `e:\foo` 才会落到同一个目录。
 */
function encodeWorkRoot(workRoot: string): string {
	const normalized = workRoot.replaceAll(/[/\\:]/g, "-");
	const readable = normalized.startsWith("-") ? normalized.slice(1) : normalized;
	const key = process.platform === "win32" ? workRoot.toLowerCase() : workRoot;
	const hash = createHash("sha256").update(key).digest("hex").slice(0, WORK_ROOT_HASH_LENGTH);
	// 目录名不宜过长：只保留末尾 40 个字符，项目名通常在那里
	const prefix = readable.length > 40 ? readable.slice(-40) : readable;
	return `${prefix}-${hash}`;
}

/** 旧版编码（只有可读前缀、没有哈希）；当前编码与它相同时返回 undefined，避免重复。 */
function legacyWorkRoot(workRoot: string): string | undefined {
	const normalized = workRoot.replaceAll(/[/\\:]/g, "-");
	const legacy = normalized.startsWith("-") ? normalized.slice(1) : normalized;
	return legacy === encodeWorkRoot(workRoot) ? undefined : legacy;
}

/**
 * 工作区里的配置目录。
 *
 * 与用户配置目录同名但位置不同：一个是使用者的全局设置，一个是这个项目自带的设置。后者
 * 需要先取得信任才会被读取，因此不能混在同一个位置。
 */
export function projectDirPath(workRoot: string): string {
	return join(workRoot, CONFIG_DIR_NAME);
}

export function projectConfigFilePath(workRoot: string): string {
	return join(projectDirPath(workRoot), CONFIG_FILE_NAME);
}

export function projectProvidersFilePath(workRoot: string): string {
	return join(projectDirPath(workRoot), PROVIDERS_FILE_NAME);
}

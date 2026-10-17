/**
 * 斜杠命令下拉的匹配规则。
 *
 * 只在光标还停在命令名里时打开：`/he` 有候选，`/help ` 之后进入参数阶段就不再列命令。
 * 匹配只作用于命令名，先精确、再前缀、最后子序列；同一档内短名字优先。
 */

export interface SlashCommand {
	readonly name: string;
	readonly description: string;
	/** 接受候选后插入输入框的文字，通常带一个尾随空格。 */
	readonly insertText: string;
}

export interface SlashContext {
	/** 光标前的命令名，不含开头的斜杠。 */
	readonly query: string;
	/** 命令标记在整段文本里的长度，包含斜杠，不含后面的空白。 */
	readonly tokenLength: number;
}

/** 光标是否还在命令名范围内；是则返回查询词与要替换的标记长度。 */
export function slashContext(text: string, cursor: number): SlashContext | undefined {
	if (text.length === 0 || text[0] !== "/") return undefined;
	const position = Math.max(0, Math.min(cursor, text.length));
	if (position === 0) return undefined;

	const whitespace = text.search(/\s/);
	const tokenEnd = whitespace < 0 ? text.length : whitespace;
	// 光标已经越过空白，说明在输入参数，不再列命令
	if (position > tokenEnd) return undefined;

	return {
		query: text.slice(1, Math.min(position, tokenEnd)),
		tokenLength: tokenEnd,
	};
}

/** 过滤并排序候选；空查询按注册顺序返回全部。 */
export function matchSlashCommands(
	commands: readonly SlashCommand[],
	query: string,
): readonly SlashCommand[] {
	if (query.length === 0) return commands;

	const needle = query.toLowerCase();
	const ranked = commands
		.map((command, index) => ({ command, index, rank: matchRank(command.name.toLowerCase(), needle) }))
		.filter((entry): entry is { command: SlashCommand; index: number; rank: number } => entry.rank !== undefined);

	ranked.sort((left, right) => {
		if (left.rank !== right.rank) return left.rank - right.rank;
		if (left.command.name.length !== right.command.name.length) {
			return left.command.name.length - right.command.name.length;
		}
		return left.index - right.index;
	});
	return ranked.map((entry) => entry.command);
}

/** 0 精确、1 前缀、2 子序列；不匹配返回 undefined。 */
function matchRank(name: string, query: string): number | undefined {
	if (query.length === 0) return 0;
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;

	let index = 0;
	for (const char of query) {
		const found = name.indexOf(char, index);
		if (found < 0) return undefined;
		index = found + 1;
	}
	return 2;
}

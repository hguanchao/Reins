import { PANEL } from "#src/tui/copy.ts";
import {
	type MenuListState,
	ACCENT_COLOR,
	BOLD_OFF,
	HOVER_BG,
	MENU_MAX_VISIBLE,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	SUBTLE_COLOR,
	TEXT_COLOR,
	menuListHeight,
	menuListLines,
} from "#src/tui/panel/menu-panel.ts";
import { displayWidth, fitToWidth } from "#src/tui/render/text.ts";

/**
 * 输入框里的 `$` 技能补全。
 *
 * 只做「名字」的补全：选中后把 `$name` 写回输入框，正文仍由模型按提示词里的技能清单去读
 * SKILL.md。触发与 `@` 文件补全同一套规则，两个行内面板互斥，同一时间只开一个。
 */

/** 技能清单条目；来自 options.skills 的同一份每轮重扫来源。 */
export interface SkillMenuItem {
	readonly name: string;
	readonly description: string;
	readonly scope: "user" | "project";
}

/** 光标所在的 `$` 名字片段。 */
export interface SkillToken {
	/** `$` 的下标 */
	readonly start: number;
	/** 片段结束位置（下一个空白前） */
	readonly end: number;
	/** `$` 与光标之间的过滤词 */
	readonly query: string;
}

export interface SkillMenuState extends MenuListState {
	readonly items: readonly SkillMenuItem[];
	readonly token: SkillToken;
}

const MAX_RESULTS = 100;
const PREFIX_WIDTH = 3;
/** 徽标列的宽度：按更长的 "project" 定，user 补空格对齐。 */
const SCOPE_COLUMN = 7;
/** 名称列的封顶宽度：再长的名字截断，描述至少留出可读的几列。 */
const MAX_NAME_COLUMN = 30;
const MIN_DESCRIPTION = 8;
const EMPTY = PANEL.noMatchingSkills;

/** 面板高度与条数一致：超过一屏时只画窗口内的行。 */
export function skillMenuHeight(itemCount: number, maxVisible = MENU_MAX_VISIBLE): number {
	return menuListHeight(itemCount, { empty: EMPTY }, maxVisible);
}

/**
 * 找出光标所在的 `$` 片段。
 *
 * 与 `@` 同一条规则：只认行首或空白之后的 `$`，普通文本里的 `$PATH`、`花了$5` 不算引用。
 * 名字只允许技能名会用的字符——`$` 与光标之间出现别的字符（`$a.b`、`${x}`）就不是引用，
 * 不能只因为有个 `$` 就把面板弹出来。
 */
export function findSkillToken(text: string, cursor: number): SkillToken | undefined {
	const position = Math.min(Math.max(0, cursor), text.length);
	if (position === 0) return undefined;

	let start = position - 1;
	while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
	if (text[start] !== "$") return undefined;

	const query = text.slice(start + 1, position);
	if (!/^[A-Za-z0-9_-]*$/.test(query)) return undefined;

	let end = position;
	while (end < text.length && /[A-Za-z0-9_-]/.test(text[end] ?? "")) end += 1;
	return { start, end, query };
}

/**
 * 过滤技能清单。
 *
 * 名称前缀命中排最前，其次是名称包含，再是描述包含——描述命中让人可以用「部署」这种词
 * 找到 deploy-docs。同档保持清单原序（discoverSkills 已按名字排好）。
 */
export function filterSkills(
	skills: readonly SkillMenuItem[],
	query: string,
	limit = MAX_RESULTS,
): readonly SkillMenuItem[] {
	const needle = query.toLowerCase();
	if (needle.length === 0) return skills.slice(0, limit);

	const scored: { readonly skill: SkillMenuItem; readonly score: number }[] = [];
	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		const description = skill.description.toLowerCase();
		const score = name.startsWith(needle)
			? 0
			: name.includes(needle)
				? 1
				: description.includes(needle)
					? 2
					: -1;
		if (score >= 0) scored.push({ skill, score });
	}
	scored.sort((left, right) => left.score - right.score);
	return scored.slice(0, limit).map((entry) => entry.skill);
}

export function renderSkillMenu(
	width: number,
	state: SkillMenuState,
	maxVisible = MENU_MAX_VISIBLE,
): readonly string[] {
	// 名称列取清单里最宽的名字并封顶：所有行共享同一列宽，徽标与描述才对得齐。
	// 按整份清单算而不是可见窗口，滚动时列宽才不会跳。
	const nameColumn = Math.min(
		MAX_NAME_COLUMN,
		state.items.reduce((widest, skill) => Math.max(widest, displayWidth(skill.name)), 0),
	);
	return menuListLines(
		Math.max(0, width),
		state.items,
		state,
		() => undefined,
		(columns, skill, selected, hovered) => row(columns, nameColumn, skill, selected, hovered),
		{ empty: EMPTY },
		maxVisible,
	);
}

function row(
	columns: number,
	nameColumn: number,
	skill: SkillMenuItem,
	selected: boolean,
	hovered: boolean,
): string {
	const background = selected ? PANEL_BG : hovered ? HOVER_BG : PANEL_BG;
	const budget = Math.max(0, columns - PREFIX_WIDTH);
	// 窄屏放不下完整三列时依次让位：描述收窄、名称收窄，徽标最后消失
	const showBadge = budget >= 1 + SCOPE_COLUMN + 1 + MIN_DESCRIPTION;
	const nameWidth = Math.max(
		1,
		Math.min(nameColumn, budget - (showBadge ? SCOPE_COLUMN + 1 : 0) - 1 - MIN_DESCRIPTION),
	);
	const badgeWidth = showBadge ? Math.min(SCOPE_COLUMN, budget - nameWidth - 1) : 0;
	const name = fitToWidth(skill.name, nameWidth);
	const description = fitToWidth(skill.description, Math.max(0, budget - nameWidth - badgeWidth - 2));

	// 先按纯文本算宽度：颜色转义不能参与补齐，否则底色只铺到文字末尾
	const namePadding = " ".repeat(Math.max(0, nameWidth - displayWidth(name)));
	const scope = fitToWidth(skill.scope, badgeWidth);
	const scopePadding = " ".repeat(Math.max(0, badgeWidth - scope.length));
	const plain = `${selected ? " › " : "   "}${name}${namePadding} ${scope}${scopePadding} ${description}`;
	const padding = " ".repeat(Math.max(0, columns - displayWidth(plain)));
	const prefix = selected ? ` ${ACCENT_COLOR}›${SELECTED_TEXT_COLOR} ` : "   ";
	// 与其它面板一致：只加粗名称这一主列；徽标与描述始终弱色，选中时也不提亮
	const boldOff = selected ? BOLD_OFF : "";
	return (
		`${background}${prefix}${selected ? SELECTED_TEXT_COLOR : TEXT_COLOR}${name}${boldOff}` +
		`${namePadding} ` +
		`${selected ? MUTED_COLOR : SUBTLE_COLOR}${scope}${scopePadding} ` +
		`${SUBTLE_COLOR}${description}` +
		`${padding}${RESET}`
	);
}

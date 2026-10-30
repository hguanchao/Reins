import type { SyntaxToken } from "#src/tui/render/syntax.ts";
import { THEME } from "#src/tui/render/theme.ts";

/** 语法角色到颜色；无角色表示普通正文。 */
export function syntaxColor(token: SyntaxToken | undefined): string {
	switch (token) {
		case "keyword":
			return THEME.syntaxKeyword;
		case "string":
			return THEME.syntaxString;
		case "number":
			return THEME.syntaxNumber;
		case "comment":
			return THEME.syntaxComment;
		case "function":
			return THEME.syntaxFunction;
		case "type":
			return THEME.syntaxType;
		case "property":
			return THEME.syntaxType;
		case "operator":
			return THEME.syntaxOperator;
		default:
			return THEME.textPrimary;
	}
}

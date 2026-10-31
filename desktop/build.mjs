import { build } from "esbuild";
import { readFileSync } from "node:fs";

/**
 * 桌面打包的两段 esbuild。用 JS API 而不是命令行,只为干净地放进 banner:
 * 内核依赖里有 CJS 包(jsonc-parser 等),ESM bundle 里它们的动态 require 需要
 * createRequire 兜底,命令行写这段引号太遭罪。
 */

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

await build({
	entryPoints: ["desktop/server-main.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: "desktop/build/server.mjs",
	// 打包后按 import.meta.url 找 package.json 必然断裂,版本号在构建期注入
	define: { REINS_BUNDLED_VERSION: JSON.stringify(version) },
	banner: {
		js: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);`,
	},
	// jsonc-parser 的 main 指向 UMD 包装:require 是工厂参数,esbuild 只能留成动态调用,
	// 打包后解析不到相对路径。它的 lib/esm 是静态导入的等价实现,直接指过去。
	alias: {
		"jsonc-parser": "jsonc-parser/lib/esm/main.js",
	},
});

await build({
	entryPoints: ["desktop/main.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	external: ["electron"],
	// .cjs 后缀是刻意的:打包进去的 package.json 带 "type": "module",.js 会被当 ESM 加载
	outfile: "desktop/build/main.cjs",
});

await build({
	entryPoints: ["desktop/preload.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	external: ["electron"],
	outfile: "desktop/build/preload.cjs",
});

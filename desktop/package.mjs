import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 打包编排:electron-builder 的输出目录用时间戳,每次都是全新目录。
 *
 * 本机上新写出的 app.asar 会被系统进程(杀软/索引)长期握住,固定目录下一次打包要
 * 先删上一次的 asar,必然撞锁。时间戳目录绕开删旧这步; exe 产出后复制到 desktop/
 * 下的稳定路径,旧产物目录里超过一天的尝试性清掉,清不掉就留给重启后手删。
 */

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const out = join("desktop", "out", stamp);

if (existsSync(join("desktop", "out"))) {
	for (const name of readdirSync(join("desktop", "out"))) {
		const full = join("desktop", "out", name);
		if (Date.now() - statSync(full).mtimeMs > 24 * 3600_000) {
			rmSync(full, { recursive: true, force: true });
		}
	}
}

const result = spawnSync("npx", ["electron-builder", "--win", "--config", join("desktop", "electron-builder.json"), "-c.directories.output=" + out], {
	stdio: "inherit",
	shell: true,
});
if (result.status !== 0) process.exit(result.status ?? 1);

for (const name of readdirSync(out)) {
	if (name.endsWith(".exe")) {
		copyFileSync(join(out, name), join("desktop", name));
		console.log(`artifact: desktop/${name}`);
	}
}
console.log(`unpacked: ${join(out, "win-unpacked")}`);

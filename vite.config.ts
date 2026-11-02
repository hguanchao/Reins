import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 浏览器界面的构建配置。
 *
 * 源码在 web/,产物出到 web/dist(不入库),由 `reins serve` 托管。开发时的代理指向
 * 本地 serve,让前端热更新照常可用——正式使用不需要这一层,同端口托管即可。
 */
export default defineConfig({
	root: "web",
	plugins: [react(), tailwindcss()],
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		proxy: { "/api": { target: "http://127.0.0.1:8787" } },
	},
});

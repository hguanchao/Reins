import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 界面的构建配置。
 *
 * 源码在 web/,产物出到 web/dist(不入库),由桌面壳启动的本地服务托管。
 * 页面只在桌面窗口里加载，不再提供开发代理与外部浏览器入口。
 */
export default defineConfig({
	root: "web",
	plugins: [react(), tailwindcss()],
	build: { outDir: "dist", emptyOutDir: true },
});

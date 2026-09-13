import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// v0.7.2：跳过 emptyOutDir 避免打包时触发沙箱的批量删除守卫（dist/assets 旧 hash 残留
// 不影响运行：同名 hash 会被新构建覆盖，孤立旧文件仅占少量磁盘；下次发版前可手动清）
const skipEmpty = process.env.SKIP_EMPTY_OUTDIR === "1";

export default defineConfig(async () => ({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  build: skipEmpty ? { emptyOutDir: false } : undefined,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

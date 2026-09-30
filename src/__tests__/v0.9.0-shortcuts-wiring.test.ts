/**
 * v0.9.0 自定义快捷键：源码接线锁定（伴随新功能 + 链路改造的防回归断言）。
 *
 * 锁定点：
 * - 双击阈值 220ms（D2）；App.tsx 全局查表派发 + F11 全屏；
 * - 文件树等效关闭键 Ctrl+2 → Backspace；
 * - AppShell 命令总线折叠入口（toggleLeft/toggleRight）；
 * - PM 动态键位插件注册且静态 keymap 不再登记删除线旧键 Shift-Mod-s（D1）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 以本测试文件目录为基准读源码（不受进程 cwd 影响），p 相对 src/ */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf-8");

describe("v0.9.0 自定义快捷键：源码接线", () => {
  it("App.tsx：双击阈值取自 modeSwitch 单源常量（D2 = 220ms）", () => {
    // v0.9.0 review：阈值此前在 App.tsx 与 utils/modeSwitch.ts 各存一份（220/300 不一致），
    // 现在只保留 modeSwitch 的 DOUBLE_PRESS_THRESHOLD，App 直接导入
    expect(read("utils/modeSwitch.ts")).toContain("DOUBLE_PRESS_THRESHOLD = 220");
    const app = read("App.tsx");
    expect(app).toContain("DOUBLE_PRESS_THRESHOLD");
    expect(app).not.toContain("DOUBLE_CLICK_THRESHOLD");
    expect(app).toContain("isShortcutOverridden");
  });

  it("App.tsx：全局 keydown 查生效键位表派发", () => {
    const src = read("App.tsx");
    expect(src).toContain('matchShortcut(e, ["global", "editor"])');
    expect(src).toContain('from "./core/shortcuts"');
  });

  it("App.tsx：F11 全屏（🔒 保留键）走 Tauri 窗口 API + DOM 回退", () => {
    // v0.9.0 review：WebView2 下 DOM Fullscreen API 不会让系统窗口全屏（P8 探针结论），
    // 改为优先 Tauri setFullscreen，非 Tauri 环境回退 DOM API
    // v0.9.1 需求6：F11 改为「沉浸式全屏」——大字提示 → 显式 setFullscreen(true) + 收起四周面板，
    // 因此 App 侧入口是 setWindowFullscreen（不再是 toggle），并新增 Esc 退出分支
    expect(read("App.tsx")).toContain('"F11"');
    expect(read("App.tsx")).toContain("setWindowFullscreen");
    expect(read("App.tsx")).toContain("app-immersive");
    const app = read("App.tsx");
    expect(app).toContain("immersiveRef.current && e.key === \"Escape\"");
    const util = read("utils/windowFullscreen.ts");
    expect(util).toContain("setFullscreen");
    expect(util).toContain("requestFullscreen");
    expect(util).toContain("isFullscreen");
  });

  it("FileTree.tsx：关闭临时文件等效键为 Backspace，Ctrl+2 分支已移除", () => {
    const src = read("components/sidebar/FileTree.tsx");
    expect(src).toContain('e.key === "Backspace"');
    expect(src).not.toContain('e.ctrlKey && e.key === "2"');
  });

  it("AppShell.tsx：命令总线折叠入口已接线", () => {
    const src = read("components/layout/AppShell.tsx");
    expect(src).toContain("view.toggleLeft");
    expect(src).toContain("view.toggleRight");
  });

  it("keymap.ts：动态键位插件接管格式键，删除线旧键 Shift-Mod-s 已废弃（D1）", () => {
    const keymap = read("core/keymap.ts");
    expect(keymap).toContain("dynamicShortcutsPlugin");
    expect(keymap).not.toContain("Shift-Mod-s");
    expect(keymap).not.toContain('"Mod-b"');
  });

  it("editor.ts：动态键位插件注册在 buildKeymap 之前", () => {
    const src = read("core/editor.ts");
    expect(src).toContain("dynamicShortcutsPlugin()");
    const dynamicIdx = src.indexOf("dynamicShortcutsPlugin()");
    const buildIdx = src.indexOf("buildKeymap()");
    expect(dynamicIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(dynamicIdx);
  });
});

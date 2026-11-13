/**
 * v0.8.3 WP3 需求4（窗口状态记忆）+ WP5 需求7（滚动性能优化）
 *
 * WP3 为 Rust 侧改动，本仓测试环境无法启动 Tauri 窗口，故以"配置/源码接线锁定"
 * 的方式回归（编译验证由 `cargo check` 完成，行为由用户本机 `pnpm tauri dev` 实测）。
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cargoToml = readFileSync(resolve(__dirname, "../../src-tauri/Cargo.toml"), "utf-8");
const cargoLock = readFileSync(resolve(__dirname, "../../src-tauri/Cargo.lock"), "utf-8");
const libRs = readFileSync(resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf-8");
const capabilities = readFileSync(
  resolve(__dirname, "../../src-tauri/capabilities/default.json"),
  "utf-8",
);
const tauriConf = readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf-8");
const editorCss = readFileSync(resolve(__dirname, "../styles/editor.css"), "utf-8");
const schemaSrc = readFileSync(resolve(__dirname, "../core/schema.ts"), "utf-8");
const containerSrc = readFileSync(
  resolve(__dirname, "../components/editor/EditorContainerSource.ts.txt"),
  "utf-8",
);

describe("v0.8.3 需求4：窗口状态记忆（tauri-plugin-window-state）", () => {
  it("Cargo.toml 声明插件依赖", () => {
    expect(cargoToml).toMatch(/^tauri-plugin-window-state\s*=\s*"2"$/m);
  });

  it("Cargo.lock 已锁定 2.x 版本（离线构建可复现）", () => {
    expect(cargoLock).toMatch(/name = "tauri-plugin-window-state"\r?\nversion = "2\./);
    expect(cargoLock).toMatch(/"tauri-plugin-window-state",/);
  });

  it("lib.rs 注册插件并显式收窄 StateFlags", () => {
    expect(libRs).toContain("tauri_plugin_window_state::Builder::new()");
    expect(libRs).toContain("tauri_plugin_window_state::StateFlags::SIZE");
    expect(libRs).toContain("tauri_plugin_window_state::StateFlags::POSITION");
    expect(libRs).toContain("tauri_plugin_window_state::StateFlags::MAXIMIZED");
    // 不记忆全屏/装饰/可见性等状态，避免"偶发全屏后每次启动都全屏"
    expect(libRs).not.toContain("StateFlags::FULLSCREEN");
    expect(libRs).not.toContain("StateFlags::all()");
    expect(libRs).toContain(".with_state_flags(");
    // 插件注册在 Builder 链上且早于 invoke_handler
    const pluginIdx = libRs.indexOf("tauri_plugin_window_state::Builder");
    const handlerIdx = libRs.indexOf(".invoke_handler(");
    expect(pluginIdx).toBeGreaterThan(-1);
    expect(handlerIdx).toBeGreaterThan(pluginIdx);
  });

  it("capabilities 授予 window-state:default 权限", () => {
    expect(JSON.parse(capabilities).permissions).toContain("window-state:default");
  });

  it("tauri.conf.json 保持首次启动默认最大化（无保存状态时的兜底）", () => {
    expect(JSON.parse(tauriConf).app.windows[0].maximized).toBe(true);
  });
});

describe("v0.8.3 需求7：滚动性能优化接线", () => {
  it("不采用 content-visibility（实测在本应用下使滚动慢 4 倍，见 editor.css 结论注释）", () => {
    // 真实 Chromium 实测：1.8 万行 / 9000 顶层块文档（交替顺序、冷/热各两轮）
    //   基线                        冷滚动 avg 16.67ms（60fps）LongTask 0
    //   contain: layout style paint  冷滚动 avg 16.67ms（60fps）LongTask 0（无收益）
    //   content-visibility: auto     冷滚动 avg 70.4ms（14fps）LongTask 250 个
    const cssNoComments = editorCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssNoComments).not.toContain("content-visibility");
    expect(cssNoComments).not.toContain("contain-intrinsic-size");
    // 无收益的 contain 隔离也不引入（避免无谓复杂度）
    expect(cssNoComments).not.toMatch(/contain:\s*layout/);
    // 结论与理由必须留在源码里，避免后人盲目重加
    expect(editorCss).toContain("不采用");
    expect(editorCss).toContain("慢约 4 倍");
  });

  it("图片节点输出 loading=lazy / decoding=async（大图不阻塞合成帧）", () => {
    expect(schemaSrc).toContain('loading: "lazy"');
    expect(schemaSrc).toContain('decoding: "async"');
  });

  it("滚动监听声明 passive（阅读容器 + 源码面）", () => {
    const passiveCount = (containerSrc.match(/\{ passive: true \}/g) ?? []).length;
    expect(passiveCount).toBeGreaterThanOrEqual(2);
    expect(containerSrc).toContain('container.addEventListener("scroll", handler, { passive: true })');
    /**
     * v0.17.0 P1-4 更新：源码侧滚动监听从 `ModeSync` 里的裸
     * `textarea.addEventListener("scroll", handler, { passive: true })`
     * 改为经 `SourceSurface.onDidScroll(...)`。
     *
     * **passive 语义没有丢，反而更可靠**：
     * - textarea 实现绑真元素：`ta.addEventListener("scroll", handler, { passive: true })`
     * - CM6 实现绑真实滚动元素 `.cm-scroller`：
     *   `scroller.addEventListener("scroll", handler, { passive: true })`
     *
     * 旧写法在 CM6 下绑的是**不滚动的宿主 div**（`scrollHeight === clientHeight`），
     * 监听器永不触发 —— 这条"passive 优化"在 CM6 下等于什么都没做。
     * 因此断言改为：在**两个实现内部**校验 passive。
     */
    const textareaSurfaceSrc = readFileSync(resolve(__dirname, "../editor/surface/TextareaSourceSurface.ts"), "utf-8");
    const cm6SurfaceSrc = readFileSync(resolve(__dirname, "../editor/cm6/CmSourceSurface.ts"), "utf-8");
    expect(textareaSurfaceSrc).toContain('.addEventListener("scroll", handler, { passive: true })');
    expect(cm6SurfaceSrc).toContain('.addEventListener("scroll", handler, { passive: true })');
    // ModeSync 侧应已改为经 surface（不再自己绑裸元素）
    const modeSyncSrc = readFileSync(resolve(__dirname, "../components/editor/panes/modesync/ModeSync.tsx"), "utf-8");
    expect(modeSyncSrc).toContain("sourceSurface.onDidScroll(");
  });

  it("输入路径热点已消除：选区变化不再全文档序列化（WP2 需求3 getText 惰性）", () => {
    const editorTsSrc = readFileSync(resolve(__dirname, "../core/editor.ts"), "utf-8");
    expect(editorTsSrc).toContain("() => newState.doc.textContent");
    expect(editorTsSrc).not.toContain("const allText = newState.doc.textContent");
  });
});

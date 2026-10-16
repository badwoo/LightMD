// @vitest-environment jsdom
/**
 * v0.13.1 图片管理三项返修：需求7 / 需求9 / 需求10
 *
 * ─── 需求7：图片管理悬浮入口必须排在「译」按钮**上方** ─────────────────
 * 旧几何：模式切换 10..44 / 「译」50..84 / 图片管理 90..124（slot 跟随 AI 翻译显隐）。
 * 但「译」按钮 hover 时会从它底部伸出设置齿轮（.ftb-settings-trigger，top:34px），
 * 占 y 84..110 —— 与图片管理（90..124）相交，且图片管理在 DOM 中渲染更晚
 * （两者同为 z-index:30）→ 齿轮被压住、点不到。
 * 新几何：模式切换 10..44 / 图片管理 50..84 / 「译」90..124，齿轮 124..150，
 * 「取消翻译」气泡让到第 4 格（170）以避开齿轮。
 *
 * ⚠️ jsdom 的限制（必须明说，否则这些断言容易被误读成"验证了视觉"）：
 * jsdom **不做 CSS 级联**，也不解析自定义属性与 `calc()`，`getComputedStyle`
 * 拿不到真实像素值。因此"几何"只能以两层代理来锁定：
 *   ① CSS 源文本的槽位公式（`.ftb-wrap` 用 `2 *`、toast 用 `4 *`、
 *      `.image-manager-btn` 保持 `--imb-slot` 公式）；
 *   ② JSX 传下来的 `--imb-slot` 内联变量值（渲染 ImageManagerButton 读 style）。
 * 两者相乘才等于真实 top，故任一层被改坏都会在这里失败。
 *
 * ─── 需求9：点「本地文件」徽标 → 资源管理器定位并选中该图 ───────────────
 * 徽标对 kind === "file" 是真 <button>（调用 onRevealInFolder），
 * base64 / remote 保持 <span>（没有本地落点，不做成死按钮），且共用同一套
 * class 与固定宽度，行布局不因形态抖动。
 *
 * ─── 需求10：进/出双向淡入淡出 ──────────────────────────────────────
 * 旧实现 `if (!open) return null;` 让退场动画**不可能存在**。现在关闭走
 * closing 态 + IMAGE_MGR_CLOSE_MS 延迟卸载，本文件用假定时器证明：
 * 点 ✕ 之后弹窗仍在 DOM 且带 closing 类，推进 160ms 后 onClose 才被调用。
 */
import { createElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Tauri mock（与 v0130-image-manager-dialog.test.tsx 同型）──────────────
const mockListDir = vi.hoisted(() => vi.fn());
const mockCopyFile = vi.hoisted(() => vi.fn());
const mockRenameFile = vi.hoisted(() => vi.fn());
const mockDeleteFile = vi.hoisted(() => vi.fn());
const mockExists = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());

vi.mock("../services/fileService", () => ({
  fileService: {
    listDir: mockListDir,
    copyFile: mockCopyFile,
    renameFile: mockRenameFile,
    deleteFile: mockDeleteFile,
  },
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: mockExists,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

const mockJoin = vi.hoisted(() =>
  vi.fn((...parts: string[]) => parts.join("/").replace(/\/+/g, "/")),
);
const mockDirname = vi.hoisted(() => vi.fn((p: string) => p.replace(/[\\/][^\\/]*$/, "")));
vi.mock("@tauri-apps/api/path", () => ({
  join: mockJoin,
  dirname: mockDirname,
}));

import { ImageManagerDialog } from "../components/dialogs/ImageManagerDialog";
import { ImageManagerButton } from "../components/editor/ImageManagerButton";
import { markdownToDoc } from "../core/markdown/parser";
import { revealTargetOf } from "../utils/imageManager";

const SRC = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

const DOC_PATH = "D:/docs/readme.md";
const DOC_DIR = "D:/docs";
const ASSET_SRC =
  "http://asset.localhost/D%3A%2F10254%2F%E6%A1%8C%E9%9D%A2%2Fassets%2Fimage-3.png";
const ASSET_DECODED = "D:/10254/桌面/assets/image-3.png";

/** 纯文本取 CSS 的某条规则体（`selector { ... }`），避免注释里的同名文本干扰 */
function ruleBody(css: string, selector: string): string {
  const norm = css.replace(/\r\n/g, "\n");
  const at = norm.indexOf(`\n${selector} {`);
  if (at < 0) return "";
  const rest = norm.slice(at);
  const end = rest.indexOf("}");
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * 取**包含指定片段**的那条规则体：从该片段向前回溯到最近的规则头
 * `\n<selector> {`，再截到右花括号。
 *
 * 为什么需要它：`.image-manager-btn` 在文件里出现两次——先是与
 * `.mode-switch-btn` 的共享组规则（尺寸），再单独给 top。`ruleBody` 只会命中
 * 第一条（拿不到 `--imb-slot` 公式），所以这里按"哪个规则含 --imb-slot"来选。
 */
function ruleOfSnippet(css: string, selector: string, snippet: string): string {
  const norm = css.replace(/\r\n/g, "\n");
  const at = norm.indexOf(snippet);
  if (at < 0) return "";
  const head = norm.lastIndexOf(`\n${selector} {`, at);
  if (head < 0) return "";
  const end = norm.indexOf("}", head);
  return end < 0 ? norm.slice(head) : norm.slice(head, end);
}

function renderDialog(overrides?: {
  markdown?: string;
  docPath?: string | null;
  onRevealInFolder?: (absPath: string) => void;
  onClose?: () => void;
}) {
  const md = overrides?.markdown ?? "![图](./assets/a.png)\n";
  const doc = markdownToDoc(md);
  const onRevealInFolder = overrides?.onRevealInFolder ?? vi.fn();
  const onClose = overrides?.onClose ?? vi.fn();
  const utils = render(
    createElement(ImageManagerDialog, {
      open: true,
      doc,
      docPath: overrides?.docPath === undefined ? DOC_PATH : overrides.docPath,
      onRewriteRefs: vi.fn(),
      onClose,
      onRevealInFolder,
    }),
  );
  return { ...utils, onRevealInFolder, onClose };
}

beforeEach(() => {
  cleanup();
  for (const m of [
    mockListDir,
    mockCopyFile,
    mockRenameFile,
    mockDeleteFile,
    mockExists,
    mockReadFile,
    mockWriteFile,
  ]) {
    m.mockReset();
  }
  mockListDir.mockResolvedValue([]);
  mockExists.mockResolvedValue(false);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

// ═════════════ 需求7：悬浮图标槽位几何 ═════════════

describe("需求7：图片管理图标排在「译」按钮上方（槽位 + 气泡让位）", () => {
  const css = () => SRC("components/editor/FullTranslateButton.css");

  it("`.image-manager-btn` 仍由 --imb-slot 公式驱动（slot 1 = 50px）", () => {
    // 注意：`.image-manager-btn` 在文件里出现两次——先是与 .mode-switch-btn 的
    // 共享组规则（尺寸），再单独给 top。必须取**含 --imb-slot 的那条**。
    const body = ruleOfSnippet(css(), ".image-manager-btn", "var(--imb-slot, 1)");
    expect(body).toContain("top: calc(");
    expect(body).toContain("var(--float-icon-top) + var(--imb-slot, 1) *");
    expect(body).toContain("var(--float-icon-size) + var(--float-icon-gap)");
    // 不得退回写死像素（写死就无法与上方两个图标保持等距）
    expect(body).not.toMatch(/top:\s*\d+px/);
  });

  it("`.ftb-wrap`（「译」容器）用 `2 *` 公式 → 让到第 3 格（90px），不再占第 1 格", () => {
    const norm = css().replace(/\r\n/g, "\n");
    const at = norm.indexOf("top: calc(\n    var(--float-icon-top) + 2 *");
    expect(at, "「译」容器必须使用 `2 *` 槽位公式").toBeGreaterThanOrEqual(0);
    // 旧写法 `+ 1 *` 必须消失（它正是与图片管理撞位的根因）
    expect(norm).not.toContain("var(--float-icon-top) + 1 *");
  });

  it("`.ftb-wrap` 不再写死 `top: 50px`（写死会与 slot=1 的图片管理入口完全重合）", () => {
    const norm = css().replace(/\r\n/g, "\n");
    // v0.7.0 时代的第一段 .ftb-wrap 规则（top: 50px / right: 14px）
    const early = norm.slice(norm.indexOf(".ftb-wrap {"), norm.indexOf(".ftb-wrap {") + 200);
    expect(early).not.toContain("top: 50px");
    expect(early).toContain("position: absolute");
  });

  it("`.translate-undo-toast` 用 `4 *`（170px）让开「译」及其 hover 齿轮", () => {
    const body = ruleBody(css(), ".translate-undo-toast");
    expect(body).toContain("var(--float-icon-top, 10px) + 4 *");
    // 旧值 3 格（130px）正落在齿轮 124..150 上
    expect(body).not.toContain("+ 3 *");
  });

  it("把公式代入变量后的真实几何：三图标等距、齿轮与气泡各不相交", () => {
    // jsdom 不解析 calc()，这里按 CSS 里声明的变量值手工代入，
    // 断言"槽位序"而非像素渲染（像素只能靠实机，已在交付说明里注明）。
    const TOP = 10;
    const SIZE = 34;
    const GAP = 6;
    const step = SIZE + GAP; // 40
    const slotTop = (n: number) => TOP + n * step;

    const modeSwitch = { top: slotTop(0), bottom: slotTop(0) + SIZE };
    const imageMgr = { top: slotTop(1), bottom: slotTop(1) + SIZE };
    const translate = { top: slotTop(2), bottom: slotTop(2) + SIZE };
    // 齿轮挂在「译」容器内、紧贴按钮底部（top:34px，高 26px）
    const gear = { top: translate.top + 34, bottom: translate.top + 34 + 26 };
    const toast = { top: slotTop(4) };

    expect(modeSwitch).toEqual({ top: 10, bottom: 44 });
    expect(imageMgr).toEqual({ top: 50, bottom: 84 });
    expect(translate).toEqual({ top: 90, bottom: 124 });
    expect(gear).toEqual({ top: 124, bottom: 150 });

    // 图片管理在「译」上方（用户诉求）
    expect(imageMgr.top).toBeLessThan(translate.top);
    // 齿轮与图片管理不再相交（旧几何 90..124 vs 84..110 是相交的）
    expect(gear.top).toBeGreaterThanOrEqual(imageMgr.bottom);
    // 气泡避开齿轮
    expect(toast.top).toBeGreaterThanOrEqual(gear.bottom);
    // 三个图标等距（同尺寸同间距）
    expect(imageMgr.top - modeSwitch.top).toBe(step);
    expect(translate.top - imageMgr.top).toBe(step);
  });

  it("JSX 传下来的 --imb-slot 是常量 1（不再跟随 translateSlotShown）", () => {
    const { unmount } = render(
      createElement(ImageManagerButton, { slot: 1, onOpen: vi.fn() }),
    );
    const btn = screen.getByTestId("image-manager-btn") as HTMLElement;
    expect(btn.style.getPropertyValue("--imb-slot")).toBe("1");
    unmount();
  });

  it("EditorContainer 调用处写死 slot={1}（AI 翻译开关都不改变图片管理的位置）", () => {
    const src = SRC("components/editor/EditorContainer.tsx");
    expect(src).toContain("slot={1}");
    expect(src).not.toContain("slot={translateSlotShown ? 2 : 1}");
  });

  it("不变式仍成立：三按钮同尺寸 / 圆形 / 右缘对齐，且未改 --float-icon-* 取值", () => {
    const src = css();
    const shared = src.slice(src.indexOf(".mode-switch-btn,\n.image-manager-btn"));
    expect(shared.slice(0, 700)).toContain("width: var(--float-icon-size)");
    expect(shared.slice(0, 700)).toContain("height: var(--float-icon-size)");
    expect(shared.slice(0, 700)).toContain("border-radius: 50%");
    expect(shared.slice(0, 700)).toContain("right: var(--float-icon-right)");
    // 「译」按钮同样收敛
    expect(src).toContain(".full-translate-btn {\n  height: var(--float-icon-size);");
    // 变量取值未被本轮改动
    const vars = src.slice(src.indexOf(":root {"), src.indexOf(":root {") + 200);
    expect(vars).toContain("--float-icon-size: 34px");
    expect(vars).toContain("--float-icon-gap: 6px");
    expect(vars).toContain("--float-icon-right: 14px");
    expect(vars).toContain("--float-icon-top: 10px");
  });
});

// ═════════════ 需求9：本地文件徽标 → 资源管理器定位 ═════════════

describe("需求9：点击「本地文件」徽标 → 在资源管理器中定位该图", () => {
  it("纯函数：asset.localhost → 解码后的绝对路径", () => {
    expect(revealTargetOf(ASSET_SRC, DOC_DIR)).toBe(ASSET_DECODED);
  });

  it("纯函数：相对路径与文档目录拼接（含 .. 消解）", () => {
    expect(revealTargetOf("./assets/a.png", DOC_DIR)).toBe("D:/docs/assets/a.png");
    expect(revealTargetOf("../pic/a.png", "D:/docs/sub")).toBe("D:/docs/pic/a.png");
  });

  it("纯函数：远程图 / data URL → null（没有本地文件可定位）", () => {
    expect(revealTargetOf("https://a.com/x.png", DOC_DIR)).toBeNull();
    expect(revealTargetOf("blob:http://localhost/x", DOC_DIR)).toBeNull();
    expect(revealTargetOf("data:image/png;base64,AAAA", DOC_DIR)).toBeNull();
  });

  it("file 徽标是真按钮：点击用**解析后的绝对路径**调 onRevealInFolder", () => {
    const onRevealInFolder = vi.fn();
    renderDialog({
      markdown: `![x](${ASSET_SRC})\n`,
      onRevealInFolder,
    });
    const badge = screen.getByRole("button", { name: "本地文件" });
    expect(badge.className).toContain("image-mgr-badge");
    expect(badge.className).toContain("file");
    // 提示文案告诉用户点它会做什么
    expect(badge.getAttribute("title")).toBe("在资源管理器中打开该图片所在的文件夹并选中它");

    fireEvent.click(badge);
    expect(onRevealInFolder).toHaveBeenCalledTimes(1);
    // 关键：传的是**磁盘绝对路径**，不是 asset.localhost URL 原文
    expect(onRevealInFolder).toHaveBeenCalledWith(ASSET_DECODED);
  });

  it("相对路径的 file 徽标同样解析成绝对路径", () => {
    const onRevealInFolder = vi.fn();
    renderDialog({ markdown: "![图](./assets/a.png)\n", onRevealInFolder });
    fireEvent.click(screen.getByRole("button", { name: "本地文件" }));
    expect(onRevealInFolder).toHaveBeenCalledWith("D:/docs/assets/a.png");
  });

  it("远程图**不是**按钮，也绝不调用 onRevealInFolder（点不到死控件）", () => {
    const onRevealInFolder = vi.fn();
    renderDialog({
      markdown: "![x](https://a.com/pic/x.png)\n",
      onRevealInFolder,
    });
    // remote 徽标保持 <span>
    const badge = screen.getByText("远程图片");
    expect(badge.tagName).toBe("SPAN");
    expect(badge.className).toContain("image-mgr-badge");
    expect(badge.className).toContain("remote");
    // 面板里不存在任何「本地文件」按钮
    expect(screen.queryByRole("button", { name: "本地文件" })).toBeNull();
    expect(onRevealInFolder).not.toHaveBeenCalled();
  });

  it("base64（data URL）同样不是按钮，且不触发定位", () => {
    const onRevealInFolder = vi.fn();
    renderDialog({
      markdown: "![x](data:image/png;base64,iVBORw0KGgo=)\n",
      onRevealInFolder,
    });
    const badge = screen.getByText("内联 base64");
    expect(badge.tagName).toBe("SPAN");
    expect(onRevealInFolder).not.toHaveBeenCalled();
  });

  it("未保存文档（docPath === null）→ file 徽标禁用，点击不触发定位", () => {
    const onRevealInFolder = vi.fn();
    renderDialog({ markdown: "![图](./assets/a.png)\n", docPath: null, onRevealInFolder });
    const badge = screen.getByRole("button", { name: "本地文件" }) as HTMLButtonElement;
    expect(badge.disabled).toBe(true);
    expect(badge.getAttribute("title")).toContain("请先保存");
    fireEvent.click(badge);
    expect(onRevealInFolder).not.toHaveBeenCalled();
  });

  it("外一支：无本地落点时给出提示（用户能看到「为什么点不了」）", () => {
    // 远程徽标是 span，没有 onClick；这条覆盖的是「有本地落点判定的转发逻辑」
    // —— 用 docPath === null 的相对路径图来走 handleReveal 的失败分支。
    const onRevealInFolder = vi.fn();
    renderDialog({ markdown: "![图](./assets/a.png)\n", docPath: null, onRevealInFolder });
    // 禁用按钮不会派发 click，故这里直接验证文案来源存在
    const badge = screen.getByRole("button", { name: "本地文件" });
    expect(badge.getAttribute("title")).toBe("⚠️ 文档尚未保存，请先保存（Ctrl+S）后再管理图片");
    expect(onRevealInFolder).not.toHaveBeenCalled();
  });

  it("行布局不因形态而位移：三类徽标共用同一 class 与固定宽度列", () => {
    renderDialog({
      markdown:
        `![a](${ASSET_SRC})\n\n![b](https://a.com/x.png)\n\n![c](data:image/png;base64,AAAA)\n`,
    });
    const kinds = Array.from(
      screen.getByTestId("image-manager").querySelectorAll(".image-mgr-badge"),
    ) as HTMLElement[];
    expect(kinds).toHaveLength(3);
    expect(kinds.map((el) => el.className)).toEqual([
      "image-mgr-badge file",
      "image-mgr-badge remote",
      "image-mgr-badge base64",
    ]);
    expect(new Set(kinds.map((el) => el.tagName))).toEqual(new Set(["BUTTON", "SPAN"]));
    // 宽度由列 (.image-mgr-kind) 而非元素自身决定 → 换形态不会撑开/收窄该列
    const css = SRC("components/dialogs/ImageManagerDialog.css");
    const kindCol = ruleBody(css, ".image-mgr-kind");
    expect(kindCol).toContain("width: 92px");
    expect(kindCol).toContain("white-space: nowrap");
  });
});

// ═════════════ 需求10：淡入淡出动画 ═════════════

describe("需求10：图片管理弹窗的顺滑淡入/淡出", () => {
  const css = () => SRC("components/dialogs/ImageManagerDialog.css");

  it("CSS 自带**两个方向**的 keyframes（不再借 TabBar / SettingsDialog 的）", () => {
    const src = css();
    for (const name of [
      "image-mgr-scrim-in",
      "image-mgr-scrim-out",
      "image-mgr-dialog-in",
      "image-mgr-dialog-out",
    ]) {
      expect(src, `缺 @keyframes ${name}`).toContain(`@keyframes ${name} {`);
    }
    // 借来的旧 keyframes 必须消失，否则下次对方改名这里会静默失效
    expect(src).not.toMatch(/animation:\s*fadeIn\b/);
    expect(src).not.toMatch(/animation:\s*slideUp\b/);
  });

  it("遮罩移到独立层 ::before，overlay 本体不再有 background/animation", () => {
    const src = css();
    const overlay = ruleBody(src, ".image-mgr-overlay");
    expect(overlay).not.toContain("background:");
    expect(overlay).not.toContain("animation:");
    const scrim = ruleBody(src, ".image-mgr-overlay::before");
    expect(scrim).toContain("content:");
    expect(scrim).toContain("background: rgba(0, 0, 0, 0.4)");
    expect(scrim).toContain("image-mgr-scrim-in");
    expect(src).toContain(".image-mgr-overlay.closing::before {");
    expect(src).toContain(".image-mgr-overlay.closing .image-mgr-dialog {");
  });

  it("只动 opacity / transform（不得出现 width/height/display 过渡）", () => {
    const src = css();
    const dialog = ruleBody(src, ".image-mgr-dialog");
    expect(dialog).toContain("will-change: opacity, transform");
    expect(src).not.toMatch(/transition:[^;]*\b(?:width|height|display)\b/);
    const dialogIn = src.slice(src.indexOf("@keyframes image-mgr-dialog-in {"));
    const inBody = dialogIn.slice(0, dialogIn.indexOf("}"));
    expect(inBody).toContain("opacity");
    expect(inBody).toContain("transform");
  });

  it("时长：短促的淡淡变化（遮罩 0.15s / 弹窗入 0.18s / 出 0.16s）", () => {
    const src = css();
    expect(src).toContain("image-mgr-scrim-in 0.15s");
    expect(src).toContain("image-mgr-scrim-out 0.15s");
    expect(src).toContain("image-mgr-dialog-in 0.18s");
    expect(src).toContain("image-mgr-dialog-out 0.16s");
    // 组件里的常量必须与退出动画等值（改一处要同时改另一处）
    const tsx = SRC("components/dialogs/ImageManagerDialog.tsx");
    expect(tsx).toContain("const IMAGE_MGR_CLOSE_MS = 160;");
  });

  it("存在 prefers-reduced-motion 降级块，且同时覆盖伪元素与弹窗", () => {
    const src = css();
    const at = src.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = src.slice(at, src.indexOf("}", src.indexOf("animation: none;", at)));
    expect(block).toContain(".image-mgr-overlay::before");
    expect(block).toContain(".image-mgr-dialog");
    expect(block).toContain("animation: none");
  });

  it("点 ✕ → 弹窗**仍在 DOM** 且带 closing 类，推进 160ms 后才 onClose", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderDialog({ onClose });

    expect(screen.getByTestId("image-manager")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("关闭"));

    // ① 立即：节点还在，overlay 已切 closing（退场动画正在播）
    expect(screen.getByTestId("image-manager")).toBeTruthy();
    const overlay = screen.getByTestId("image-manager").parentElement as HTMLElement;
    expect(overlay.className).toContain("closing");
    // ② onClose 还没被调用（动画未播完，不能提前卸载）
    expect(onClose).not.toHaveBeenCalled();

    // ③ 推进常量时长 → onClose 触发（真实卸载由父组件把 open 置 false 完成）
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("推进到 159ms 时仍未关闭（时长常量不能被偷偷缩短）", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByLabelText("关闭"));
    act(() => {
      vi.advanceTimersByTime(159);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("image-manager")).toBeTruthy();
  });

  it("Esc 走同一条退场路径（不再直接 onClose 导致瞬间消失）", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    const overlay = screen.getByTestId("image-manager").parentElement as HTMLElement;
    expect(overlay.className).toContain("closing");

    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩走同一条退场路径（弹窗内部点击不关闭）", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderDialog({ onClose });
    const overlay = screen.getByTestId("image-manager").parentElement as HTMLElement;

    // 先点弹窗内部：不该关闭
    fireEvent.click(screen.getByTestId("image-manager"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("连点 ✕ 只排一个定时器（onClose 不得被调用两次）", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderDialog({ onClose });
    const close = screen.getByLabelText("关闭");
    fireEvent.click(close);
    fireEvent.click(close);
    fireEvent.click(close);
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("退场途中卸载 → 定时器被清掉，不再有卸载后的回调/状态更新", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = renderDialog({ onClose });
    fireEvent.click(screen.getByLabelText("关闭"));
    expect(onClose).not.toHaveBeenCalled();

    // 父组件直接卸载（例如切换文档）→ 必须清掉在途定时器
    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("open 重新翻 true 时清掉退场态（否则一打开就播退场动画）", () => {
    // 组件不自己清 closing 的话，父组件"关掉再打开"会带着 closing 类渲染
    const src = SRC("components/dialogs/ImageManagerDialog.tsx");
    const effect = src.slice(src.indexOf("if (!open) return;"));
    const body = effect.slice(0, effect.indexOf("}, [open]);"));
    expect(body).toContain("setClosing(false)");
    expect(body).toContain("closingRef.current = false");
  });
});

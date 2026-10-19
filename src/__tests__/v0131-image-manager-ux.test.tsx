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
 * ─── 需求10 / v0.13.2 返修：关闭动效 + 窗口拖拽 ─────────────────────
 * v0.13.2 返修前：面板自己延迟 260ms 再 onClose，同时保留 `if (!open) return null;`
 * → 父组件把 open 置 false 后子组件先返回 null，壳的退场动画没有 DOM 可播，
 * 视觉上"窗口瞬间消失"。现在关闭**立即**上抛，面板在 open=false 期间保持渲染，
 * 由 GenieDialogShell 播完 300ms `image-mgr-genie-out` 再统一卸载。
 * 同时标题栏支持拖拽（left/top 位移，避开 transform 的动画占用），
 * 并把位移限制在视口内。
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

  it("`.ftb-wrap`（「译」容器）用**动态槽位** `--ftb-slot`（需求4 起不再写死 `2 *`）", () => {
    const norm = css().replace(/\r\n/g, "\n");
    // v0.13.2 需求4：图片管理图标缺席时「译」要补位，故槽位由 JSX 注入的
    // `--ftb-slot` 决定（有图片 = 1，无图片 = 0），不再是写死的 `2 *`。
    expect(norm).toContain("var(--ftb-slot, 1)");
    // 旧写法 `+ 1 *` / `+ 2 *` 必须消失（写死就无法补位）
    expect(norm).not.toContain("var(--float-icon-top) + 1 *");
    expect(norm).not.toContain("var(--float-icon-top) + 2 *");
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

  it("把公式代入变量后的真实几何：两图标等距、齿轮与气泡各不相交", () => {
    // jsdom 不解析 calc()，这里按 CSS 里声明的变量值手工代入，
    // 断言"槽位序"而非像素渲染（像素只能靠实机，已在交付说明里注明）。
    // v0.13.2 需求4（返修后口径）：图片管理可见时「译」在 slot=2（与图片管理等距），
    // 图片管理不可见时「译」补位到 slot=1（紧跟模式切换）；slot=0 永远属于模式切换。
    const TOP = 10;
    const SIZE = 34;
    const GAP = 6;
    const step = SIZE + GAP; // 40
    const slotTop = (n: number) => TOP + n * step;

    const modeSwitch = { top: slotTop(0), bottom: slotTop(0) + SIZE };
    const imageMgr = { top: slotTop(1), bottom: slotTop(1) + SIZE };
    // 有图片：图片管理占第 1 格 → 「译」在第 2 格
    const translateWithImg = { top: slotTop(2), bottom: slotTop(2) + SIZE };
    // 无图片：图片管理淡出，「译」补上第 1 格（用户要求"紧跟在模式切换下面"）
    const translateNoImg = { top: slotTop(1), bottom: slotTop(1) + SIZE };
    const gear = { top: translateWithImg.top + 34, bottom: translateWithImg.top + 34 + 26 };
    const toast = { top: slotTop(4) };

    expect(modeSwitch).toEqual({ top: 10, bottom: 44 });
    expect(imageMgr).toEqual({ top: 50, bottom: 84 });
    expect(translateWithImg).toEqual({ top: 90, bottom: 124 });
    expect(translateNoImg).toEqual({ top: 50, bottom: 84 });
    expect(gear).toEqual({ top: 124, bottom: 150 });

    // 有图片时：图片管理在「译」上方（用户诉求）
    expect(imageMgr.top).toBeLessThan(translateWithImg.top);
    // 无图片时：「译」恰好落在图片管理原本的位置（补位，不留空缺）
    expect(translateNoImg.top).toBe(imageMgr.top);
    // 齿轮与图片管理不再相交（旧几何 90..124 vs 84..110 是相交的）
    expect(gear.top).toBeGreaterThanOrEqual(imageMgr.bottom);
    // 气泡避开齿轮
    expect(toast.top).toBeGreaterThanOrEqual(gear.bottom);
    // 槽位等距（同尺寸同间距）
    expect(imageMgr.top - modeSwitch.top).toBe(step);
    expect(translateWithImg.top - imageMgr.top).toBe(step);
    expect(translateNoImg.top - modeSwitch.top).toBe(step);
  });

  it("图片管理图标带自绘浮动提示（data-tip + CSS ::after，不依赖原生 title）", () => {
    const { container, unmount } = render(
      createElement(ImageManagerButton, { slot: 1, onOpen: vi.fn() }),
    );
    const btn = container.querySelector('[data-testid="image-manager-btn"]') as HTMLElement;
    expect(btn.getAttribute("data-tip")).toBeTruthy();
    // 原生 title 有延迟且会与自绘提示重复 → 不再设置
    expect(btn.getAttribute("title")).toBeNull();
    const css = SRC("components/editor/FullTranslateButton.css");
    expect(css).toContain("content: attr(data-tip)");
    expect(css).toMatch(/\.image-manager-btn:hover::after[\s\S]{0,80}?opacity:\s*1/);
    unmount();
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

// ═════════════ 需求6（v0.13.2）：从按钮跑出来 / 跑回去 ═════════════

describe("需求6：图片管理弹窗改为「底部栏搜索框同款」动画", () => {
  const css = () => SRC("components/dialogs/ImageManagerDialog.css");

  it("CSS 自带双向 genie keyframes（已彻底去掉遮罩层）", () => {
    const src = css();
    for (const name of ["image-mgr-genie-in", "image-mgr-genie-out"]) {
      expect(src, `缺 @keyframes ${name}`).toContain(`@keyframes ${name} {`);
    }
    // v0.13.2 返修：参考搜索框 —— 不要背景变暗，遮罩整层删除
    expect(src).not.toContain("@keyframes image-mgr-scrim-in");
    expect(src).not.toContain("@keyframes image-mgr-scrim-out");
    expect(src).not.toContain(".image-mgr-overlay::before");
    // 借来的旧 keyframes 必须消失，否则下次对方改名这里会静默失效
    expect(src).not.toMatch(/animation:\s*fadeIn\b/);
    expect(src).not.toMatch(/animation:\s*slideUp\b/);
  });

  it("位移恒 0，只用 transform-origin 指向按钮（避免位移+原点重复计算飞出视口）", () => {
    const src = css();
    // v0.13.2 返修：位移与缩放原点重复计算会让起点落到视口外右侧
    expect(src).toContain("transform-origin: var(--genie-origin-x, 50%) var(--genie-origin-y, 0%)");
    const inKeyframes = src.slice(src.indexOf("@keyframes image-mgr-genie-in {"));
    expect(inKeyframes.slice(0, 200)).not.toContain("var(--genie-from-x");
    expect(inKeyframes.slice(0, 200)).not.toContain("var(--genie-from-y");
  });

  it("overlay 完全透明（不变暗背景），且不再有 ::before 遮罩", () => {
    const src = css();
    const overlay = ruleBody(src, ".image-mgr-overlay");
    expect(overlay).not.toContain("animation:");
    // 没有半透明黑底（搜索框弹窗也没有遮罩）
    expect(overlay).not.toMatch(/background:\s*rgba\(0,\s*0,\s*0/);
    expect(src).not.toContain("rgba(0, 0, 0, 0.4)");
    // 退场仍走壳的 image-mgr-genie-out 类（只动画弹窗本体）
    expect(src).toContain(".image-mgr-genie-out .image-mgr-dialog {");
  });

  it("弹窗本体只动 transform（不做 opacity，避免背景透出闪动）", () => {
    const src = css();
    const dialog = ruleBody(src, ".image-mgr-dialog");
    expect(dialog).toContain("will-change: transform");
    // 只匹配可执行声明（注释里允许解释"为何不再声明"）
    expect(dialog).not.toMatch(/^\s*will-change:\s*opacity/m);
    expect(src).not.toMatch(/transition:[^;]*\b(?:width|height|display)\b/);
    for (const name of ["image-mgr-genie-in", "image-mgr-genie-out"]) {
      const start = src.indexOf(`@keyframes ${name} {`);
      const body = src.slice(start, src.indexOf("\n}", start));
      expect(body, `${name} 不得含 opacity`).not.toContain("opacity");
      expect(body).toContain("transform");
    }
  });

  it("时长与搜索框同族：入场 0.48s / 退场 0.38s；壳的延迟卸载覆盖退场", () => {
    const src = css();
    expect(src).toContain("image-mgr-genie-in 0.48s");
    expect(src).toContain("image-mgr-genie-out 0.38s");
    // 面板不自己延迟关闭；延迟卸载只由壳负责，且常量必须覆盖 380ms 动画
    const tsx = SRC("components/dialogs/ImageManagerDialog.tsx");
    expect(tsx).not.toContain("IMAGE_MGR_CLOSE_MS");
    const shell = SRC("components/dialogs/GenieDialogShell.tsx");
    expect(shell).toContain("IMAGE_MGR_GENIE_OUT_MS = 440");
  });

  it("存在 prefers-reduced-motion 降级块，覆盖弹窗本体", () => {
    const src = css();
    const at = src.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = src.slice(at, src.indexOf("}", src.indexOf("animation: none;", at)));
    expect(block).toContain(".image-mgr-genie-in .image-mgr-dialog");
    expect(block).toContain(".image-mgr-genie-out .image-mgr-dialog");
    expect(block).toContain("animation: none");
  });

  it("点 ✕ → 立即把关闭意图交给父组件（退场动画由 GenieDialogShell 统一播放）", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    expect(screen.getByTestId("image-manager")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("关闭"));

    // v0.13.2 返修：不再自己等 260ms（那段时间画面静止，随后 open=false 让子组件
    // 直接返回 null，壳的退场动画根本没有 DOM 可播）。现在关闭意图立即上抛，
    // 面板保持渲染，壳负责 300ms 退场动画结束后再卸载。
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("image-manager")).toBeTruthy();
  });

  it("Esc 同样立即触发关闭意图（退场由壳负责）", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩触发关闭；弹窗内部点击不关闭", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const overlay = screen.getByTestId("image-manager").parentElement as HTMLElement;

    fireEvent.click(screen.getByTestId("image-manager"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("连点 ✕ 只回调一次（closeRequestedRef 去重；重开时复位）", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const close = screen.getByLabelText("关闭");
    fireEvent.click(close);
    fireEvent.click(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("open 重新翻 true 时复位拖拽位移与关闭去重标记", () => {
    const src = SRC("components/dialogs/ImageManagerDialog.tsx");
    const effect = src.slice(src.indexOf("if (!open) return;"));
    const body = effect.slice(0, effect.indexOf("}, [open]);"));
    expect(body).toContain("setDragOffset({ x: 0, y: 0 })");
    expect(body).toContain("closeRequestedRef.current = false");
  });

  /**
   * v0.13.2 返修（用户复测）：窗口支持拖拽。
   * jsdom 没有真实布局（rect 全 0），但拖拽逻辑只依赖 clientX/clientY 与
   * window.innerWidth/Height，因此可以断言 inline left/top 的真实变化。
   */
  it("拖拽标题栏 → 面板 left/top 跟随鼠标位移", () => {
    renderDialog();
    const dialog = screen.getByTestId("image-manager") as HTMLElement;
    const header = screen.getByTestId("image-manager-drag-handle");

    fireEvent.mouseDown(header, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 140 });
    fireEvent.mouseUp(window);

    expect(dialog.style.left).toBe("60px");
    expect(dialog.style.top).toBe("40px");
  });

  it("点标题栏里的关闭按钮不会启动拖拽", () => {
    renderDialog();
    const dialog = screen.getByTestId("image-manager") as HTMLElement;
    fireEvent.mouseDown(screen.getByLabelText("关闭"), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(window);
    expect(dialog.style.left).toBe("0px");
    expect(dialog.style.top).toBe("0px");
  });

  it("拖拽位移被限制在视口内（标题栏不会被拖出屏幕）", () => {
    renderDialog();
    const dialog = screen.getByTestId("image-manager") as HTMLElement;
    const header = screen.getByTestId("image-manager-drag-handle");
    // jsdom rect 全 0、视口 1024x768 → 最远可到 8 / 760 附近，不应出现负得离谱的值
    fireEvent.mouseDown(header, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: -100000, clientY: -100000 });
    fireEvent.mouseUp(window);
    expect(parseFloat(dialog.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(8);
  });

  /**
   * v0.13.2 返修（需求6）：关闭图片管理弹窗报 React error #300
   * （Rendered fewer hooks than expected）。
   *
   * 根因：`if (!open) return null;` 之后还有一个 useMemo。关闭时 App 把 open 置 false，
   * 但 GenieDialogShell 仍挂 300ms 播退场 —— 期间组件照常渲染 → 早退跳过 useMemo →
   * Hook 数量比上一次少 → React 抛 #300。这里用真实 React 渲染模拟"打开 → 关闭 →
   * 再打开"，断言不再抛错（Hook 顺序错误的修复不可能靠源码字面量锁住）。
   */
  it("open true→false→true 不抛 React #300（Hook 数量必须稳定）", () => {
    const doc = markdownToDoc("![图](./assets/a.png)\n");
    const baseProps = {
      doc,
      docPath: DOC_PATH,
      onRewriteRefs: vi.fn(),
      onClose: vi.fn(),
    };
    const { container, rerender, unmount } = render(
      createElement(ImageManagerDialog, { ...baseProps, open: true }),
    );
    expect(container.querySelector(".image-mgr-dialog")).not.toBeNull();

    // 关闭：壳还在挂载期 → 组件仍被渲染（这正是崩溃现场）
    expect(() =>
      rerender(createElement(ImageManagerDialog, { ...baseProps, open: false })),
    ).not.toThrow();
    // v0.13.2 返修：open=false 时**保持渲染**，让壳的 image-mgr-genie-out 有 DOM 可播；
    // 卸载由壳在 300ms 退场结束后统一完成。
    expect(container.querySelector(".image-mgr-dialog")).not.toBeNull();

    // 不卸载直接重开也要正常
    expect(() =>
      rerender(createElement(ImageManagerDialog, { ...baseProps, open: true })),
    ).not.toThrow();
    expect(container.querySelector(".image-mgr-dialog")).not.toBeNull();
    unmount();
  });
});

// ═════════════ 需求6：延迟卸载壳 ═════════════

describe("需求6：GenieDialogShell（延迟卸载 + 几何测量）", () => {
  const shell = () => SRC("components/dialogs/GenieDialogShell.tsx");

  it("关闭走延迟卸载（动画播完才卸载），不是条件渲染即刻摘除", () => {
    const src = shell();
    expect(src).toContain("setTimeout(");
    expect(src).toContain("setMounted(false)");
    expect(src).toContain("IMAGE_MGR_GENIE_OUT_MS");
  });

  it("开合各测量一次注入四个几何变量（无监听、无持续开销）", () => {
    const src = shell();
    for (const v of [
      "--genie-from-x",
      "--genie-from-y",
      "--genie-origin-x",
      "--genie-origin-y",
    ]) {
      expect(src, `缺 ${v}`).toContain(`setProperty("${v}"`);
    }
    // 打开时双 rAF 测量后再放行动画；关闭时 layout effect 重测
    expect(src).toContain("requestAnimationFrame(");
    expect(src).toContain("useLayoutEffect(");
  });

  it("三个状态类齐全：pending / in / out（pending 期间面板藏起来防首帧跳动）", () => {
    const src = shell();
    expect(src).toContain("image-mgr-genie-pending");
    expect(src).toContain("image-mgr-genie-in");
    expect(src).toContain("image-mgr-genie-out");
    const css = SRC("components/dialogs/ImageManagerDialog.css");
    expect(css).toMatch(/\.image-mgr-genie-pending \.image-mgr-dialog \{[\s\S]{0,80}?opacity:\s*0/);
  });

  it("锚点是图片管理按钮（测到按钮矩形才能『从按钮里跑出来』）", () => {
    expect(shell()).toContain('[data-genie-anchor="image-manager"]');
    // EditorContainer 给按钮包了锚点容器
    expect(SRC("components/editor/EditorContainer.tsx")).toContain('data-genie-anchor="image-manager"');
  });

  it("App.tsx 用壳包住弹窗（不是条件渲染）", () => {
    const app = SRC("App.tsx");
    expect(app).toContain("<GenieDialogShell active={showImageManager}>");
    expect(app).not.toContain("{showImageManager && (");
  });
});

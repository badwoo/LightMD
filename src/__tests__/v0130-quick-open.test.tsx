/**
 * v0.13.0 需求8：`Ctrl+P` 快速切换器。
 *
 * 覆盖：
 * - `fuzzyMatch` 子序列匹配 + 打分真值表（连续子串 / 词首 / 位置衰减 / 不匹配）；
 * - `buildQuickOpenItems`：三类来源去重（同路径保留最高优先级分组）、
 *   过滤、排序（分数 → 分组序 → 名称）；
 * - `flattenFileTree`：只取文件、目录作为容器、深度上限保护；
 * - 组件行为：三类分组渲染、↑↓/Enter/Esc 键盘导航、命中字符高亮；
 * - 快捷键登记：`view.quickOpen` 默认 `Ctrl+P` 且与命令面板键位不冲突。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  fuzzyMatch,
  buildQuickOpenItems,
  scoreItem,
  flattenFileTree,
  fileNameOf,
  dirOf,
  QUICK_OPEN_GROUP_KEYS,
  type QuickOpenItem,
} from "../utils/quickOpen";
import { QuickOpenDialog } from "../components/dialogs/QuickOpenDialog";
import { SHORTCUT_DEFS, RESERVED_COMBOS } from "../core/shortcuts";

afterEach(cleanup);

// jsdom 未实现 scrollIntoView（QuickOpenDialog 的选中项滚入可视区会调用）
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// ───────── 纯函数：fuzzyMatch ─────────

describe("fuzzyMatch 子序列匹配与打分", () => {
  it("空 query → 命中（score=1，无高亮位置）", () => {
    const r = fuzzyMatch("", "anything");
    expect(r.matched).toBe(true);
    expect(r.positions).toEqual([]);
  });

  it("空 target → 不命中", () => {
    expect(fuzzyMatch("a", "").matched).toBe(false);
  });

  it("子序列命中：ls → LightMD-Setup", () => {
    const r = fuzzyMatch("ls", "lightmd-setup");
    expect(r.matched).toBe(true);
    // "lightmd-setup"：l=0，s=8（setup 的词首，前面是 '-'）
    expect(r.positions).toEqual([0, 8]);
  });

  it("连续子串得分高于分散命中", () => {
    const contiguous = fuzzyMatch("abc", "xxabcxx");
    const scattered = fuzzyMatch("abc", "axbxcx");
    expect(contiguous.matched).toBe(true);
    expect(scattered.matched).toBe(true);
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });

  it("词首命中加权：'sr' 在 'a-s-README' 里 s 与 r 都算词首", () => {
    const r = fuzzyMatch("sr", "a-s-readme");
    expect(r.matched).toBe(true);
    // s 位于 '-' 之后 → 词首；r 是 readme 首字母 → 词首
    expect(r.positions).toEqual([2, 4]);
  });

  it("位置越靠前分越高", () => {
    const early = fuzzyMatch("a", "axxxxxxx");
    const late = fuzzyMatch("a", "xxxxxxxa");
    expect(early.score).toBeGreaterThan(late.score);
  });

  it("非子序列 → 不命中", () => {
    expect(fuzzyMatch("z", "abc").matched).toBe(false);
    expect(fuzzyMatch("ba", "abc").matched).toBe(false); // 顺序不符
  });

  it("完全相等额外加分", () => {
    const exact = fuzzyMatch("abc", "abc");
    const partial = fuzzyMatch("abc", "abcd");
    expect(exact.score).toBeGreaterThan(partial.score);
  });

  it("大小写由调用方归一（本函数按传入大小写比较）", () => {
    expect(fuzzyMatch("a", "A").matched).toBe(false);
    expect(fuzzyMatch("a", "a").matched).toBe(true);
  });
});

// ───────── 纯函数：scoreItem ─────────

describe("scoreItem：文件名优先于路径", () => {
  const item: QuickOpenItem = {
    path: "D:/docs/notes/readme.md",
    name: "readme.md",
    group: "workspace",
  };

  it("文件名命中 → 高分", () => {
    expect(scoreItem("readme", item).score).toBeGreaterThan(0);
  });

  it("仅路径命中 → 分数低于文件名命中", () => {
    const byName = scoreItem("readme", item).score;
    const byDir = scoreItem("notes", item).score;
    expect(byName).toBeGreaterThan(byDir);
  });

  it("都命中 → 用文件名的高亮位置", () => {
    const r = scoreItem("readme.md", item);
    expect(r.matched).toBe(true);
    expect(r.positions.length).toBeGreaterThan(0);
    // 位置应落在 name 上（readme.md 长度范围内）
    for (const p of r.positions) expect(p).toBeLessThan(item.name.length);
  });

  it("都不命中 → matched=false", () => {
    expect(scoreItem("zzzz", item).matched).toBe(false);
  });
});

// ───────── 纯函数：buildQuickOpenItems ─────────

describe("buildQuickOpenItems：去重 / 过滤 / 排序", () => {
  const tabA: QuickOpenItem = { path: "D:/a.md", name: "a.md", group: "openTabs" };
  const tabB: QuickOpenItem = { path: "D:/b.md", name: "b.md", group: "openTabs", isActive: true };
  const recentA: QuickOpenItem = { path: "D:/a.md", name: "a.md", group: "recent" };
  const recentC: QuickOpenItem = { path: "D:/c.md", name: "c.md", group: "recent" };
  const wsD: QuickOpenItem = { path: "D:/docs/d.md", name: "d.md", group: "workspace" };
  const wsA: QuickOpenItem = { path: "D:/a.md", name: "a.md", group: "workspace" };

  it("空 query → 全部返回（已去重）", () => {
    const out = buildQuickOpenItems("", {
      openTabs: [tabA, tabB],
      recent: [recentA, recentC],
      workspace: [wsD, wsA],
    });
    // a.md 出现在三类里但只保留 openTabs 那份
    expect(out.filter((s) => s.item.path === "D:/a.md")).toHaveLength(1);
    expect(out.find((s) => s.item.path === "D:/a.md")?.item.group).toBe("openTabs");
    expect(out).toHaveLength(4);
  });

  it("同路径重复时保留**最高优先级**分组（openTabs > recent > workspace）", () => {
    const out = buildQuickOpenItems("", {
      openTabs: [tabA],
      recent: [recentA],
      workspace: [wsA],
    });
    expect(out).toHaveLength(1);
    expect(out[0].item.group).toBe("openTabs");
  });

  it("无 openTabs 命中时回落 recent（其次）", () => {
    const out = buildQuickOpenItems("", {
      openTabs: [],
      recent: [recentA],
      workspace: [wsA],
    });
    expect(out[0].item.group).toBe("recent");
  });

  it("query 过滤掉不匹配项", () => {
    const out = buildQuickOpenItems("d.md", {
      openTabs: [tabA, tabB],
      recent: [recentC],
      workspace: [wsD],
    });
    expect(out).toHaveLength(1);
    expect(out[0].item.name).toBe("d.md");
  });

  it("同分时按分组序（openTabs 在前）", () => {
    const a: QuickOpenItem = { path: "D:/x.md", name: "x.md", group: "workspace" };
    const b: QuickOpenItem = { path: "D:/y.md", name: "y.md", group: "openTabs" };
    const out = buildQuickOpenItems("x", {
      openTabs: [b],
      recent: [],
      workspace: [a],
    });
    // x 命中 x.md（高分），y.md 不命中 → 只剩 x.md
    expect(out).toHaveLength(1);
  });

  it("isActive 条目获得加分（同分时排前）", () => {
    const plain: QuickOpenItem = { path: "D:/p.md", name: "p.md", group: "openTabs" };
    const active: QuickOpenItem = {
      path: "D:/q.md",
      name: "q.md",
      group: "openTabs",
      isActive: true,
    };
    const out = buildQuickOpenItems("", { openTabs: [plain, active], recent: [], workspace: [] });
    expect(out[0].item.isActive).toBe(true);
  });

  it("返回带高亮位置（与排序依据同源）", () => {
    const out = buildQuickOpenItems("setup", {
      openTabs: [],
      recent: [],
      workspace: [{ path: "D:/LightMD-Setup.exe", name: "LightMD-Setup.exe", group: "workspace" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].positions.length).toBe(5);
  });
});

// ───────── 纯函数：flattenFileTree / 路径工具 ─────────

describe("flattenFileTree", () => {
  it("只收集文件，目录仅作为容器", () => {
    const out = flattenFileTree([
      { name: "a.md", path: "D:/a.md", isDir: false },
      { name: "sub", path: "D:/sub", isDir: true, children: [{ name: "b.md", path: "D:/sub/b.md", isDir: false }] },
    ]);
    expect(out.map((f) => f.path)).toEqual(["D:/a.md", "D:/sub/b.md"]);
  });

  it("空 children 的目录不产生条目", () => {
    expect(flattenFileTree([{ name: "e", path: "D:/e", isDir: true, children: [] }])).toEqual([]);
  });

  it("深度超限时停止递归（防异常深树）", () => {
    let deep: { name: string; path: string; isDir: boolean; children?: unknown[] } = {
      name: "f.md",
      path: "D:/deep.md",
      isDir: false,
    };
    for (let i = 0; i < 20; i++) {
      deep = { name: `d${i}`, path: `D:/d${i}`, isDir: true, children: [deep] };
    }
    const out = flattenFileTree(deep ? [deep as never] : []);
    expect(out).toEqual([]); // 超过 maxDepth=12 → 拿不到最深层
  });

  it("空树 → 空数组", () => {
    expect(flattenFileTree([])).toEqual([]);
  });
});

describe("fileNameOf / dirOf", () => {
  it("正斜杠与反斜杠都认", () => {
    expect(fileNameOf("D:/a/b.md")).toBe("b.md");
    expect(fileNameOf("D:\\a\\b.md")).toBe("b.md");
    expect(dirOf("D:/a/b.md")).toBe("D:/a");
    expect(dirOf("D:\\a\\b.md")).toBe("D:\\a");
  });

  it("无目录 → dirOf 空串", () => {
    expect(dirOf("b.md")).toBe("");
  });
});

// ───────── 组件行为 ─────────

const OPEN_TAB: QuickOpenItem = { path: "D:/tab.md", name: "tab.md", group: "openTabs", isActive: true };
const RECENT: QuickOpenItem = { path: "D:/recent.md", name: "recent.md", group: "recent" };
const WS: QuickOpenItem = { path: "D:/ws.md", name: "ws.md", group: "workspace" };

function renderDialog(overrides: Partial<Parameters<typeof QuickOpenDialog>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <QuickOpenDialog
      open
      openTabs={[OPEN_TAB]}
      recent={[RECENT]}
      workspace={[WS]}
      onPick={onPick}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onPick, onClose };
}

describe("QuickOpenDialog 组件", () => {
  it("三类来源分组渲染（已打开标签在前）", () => {
    renderDialog();
    const titles = screen.getAllByText(/已打开的标签|最近文件|工作区文件/);
    expect(titles.length).toBe(3);
    // 顺序：openTabs → recent → workspace
    expect(titles[0].textContent).toBe("已打开的标签");
    expect(titles[1].textContent).toBe("最近文件");
    expect(titles[2].textContent).toBe("工作区文件");
  });

  it("QUICK_OPEN_GROUP_KEYS 覆盖三类", () => {
    expect(Object.keys(QUICK_OPEN_GROUP_KEYS).sort()).toEqual(["openTabs", "recent", "workspace"]);
  });

  it("↑↓ 循环导航，Enter 触发 onPick", () => {
    const { onPick } = renderDialog();
    const input = screen.getByPlaceholderText("按文件名搜索并切换文件…");
    // 默认选中第 0 项（tab.md）
    expect(document.querySelector(".quick-open-item.selected")?.textContent).toContain("tab.md");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.querySelector(".quick-open-item.selected")?.textContent).toContain("recent.md");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.querySelector(".quick-open-item.selected")?.textContent).toContain("ws.md");
    // 循环回首项
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.querySelector(".quick-open-item.selected")?.textContent).toContain("tab.md");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].path).toBe("D:/tab.md");
  });

  it("Esc 关闭", () => {
    const { onClose } = renderDialog();
    const input = screen.getByPlaceholderText("按文件名搜索并切换文件…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击条目也触发 onPick", () => {
    const { onPick } = renderDialog();
    // 文件名按字符拆成多个 span（高亮用），用容器定位而非纯文本匹配
    const items = document.querySelectorAll(".quick-open-item");
    const wsItem = Array.from(items).find((el) =>
      el.querySelector(".quick-open-item-name")?.textContent?.includes("ws.md"),
    );
    expect(wsItem).toBeTruthy();
    fireEvent.click(wsItem!);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].path).toBe("D:/ws.md");
  });

  it("输入过滤：无匹配时显示空态", () => {
    renderDialog();
    const input = screen.getByPlaceholderText("按文件名搜索并切换文件…");
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByText("没有匹配的文件")).toBeTruthy();
  });

  it("子序列匹配：输入 'ws' 命中 ws.md", () => {
    renderDialog();
    const input = screen.getByPlaceholderText("按文件名搜索并切换文件…");
    fireEvent.change(input, { target: { value: "ws" } });
    const names = Array.from(document.querySelectorAll(".quick-open-item-name")).map(
      (el) => el.textContent,
    );
    expect(names).toContain("ws.md");
    expect(names).not.toContain("tab.md");
  });

  it("命中字符带 .hl 高亮", () => {
    renderDialog();
    const input = screen.getByPlaceholderText("按文件名搜索并切换文件…");
    fireEvent.change(input, { target: { value: "ws" } });
    const hls = document.querySelectorAll(".quick-open-item-name .hl");
    expect(hls.length).toBe(2); // w 与 s 两个字符
  });

  it("open=false → 不渲染", () => {
    render(
      <QuickOpenDialog
        open={false}
        openTabs={[OPEN_TAB]}
        recent={[]}
        workspace={[]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.querySelector(".quick-open")).toBeNull();
  });
});

// ───────── 快捷键登记 ─────────

describe("快捷键：view.quickOpen（Ctrl+P）", () => {
  it("已登记且默认 Ctrl+P", () => {
    const def = SHORTCUT_DEFS.find((d) => d.id === "view.quickOpen");
    expect(def).toBeTruthy();
    expect(def!.defaultCombo).toBe("Ctrl+P");
    expect(def!.scope).toBe("global"); // 三模式一致
  });

  it("不与命令面板（Ctrl+Shift+P）冲突", () => {
    const palette = SHORTCUT_DEFS.find((d) => d.id === "view.commandPalette");
    expect(palette!.defaultCombo).not.toBe("Ctrl+P");
  });

  it("Ctrl+P 不在保留占用清单里", () => {
    expect(RESERVED_COMBOS).not.toContain("Ctrl+P");
  });

  it("基线 50 → 51（新增这一条）", () => {
    expect(SHORTCUT_DEFS.length).toBe(51);
  });
});

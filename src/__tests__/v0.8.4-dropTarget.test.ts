/**
 * v0.8.4 拖拽交互升级单元测试（需求1 + 需求3）
 *
 * 覆盖：
 * - isDescendantDir：自嵌套守卫纯函数（自身/后代/兄弟/大小写/分隔符/文件源）
 * - resolveDropAction：D5 落点三分流决策（canDrop 拒绝 / 同目录重排 / 其他目录传输）
 * - resolveInsertPlace：插入位置计算（jsdom 注入 rect，行前/行后/空白末尾/源自身行末尾）
 * - beginFileDrag 会话级三分流：canDrop 谓词联动高亮与投放（S3 体验闭环）
 *
 * 注意：项目 vitest 未开启 globals，需显式 import 测试 API。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { isDescendantDir } from "../utils/fileClipboard";
import { resolveInsertPlace, canDropIntoTarget } from "../utils/dropTarget";
import {
  beginFileDrag,
  resolveDropAction,
  DROP_DIR_ATTR,
  DRAG_ACTIVE_CLASS,
  type FileDragPayload,
} from "../utils/fileDragMouse";

afterEach(() => {
  document.body.innerHTML = "";
  document.body.classList.remove("file-dragging");
});

describe("v0.8.4 isDescendantDir（自嵌套守卫）", () => {
  it("targetDir 即源自身 → true", () => {
    expect(isDescendantDir("D:/a", "D:/a")).toBe(true);
  });

  it("targetDir 为源的直接/深层后代 → true", () => {
    expect(isDescendantDir("D:/a", "D:/a/sub")).toBe(true);
    expect(isDescendantDir("D:/a", "D:/a/sub/deep")).toBe(true);
  });

  it("前缀相同但非目录边界（D:/ab）→ false", () => {
    expect(isDescendantDir("D:/a", "D:/ab")).toBe(false);
  });

  it("兄弟目录 → false", () => {
    expect(isDescendantDir("D:/a", "D:/b")).toBe(false);
    expect(isDescendantDir("D:/a", "D:/b/a")).toBe(false);
  });

  it("源为文件：目标目录不可能是其后代 → false；与源同路径时防御性拒绝 → true", () => {
    expect(isDescendantDir("D:/a/b.md", "D:/a")).toBe(false);
    // targetDir 与文件路径完全相同 → 同路径视为"放进自身"拒绝（防御语义，
    // 实际投放目录均来自 data-drop-dir（只会是目录），此为兜底方向安全）
    expect(isDescendantDir("D:/a/b.md", "D:/a/b.md")).toBe(true);
  });

  it("Windows 语义：大小写不敏感、反斜杠与尾斜杠归一", () => {
    expect(isDescendantDir("D:/A", "D:/a/sub")).toBe(true);
    expect(isDescendantDir("D:\\a", "D:/a/sub")).toBe(true);
    expect(isDescendantDir("D:/a/", "D:/a/sub")).toBe(true);
  });

  it("空路径守卫 → false", () => {
    expect(isDescendantDir("", "D:/a")).toBe(false);
    expect(isDescendantDir("D:/a", "")).toBe(false);
  });
});

describe("v0.8.4 需求3 修复：canDropIntoTarget（落点准入按源类型分流）", () => {
  it("文件源：落到自身所在目录/祖先目录/同目录 → 放行（不得误判为自嵌套）", () => {
    // 这是本次修复的核心断言：修复前对文件源套用 isDescendantDir 虽不误拒父目录，
    // 但语义上"文件不可能是目录祖先"，此处明确文件源一律放行（除完全同路径）。
    expect(canDropIntoTarget("D:/proj/a.md", false, "D:/proj")).toBe(true);
    expect(canDropIntoTarget("D:/proj/sub/a.md", false, "D:/proj")).toBe(true);
    expect(canDropIntoTarget("D:/proj/a.md", false, "D:/proj/sub")).toBe(true);
    // 分隔符/尾斜杠/大小写归一
    expect(canDropIntoTarget("D:\\proj\\a.md", false, "D:/proj/")).toBe(true);
  });

  it("文件源：仅当 targetDir 与源完全同路径时防御性拒绝", () => {
    expect(canDropIntoTarget("D:/proj/a.md", false, "D:/proj/a.md")).toBe(false);
    expect(canDropIntoTarget("D:/proj/a.md", false, "D:\\proj\\A.MD")).toBe(false);
  });

  it("目录源：落到自身或自身后代 → 拒绝；其他目录 → 放行", () => {
    expect(canDropIntoTarget("D:/a", true, "D:/a")).toBe(false);
    expect(canDropIntoTarget("D:/a", true, "D:/a/sub")).toBe(false);
    // 落到自身父目录（如区域根）/兄弟目录 → 放行
    expect(canDropIntoTarget("D:/a", true, "D:/")).toBe(true);
    expect(canDropIntoTarget("D:/a/sub", true, "D:/a")).toBe(true);
  });
});

describe("v0.8.4 resolveDropAction（D5 落点三分流决策）", () => {
  const filePayload: FileDragPayload = { path: "D:/docs/a.md", name: "a.md" };

  it("同目录 → reorder（需求3：根栏空白/自身目录内拖拽进入重排）", () => {
    expect(resolveDropAction(filePayload, "D:/docs")).toBe("reorder");
  });

  it("同目录判定对分隔符与尾斜杠归一", () => {
    expect(resolveDropAction({ path: "D:\\docs\\a.md", name: "a.md" }, "D:\\docs\\")).toBe("reorder");
  });

  it("子文件夹 → transfer（需求1：复制/Shift 移动）", () => {
    expect(resolveDropAction(filePayload, "D:/docs/sub")).toBe("transfer");
  });

  it("拖文件夹到自身后代 + canDrop 注入 → reject（S3：高亮阶段即拒绝）", () => {
    const dirPayload: FileDragPayload = { path: "D:/a", name: "a" };
    const canDrop = (targetDir: string) => !isDescendantDir(dirPayload.path, targetDir);
    expect(resolveDropAction(dirPayload, "D:/a/sub", canDrop)).toBe("reject");
    expect(resolveDropAction(dirPayload, "D:/a", canDrop)).toBe("reject");
  });

  it("拖文件夹到自身后代 + 未注入 canDrop → transfer（由 transferTo 守卫拒绝并 toast 兜底）", () => {
    // 语义说明：fileDragMouse 不耦合 i18n；transferTo 的 isDescendantDir 守卫
    // 负责「不能移动/复制到自身内部」提示，本分支保证自嵌套不会真正执行传输。
    const dirPayload: FileDragPayload = { path: "D:/a", name: "a" };
    expect(resolveDropAction(dirPayload, "D:/a/sub")).toBe("transfer");
  });
});

describe("v0.8.4 resolveInsertPlace（插入位置计算，jsdom 注入 rect）", () => {
  /** 构造一行树节点（wrapper + filetree-name），可选注入 getBoundingClientRect */
  function makeRow(name: string, rect?: { top: number; height: number }): HTMLElement {
    const row = document.createElement("div");
    row.className = "filetree-node-wrapper";
    const nameEl = document.createElement("span");
    nameEl.className = "filetree-name";
    nameEl.textContent = name;
    row.appendChild(nameEl);
    if (rect) {
      (row as HTMLElement).getBoundingClientRect = () =>
        ({
          top: rect.top,
          height: rect.height,
          left: 0,
          right: 100,
          bottom: rect.top + rect.height,
          width: 100,
          x: 0,
          y: rect.top,
          toJSON: () => ({}),
        }) as DOMRect;
    }
    document.body.appendChild(row);
    return row;
  }

  it("未命中元素（空白处）→ end", () => {
    expect(resolveInsertPlace(null, 50)).toEqual({ targetName: null, place: "end" });
  });

  it("命中元素不属于任何行 → end", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(resolveInsertPlace(plain, 50)).toEqual({ targetName: null, place: "end" });
  });

  it("鼠标在行垂直中点上方 → before", () => {
    const row = makeRow("a.md", { top: 100, height: 20 });
    expect(resolveInsertPlace(row, 105)).toEqual({ targetName: "a.md", place: "before" });
  });

  it("鼠标在行垂直中点及以下 → after", () => {
    const row = makeRow("a.md", { top: 100, height: 20 });
    expect(resolveInsertPlace(row, 110)).toEqual({ targetName: "a.md", place: "after" });
    expect(resolveInsertPlace(row, 115)).toEqual({ targetName: "a.md", place: "after" });
  });

  it("命中源自身行 → end（把源移除后追加到末尾）", () => {
    const row = makeRow("b.md", { top: 100, height: 20 });
    expect(resolveInsertPlace(row, 105, "b.md")).toEqual({ targetName: null, place: "end" });
  });

  it("行内命中的是子元素时仍取最近行（closest 语义）", () => {
    const row = makeRow("c.md", { top: 0, height: 20 });
    const leaf = row.querySelector(".filetree-name") as Element;
    expect(resolveInsertPlace(leaf, 5, "c.md")).toEqual({ targetName: null, place: "end" });
  });

  it("无有效几何信息（jsdom 默认 height=0）→ 保守 after", () => {
    const row = makeRow("d.md");
    expect(resolveInsertPlace(row, 50)).toEqual({ targetName: "d.md", place: "after" });
  });
});

describe("v0.8.4 beginFileDrag 三分流会话（canDrop 联动高亮与投放）", () => {
  function mountDropDir(dir: string): HTMLDivElement {
    const el = document.createElement("div");
    el.setAttribute(DROP_DIR_ATTR, dir);
    document.body.appendChild(el);
    return el;
  }

  it("落在源所在目录 → onReorder 触发且 onDrop 不触发（D5 分支③）", () => {
    const payload: FileDragPayload = { path: "D:/docs/a.md", name: "a.md" };
    const onDrop = vi.fn();
    const onReorder = vi.fn();
    const target = mountDropDir("D:/docs");
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, { onDrop, onReorder }, () => target);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 40, clientY: 0 }));

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder.mock.calls[0][0]).toBe(payload);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("拖文件夹悬停自身后代 → 不高亮、松手不触发任何回调（S3 体验闭环）", () => {
    const payload: FileDragPayload = { path: "D:/a", name: "a" };
    const onDrop = vi.fn();
    const onReorder = vi.fn();
    const child = mountDropDir("D:/a/sub"); // 源的后代目录
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, {
      onDrop,
      onReorder,
      canDrop: (targetDir) => !isDescendantDir(payload.path, targetDir),
    }, () => child);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 0 }));
    // canDrop 拒绝 → 不进入高亮
    expect(child.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);

    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 40, clientY: 0 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("拖文件夹悬停自身 → 同样不高亮、不触发回调", () => {
    const payload: FileDragPayload = { path: "D:/a", name: "a" };
    const onDrop = vi.fn();
    const self = mountDropDir("D:/a");
    // FolderSection 式根区域也带源自身的 drop-dir（父目录区域）
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, {
      onDrop,
      canDrop: (targetDir) => !isDescendantDir(payload.path, targetDir),
    }, () => self);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 0 }));
    expect(self.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 40, clientY: 0 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("拖文件夹到其他目录 → 高亮并照常 onDrop", () => {
    const payload: FileDragPayload = { path: "D:/a", name: "a" };
    const onDrop = vi.fn();
    const target = mountDropDir("D:/b");
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, {
      onDrop,
      canDrop: (targetDir) => !isDescendantDir(payload.path, targetDir),
    }, () => target);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 0 }));
    expect(target.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 40, clientY: 0 }));
    expect(onDrop).toHaveBeenCalledWith(payload, "D:/b", "copy");
  });

  it("canDrop 拒绝的落点会把已高亮的前一个合法落点清掉（守卫防误投）", () => {
    const payload: FileDragPayload = { path: "D:/a", name: "a" };
    const onDrop = vi.fn();
    const good = mountDropDir("D:/b");
    const bad = mountDropDir("D:/a/sub");
    let current: Element = good;
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, {
      onDrop,
      canDrop: (targetDir) => !isDescendantDir(payload.path, targetDir),
    }, () => current);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 0 }));
    expect(good.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    // 移到自身后代：合法高亮被清除，且不会误保留旧落点参与松手判定
    current = bad;
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 60, clientY: 0 }));
    expect(bad.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    expect(good.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);

    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 60, clientY: 0 }));
    expect(onDrop).not.toHaveBeenCalled();
  });
});

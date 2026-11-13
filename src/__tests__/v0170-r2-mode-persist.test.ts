// @vitest-environment jsdom
/**
 * v0.17.0 第二轮 #10：视图模式（`viewMode` / `splitPreviewOpen`）的跨会话持久化。
 *
 * ## 缺陷背景
 * 用户报告：「在编辑模式下关闭软件，重新打开后没有保持以编辑模式的窗口和文档阅读进度打开。」
 * 根因：`useEditorStore` 的 `viewMode` / `splitPreviewOpen` **没有任何持久化**
 * （只有 `useFileStore` / `useSettingsStore` 挂了 `persist`）→ 会话结束即丢。
 *
 * ## 本测试锁什么
 * 1. `loadViewModePref` 的**容错契约**：老用户无数据 / 数据损坏 / 非法值 → null（落默认值，不崩）
 * 2. `VIEW_MODE_PREF_KEY` 的**窗口后缀口径**：main 用无后缀旧 key，sec-* 加后缀
 * 3. **大文件强制降级不得覆盖用户偏好**（合批启发式）：
 *    「进编辑 + 关预览」同批出现 = 大文件路径 → 保留用户原来的 `splitPreviewOpen`
 * 4. 用户**手动**关预览必须被记住（不能因为上一条把正常路径也吞掉）
 * 5. `flushViewModePref` 能把 600ms 合批里的待写状态立刻落盘
 *
 * ## ⚠️ 测试自身的两个坑（写下来防重蹈）
 * 1. **不能** `import { useEditorStore }` 之前不重置模块状态：store 在**模块求值期**
 *    就读了一次 localStorage（首帧正确的代价），所以"读回恢复"的用例必须
 *    `vi.resetModules()` + 动态 import 才能拿到"重新启动"的语义。
 * 2. `__resetViewModePrefForTest` 必须在每个用例后调用，否则上一个用例的
 *    pending batch 会在下一个用例 flush 时写脏数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "lightmd-view-mode";

/** 清空我们关心的 key（其它测试的 localStorage 残留不干扰） */
function clearOurKeys(): void {
  for (const k of ["lightmd-view-mode", "lightmd-view-mode-sec-1", "lightmd-view-mode-sec-2"]) {
    localStorage.removeItem(k);
  }
}

/** 写一份持久化载荷 */
function seed(value: unknown): void {
  localStorage.setItem(KEY, typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(() => {
  clearOurKeys();
  vi.resetModules();
});

afterEach(() => {
  clearOurKeys();
});

/* ─────────────────────── ① 读取容错 ─────────────────────── */

describe("#10 loadViewModePref：容错契约（老用户升级 / 数据损坏一律不崩）", () => {
  it("无任何数据 → null（落回默认阅读模式 + 预览开）", async () => {
    const { loadViewModePref } = await import("../stores/useEditorStore");
    expect(loadViewModePref()).toBeNull();
  });

  it("合法数据 → 原样返回", async () => {
    seed({ v: 1, viewMode: "edit", splitPreviewOpen: false });
    const { loadViewModePref } = await import("../stores/useEditorStore");
    expect(loadViewModePref()).toEqual({ viewMode: "edit", splitPreviewOpen: false });
  });

  it("JSON 损坏 → null（不抛）", async () => {
    localStorage.setItem(KEY, "{not json");
    const { loadViewModePref } = await import("../stores/useEditorStore");
    expect(() => loadViewModePref()).not.toThrow();
    expect(loadViewModePref()).toBeNull();
  });

  it("viewMode 非法值（旧的三模式 split / 垃圾串）→ null，不部分采信", async () => {
    const { loadViewModePref } = await import("../stores/useEditorStore");
    seed({ v: 1, viewMode: "split", splitPreviewOpen: true });
    expect(loadViewModePref()).toBeNull();
    seed({ v: 1, viewMode: 42, splitPreviewOpen: true });
    expect(loadViewModePref()).toBeNull();
    seed({ v: 1, splitPreviewOpen: true });
    expect(loadViewModePref()).toBeNull();
  });

  it("splitPreviewOpen 缺失/非法 → 回默认 true（viewMode 仍然生效）", async () => {
    const { loadViewModePref } = await import("../stores/useEditorStore");
    seed({ v: 1, viewMode: "edit" });
    expect(loadViewModePref()).toEqual({ viewMode: "edit", splitPreviewOpen: true });
    seed({ v: 1, viewMode: "edit", splitPreviewOpen: "yes" });
    expect(loadViewModePref()).toEqual({ viewMode: "edit", splitPreviewOpen: true });
  });

  it("顶层不是对象（null / 数组 / 数字）→ null", async () => {
    const { loadViewModePref } = await import("../stores/useEditorStore");
    for (const bad of [null, [], 7, "edit"]) {
      seed(bad as unknown);
      expect(loadViewModePref()).toBeNull();
    }
  });
});

/* ─────────────────────── ② 窗口后缀口径 ─────────────────────── */

describe("#10 key 口径：viewMode 是窗口级数据（main 无后缀，sec-* 加后缀）", () => {
  it("主窗口写无后缀 key", async () => {
    const { __setWindowLabelForTest } = await import("../utils/windowLabel");
    __setWindowLabelForTest("main");
    const { loadViewModePref } = await import("../stores/useEditorStore");
    seed({ v: 1, viewMode: "edit", splitPreviewOpen: true });
    expect(loadViewModePref()).toEqual({ viewMode: "edit", splitPreviewOpen: true });
    __setWindowLabelForTest(null);
  });

  it("辅助窗口读自己的后缀 key（不串主窗口的值）", async () => {
    const { __setWindowLabelForTest } = await import("../utils/windowLabel");
    // 主窗口记的是 edit
    seed({ v: 1, viewMode: "edit", splitPreviewOpen: true });
    __setWindowLabelForTest("sec-1");
    const { loadViewModePref } = await import("../stores/useEditorStore");
    // 辅助窗口没有自己的数据 → null（**不**继承主窗口）
    expect(loadViewModePref()).toBeNull();
    // 写一份 sec-1 自己的 → 读到自己的
    localStorage.setItem("lightmd-view-mode-sec-1", JSON.stringify({ v: 1, viewMode: "preview", splitPreviewOpen: false }));
    expect(loadViewModePref()).toEqual({ viewMode: "preview", splitPreviewOpen: false });
    __setWindowLabelForTest(null);
  });
});

/* ─────────────────────── ③ store 初始化即恢复（首帧正确） ─────────────────────── */

describe("#10 store 初始化：模块求值期就恢复（保证首帧不闪）", () => {
  it("有 edit 快照 → store 创建出来就是 edit", async () => {
    seed({ v: 1, viewMode: "edit", splitPreviewOpen: false });
    const { useEditorStore } = await import("../stores/useEditorStore");
    const s = useEditorStore.getState();
    expect(s.viewMode).toBe("edit");
    expect(s.splitPreviewOpen).toBe(false);
  });

  it("无快照 → 默认 preview + 预览开（与 v0.14.0 既有默认一致）", async () => {
    const { useEditorStore } = await import("../stores/useEditorStore");
    const s = useEditorStore.getState();
    expect(s.viewMode).toBe("preview");
    expect(s.splitPreviewOpen).toBe(true);
  });

  it("数据损坏 → 默认值，且 store 创建不抛", async () => {
    localStorage.setItem(KEY, "%%%");
    await expect(import("../stores/useEditorStore")).resolves.toBeTruthy();
    const { useEditorStore } = await import("../stores/useEditorStore");
    expect(useEditorStore.getState().viewMode).toBe("preview");
  });
});

/* ─────────────────────── ④ 写入：手动路径必须被记住 ─────────────────────── */

describe("#10 写入：用户手动切换必须落盘（600ms 合批后 flush）", () => {
  it("setViewMode('edit') → flush 后持久化为 edit", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    expect(JSON.parse(localStorage.getItem(KEY) || "null")).toEqual({
      v: 1, viewMode: "edit", splitPreviewOpen: true,
    });
    __resetViewModePrefForTest();
  });

  it("用户手动关预览（toggleSplitPreview）→ 必须记住 false（不能被降级启发式吞掉）", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    // 用户在编辑模式里点「关闭预览」：只改 splitPreviewOpen，不改 viewMode
    useEditorStore.getState().toggleSplitPreview();
    flushViewModePref();
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    expect(saved.viewMode).toBe("edit");
    expect(saved.splitPreviewOpen).toBe(false);
    __resetViewModePrefForTest();
  });

  it("setSplitPreviewOpen(false) 单独调用（用户关闭）→ 记住 false", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    useEditorStore.getState().setSplitPreviewOpen(false);
    flushViewModePref();
    expect(JSON.parse(localStorage.getItem(KEY) || "null").splitPreviewOpen).toBe(false);
    __resetViewModePrefForTest();
  });

  it("toggleSplitPreview 在阅读模式下也记录（切回编辑时按此恢复）", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    expect(useEditorStore.getState().viewMode).toBe("preview");
    useEditorStore.getState().toggleSplitPreview();
    flushViewModePref();
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    expect(saved.viewMode).toBe("preview");
    expect(saved.splitPreviewOpen).toBe(false);
    __resetViewModePrefForTest();
  });
});

/* ─────────────────────── ⑤ 大文件降级不得覆盖偏好（核心启发式） ─────────────────────── */

describe("#10 大文件强制降级：不得覆盖用户的『编辑 + 带预览』偏好", () => {
  /**
   * ═══ ⚠️ "未来反例"说明（Lead 要求写在单测旁边，别删） ═══
   *
   * 本组第 1 条测的判据是**形状推断**：
   * "同一合批里 `viewMode: preview→edit` **且** `splitPreviewOpen: true→false`"。
   *
   * 它成立的**前提**是本产品不存在"用户在单次操作里既进编辑又关预览"的路径
   * （进编辑恒 `setSplitPreviewOpen(true)`，关预览只改开关不改 viewMode）。
   *
   * **失效条件（出现任一条，形状判据就会误伤"用户真的想关预览"）**：
   * 1. 新增「进编辑模式但默认不带预览」的偏好设置；
   * 2. 新增「阅读模式下直接切到纯源码编辑」的快捷入口（一条命令里 set 两次）；
   * 3. 大文件提示里加"以后都用纯编辑打开"的一键选项。
   *
   * **正确处置**（已实现的升级路径）：让调用点显式传
   * `setViewMode("edit", { reason: "large-file" })`（见下方第 4 条用例），
   * 之后**删除**形状判据 `looksLikeForcedDowngrade` 与 `splitChanged` 字段即可。
   * ⚠️ 不要因为"现在测试绿"就认为形状判据永远安全 —— 它是**过渡手段**。
   */
  it("★ 同一合批里『进编辑 + 关预览』→ 只记 viewMode，保留 splitPreviewOpen=true（形状判据）", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    // 用户上次的偏好：编辑 + 带预览
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    expect(JSON.parse(localStorage.getItem(KEY) || "null").splitPreviewOpen).toBe(true);

    // 模拟 App.tsx 大文件分支：先回阅读（等价于从阅读态打开大文件）再强制降级
    useEditorStore.getState().setViewMode("preview");
    flushViewModePref();
    __resetViewModePrefForTest();

    // 大文件路径：setViewMode("edit") + setSplitPreviewOpen(false) 同一同步块
    useEditorStore.getState().setViewMode("edit");
    useEditorStore.getState().setSplitPreviewOpen(false);
    flushViewModePref();

    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    expect(saved.viewMode).toBe("edit");        // 降级后的模式要记住
    expect(saved.splitPreviewOpen).toBe(true);  // 但用户的预览偏好不能被降级覆盖
    __resetViewModePrefForTest();
  });

  it("大文件降级在**下一个合批**里的纯关预览（用户自己点）→ 正常记住 false", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    __resetViewModePrefForTest();
    // 隔一次合批再关预览：没有 modeChanged → 属于用户操作
    useEditorStore.getState().setSplitPreviewOpen(false);
    flushViewModePref();
    expect(JSON.parse(localStorage.getItem(KEY) || "null").splitPreviewOpen).toBe(false);
    __resetViewModePrefForTest();
  });

  it("降级时用户偏好本来就是『无预览』→ 结果仍是 false（启发式不误判为需保留）", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    // 用户偏好：编辑 + 无预览
    useEditorStore.getState().setSplitPreviewOpen(false);
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    __resetViewModePrefForTest();
    useEditorStore.getState().setViewMode("preview");
    flushViewModePref();
    __resetViewModePrefForTest();
    // 大文件降级
    useEditorStore.getState().setViewMode("edit");
    useEditorStore.getState().setSplitPreviewOpen(false);
    flushViewModePref();
    expect(JSON.parse(localStorage.getItem(KEY) || "null").splitPreviewOpen).toBe(false);
    __resetViewModePrefForTest();
  });

  /**
   * 升级路径的正确姿势：显式 `reason` 优先于形状判据。
   * 这条用例同时是"将来 App.tsx 传了 reason 之后行为不变"的护栏。
   */
  it("★ 显式 reason='large-file' → 即使形状不像（没在同批里关预览）也保留偏好", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    // 用户偏好：编辑 + 带预览
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    __resetViewModePrefForTest();
    useEditorStore.getState().setViewMode("preview");
    flushViewModePref();
    __resetViewModePrefForTest();
    /**
     * 显式声明强制降级，但**只**降级 viewMode、**不**关预览
     * （形状判据在缺 `splitChanged` 时会漏判；显式 reason 必须兜住）
     */
    useEditorStore.getState().setViewMode("edit", { reason: "large-file" });
    flushViewModePref();
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    expect(saved.viewMode).toBe("edit");
    expect(saved.splitPreviewOpen).toBe(true);  // 用户偏好未被覆盖
    __resetViewModePrefForTest();
  });

  it("显式 reason 与关预览同批出现 → 保留偏好 true（显式优先，行为与形状判据一致）", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    __resetViewModePrefForTest();
    useEditorStore.getState().setViewMode("preview");
    flushViewModePref();
    __resetViewModePrefForTest();
    // 模拟 App.tsx 升级后的写法：两个 action 都带 reason
    useEditorStore.getState().setViewMode("edit", { reason: "large-file" });
    useEditorStore.getState().setSplitPreviewOpen(false, { reason: "large-file" });
    flushViewModePref();
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    expect(saved.viewMode).toBe("edit");
    expect(saved.splitPreviewOpen).toBe(true);
    __resetViewModePrefForTest();
  });

  it("不传 reason（普通用户操作）→ 与既有行为完全一致（向后兼容护栏）", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    // 只切模式、不动预览：不传 reason 也必须正常写入
    useEditorStore.getState().setViewMode("edit");
    flushViewModePref();
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    expect(saved.viewMode).toBe("edit");
    expect(saved.splitPreviewOpen).toBe(true);
    __resetViewModePrefForTest();
  });
});

/* ─────────────────────── ⑥ 往返一致性（重启语义） ─────────────────────── */

describe("#10 往返：写完 → 重新加载模块 → 状态一致", () => {
  it("★ 编辑 + 关预览 → 『重启』后仍是编辑 + 关预览", async () => {
    {
      const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
        await import("../stores/useEditorStore");
      useEditorStore.getState().setViewMode("edit");
      flushViewModePref();
      useEditorStore.getState().setSplitPreviewOpen(false);
      flushViewModePref();
      __resetViewModePrefForTest();
    }
    // 模拟冷启动：丢掉模块缓存重新 import（localStorage 保留）
    vi.resetModules();
    const { useEditorStore } = await import("../stores/useEditorStore");
    const s = useEditorStore.getState();
    expect(s.viewMode).toBe("edit");
    expect(s.splitPreviewOpen).toBe(false);
  });

  it("阅读模式也被记住（用户上次停在阅读）", async () => {
    {
      const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
        await import("../stores/useEditorStore");
      useEditorStore.getState().setViewMode("edit");
      flushViewModePref();
      useEditorStore.getState().setViewMode("preview");
      flushViewModePref();
      __resetViewModePrefForTest();
    }
    vi.resetModules();
    const { useEditorStore } = await import("../stores/useEditorStore");
    expect(useEditorStore.getState().viewMode).toBe("preview");
  });

  it("连续多次切换只落最后一笔（合批有效）", async () => {
    const { useEditorStore, flushViewModePref, __resetViewModePrefForTest } =
      await import("../stores/useEditorStore");
    for (const m of ["edit", "preview", "edit", "preview", "edit"] as const) {
      useEditorStore.getState().setViewMode(m);
    }
    flushViewModePref();
    expect(JSON.parse(localStorage.getItem(KEY) || "null").viewMode).toBe("edit");
    __resetViewModePrefForTest();
  });
});

/* ─────────────────────── ⑦ 不影响既有 store 语义（回归护栏） ─────────────────────── */

describe("#10 回归护栏：持久化不得改变 store 的既有语义", () => {
  it("setViewMode 不同步改 splitPreviewOpen（v0.14.0 既有契约）", async () => {
    const { useEditorStore, __resetViewModePrefForTest } = await import("../stores/useEditorStore");
    const before = useEditorStore.getState().splitPreviewOpen;
    useEditorStore.getState().setViewMode("edit");
    expect(useEditorStore.getState().splitPreviewOpen).toBe(before);
    __resetViewModePrefForTest();
  });

  it("setSplitPreviewOpen 不同步改 viewMode（v0.14.0 既有契约：关预览不掉回阅读）", async () => {
    const { useEditorStore, __resetViewModePrefForTest } = await import("../stores/useEditorStore");
    useEditorStore.getState().setViewMode("edit");
    useEditorStore.getState().setSplitPreviewOpen(false);
    expect(useEditorStore.getState().viewMode).toBe("edit");
    __resetViewModePrefForTest();
  });

  it("toggleSplitPreview 是纯取反", async () => {
    const { useEditorStore, __resetViewModePrefForTest } = await import("../stores/useEditorStore");
    const before = useEditorStore.getState().splitPreviewOpen;
    useEditorStore.getState().toggleSplitPreview();
    expect(useEditorStore.getState().splitPreviewOpen).toBe(!before);
    __resetViewModePrefForTest();
  });

  it("不做任何切换时 flush 是 no-op（不写 key）", async () => {
    const { flushViewModePref, __resetViewModePrefForTest } = await import("../stores/useEditorStore");
    __resetViewModePrefForTest();
    flushViewModePref();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

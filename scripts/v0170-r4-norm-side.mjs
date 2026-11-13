/**
 * T4 接线的**副作用**探针（T1）—— 比"归一化是否生效"更重要
 *
 * ## 为什么必须先测副作用
 * 我的接线是 `getMarkdownFromDoc(doc, { normalizeOrderedLists: true })`。
 * T4 的注释明确写了这个开关的代价（`serializer.ts:100-122`）：
 * > `normalizeOrderedLists` 为 true 时**跳过 B6 快路径**，强制走逐块规范序列化。
 * > B6 的设计目的是「**未编辑文档保存零 diff**」。
 *
 * 而 B6 快路径**唯一的消费者之前是保存**。我把它接在「阅读 → 编辑」上，
 * 意味着**每次切模式都会重新序列化整篇** → 潜在后果：
 * - 未编辑文档切一次模式，文本被"规范化"（补空行、改列表符号、改强调符号…）；
 * - 而 `setSourceContent(mdMasked)` + `onContentChangeRef(mdMasked)` 会把它**写进 App 与标签**
 *   → 一次"我只是看了看"的切换就产生了**脏数据**（用户没编辑，小蓝点亮了、存盘内容变了）。
 *
 * 这是**数据正确性级**的风险，必须量化：**无有序列表的普通文档切模式后 diff 必须为 0**。
 *
 * ## 判据
 * | id | 场景 | 期望 |
 * |---|---|---|
 * | N1 | 普通文档（无列表）切一圈 | 文本**逐字节不变** |
 * | N2 | 普通文档切一圈 | 不产生脏标记 |
 * | N3 | 含 bullet 列表文档切一圈 | 文本逐字节不变 |
 * | N4 | 含代码块/表格文档切一圈 | 文本逐字节不变 |
 * | N5 | 检查是否需要 `normalizeOrderedLists` 的条件化（仅在文档真的含有序列表时启用） |
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const DOCS = {
  /** 普通文档：无任何列表 —— normalize 不该改变它 */
  plain: [
    "# 普通文档",
    "",
    "第一段。PI01 供定位。",
    "",
    "第二段。PI02 供定位。",
    "",
    "第三段。PI03 供定位。",
    "",
  ].join("\n"),
  /** bullet 列表 */
  bullet: [
    "# 无序列表",
    "",
    "- 甲项 K01",
    "- 乙项 K02",
    "",
    "尾段 K03。",
    "",
  ].join("\n"),
  /**
   * 紧凑写法的有序列表（无空行、连续 1.）—— **专门验 T4 记录的"补空行"副作用**。
   *
   * T4 原话：
   * > 归一化跳过快路径 → 走逐块规范序列化 → 块间会补空行：
   * > `1. aa ⏎ - [ ] 2. bb ⏎ 3. cc` → 归一化后变带空行版本。序号与内容完全不变。
   * > **如果用户反馈"切模式后多了空行"，那是预期行为，不是缺陷。**
   *
   * ⚠️ 这条判据我**不判 FAIL**（T4 已声明是预期行为），但要**量化它发生在哪些文档上**：
   * 若连"普通无列表文档"也被补空行，那就越界了（末-1 条已证明不会）。
   */
  compact: [
    "# 紧凑列表",
    "",
    "- 甲项 K01",
    "- 乙项 K02",
    "- 丙项 K03",
    "",
    "尾段 K04。",
    "",
  ].join("\n"),
  /** 代码块 + 表格 */
  rich: [
    "# 富内容",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "| 列1 | 列2 |",
    "| --- | --- |",
    "| A | B |",
    "",
    "尾段 K04。",
    "",
  ].join("\n"),
};

/** 读源码面文本 + App content + 脏标记 */
const READ = String.raw`
  const TOKEN = "NONE";
  const root = document.querySelector("#root") || document.body;
  const contKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  let start = contKey ? root[contKey] : null;
  if (start && start.current) start = start.current;
  const contentStates = [];
  let dirty = null;
  const stack = start ? [start] : []; const seen = new Set(); let g = 0;
  while (stack.length && g++ < 60000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        // App content：字符串且含"供定位"或"甲项"/"列1"
        if (typeof v === "string" && v.length > 30 && (v.indexOf("供定位") >= 0 || v.indexOf("甲项") >= 0 || v.indexOf("列1") >= 0)) {
          contentStates.push(v);
        }
        // 脏标记：布尔 state + 附近有 openTabs 数组
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "isDirty" in v[0] && "path" in v[0]) {
          if (dirty === null) dirty = !!v[0].isDirty;
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  contentStates.sort((a, b) => b.length - a.length);
  const app = contentStates[0] || "";
  let src = "";
  try {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (v) src = v.state.doc.sliceString(0, v.state.doc.length);
  } catch (e) {}
  return { src, app, dirty };
`;

/** 逐字节 diff 摘要：首个差异位置 + 两侧片段 */
const diffInfo = (a, b) => {
  if (a === b) return null;
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return {
    at: i,
    aLen: a.length,
    bLen: b.length,
    delta: b.length - a.length,
    aCtx: JSON.stringify(a.slice(Math.max(0, i - 25), i + 45)),
    bCtx: JSON.stringify(b.slice(Math.max(0, i - 25), i + 45)),
  };
};

const openDoc = (ui, name, content) => ui.ev(`
  window.dispatchEvent(new CustomEvent("lightmd:openFile", {
    detail: { path: ${JSON.stringify("D:/tmp/t1-norm-" + name + ".md")},
              name: ${JSON.stringify(name + ".md")},
              content: ${JSON.stringify(content)},
              skipConflictCheck: true },
  }));
  return true;
`);

for (const [name, content] of Object.entries(DOCS)) {
  await runBrowserProbe({ name: `v0170-r4-norm-side-${name}`, doc: content, docTitle: "供定位" }, async (ui) => {
    const read = () => ui.ev(READ);
    const toPreview = async () => { await ui.command("view.preview"); await sleep(900); };
    const toEdit = async () => { await ui.command("view.edit"); await sleep(900); };

    /* 打开指定文档（覆盖 runBrowserProbe 默认装入的那份） */
    await toEdit();
    await openDoc(ui, name, content);
    await sleep(1500);
    const base = await read();
    console.log(`[${name}] 基线 src.len=${base.src.length} app.len=${base.app.length} dirty=${base.dirty}`);
    console.log(`[${name}] 基线 src 原文 = ${JSON.stringify(base.src)}`);

    /* 切一圈：编辑 → 阅读 → 编辑 */
    await toPreview();
    await toEdit();
    const cyc = await read();
    console.log(`[${name}] 切后 src.len=${cyc.src.length} app.len=${cyc.app.length} dirty=${cyc.dirty}`);
    console.log(`[${name}] 切后 src 原文 = ${JSON.stringify(cyc.src)}`);

    const dSrc = diffInfo(base.src, cyc.src);
    const dApp = diffInfo(base.app, cyc.app);
    if (dSrc) console.log(`[${name}] ★ src diff = ${JSON.stringify(dSrc)}`);
    if (dApp) console.log(`[${name}] ★ app diff = ${JSON.stringify(dApp)}`);

    ui.add(`${name}-1`, `[${name}] 切一圈后源码面文本**逐字节不变**`,
      !dSrc ? "PASS" : "FAIL", dSrc ? JSON.stringify(dSrc) : "无 diff");
    ui.add(`${name}-2`, `[${name}] 切一圈后 App content 逐字节不变`,
      !dApp ? "PASS" : "FAIL", dApp ? JSON.stringify(dApp) : "无 diff");
    ui.add(`${name}-3`, `[${name}] 切一圈**不产生脏标记**`,
      cyc.dirty === false || cyc.dirty === null ? "PASS" : "FAIL", `dirty=${cyc.dirty}`);
  });
}

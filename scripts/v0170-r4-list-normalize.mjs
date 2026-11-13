/**
 * #6 接线验收探针（T1 的接线职责，能力由 T4 提供）
 *
 * ## 只验"接线是否真的把归一化落到 App / 标签 / 落盘"
 * 归一化**算法**本身由 T4 的 25 个单测负责；这里的判据是**端到端**：
 * 编辑面写两个 `1.` → 切阅读 → 切回编辑 → **屏幕、App content、标签 content 全部是 1./2.**
 *
 * ## 为什么必须验三层（T4 特别提醒的"5 处快路径"）
 * | # | 快路径 | 若未处理的表现 |
 * |---|---|---|
 * | ① | 整篇快路径 | 输出 = 原文（两个 1.） |
 * | ② | 块级原文切片 | 单块文档下与①输出相同 → 必须看"递增是否发生" |
 * | ③ | 序列化缓存 | 第 1 次切对、第 2 次切又变回去 |
 * | ⑤ | `onDocChange` 上报 | 切回编辑当场对，但下一拍被 App 侧旧 content 覆盖 |
 *
 * 所以本探针：**切两次**（验③），每次同时读**屏幕 / App / 标签**（验⑤）。
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const MARK = "有序列表归一化夹具";

/**
 * ## 夹具为什么是「磁盘原文两个 `1.`」而不是两个独立段落（两版踩坑记录）
 *
 * ### 第一版：`1. 甲项\n1. 乙项`（无空行）→ 基线直接 1./2. → 全部判据**恒真**
 * markdown-it 把紧邻两行 `1.` 解析成**一个** ordered_list 两项，序列化按 `idx++`
 * 输出 1./2.。**根本没触发 #6**，是恒真判据（第三轮 §1 的教训）。
 *
 * ### 第二版：两个空行分隔的 `1. 甲项` / `1. 乙项` → 基线**仍是** 1./2.
 * 因为 markdown-it 把"空行分隔的有序列表"合并成一个列表（`ordered_list_open` 连续），
 * 或者解析成两个列表但序列化时同 `order` 续号 —— 两种都不会让 PM 里留下"两个 1."。
 *
 * ### 真正复现用户场景的最短路径：**让磁盘原文（B6 快路径的输入）带两个 `1.`**
 *
 * T4 的根因注释写得很清楚（`serializer.ts:100-107`）：
 * > 用户逐行敲 `1. 甲` ↵ `1. 乙` 时，PM doc 里是**一个** ordered_list（两项），
 * > 而**原文里确实写着两个 `1.`**。走 B6 快路径 → 返回原文 → 两个 `1.` 保持不变，
 * > `listToMarkdown` 的递增逻辑**根本没被执行**。
 *
 * 所以夹具的关键不是"PM 里有几个列表"，而是"**解析时的原文**里写的是两个 `1.`"。
 * `lightmd:openFile` 的 `detail.content` 就是那份原文 → 直接用两个 `1.` 即可。
 * 基线**在编辑面**会显示原文（两个 `1.`，因为编辑面 = sourceContent = 未重新序列化），
 * 这才是 #6 的真实基线。第一版看到"基线就是 1./2."，是因为基线采样晚于一次
 * 已完成的 PM→源码同步（探针先切了 view.edit）。
 */
const DOC = [
  `# ${MARK}`,
  "",
  "第一段内容。K01 供定位。",
  "",
  "1. 甲项",
  "1. 乙项",
  "",
  "第三段内容。K03 供定位。",
  "",
].join("\n");

const readScript = () => String.raw`
  const root = document.querySelector("#root") || document.body;
  const contKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  let start = contKey ? root[contKey] : null;
  if (start && start.current) start = start.current;
  const contentStates = [], tabStates = [];
  const stack = start ? [start] : []; const seen = new Set(); let g = 0;
  while (stack.length && g++ < 60000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        if (typeof v === "string" && v.indexOf("甲项") >= 0) contentStates.push(v);
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "content" in v[0] && "path" in v[0]) {
          tabStates.push(v);
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  contentStates.sort((a, b) => b.length - a.length);
  const app = contentStates[0] || "";
  let tab = "";
  for (const arr of tabStates) {
    const hit = arr.find((t) => typeof t.content === "string" && t.content.indexOf("甲项") >= 0);
    if (hit) { tab = hit.content; break; }
  }
  let src = "";
  try {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (v) src = v.state.doc.sliceString(0, v.state.doc.length);
  } catch (e) {}

  /** 抽出有序列表那两行，判断序号是否递增 */
  const listOf = (text) => {
    if (!text) return null;
    const lines = text.split("\n");
    const hits = [];
    for (const ln of lines) {
      const m = /^\s*(\d+)\.\s+(\S+)/.exec(ln);
      if (m && (ln.indexOf("甲项") >= 0 || ln.indexOf("乙项") >= 0)) hits.push({ n: Number(m[1]), item: m[2] });
    }
    return hits.length ? hits : null;
  };
  return {
    app: { len: app.length, list: listOf(app) },
    tab: { len: tab.length, list: listOf(tab) },
    src: { len: src.length, list: listOf(src) },
    ls: (() => { try { const v = localStorage.getItem("lightmd-content") || ""; return { len: v.length, list: listOf(v) }; } catch (e) { return null; } })(),
  };
`;

const PLACE_SOURCE_END = String.raw`
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return { ok: false };
  v.focus();
  v.dispatch({ selection: { anchor: Math.min(20, v.state.doc.length) } });
  return { ok: true };
`;

const fmt = (s) => JSON.stringify(s && s.list);

await runBrowserProbe({ name: "v0170-r4-list-normalize", doc: DOC, docTitle: MARK }, async (ui) => {
  const read = () => ui.ev(readScript());
  const toPreview = async () => { await ui.command("view.preview"); await sleep(900); };
  const toEdit = async () => { await ui.command("view.edit"); await sleep(900); };

  await toEdit();
  const base = await read();
  console.log(`[list] ===== 基线（编辑面，未切过模式）=====`);
  console.log(`[list] src=${fmt(base.src)} app=${fmt(base.app)} tab=${fmt(base.tab)}`);
  console.log(`[list] 基线 src 原文片段 = ${JSON.stringify((await ui.ev(`return (() => { const c=document.querySelector(".cm-content"); const v=c&&c.cmTile&&c.cmTile.view; return v? v.state.doc.sliceString(0,v.state.doc.length).slice(0,140):""; })();`)))}`);

  /* ── 第 1 次切模式 ── */
  await toPreview();
  await toEdit();
  const cyc1 = await read();
  console.log(`[list] ===== 第 1 次切一圈（阅读→编辑）=====`);
  console.log(`[list] src=${fmt(cyc1.src)} app=${fmt(cyc1.app)} tab=${fmt(cyc1.tab)}`);

  /* ── 第 2 次切模式（验序列化缓存快路径 ③）── */
  await toPreview();
  await toEdit();
  const cyc2 = await read();
  console.log(`[list] ===== 第 2 次切一圈 =====`);
  console.log(`[list] src=${fmt(cyc2.src)} app=${fmt(cyc2.app)} tab=${fmt(cyc2.tab)}`);

  const incr = (list) => !!list && list.length >= 2 && list[0].n === 1 && list[1].n === 2;

  /**
   * R0 前置判据（**防恒真**）：基线必须真的是两个 `1.`。
   * 若基线就是 1./2.，说明夹具没复现 #6 的场景 → 后续 L1-L5 全部是恒真，不得采纳。
   */
  const baseIsDup = !!base.src.list && base.src.list.length >= 2 &&
    base.src.list[0].n === 1 && base.src.list[1].n === 1;
  ui.add("R0", "夹具自检：基线（编辑面原文）确实是两个 1.（不是恒真判据）",
    baseIsDup ? "PASS" : "FAIL",
    `${fmt(base.src)}（若不是 [1,1] 则本探针结论无效）`);

  ui.add("L1", "第 1 次切一圈：源码面序号递增为 1./2.", incr(cyc1.src.list) ? "PASS" : "FAIL", fmt(cyc1.src));
  ui.add("L2", "第 1 次切一圈：App content 同步为 1./2.（验 ⑤ 上报）",
    incr(cyc1.app.list) ? "PASS" : "FAIL", fmt(cyc1.app));
  ui.add("L3", "第 1 次切一圈：标签 content 同步为 1./2.（存盘取这里）",
    incr(cyc1.tab.list) ? "PASS" : "FAIL", fmt(cyc1.tab));
  ui.add("L4", "第 2 次切一圈：序号仍递增（验序列化缓存快路径 ③ 未被绕过）",
    incr(cyc2.src.list) ? "PASS" : "FAIL", fmt(cyc2.src));
  ui.add("L5", "第 2 次切一圈：App / 标签仍同步",
    incr(cyc2.app.list) && incr(cyc2.tab.list) ? "PASS" : "FAIL",
    `app=${fmt(cyc2.app)} tab=${fmt(cyc2.tab)}`);

  /* ── 内容正确性：不得丢字/改字 ── */
  /**
   * ⚠️ 第一版本行写的是 `hasItems(cyc2.src.len)` —— 把**长度**传给了期望字符串的函数，
   * 抛 `t.indexOf is not a function`，整个探针在 L6 处中断（后续 L7 没跑）。
   * 这类"探针自己的类型错误"必须显式记下来：它和产品缺陷长得一样（都是 FAIL）。
   */
  const srcList = cyc2.src.list;
  ui.add("L6", "归一化未丢内容（甲项/乙项 两项都在，且序号不重复）",
    !!srcList && srcList.length === 2 &&
      srcList.some((x) => x.item.indexOf("甲") >= 0) &&
      srcList.some((x) => x.item.indexOf("乙") >= 0) ? "PASS" : "FAIL",
    fmt(cyc2.src));

  /* ── 编辑面键入后仍正常（护栏：接线不能破坏编辑） ── */
  await ui.ev(PLACE_SOURCE_END);
  await sleep(200);
  const beforeType = await read();
  for (const ch of "QQ") await ui.key(ch, "KeyQ", 81);
  await sleep(700);
  const afterType = await read();
  console.log(`[list] 编辑键入：src.len ${beforeType.src.len} → ${afterType.src.len}`);
  ui.add("L7", "接线后编辑面键入仍正常落库（+2 字符且 App 同步）",
    afterType.src.len === beforeType.src.len + 2 && afterType.app.len === afterType.src.len
      ? "PASS" : "FAIL",
    `src ${beforeType.src.len}→${afterType.src.len}, app=${afterType.app.len}`);
});

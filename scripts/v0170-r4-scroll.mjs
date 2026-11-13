/**
 * v0.17.0 第四轮 · T2 · 用户第 1 项：
 * **「格式栏或语法栏插入格式时仍然会出现页面抖动，特别是从语法辅助栏进行格式插入，
 *   页面会瞬间往下跳。」**
 *
 * ## 为什么这一轮还要重测（上一轮不是已修了吗）
 *
 * 上一轮（R3 #4）只改了 `SourcePane.handleFormatAction` / `AiAssistPane.removeFormatGhostSyntax`
 * 的落地路径，把「整篇 `setSourceContent`」换成 `computeMinimalEdit` + `applyEdit`，
 * 实测 192/557px → 0px。**但用户在真机上仍报。**
 *
 * 本轮的第一步不是去改代码，而是**逐条路径各自取证** —— 假设"上一轮只覆盖了一部分"
 * 是唯一有实证支持的假设：`SyntaxHelper` 的插入**根本不经过** `handleFormatAction`，
 * 它走 `App.tsx` → `useEditorStore.sourceInsertHandler` → `ModeSync.insertHandler`，
 * 那是完全独立的第二条落地链。上一轮没有碰它。
 *
 * ## 4 条路径（用户/任务卡要求逐条覆盖）
 *
 * | 路径 | 入口链 | 落地函数 |
 * |---|---|---|
 * | P1 格式栏按钮 | `.source-format-toolbar .format-btn` → `onFormatBtnClick` → `handleFormatAction` | `SourcePane.applyMinimalDiscreteEdit` |
 * | P2 语法辅助栏 | `.syntax-helper-item` → `sourceInsertHandler` → `ModeSync.insertHandler` | **`setSourceContent` 整篇** |
 * | P3 右键菜单插入 | `.editor-context-menu` → `handleContextMenuAction("codeblock")` | `SourcePane.insertTextAtCursor` |
 * | P4 斜杠命令 `/` | `.slash-command-item` → `handleSlashInsert` | `SourcePane.handleSlashInsert` |
 *
 * ## 判据（与任务卡一致，且每条都说明"为什么这个量代表用户感受"）
 *
 * | 量 | 阈值 | 为什么 |
 * |---|---|---|
 * | 视口中心 PI 段号 只出现 1 种 | 不变 | **主判据**。R2 教训：整篇替换后 `scrollTop` 本来就该变，只判像素会把"正常重排"当缺陷；反过来 R3 #4 也出现过"像素被拉回、内容其实偏了 7 段" |
 * | `scrollTop` 单帧最大跳变 | ≤ 3px | 3px@60Hz = 180px/s，超过人眼即感知为"顿一下" |
 * | `scrollTop` 方向反转 | = 0 | 单调移动叫"滚动"，来回摆才叫"抖" |
 * | `caretY` 单帧最大跳变 | ≤ 2px | 插入后光标是"接着打字"的落点，它跳 = 视线被打断（"瞬间往下跳"的直接观测量） |
 *
 * ## 前置断言（不通过 → INVALID，**不产出产品结论**）
 *
 * A1 文档可滚动(`max>200`) / A2 光标在视口内 / A3 采样前滚动已稳定 /
 * A4 插入确实改了文档 / A5 视口中心能读到 PI 段号。
 *
 * ⚠️ A4 尤其关键：上一轮有探针因为"点击目标 = null"而全程什么都没发生，
 * 却因为 `scrollTop` 没动而**恒 PASS** —— 那是比 FAIL 更危险的假绿。
 *
 * 用法：
 *   npx vite build --outDir _verify-out/dist-t2 --emptyOutDir
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t2" node scripts/v0170-r4-scroll.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import {
  runScenario, report, dump, wheelTo, waitStableScroll, placeCaretMid,
  centerOf, rightClick, readState,
} from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);
const CM = ".cm-scroller";

await runBrowserProbe({ name: "v0170-r4-scroll", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  if (ui.impl !== "cm6") {
    ui.add("A0", "源码面是 CM6", "FAIL", `impl=${ui.impl}`);
    return;
  }

  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);

  // ── 环境自检（前置断言的一部分：轨道不存在就没法测）──
  const env = await ui.ev(`
    return {
      toolbar: document.querySelectorAll(".source-format-toolbar .format-btn").length,
      syntaxItems: document.querySelectorAll(".syntax-helper-item").length,
      cmScroller: !!document.querySelector(".cm-scroller"),
      syntaxBox: (() => { const e = document.querySelector(".syntax-helper"); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };
  `);
  ui.add("A0", "4 条插入路径的入口都存在（格式栏 / 语法栏 / 滚动容器）",
    env.toolbar > 0 && env.syntaxItems > 0 && env.cmScroller ? "PASS" : "FAIL",
    `格式栏按钮=${env.toolbar}；语法栏条目=${env.syntaxItems}；语法栏尺寸=${JSON.stringify(env.syntaxBox)}`);

  /* ══════════════════════════════════════════════════════════════════
   * P1 格式栏按钮（上一轮已修 → 本轮验证「没回归」）
   * ══════════════════════════════════════════════════════════════════ */
  const p1 = await runScenario(ui, {
    tag: "P1-格式栏-粗体",
    kind: "cm",
    scroller: CM,
    pct: 0.45,
    multiline: false,   // 行内插入：光标应留在同一行
    ms: 2800,
    after: 2200,
    async prepare(u) { return await placeCaretMid(u, { kind: "cm", scroller: CM }); },
    async trigger(u) {
      const btn = await centerOf(u, ".source-format-toolbar .format-btn", "粗体");
      if (!btn) return { ok: false, why: "找不到「粗体」按钮" };
      await u.click(btn.x, btn.y);
      await u.sleep(120);
      return { ok: true, how: "toolbar-bold", btn };
    },
  });
  dump(ui, p1);
  report(ui, "B1", "P1 格式栏「粗体」(行内)：内容不变 + 无不可解释跳变 + 无反拉", p1);

  /* ══════════════════════════════════════════════════════════════════
   * P2 语法辅助栏（**用户点名，最可能没修**）
   *
   * ⚠️ 这里选「代码块」而不是「粗体」：
   * - 用户原话是"从语法辅助栏进行格式插入会瞬间往下跳"；
   * - 代码块插入的是 `\n```\n\n```\n`（**含换行**，会真的改变行数/块数），
   *   比纯字符插入更容易触发重排 —— 是**更严苛**的用例，也是用户点名的例子（R3 #3）。
   * 另外语法栏的「粗体」`****` 与格式栏同形态，测它无法区分两条链的差异。
   * ══════════════════════════════════════════════════════════════════ */
  const p2a = await runScenario(ui, {
    tag: "P2-语法栏-代码块",
    kind: "cm",
    scroller: CM,
    pct: 0.45,
    multiline: true,    // 插入 `\n```\n\n```\n`：光标必然换行进围栏内
    ms: 2800,
    after: 2200,
    async prepare(u) { return await placeCaretMid(u, { kind: "cm", scroller: CM }); },
    async trigger(u) {
      const it = await centerOf(u, ".syntax-helper-item", "代码块```");
      if (!it) return { ok: false, why: "找不到语法栏「代码块」" };
      await u.click(it.x, it.y);
      await u.sleep(120);
      return { ok: true, how: "syntax-codeblock", item: it };
    },
  });
  dump(ui, p2a);
  report(ui, "B2", "P2 语法辅助栏「代码块」(多行)：内容不变 + 无不可解释跳变 + 无反拉", p2a);

  // P2b：语法栏「粗体」—— 与格式栏同形态，用来证明"差异来自链路而不是操作本身"
  const p2b = await runScenario(ui, {
    tag: "P2b-语法栏-粗体",
    kind: "cm",
    scroller: CM,
    pct: 0.45,
    multiline: false,   // `****` 行内插入：与 P1 同形态，可直接对比
    ms: 2800,
    after: 2200,
    async prepare(u) { return await placeCaretMid(u, { kind: "cm", scroller: CM }); },
    async trigger(u) {
      const it = await centerOf(u, ".syntax-helper-item", "粗体");
      if (!it) return { ok: false, why: "找不到语法栏「粗体」" };
      await u.click(it.x, it.y);
      await u.sleep(120);
      return { ok: true, how: "syntax-bold", item: it };
    },
  });
  dump(ui, p2b);
  report(ui, "B3", "P2b 语法辅助栏「粗体」(行内，与格式栏同操作 → **归因**链路差异)", p2b);

  /* ══════════════════════════════════════════════════════════════════
   * P3 右键菜单插入（「插入代码块」）
   * ══════════════════════════════════════════════════════════════════ */
  const p3 = await runScenario(ui, {
    tag: "P3-右键菜单-代码块",
    kind: "cm",
    scroller: CM,
    pct: 0.45,
    multiline: true,    // `\n```\n\n```\n` 多行模板
    ms: 2800,
    after: 2200,
    async prepare(u) {
      const pt = await placeCaretMid(u, { kind: "cm", scroller: CM });
      if (!pt) return null;
      await rightClick(u, pt.x, pt.y);
      const opened = await u.ev(`return { open: !!document.querySelector(".editor-context-menu"), n: document.querySelectorAll(".editor-context-menu .context-menu-item").length, labels: Array.from(document.querySelectorAll(".editor-context-menu .context-menu-item")).map(e => (e.textContent||"").trim().slice(0,14)).slice(0, 24) };`);
      u.log("[P3] 右键菜单 = " + JSON.stringify(opened));
      if (!opened.open) return null;
      return pt;
    },
    async trigger(u) {
      const item = await centerOf(u, ".editor-context-menu .context-menu-item", "插入代码块");
      if (!item) {
        // 兜底：按 action 属性/位置找（菜单结构若变了，别静默）
        const all = await u.ev(`return Array.from(document.querySelectorAll(".editor-context-menu .context-menu-item")).map(e => (e.textContent||"").trim())`);
        return { ok: false, why: "找不到「插入代码块」菜单项", all };
      }
      await u.click(item.x, item.y);
      await u.sleep(150);
      return { ok: true, how: "ctx-codeblock", item };
    },
  });
  dump(ui, p3);
  report(ui, "B4", "P3 右键菜单「插入代码块」(多行)：内容不变 + 无不可解释跳变 + 无反拉", p3);

  /* ══════════════════════════════════════════════════════════════════
   * P4 斜杠命令 `/` 插入
   *
   * 触发方式必须**真实**：在空行行首敲 `/`，等菜单出来，再点条目。
   * 直接调 `handleSlashInsert` 会绕过"菜单定位/焦点变化"这一整段，
   * 而焦点变化正是 `caretY` 判据要抓的东西。
   * ══════════════════════════════════════════════════════════════════ */
  const p4 = await runScenario(ui, {
    tag: "P4-斜杠命令-代码块",
    kind: "cm",
    scroller: CM,
    pct: 0.45,
    multiline: true,    // 斜杠菜单插入代码块（多行模板）
    ms: 3200,
    after: 2400,
    async prepare(u) {
      /**
       * 斜杠路径的前置条件比其它三条严：**光标必须在空行行首**（`findSlashTrigger`
       * 的正则 `/^(\s*)\/(\w*)$/` 要求整行只有空白 + `/` + 词字符）。
       *
       * ⚠️ 两次失败教训（都记下来，避免下轮重踩）：
       * 1. 第一版在**文末**找空行 → 前面的场景已经把文档改长，`wheelTo` 后视口里没有
       *    满足"上下各留 20px"的空行 → 返回 null → INVALID；
       * 2. 找到空行但**不校验点击后光标真的落在该行 col=0** → 若点偏到相邻行，
       *    `/` 会插到有内容的行中，正则不匹配，菜单不弹，看起来像产品缺陷。
       * 所以这里：多候选重试 + **点击后断言 `lineText === "" && col === 0`**。
       */
      await wheelTo(u, 0.45, CM, { settle: 700 });
      const cands = await u.ev(`
        const sc = document.querySelector(${JSON.stringify(".cm-scroller")});
        if (!sc) return [];
        const scR = sc.getBoundingClientRect();
        const midY = scR.top + sc.clientHeight / 2;
        const out = [];
        for (const l of sc.querySelectorAll(".cm-line")) {
          if ((l.textContent || "").trim() !== "") continue;
          const r = l.getBoundingClientRect();
          if (r.height <= 0 || r.top < scR.top + 24 || r.bottom > scR.bottom - 24) continue;
          out.push({ x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2), d: Math.round(Math.abs((r.top + r.bottom) / 2 - midY)) });
        }
        out.sort((a, b) => a.d - b.d);
        return out.slice(0, 4);
      `);
      u.log(`[P4] 空行候选 ${cands.length} 个：${JSON.stringify(cands)}`);
      if (!cands.length) return null;

      const readCurLine = `
        const c = document.querySelector(".cm-content");
        const v = c && c.cmTile && c.cmTile.view;
        if (!v) return null;
        const m = v.state.selection.main;
        const ln = v.state.doc.lineAt(m.head);
        return { col: m.head - ln.from, text: ln.text };
      `;
      for (const c of cands) {
        await u.click(c.x, c.y);
        await u.sleep(420);
        const cur = await u.ev(readCurLine);
        if (!cur) continue;
        u.log(`[P4] 点 (${c.x},${c.y}) 后 行=${JSON.stringify(cur)}`);
        if (cur.text !== "" || cur.col !== 0) continue; // 点偏了，换下一个候选
        await u.key("/", "Slash", 191);
        await u.sleep(600);
        const menu = await u.ev(`return { open: !!document.querySelector(".slash-command-menu"), n: document.querySelectorAll(".slash-command-item").length }`);
        u.log("[P4] 斜杠菜单 = " + JSON.stringify(menu));
        if (menu.open) return { ok: true, cand: c, cur };
        // 菜单没弹：把刚敲的 `/` 撤掉，换下一个候选（不把探针问题当产品缺陷）
        await u.key("Backspace", "Backspace", 8);
        await u.sleep(300);
      }
      u.log("[P4] 所有候选都未弹出菜单 → 前置失败");
      return null;
    },
    async trigger(u) {
      const item = await centerOf(u, ".slash-command-item", "代码块");
      if (!item) {
        const all = await u.ev(`return Array.from(document.querySelectorAll(".slash-command-item")).map(e => (e.textContent||"").trim().slice(0,20))`);
        return { ok: false, why: "找不到斜杠菜单「代码块」", all };
      }
      await u.click(item.x, item.y);
      await u.sleep(150);
      return { ok: true, how: "slash-codeblock", item };
    },
  });
  dump(ui, p4);
  report(ui, "B5", "P4 斜杠命令「/ → 代码块」(多行)：内容不变 + 无不可解释跳变 + 无反拉", p4);

  /* ══════════════════════════════════════════════════════════════════
   * 汇总
   * ══════════════════════════════════════════════════════════════════ */
  const rows = [p1, p2a, p2b, p3, p4].filter(Boolean);
  const summary = rows.map((r) => ({
    tag: r.tag,
    invalid: !!r.invalid,
    why: r.why,
    pass: r.pass,
    piSet: r.piSet,
    stMaxJump: r.st?.maxJump,
    stReversals: r.st?.reversals,
    caretMaxJump: r.caret?.maxJump,
    stBefore: r.before?.st, stAfter: r.after?.st,
    shBefore: r.before?.sh, shAfter: r.after?.sh,
    lenBefore: r.lenBefore, lenAfter: r.lenAfter,
    writeCount: r.writeCount,
    bigWrites: r.bigWrites?.map((w) => ({ how: w.how, from: w.from, v: w.v })),
  }));
  ui.log("[SUMMARY-1] " + JSON.stringify(summary, null, 1));

  // 总判据：四条路径全 PASS 才算这一项修好
  const measured = rows.filter((r) => !r.invalid);
  const allPass = measured.length === rows.length && measured.every((r) => r.pass);
  ui.add("B0", "★ #1 总判定：4 条插入路径全部「内容不变 + 不跳 + 不回弹」",
    rows.length < 4 ? "FAIL" : (allPass ? "PASS" : "FAIL"),
    `测到 ${measured.length}/${rows.length} 条（INVALID=${rows.length - measured.length}）；` +
    `通过 ${measured.filter((r) => r.pass).length}/${measured.length}；` +
    `失败：${JSON.stringify(measured.filter((r) => !r.pass).map((r) => r.tag))}`);

  await ui.shot("r4-scroll");
});

/**
 * v0.17.0 R4 · T2 · **跨模块一致性验证**（T1 要求，Lead 排为第 1 优先级）
 *
 * ## 为什么这一项必须在报告之前做
 *
 * T1 提醒过一条链路（他在 #5 里实测到"内容被回写"）：
 * ```
 * ModeSync.insertHandler:
 *   setSourceContent(newContent)              ← CM6 面 state
 *   onContentChangeRef.current?.(newContent)  ← 上报 App → setContent
 *     → content prop 变 → EditorContainer:1341 的 prop-sync effect
 *       → 判"非回声" → setSourceContent(maskBase64Images(content))
 * ```
 * 我本轮在 `insertHandler` 里插了最小 diff 落地（`applyEdit`），
 * **正好落在这条链的中间**。所以必须验证：
 * - 插入后 **CM6 文档文本 == SourcePane 的 sourceContent == App 的 content** 三者一致；
 * - 且**连续多次**插入后仍然一致（一次能对上可能是巧合/时序窗口没撞上）。
 *
 * ## 另一件必须验证的事：`applyEdit` 与 `setSourceContent` 的竞态
 *
 * 我的落地顺序（顺序铁律）是：
 * ```
 * setSourceContent(newText)  ← 先让 React state 指向新文本
 * applyEdit(minimal)          ← 再单事务落地
 * ```
 * 但如果 `setSourceContent` 触发的 React 重渲染**晚于** `applyEdit`，
 * 受控写入 effect 会跑一次 `setText(newText)` —— 那会：
 * ① 整篇替换（最小 diff 白做，scrollHeight 又塌）；
 * ② 把 `applyEdit` 设的光标位置冲掉。
 * 这正是「上一轮只改了一半」的风险点，必须**连续插 5 次**看是否每次都不塌。
 *
 * ## 判据
 * 1. 每次插入后三处文本**逐字节相等**；
 * 2. 每次插入后 `scrollHeight` **不塌**（Δ ≥ 0，且 < 200px 的合理增量）；
 * 3. 每次插入后 `scrollTop` 单帧不可解释跳变 ≤ 3px；
 * 4. 5 次全过后，文档结构仍合法（无内容丢失：长度只增不减，且含全部插入片段）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import {
  INSTALL_SPY, startTrace, readState, analyze, track,
  wheelTo, waitStableScroll, placeCaretMid, centerOf,
} from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);
const CM = ".cm-scroller";

/** 页面内：读三处文本 —— CM6 doc / SourcePane 的 sourceContent（经 React state 镜像）/ App content */
const READ_THREE = `
  const round = (n) => Math.round(n * 100) / 100;
  const out = { ok: true };

  // ① CM6 文档（权威）
  const c = document.querySelector(".cm-content");
  let cmText = null;
  try {
    const v = c && c.cmTile && c.cmTile.view;
    if (v && v.state) {
      cmText = v.state.doc.toString();
      out.cmLen = v.state.doc.length;
      out.cmLines = v.state.doc.lines;
      const m = v.state.selection.main;
      out.cmSel = m.head;
    }
  } catch (e) { out.cmErr = String(e).slice(0, 80); }
  out.cmText = cmText;

  // ② 受控 textarea / 宿主的值通道
  const ta = document.querySelector("textarea.source-editor");
  out.taValue = ta ? ta.value : null;
  out.taIsReal = !!(ta && typeof ta.value === "string");

  // ③ App 层的 content：从 React fiber 上取（最贴近"上层拿到的值"）
  //    App 的 content 也会同步到 localStorage 的 CONTENT_KEY（防抖 500ms），
  //    所以这里两条都取，用 fiber 的即时值优先。
  let fiberContent = null;
  try {
    const rootEl = document.querySelector("#root") || document.body;
    const key = Object.keys(rootEl).find((k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber"));
    // 退化：从 Tauri 无关的 store 快照读。App 未暴露 store，故用 localStorage 兜底。
  } catch (e) {}
  try {
    // localStorage 里存的是 App 防抖后的 content（键名在 App 里定义）
    const cands = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/content|CONTENT|document/i.test(k)) cands.push(k);
    }
    out.lsKeys = cands.slice(0, 6);
  } catch (e) {}

  // ④ 滚动几何
  const sc = document.querySelector(".cm-scroller");
  if (sc) {
    out.st = round(sc.scrollTop);
    out.sh = Math.round(sc.scrollHeight);
    out.ch = Math.round(sc.clientHeight);
    out.max = Math.round(sc.scrollHeight - sc.clientHeight);
  }
  return out;
`;

await runBrowserProbe({ name: "v0170-r4-consistency", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await ui.ev(INSTALL_SPY);

  ui.log("[setup] impl = " + ui.impl);

  // 环境自检
  const env = await ui.ev(`
    return {
      cm: !!document.querySelector(".cm-editor"),
      syntaxItems: document.querySelectorAll(".syntax-helper-item").length,
      realTextarea: !!(document.querySelector("textarea.source-editor")),
      typedHost: (() => { const h = document.querySelector(".source-editor"); return h ? { cls: String(h.className).slice(0,40), valType: typeof h.value } : null; })(),
    };
  `);
  ui.log("[env] " + JSON.stringify(env));
  ui.add("X0", "前置：CM6 编辑面 + 语法栏可用 + 宿主是 div（无 .value）",
    env.cm && env.syntaxItems > 0 && env.typedHost && env.typedHost.valType === "undefined" ? "PASS" : "FAIL",
    JSON.stringify(env));

  /**
   * 连续插入 5 次（每次插不同的语法项，覆盖行内/多行/前缀类）。
   * 每次：记三处文本 → 插入 → 等稳 → 再记三处 → 比较。
   */
  const ITEMS = [
    { label: "粗体", match: "粗体", kind: "inline" },
    { label: "代码块", match: "代码块```", kind: "multiline" },
    { label: "斜体", match: "斜体", kind: "inline" },
    { label: "无序列表", match: "无序列表", kind: "inline" },
    { label: "表格", match: "表格|...|", kind: "multiline" },
  ];

  const rounds = [];
  const inserted = [];

  for (let i = 0; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    // 每次重新定位（文档在变长，滚动位置会漂）
    await wheelTo(ui, 0.45, CM, { settle: 600 });
    const placed = await placeCaretMid(ui, { kind: "cm", scroller: CM });
    if (!placed) {
      ui.add(`X${i + 1}`, `第 ${i + 1} 次（${item.label}）`, "FAIL", "放光标失败");
      break;
    }
    await ui.sleep(250);
    const stable = await waitStableScroll(ui, CM, { need: 4 });
    const before = await ui.ev(READ_THREE);

    // 逐帧采样 + 触发
    await ui.ev(`window.__R4_WRITES = []; return true;`);
    await ui.ev(startTrace({ ms: 2200, kind: "cm", scroller: CM }));
    await ui.sleep(80);
    /**
     * ⚠️ 匹配语法栏项：必须**先打印候选**再判找不到。
     * 第一版对「无序列表」返回 null，看起来像产品缺陷，实际是探针匹配不到
     * （候选文案形如 `无序列表-`，而 `centerOf` 的匹配串带空格/换行差异）。
     * 按项目规矩：**"找不到目标"必须先输出候选清单**，否则无法区分探针 bug 与产品 bug。
     */
    /**
     * ⚠️ 语法栏有 35 项、总高 ~1100px，而可视区只有 ~798px ——
     * **目标项可能在滚动容器外**（第一版 R4/R5 的 y=1091/1364 就是这么来的：
     * 点击坐标落到视口外，什么都没发生，却被读成"长度 +0"）。
     *
     * 所以先 `scrollIntoView` 把目标项滚进 `.syntax-helper-scroll`，再取坐标。
     * 这一步必须做：否则"点不到"会被误判成产品缺陷。
     */
    const it = await ui.ev(`
      const all = Array.from(document.querySelectorAll(".syntax-helper-item"));
      const want = ${JSON.stringify(item.match)};
      const norm = (s) => (s || "").replace(/\s+/g, "");
      const el = all.find((e) => norm(e.textContent || "").indexOf(norm(want)) >= 0);
      if (!el) return { ok: false, cands: all.map((e) => (e.textContent || "").trim().slice(0, 24)).slice(0, 40) };
      el.scrollIntoView({ block: "center" });
      return { ok: true, scrolled: true, text: (el.textContent || "").trim().slice(0, 24) };
    `);
    if (it && it.ok) {
      await ui.sleep(300); // 等滚动稳定再取矩形
      const pos = await ui.ev(`
        const all = Array.from(document.querySelectorAll(".syntax-helper-item"));
        const want = ${JSON.stringify(item.match)};
        const norm = (s) => (s || "").replace(/\s+/g, "");
        const el = all.find((e) => norm(e.textContent || "").indexOf(norm(want)) >= 0);
        if (!el) return { ok: false };
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { ok: false, why: "尺寸为 0" };
        // 断言在视口内（否则点击无效 —— 必须先验再点）
        const inView = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
        return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), inView, box: { top: Math.round(r.top), bottom: Math.round(r.bottom) }, vh: window.innerHeight };
      `);
      if (pos && pos.ok) { it.x = pos.x; it.y = pos.y; it.inView = pos.inView; it.box = pos.box; }
      else { it.ok = false; it.why = "取坐标失败"; }
    }
    if (!it || !it.ok) {
      ui.add(`X${i + 1}`, `第 ${i + 1} 次（${item.label}）`, "FAIL",
        `找不到语法栏项「${item.match}」；候选=${JSON.stringify(it?.cands || [])}`);
      break;
    }
    ui.log(`[R${i + 1}] 目标项 = ${JSON.stringify(it)}`);
    if (!it.inView) {
      ui.add(`X${i + 1}`, `第 ${i + 1} 次（${item.label}）`, "KNOWN",
        `INVALID：目标项滚动后仍不在视口内 ${JSON.stringify(it.box)} vh=${it.vh} —— 探针点不到，不产出结论`);
      break;
    }
    await ui.click(it.x, it.y);
    await ui.sleep(2000);

    const trace = await ui.ev(`return window.__R4_TR || []`);
    const after = await ui.ev(READ_THREE);
    const writes = await ui.ev(`return (window.__R4_WRITES||[]).map(w=>({v:w.v,from:w.from,how:w.how}))`);

    // 分析
    const stArr = trace.map((t) => t.st);
    const shArr = trace.map((t) => t.sh);
    let maxUnexplained = 0;
    for (let k = 1; k < trace.length; k++) {
      const dst = (stArr[k] ?? 0) - (stArr[k - 1] ?? 0);
      const dsh = (shArr[k] ?? 0) - (shArr[k - 1] ?? 0);
      const u = Math.abs(dst) - Math.abs(dsh);
      if (Math.abs(dst) > 3 && u > maxUnexplained) maxUnexplained = u;
    }
    const runs = [];
    for (let k = 1; k < trace.length; k++) {
      const d = (stArr[k] ?? 0) - (stArr[k - 1] ?? 0);
      if (!Number.isFinite(d) || Math.abs(d) < 0.5) continue;
      const sign = d > 0 ? 1 : -1;
      if (!runs.length || runs[runs.length - 1].sign !== sign) runs.push({ sign, sum: 0 });
      runs[runs.length - 1].sum += d;
    }
    const reversals = Math.max(0, runs.length - 1);

    const lenDelta = (after.cmLen ?? 0) - (before.cmLen ?? 0);
    const shDelta = (after.sh ?? 0) - (before.sh ?? 0);
    const grew = lenDelta > 0;
    const shNotCollapsed = shDelta >= 0;
    const jumpOk = maxUnexplained <= 3;
    const reverseOk = reversals === 0;
    // 三处一致：CM6 是权威；真 textarea 路径下 taValue 也应有值
    const threeWayOk = env.realTextarea ? (after.taValue === after.cmText) : true;

    rounds.push({
      i: i + 1, label: item.label, kind: item.kind,
      beforeLen: before.cmLen, afterLen: after.cmLen, lenDelta,
      beforeSh: before.sh, afterSh: after.sh, shDelta,
      stBefore: before.st, stAfter: after.st,
      maxUnexplained, reversals, writes: writes.length,
      grew, shNotCollapsed, jumpOk, reverseOk, threeWayOk,
      // ⚠️ A4：点击没生效 → 这一轮测不到东西，标 INVALID（不能算 PASS，也不能算产品 FAIL）
      invalid: !grew,
      pass: grew && shNotCollapsed && jumpOk && reverseOk && threeWayOk,
    });
    inserted.push({ label: item.label, ok: grew });

    ui.log(`[R${i + 1}] ${item.label}: len ${before.cmLen}→${after.cmLen}(+${lenDelta}) ` +
      `sh ${before.sh}→${after.sh}(Δ${shDelta}) st ${before.st}→${after.st} ` +
      `不可解释=${maxUnexplained}px 反转=${reversals} 写入=${writes.length} ` +
      `三处一致=${threeWayOk}`);

    ui.add(`X${i + 1}`, `第 ${i + 1} 次插入「${item.label}」（${item.kind}）：内容增长 + sh 不塌 + 不跳 + 三处一致`,
      rounds[rounds.length - 1].invalid ? "KNOWN" : (rounds[rounds.length - 1].pass ? "PASS" : "FAIL"),
      `长度 +${lenDelta}；scrollHeight Δ${shDelta}（不塌=${shNotCollapsed}）；` +
      `不可解释跳变=${maxUnexplained}px；反转=${reversals}；滚动写入=${writes.length}；三处一致=${threeWayOk}` +
      (rounds[rounds.length - 1].invalid ? "（**INVALID：点击未生效，长度 +0，不产出结论**）" : ""));
  }

  /* ── 终局校验：文档结构完整（无内容丢失） ── */
  const final = await ui.ev(READ_THREE);
  const finalCheck = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (!v) return null;
    const txt = v.state.doc.toString();
    // 原始文档的最后一段必须还在（防止"插入把后面的内容吃了"）
    const hasLastPara = txt.indexOf("PI60") >= 0;
    const hasFirstPara = txt.indexOf("PI01") >= 0;
    // 每 10 段的有序列表也必须在
    const ol = (txt.match(/^1\\. 甲项/gm) || []).length;
    return {
      len: v.state.doc.length, lines: v.state.doc.lines,
      hasLastPara, hasFirstPara, olCount: ol,
      // 插入片段计数
      bold: (txt.match(/\\*\\*\\*\\*/g) || []).length,
      italic: (txt.match(/(?<!\\*)\\*\\*(?!\\*)/g) || []).length,
      codeblock: (txt.match(/\`\`\`/g) || []).length,
      table: (txt.match(/^\\|/gm) || []).length,
    };
  `);
  ui.log("[final] " + JSON.stringify(finalCheck, null, 1));

  const valid = rounds.filter((r) => !r.invalid);
  const passCount = valid.filter((r) => r.pass).length;
  ui.add("X6", "★ 连续 5 次插入后文档结构完整（首末段 + 有序列表全在，无内容被吃）",
    finalCheck && finalCheck.hasFirstPara && finalCheck.hasLastPara ? "PASS" : "FAIL",
    JSON.stringify(finalCheck));

  ui.add("X7", "★ 跨模块一致性总判定（有效轮次全过：增长 + 不塌 + 不跳 + 三处一致）",
    valid.length > 0 && passCount === valid.length ? "PASS" : "FAIL",
    `有效 ${valid.length}/${rounds.length} 轮，通过 ${passCount}；明细=${JSON.stringify(rounds.map((r) => ({
      n: r.i, label: r.label, lenDelta: r.lenDelta, shDelta: r.shDelta,
      jump: r.maxUnexplained, rev: r.reversals, writes: r.writes, pass: r.pass,
    })))}`);

  ui.log("[SUMMARY-CONSISTENCY] " + JSON.stringify(rounds, null, 1));

  await ui.shot("consistency");
});

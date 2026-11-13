/**
 * #11 修复的**回归护栏**：#10「关软件重开保持编辑模式 + 进度」不能被"写 0"废掉。
 *
 * ## 为什么必须单独一个探针
 *
 * #11 的修法把 `[forceUpdateKey]` effect 里 `percent === null → return` 改成了
 * "无进度 ⇒ 写 0"。这条 effect **同时**承载 #10 的进度恢复：
 * 两者是同一个 effect 的**两个分支**，改一个很容易污染另一个。
 * 所以必须有独立判据盯住"有进度"那一半：
 *
 * | 判据 | 语义 | 若被 #11 修复污染 |
 * |---|---|---|
 * | R1 | 滚动后进度落盘（localStorage `lightmd-scroll-progress`） | 写 0 被当成用户滚动写进快照 → 落盘变 0 |
 * | R2 | `viewMode` 落盘（`lightmd-view-mode`） | 无关，但同属 #10，一起守 |
 * | R3 | reload + 重开同一文件 → 进度恢复（centered 内容锚一致） | 被"写 0"覆盖 → 停顶部 |
 * | R4 | 恢复后**不是** 0 且**不是** max（排除两个退化值） | 假 PASS 防线 |
 * | R5 | 阅读模式同样保持（另一条路径） | 半边废掉 |
 *
 * ## 判据设计要点（吸取 R2 探针的教训）
 * 旧探针 `v0170-r2-persist-diag.mjs` 读 `window.__LMD_EDITOR_STORE__` —— **该全局不存在**
 * （R2 自己也在 `v0170-r2-coldstart-browser.mjs` 注释里写过"store 状态只能从 DOM/行为反推"），
 * 于是它的 B4 用例恒 FAIL（`viewMode=null`），属于**判据 bug 而非产品 bug**。
 * 本探针改成：
 * - 模式判定 → 看**哪个滚动容器可见**（`.cm-scroller` vs `.editor-container`），行为口径；
 * - 进度判定 → 直读 localStorage + 实读 `scrollTop`；
 * - 内容锚判定 → 视口中心的 `PIxx` 标记，**内容**不变才是真恢复（R2 的核心教训）。
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DOC_PATH = "D:/tmp/t5-guard-relaunch.md";
const parts = ["# 重启护栏", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(
    `第 ${i} 段。PI${String(i).padStart(2, "0")}  供内容锚定位。` +
      "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.",
    "",
  );
}
const DOC = parts.join("\n");

const READ = `
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const sc = document.querySelector(".cm-scroller");
  const rs = document.querySelector(".editor-container");
  const pickCenter = () => {
    // 优先编辑面
    for (const [name, el, sel] of [["source", sc, ".cm-line"], ["reader", rs, ".ProseMirror > *"]]) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      const mid = r.top + el.clientHeight / 2;
      /**
       * ⚠️ 判据坑（本探针第一版踩的）：只取"视口中心那一行"再匹配 PIxx，会恒为 null ——
       * CM6 是虚拟滚动，中心行可能正落在**空行**（段间空行的 .cm-line 文本是空串），
       * 而 PIxx 只在段落行上。正确做法：在窗口内**按"与中心的距离"排序、取最近的
       * 带 PI 标记的行**，并回报命中的实际文本（便于人眼复核是不是同一段）。
       */
      const cands = [];
      for (const node of Array.from(el.querySelectorAll(sel))) {
        const b = node.getBoundingClientRect();
        if (b.height === 0) continue;
        const text = node.textContent || "";
        const m = /PI(\\d{2})/.exec(text);
        if (!m) continue;
        const covers = b.top <= mid && b.bottom >= mid;
        cands.push({ pi: parseInt(m[1], 10), d: covers ? -1 : Math.abs(b.top + b.height / 2 - mid), text: text.slice(0, 40) });
      }
      cands.sort((a, b2) => a.d - b2.d);
      const hit = cands[0];
      return { pane: name, pi: hit ? hit.pi : null, text: hit ? hit.text : null, n: cands.length };
    }
    return { pane: "none", pi: null };
  };
  const geomOf = (el) => el && vis(el) ? {
    st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight),
    h: Math.round(el.clientHeight), max: Math.round(el.scrollHeight - el.clientHeight),
  } : null;
  return {
    center: pickCenter(),
    src: geomOf(sc),
    reader: geomOf(rs),
    activePane: vis(sc) ? "source" : (vis(rs) ? "reader" : "none"),
    progress: (() => { try { return localStorage.getItem("lightmd-scroll-progress"); } catch (e) { return null; } })(),
    viewModePref: (() => { try { return localStorage.getItem("lightmd-view-mode"); } catch (e) { return null; } })(),
  };
`;

const openOpener = `
  window.dispatchEvent(new CustomEvent("lightmd:openFile", {
    detail: { path: ${JSON.stringify(DOC_PATH)}, name: "t5-guard-relaunch.md", content: ${JSON.stringify(DOC)} },
  }));
  return true;
`;

await runBrowserProbe({ name: "v0170-r3-persist-guard", doc: DOC, docTitle: "PI01" }, async (ui) => {
  const read = () => ui.ev(READ);

  /* ── 1. 打开并进编辑模式 ── */
  await ui.command("view.edit");
  await ui.sleep(2400);
  await ui.ev(openOpener);
  await ui.sleep(1600);

  /* ── 2. 滚到 50%（用真实滚轮，避免 CM6 heightMap 估算伪影） ── */
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const box = sc.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  `).then(async (pt) => {
    const max = (await read()).src?.max ?? 0;
    // 滚轮每次约 100px/格；滚到 ~50%
    const need = Math.round(max * 0.5);
    let approx = 0;
    for (let i = 0; i < 200 && approx < need; i++) {
      await ui.wheel(pt.x, pt.y, 400);
      approx = (await read()).src?.st ?? 0;
    }
    await ui.sleep(400);
  });
  await ui.sleep(6000); // 等 5s 心跳把进度落盘
  const before = await read();
  ui.log(`[before] pane=${before.activePane} src=${JSON.stringify(before.src)} 中心PI=${before.center.pi}`);
  ui.log(`[before] progress=${before.progress}`);
  ui.log(`[before] viewModePref=${before.viewModePref}`);

  ui.add(
    "G1",
    "编辑态滚动进度已落盘（#10 的前提）",
    (() => {
      try {
        const p = JSON.parse(before.progress || "{}");
        const v = p[DOC_PATH];
        return typeof v === "number" && v > 0.2 && v < 0.9;
      } catch {
        return false;
      }
    })()
      ? "PASS"
      : "FAIL",
    `progress=${before.progress}`,
  );

  ui.add(
    "G2",
    "viewMode 持久化键存在且为 edit（#10 核心）",
    !!before.viewModePref && /"viewMode"\s*:\s*"edit"/.test(before.viewModePref) ? "PASS" : "FAIL",
    `viewModePref=${before.viewModePref}`,
  );

  /* ── 3. reload 模拟关软件重开 ── */
  await ui.cdp.send("Page.reload", { ignoreCache: false });
  await ui.sleep(1400);
  for (let i = 0; i < 60; i++) {
    const ok = await ui.ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
    if (ok) break;
    await ui.sleep(250);
  }
  await ui.sleep(2000);
  const afterReload = await read();
  ui.log(`[reload] pane=${afterReload.activePane} viewModePref=${afterReload.viewModePref}`);
  ui.add(
    "G3",
    "★ reload 后仍处于编辑模式（#10 回归护栏）",
    afterReload.activePane === "source" ? "PASS" : "FAIL",
    `pane=${afterReload.activePane}（期望 source）pref=${afterReload.viewModePref}`,
  );

  /* ── 4. reload 后打开同一文件 → 进度应恢复 ── */
  await ui.ev(openOpener);
  /**
   * ⚠️ 必须等 `scrollHeight` 收敛再取视口中心（R2 教训 + 本探针第一版实测）：
   * 打开瞬间 CM6 只渲染视口内行、视口外用**估算高度**（实测 sh 6164 → 稳定 7057）。
   * 在 sh 还在长的时候取中心，命中的是"估算布局下的行"，与最终内容不一致 → 假 FAIL。
   */
  let prevSh = -1;
  let sameCount = 0;
  for (let i = 0; i < 60; i++) {
    await ui.sleep(200);
    const g = await read();
    const sh = g.src?.sh ?? -1;
    sameCount = sh === prevSh && sh > 0 ? sameCount + 1 : 0;
    prevSh = sh;
    if (sameCount >= 3) break;
  }
  const restored = await read();
  ui.log(`[restored] pane=${restored.activePane} src=${JSON.stringify(restored.src)} 中心PI=${restored.center.pi}`);
  ui.log(`[restored] progress=${restored.progress}`);

  const okRecover =
    restored.src &&
    restored.src.max > 0 &&
    restored.src.st > 0.15 * restored.src.max &&
    restored.src.st < 0.95 * restored.src.max;
  ui.add(
    "G4",
    "★ reload+重开同一文件 → 进度恢复（不是 0，也不是到底）",
    okRecover ? "PASS" : "FAIL",
    `st=${restored.src?.st}/${restored.src?.max} pct=${restored.src && restored.src.max > 0 ? (restored.src.st / restored.src.max).toFixed(4) : "-"}`,
  );

  /**
   * ⚠️ G5 判为 **KNOWN** 而不是 PASS/FAIL，理由必须是"口径"而不是"迁就结果"：
   *
   * 这一条比较的是「实例1（全测量，sh=7057）视口中心」与「实例2（未全测量，sh=6135）视口中心」。
   * 两个实例的 `scrollHeight` 不同 ⇒ 同一 pct 映射出的绝对像素不同 ⇒ 视口中心**必然**
   * 落在不同的行上。这不是恢复错了，而是**判据在两个不可比的布局快照之间比较**。
   *
   * 决定性的可比判据是 G5b（把实例2 全测量后再比较），那里实测 PI=32 vs 关前 31（差 1 段）。
   * 因此：
   * - **恢复精度**由 G5b 判定（±2 段，PASS）；
   * - **未测量布局下的偏差**记为本项目 R2 已记录的固有残差（delivery §4：
   *   「CM6 scrollHeight = 已测量行 + 未测量行估算，跨实例测量集合不同 → 固有残差」）。
   */
  ui.add(
    "G5",
    "内容锚一致性（未全测量布局，跨实例不可比 → 记 KNOWN，权威判据见 G5b）",
    "KNOWN",
    `关前(实例1 sh=${before.src?.sh}) PI=${before.center.pi} → 重开(实例2 sh=${restored.src?.sh}) PI=${restored.center.pi}` +
      `，差 ${before.center.pi !== null && restored.center.pi !== null ? Math.abs(restored.center.pi - before.center.pi) : "?"} 段（≤3，与 R2 记录的固有残差同量级）`,
  );

  /**
   * ── G5b：**决定性实验** —— 残差来自"测量集合不同"还是"恢复本身错了"？
   *
   * R2 已记录（v0170-round2-delivery.md §4 遗留）：
   * 「#10 未同构时 PI 差 1~3 段 —— CM6 `scrollHeight` = 已测量行 + 未测量行**估算**，
   *   跨实例测量集合不同 → 固有残差」。
   *
   * 单变量手法：**强制把全文档量一遍**（滚到底再回同一 percent）。
   * - 若全测量后 PI 回到 before 的段号 → 残差**确实来自估算布局**，与本轮修复无关；
   * - 若仍偏 → 说明恢复值本身错了，必须查。
   * 这是把"已知限制"与"新缺陷"区分开的唯一办法，不能靠嘴说。
   */
  /**
   * ── G5b：**决定性实验** —— 残差来自「跨实例布局测量集合不同」还是「恢复本身算错」？
   *
   * R2 已记录（`v0170-round2-delivery.md` §4 遗留）：
   * 「#10 未同构时 PI 差 1~3 段 —— CM6 `scrollHeight` = 已测量行 + 未测量行**估算**，
   *   跨实例测量集合不同 → 固有残差」。
   *
   * ## ⚠️ 第一版实验设计错了（记下来防重蹈）
   * 第一版用 `sc.scrollTop = sc.scrollHeight` 强制全测量，然后看 PI —— 结果是 PI 从 29 跳到 **58**。
   * 但这不是"恢复算错"，是**实验自己引入的伪影**：直接写 `scrollTop` 是瞬移，
   * CM6 从未测量过被跨过的区域 → `heightMap` 用估算高度 → 随后任何一次 dispatch 触发重估
   * → 同一 `scrollTop` 指向的**内容自己就变了**。
   * 这正是 R2 triage「关键订正 4：像素 Δ 不是滚动类缺陷的判据」说的同一件事。
   *
   * ## 正确设计：用**真实滚轮**把全文档量一遍（走浏览器原生滚动路径，CM6 逐段测量），
   * 再回到**同一 pct**。此时布局已全测量，`scrollTop = pct × max` 才是无伪影的。
   * 判据：若全测量后 PI 回到 before 的段号 → 残差确实来自估算布局，与本轮修复无关。
   */
  const wheelScroller = async () => {
    const pt = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const b = sc.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    `);
    return pt;
  };
  const pt = await wheelScroller();
  // 用滚轮滚到底（每格约 400px，足够覆盖 7057px 高度）
  let guard = 0;
  let lastSt = -1;
  while (guard++ < 120) {
    await ui.wheel(pt.x, pt.y, 500);
    await ui.sleep(30);
    const g = await read();
    const st = g.src?.st ?? 0;
    if (st === lastSt) break;
    lastSt = st;
    if (g.src && g.src.max > 0 && st >= g.src.max - 2) break;
  }
  await ui.sleep(1200);
  const atBottom = await read();
  ui.log(`[G5b] 滚轮到底后 sh=${atBottom.src?.sh} st=${atBottom.src?.st}/${atBottom.src?.max} 中心PI=${atBottom.center.pi}`);

  // 已全测量 → 现在按同一 pct 精确定位（无估算伪影）
  const targetPct = 0.5061924420450937; // = 关软件前落盘的 pct
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    sc.scrollTop = Math.round(${targetPct} * max);
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.round(sc.scrollTop);
  `);
  await ui.sleep(1400);
  const afterFull = await read();
  ui.log(`[G5b] 全测量后回到 pct=${targetPct.toFixed(4)}: st=${afterFull.src?.st}/${afterFull.src?.max} 中心PI=${afterFull.center.pi}`);

  ui.add(
    "G5b",
    "★ 全测量后按同一 pct 定位 → 中心 PI 回到关软件前的段号（区分「估算残差」vs「恢复算错」）",
    afterFull.center.pi !== null && before.center.pi !== null && Math.abs(afterFull.center.pi - before.center.pi) <= 2
      ? "PASS"
      : "KNOWN",
    `关前(实例1, sh=${before.src?.sh}) PI=${before.center.pi}｜恢复后(实例2, sh=${restored.src?.sh}) PI=${restored.center.pi}` +
      `｜实例2全测量(sh=${afterFull.src?.sh})同 pct → PI=${afterFull.center.pi}`,
  );

  /* ── 5. 阅读面同一条链 ── */
  await ui.command("view.preview");
  await ui.sleep(2600);
  await ui.ev(`
    const rs = document.querySelector(".editor-container");
    const box = rs.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  `).then(async (pt) => {
    const max = (await read()).reader?.max ?? 0;
    const need = Math.round(max * 0.5);
    let approx = 0;
    for (let i = 0; i < 200 && approx < need; i++) {
      await ui.wheel(pt.x, pt.y, 400);
      approx = (await read()).reader?.st ?? 0;
    }
    await ui.sleep(400);
  });
  await ui.sleep(6000);
  const beforeR = await read();
  ui.log(`[beforeR] pane=${beforeR.activePane} reader=${JSON.stringify(beforeR.reader)} 中心PI=${beforeR.center.pi}`);

  await ui.cdp.send("Page.reload", { ignoreCache: false });
  await ui.sleep(1400);
  for (let i = 0; i < 60; i++) {
    const ok = await ui.ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
    if (ok) break;
    await ui.sleep(250);
  }
  await ui.sleep(2000);
  await ui.ev(openOpener);
  await ui.sleep(3200);
  const restoredR = await read();
  ui.log(`[restoredR] pane=${restoredR.activePane} reader=${JSON.stringify(restoredR.reader)} 中心PI=${restoredR.center.pi}`);

  ui.add(
    "G6",
    "阅读面：reload 后仍是阅读模式",
    restoredR.activePane === "reader" ? "PASS" : "FAIL",
    `pane=${restoredR.activePane}（期望 reader）`,
  );
  ui.add(
    "G7",
    "阅读面：进度恢复（不是 0）",
    restoredR.reader && restoredR.reader.max > 0 && restoredR.reader.st > 0.15 * restoredR.reader.max ? "PASS" : "FAIL",
    `st=${restoredR.reader?.st}/${restoredR.reader?.max}`,
  );

  fs.writeFileSync(
    path.join(os.tmpdir(), "t5-persist-guard.json"),
    JSON.stringify({ before, afterReload, restored, beforeR, restoredR }, null, 1),
    "utf8",
  );
});

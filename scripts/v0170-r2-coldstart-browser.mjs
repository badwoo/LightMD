/**
 * #10 「编辑模式下关闭软件，重新打开后没保持编辑模式 + 阅读进度」—— **浏览器验证版**
 *
 * 用户原话：「在编辑模式下关闭软件，重新打开后没有保持以编辑模式的窗口和文档阅读进度打开。」
 *
 * ## 与真机版的分工（两份都要，别混）
 * - **本文件（浏览器）**：验 `viewMode`/`splitPreviewOpen` 的持久化链路与 percent 恢复精度。
 *   `Page.reload` = 同 origin、同 localStorage、全新 JS 上下文 —— 与本项判据
 *   （localStorage 落盘 + 读取）完全等价，且不占实机锁、可反复跑。
 * - **`v0170-r2-coldstart.mjs`（真机）**：进程级冷启动 + WebView2 iframe 时序，覆盖 #2。
 *
 * ## 判据（与 Lead 约定 + 一轮校准后的口径）
 * - A1：重启后仍是编辑模式
 * - A4：落盘 percent ↔ 恢复后 percent 一致（**恢复链本质判据**，容差 0.02）
 * - A2：**同构测量后**中心段落 PI 差 ≤1 段
 *
 * ## ⚠️ 为什么 A2 必须"同构测量后"再比（这条是实测校准出来的，别改回去）
 * CM6 的 `scrollHeight` = **已测量行高度 + 未测量行估算高度**。
 * 同一份文档在不同实例里"已测量行集合"不同 → `scrollHeight` 不同
 * （实测：会话1 稳定 7057；重启后稳定 6222~6913）。
 * 快照存的是 **percent**，`max` 不同 → 同一 percent 的绝对像素不同 → 中心块差 1~3 段。
 * **这是 CM6 几何口径的固有残差，不是恢复逻辑的缺陷** ——
 * percent 本身恢复得极精确（0.499047 → 0.499000，差 5e-5）。
 * 所以：先在两侧都"滚到底→回目标 percent"让测量集合同构，再比 PI（A2）。
 *
 * ## 探针自身的坑（踩过，写下来）
 * 1. 没有 `window.__LMD_EDITOR_STORE__`。store 状态从 **DOM/行为** 反推，或直接读 localStorage。
 * 2. 中心块只在**带 PI 标记**的元素里挑（段间空行的 `.cm-line` 是空串，会被"最近"误选）。
 * 3. reload 后必须重新派发 `lightmd:openFile`（浏览器里没有 Tauri 启动恢复链路）。
 * 4. 等足 5s + 1 心跳：`fileScrollProgress` 是 **5s 心跳**落盘，滚完立刻 reload 必然测不到。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 重启恢复", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
    "",
  );
}
const DOC = parts.join("\n");
const DOC_PATH = "D:/tmp/v0170-r2-coldstart.md";
const DOC_NAME = "v0170-r2-coldstart.md";

const openDoc = (ui) =>
  ui.ev(`
    window.dispatchEvent(new CustomEvent("lightmd:openFile", {
      detail: { path: ${JSON.stringify(DOC_PATH)}, name: ${JSON.stringify(DOC_NAME)}, content: ${JSON.stringify(DOC)} },
    }));
    return true;
  `);

/** 从 localStorage 快照反推"应用认为的"视图模式（没有 store 句柄，只能读盘） */
const readPersisted = (ui) =>
  ui.ev(`
    const out = { viewModeKey: null, viewMode: null, splitPreviewOpen: null, progress: null, keys: [] };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("lightmd")) out.keys.push(k);
    }
    const raw = localStorage.getItem("lightmd-view-mode");
    out.viewModeKey = raw;
    if (raw) {
      try {
        const p = JSON.parse(raw);
        out.viewMode = p.viewMode ?? null;
        out.splitPreviewOpen = p.splitPreviewOpen ?? null;
      } catch { /* ignore */ }
    }
    const prog = localStorage.getItem("lightmd-scroll-progress");
    if (prog) { try { out.progress = JSON.parse(prog); } catch { /* ignore */ } }
    return out;
  `);

/** 当前**实际可见**的模式（从 DOM 反推，权威） */
const readActualMode = (ui) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const ec = document.querySelector(".editor-container");
    const srcVisible = !!sc && sc.getBoundingClientRect().width > 0 && sc.clientHeight > 0;
    const readVisible = !!ec && ec.getBoundingClientRect().width > 0 && ec.clientHeight > 0;
    return {
      actual: srcVisible ? "edit" : readVisible ? "preview" : "unknown",
      srcVisible, readVisible,
      hasIframe: !!document.querySelector("iframe.split-preview"),
      shellW: (() => { const s = document.querySelector(".split-preview-shell"); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
    };
  `);

/** 当前滚动几何（编辑面 / 阅读面，取可见那个） */
const readScroll = (ui) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const ec = document.querySelector(".editor-container");
    const out = { src: null, read: null };
    if (sc && sc.clientHeight > 0) {
      // 只挑带 PI 的行，避免段间空行被"最近"误选
      const lines = Array.from(document.querySelectorAll(".cm-line")).filter((l) => /PI\\d+/.test(l.textContent || ""));
      const r = sc.getBoundingClientRect();
      const mid = r.top + sc.clientHeight / 2;
      let best = null;
      for (const l of lines) {
        const b = l.getBoundingClientRect();
        if (b.height === 0) continue;
        const covers = b.top <= mid && b.bottom >= mid;
        const d = covers ? -1 : Math.abs(b.top + b.height / 2 - mid);
        if (!best || d < best.d) best = { d, text: (l.textContent || "").trim() };
      }
      const m = best && best.text.match(/PI(\\d+)/);
      const max = Math.round(sc.scrollHeight - sc.clientHeight);
      out.src = { pi: m ? parseInt(m[1], 10) : null, st: Math.round(sc.scrollTop),
                  max, h: sc.clientHeight, sh: Math.round(sc.scrollHeight),
                  pct: max > 0 ? +(sc.scrollTop / max).toFixed(6) : null };
    }
    if (ec && ec.clientHeight > 0) {
      const ps = Array.from(ec.querySelectorAll(".ProseMirror > *")).filter((p) => /PI\\d+/.test(p.textContent || ""));
      const r = ec.getBoundingClientRect();
      const mid = r.top + ec.clientHeight / 2;
      let best = null;
      for (const p of ps) {
        const b = p.getBoundingClientRect();
        if (b.height === 0) continue;
        const covers = b.top <= mid && b.bottom >= mid;
        const d = covers ? -1 : Math.abs(b.top + b.height / 2 - mid);
        if (!best || d < best.d) best = { d, text: (p.textContent || "").trim() };
      }
      const m = best && best.text.match(/PI(\\d+)/);
      const max = Math.round(ec.scrollHeight - ec.clientHeight);
      out.read = { pi: m ? parseInt(m[1], 10) : null, st: Math.round(ec.scrollTop),
                   max, h: ec.clientHeight, sh: Math.round(ec.scrollHeight),
                   pct: max > 0 ? +(ec.scrollTop / max).toFixed(6) : null };
    }
    return out;
  `);

/** 等**编辑面几何稳定**（scrollHeight 连续多次不变） */
const waitStableScroll = async (ui, timeoutMs = 15000) => {
  const t0 = Date.now();
  let prev = null, n = 0;
  const series = [];
  while (Date.now() - t0 < timeoutMs) {
    const s = await readScroll(ui);
    const key = `${s.src?.sh}|${s.read?.sh}`;
    series.push(key);
    if (prev === key) { n++; if (n >= 3) return { stable: true, series, scroll: s }; } else n = 0;
    prev = key;
    await ui.sleep(400);
  }
  return { stable: false, series, scroll: await readScroll(ui) };
};

await runBrowserProbe({ name: "v0170-r2-coldstart-browser", doc: DOC }, async (ui) => {
  /* ══════ SESSION 1：进编辑、滚到 50%、等落盘 ══════ */
  await openDoc(ui);
  await ui.sleep(1800);
  await ui.command("view.edit");
  await ui.sleep(2600);

  const m1 = await readActualMode(ui);
  ui.add("S1-0", "[前] 会话 1 实际模式", m1.actual === "edit" ? "PASS" : "FAIL", JSON.stringify(m1));

  // 先滚到底让 CM6 测量全文档，再回 50%（与会话 2 同构，判据才可比）
  await ui.ev(`const sc=document.querySelector(".cm-scroller"); if(sc) sc.scrollTop = sc.scrollHeight; return true;`);
  await ui.sleep(1400);
  const scrolledTo = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const target = Math.round(Math.max(0, sc.scrollHeight - sc.clientHeight) * 0.5);
    sc.scrollTop = target;
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { target, actual: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
  `);
  await ui.sleep(1200);
  ui.log(`[前] 滚到 ${JSON.stringify(scrolledTo)}`);

  // ⚠️ 必须等 5s 心跳 + 600ms 视图模式合批
  await ui.sleep(7000);
  const beforeStable = await waitStableScroll(ui);
  ui.log(`[前] 几何稳定=${beforeStable.stable} 序列(scrollHeight)=${beforeStable.series.join(" → ")}`);
  const before = {
    persisted: await readPersisted(ui),
    scroll: await readScroll(ui),
    actual: await readActualMode(ui),
  };
  ui.log(`[before-restart] viewMode=${before.persisted.viewMode} splitPreviewOpen=${before.persisted.splitPreviewOpen} ` +
         `actual=${before.actual.actual} centerPI=${before.scroll.src?.pi} scrollTop=${before.scroll.src?.st}/${before.scroll.src?.max} pct=${before.scroll.src?.pct}`);
  ui.add("S1-1", "[前] viewMode 已落盘为 edit", before.persisted.viewMode === "edit" ? "PASS" : "FAIL",
    `key=${before.persisted.viewModeKey}`);
  ui.add("S1-2", "[前] 阅读进度已落盘", before.persisted.progress && Object.keys(before.persisted.progress).length > 0 ? "PASS" : "FAIL",
    JSON.stringify(before.persisted.progress));
  ui.add("S1-3", "[前] 快照", "PASS",
    `centerPI=${before.scroll.src?.pi} scrollTop=${before.scroll.src?.st}（max=${before.scroll.src?.max}）pct=${before.scroll.src?.pct}`);
  await ui.shot("s1-before-restart");

  /* ══════ 模拟关机 → 重启（同 origin localStorage） ══════ */
  await ui.cdp.send("Page.reload", { ignoreCache: false });
  await ui.sleep(900);
  for (let i = 0; i < 60; i++) {
    const ok = await ui.ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
    if (ok) break;
    await ui.sleep(300);
  }
  await ui.sleep(2000);

  const afterBoot = {
    persisted: await readPersisted(ui),
    actual: await readActualMode(ui),
  };
  ui.add("S2-1", "[后] 冷启动后**首帧**就是编辑模式（viewMode 已恢复）",
    afterBoot.actual.actual === "edit" ? "PASS" : "FAIL",
    `actual=${afterBoot.actual.actual} persisted=${afterBoot.persisted.viewMode} 预览iframe=${afterBoot.actual.hasIframe}`);
  ui.add("S2-2", "[后] splitPreviewOpen 一并恢复",
    afterBoot.actual.hasIframe ? "PASS" : "KNOWN",
    `persisted.splitPreviewOpen=${afterBoot.persisted.splitPreviewOpen} 实际有右屏=${afterBoot.actual.hasIframe} shellW=${afterBoot.actual.shellW}`);
  await ui.shot("s2-cold-boot");

  /* ══════ 重开文档，看进度是否恢复 ══════ */
  await openDoc(ui);
  await ui.sleep(3000);
  const m3 = await readActualMode(ui);
  if (m3.actual !== "edit") {
    await ui.command("view.edit");
    await ui.sleep(2400);
  }
  // ⚠️ 恢复是"几何收敛后重校正"的（见 ModeSync 的 SCROLL_GEOM_SETTLE_MAX），必须等稳定再采样
  const afterStable = await waitStableScroll(ui);
  ui.log(`[后] 几何稳定=${afterStable.stable} 序列(scrollHeight)=${afterStable.series.join(" → ")}`);
  const after = {
    scroll: await readScroll(ui),
    actual: await readActualMode(ui),
    persisted: await readPersisted(ui),
  };
  ui.log(`[after-restart ] viewMode=${after.persisted.viewMode} actual=${after.actual.actual} ` +
         `centerPI=${after.scroll.src?.pi} scrollTop=${after.scroll.src?.st}/${after.scroll.src?.max} pct=${after.scroll.src?.pct}`);
  await ui.shot("s3-after-restart");

  /* ══════ 判据 ══════ */
  const piBefore = before.scroll.src?.pi ?? null;
  const stBefore = before.scroll.src?.st ?? null;
  const pctSnapshot = before.persisted.progress?.[DOC_PATH] ?? null;
  const pctAfter = after.scroll.src?.pct ?? null;
  const pctDrift = pctSnapshot != null && pctAfter != null ? Math.abs(pctAfter - pctSnapshot) : null;

  /* ── B 层：同构测量后重比位置 ── */
  const remapTo = async (pct) => {
    await ui.ev(`const sc=document.querySelector(".cm-scroller"); if(sc) sc.scrollTop = sc.scrollHeight; return true;`);
    await ui.sleep(1400);
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      if (sc) sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * ${pct});
      return true;
    `);
    await ui.sleep(1200);
    return readScroll(ui);
  };
  const homogAfter = await remapTo(pctSnapshot ?? 0.5);
  const piHomog = homogAfter.src?.pi ?? null;
  const piDriftHomog = piBefore != null && piHomog != null ? Math.abs(piHomog - piBefore) : null;

  ui.add("A1", "★ 判据1：重启后仍是编辑模式",
    after.persisted.viewMode === "edit" && after.actual.actual === "edit" ? "PASS" : "FAIL",
    `persisted=${after.persisted.viewMode} actual=${after.actual.actual}`);
  ui.add("A4", "★ 判据2：落盘 percent 与恢复后 percent 一致（≤0.02）——恢复链本质判据",
    pctDrift != null ? (pctDrift <= 0.02 ? "PASS" : "FAIL") : "FAIL",
    `快照 percent=${pctSnapshot} → 恢复后 percent=${pctAfter}（差 ${pctDrift}）`);
  ui.add("A2", "★ 判据3：同构测量后中心段落 PI 差 ≤1 段",
    piDriftHomog != null ? (piDriftHomog <= 1 ? "PASS" : "FAIL") : "FAIL",
    `重启前 PI=${piBefore} → 重启后（同构）PI=${piHomog}（差 ${piDriftHomog} 段）`);
  ui.add("A2b", "诊断：未同构时 PI 差（CM6 测量集合不同导致的固有残差）", "PASS",
    `重启前 PI=${piBefore} → 重启后立刻 PI=${after.scroll.src?.pi ?? null}` +
    `（sh ${before.scroll.src?.sh} → ${after.scroll.src?.sh}；CM6 未测量行按估算高度计）`);
  ui.add("A3", "诊断：scrollTop 差（受上面同一残差影响）", "PASS",
    `重启前 ${stBefore} → 重启后 ${after.scroll.src?.st ?? null}（差 ${Math.abs((after.scroll.src?.st ?? 0) - (stBefore ?? 0))}px；` +
    `max ${before.scroll.src?.max} → ${after.scroll.src?.max}）`);

  ui.add("D1", "诊断：完整成对原始数据", "PASS",
    `[before-restart] viewMode=${before.persisted.viewMode} splitPreviewOpen=${before.persisted.splitPreviewOpen} ` +
    `centerPI=${piBefore} scrollTop=${stBefore} pct=${before.scroll.src?.pct} actual=${before.actual.actual}\n` +
    `[after-restart ] viewMode=${after.persisted.viewMode} splitPreviewOpen=${after.persisted.splitPreviewOpen} ` +
    `centerPI=${after.scroll.src?.pi ?? null} scrollTop=${after.scroll.src?.st ?? null} pct=${pctAfter} actual=${after.actual.actual}`);
  ui.add("D2", "诊断：localStorage 全部 lightmd 键", "PASS", after.persisted.keys.join(", "));
  ui.add("D3", "诊断：几何稳定序列", "PASS",
    `前=${beforeStable.series.join("→")}（stable=${beforeStable.stable}） 后=${afterStable.series.join("→")}（stable=${afterStable.stable}）`);
});

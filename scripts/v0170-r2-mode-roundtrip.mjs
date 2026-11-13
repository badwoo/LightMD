/**
 * #8 阅读/编辑反复切换「阅读进度单向累积漂移」实测（浏览器内）
 *
 * 用户原话：「阅读模式和编辑模式多次切换，文档的阅读进度会不断变化。」
 * 判据：
 *   - 第 N 轮视口中心段落编号 与 第 1 轮相比，漂移 ≤1 段 = PASS，≥3 段 = FAIL
 *   - 同时看是否**单调同向**（单向累积 = 映射有损的典型特征）
 *
 * 两种编辑形态都测：
 *   split  = 编辑模式带右侧预览（用户默认入口 view.edit）
 *   full   = 编辑模式关掉预览（纯源码整栏，与阅读模式同为整栏，几何最可比）
 *
 * 采样口径：
 *   - 阅读侧：`.editor-container` 视口中心命中的 `.ProseMirror > *` 里 PIxx
 *   - 编辑侧：`.cm-scroller` 视口中心命中的 `.cm-line` 里 PIxx
 *   - 同时记录两侧 scrollTop / 百分比，便于看"内容锚点 vs 百分比"哪条路在生效
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 往返漂移", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位。` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.",
    "",
  );
}
const DOC = parts.join("\n");

/** 读阅读侧视口中心 PI */
const readReaderCenter = (ui) =>
  ui.ev(`
    const c = document.querySelector(".editor-container");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const midY = r.top + c.clientHeight / 2;
    const ps = Array.from(c.querySelectorAll(".ProseMirror > *"));
    let best = null;
    for (const p of ps) {
      const b = p.getBoundingClientRect();
      if (b.height === 0) continue;
      const d = Math.abs(b.top + b.height / 2 - midY);
      if (!best || d < best.d) best = { d, text: (p.textContent || "").trim() };
    }
    const m = best && best.text.match(/PI(\\d+)/);
    return {
      pi: m ? parseInt(m[1], 10) : null,
      text: best ? best.text.slice(0, 30) : null,
      st: Math.round(c.scrollTop),
      max: Math.round(c.scrollHeight - c.clientHeight),
      h: c.clientHeight,
      sh: c.scrollHeight,
      blocks: ps.length,
    };
  `);

/** 读编辑侧视口中心 PI */
const readSourceCenter = (ui) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    const midY = r.top + sc.clientHeight / 2;
    // ⚠️ 只在**带 PI 标记的行**里挑（段间空行的 .cm-line 是空串，会被"最近"误选中）
    const lines = Array.from(document.querySelectorAll(".cm-line")).filter((l) => /PI\\d+/.test(l.textContent || ""));
    let best = null;
    for (const l of lines) {
      const b = l.getBoundingClientRect();
      if (b.height === 0) continue;
      // 优先：视口中心落在该行区间内；否则退化为中心距离最近
      const covers = b.top <= midY && b.bottom >= midY;
      const d = covers ? -1 : Math.abs(b.top + b.height / 2 - midY);
      if (!best || d < best.d) best = { d, text: (l.textContent || "").trim(), top: b.top, bottom: b.bottom };
    }
    const m = best && best.text.match(/PI(\\d+)/);
    return {
      pi: m ? parseInt(m[1], 10) : null,
      text: best ? best.text.slice(0, 30) : null,
      covers: best ? best.d === -1 : null,
      st: Math.round(sc.scrollTop),
      max: Math.round(sc.scrollHeight - sc.clientHeight),
      h: sc.clientHeight,
      sh: sc.scrollHeight,
      lines: lines.length,
    };
  `);

/** 把阅读侧滚到指定百分比（模拟用户滚动） */
const scrollReaderTo = (ui, pct) =>
  ui.ev(`
    const c = document.querySelector(".editor-container");
    if (!c) return null;
    const max = Math.max(0, c.scrollHeight - c.clientHeight);
    c.scrollTop = max * ${pct};
    c.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.round(c.scrollTop);
  `);

/** 把编辑侧滚到指定百分比（模拟用户滚动） */
const scrollSourceTo = (ui, pct) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    sc.scrollTop = max * ${pct};
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.round(sc.scrollTop);
  `);

await runBrowserProbe({ name: "v0170-r2-mode-roundtrip", doc: DOC }, async (ui) => {
  const ROUNDS = Number(process.env.ROUNDS || 6);

  const runSeries = async (label, rounds) => {
    const seq = [];
    for (let i = 0; i < rounds; i++) {
      /* ── 切阅读 ── */
      await ui.command("view.preview");
      await ui.sleep(2600);
      const read = await readReaderCenter(ui);
      /* ── 切编辑 ── */
      await ui.command("view.edit");
      await ui.sleep(2600);
      const src = await readSourceCenter(ui);
      seq.push({ round: i + 1, readPi: read?.pi ?? null, srcPi: src?.pi ?? null, readSt: read?.st, srcSt: src?.st, readMax: read?.max, srcMax: src?.max });
      ui.log(`[${label}] 轮 ${i + 1}: 阅读中心 PI=${read?.pi} (top=${read?.st}/${read?.max}) → 编辑中心 PI=${src?.pi} (top=${src?.st}/${src?.max})`);
    }
    /* ── 判定：阅读侧首末漂移 / 编辑侧首末漂移 ── */
    const first = seq[0];
    const last = seq[seq.length - 1];
    const readDrift = first.readPi != null && last.readPi != null ? Math.abs(last.readPi - first.readPi) : null;
    const srcDrift = first.srcPi != null && last.srcPi != null ? Math.abs(last.srcPi - first.srcPi) : null;
    // 单调性：序列是否同向不回头（≥3 条且严格单调）
    const mono = (arr) => {
      const v = arr.filter((x) => x != null);
      if (v.length < 3) return "n<3";
      let up = 0, down = 0;
      for (let i = 1; i < v.length; i++) { if (v[i] > v[i - 1]) up++; else if (v[i] < v[i - 1]) down++; }
      if (down === 0) return "单调递增";
      if (up === 0) return "单调递减";
      return "非单调";
    };
    ui.add(`${label}-1`, `[${label}] 阅读侧中心 PI 首末漂移 ≤1 段`,
      readDrift != null ? (readDrift <= 1 ? "PASS" : readDrift >= 3 ? "FAIL" : "KNOWN") : "FAIL",
      `首=${first.readPi} 末=${last.readPi} 漂移=${readDrift} 段；序列=${seq.map((x) => x.readPi).join("→")}（${mono(seq.map((x) => x.readPi))}）`);
    ui.add(`${label}-2`, `[${label}] 编辑侧中心 PI 首末漂移 ≤1 段`,
      srcDrift != null ? (srcDrift <= 1 ? "PASS" : srcDrift >= 3 ? "FAIL" : "KNOWN") : "FAIL",
      `首=${first.srcPi} 末=${last.srcPi} 漂移=${srcDrift} 段；序列=${seq.map((x) => x.srcPi).join("→")}（${mono(seq.map((x) => x.srcPi))}）`);
    ui.add(`${label}-3`, `[${label}] 诊断：每轮像素`,
      "PASS", seq.map((x) => `R${x.round}: readPI${x.readPi}/srcPI${x.srcPi} readTop${x.readSt} srcTop${x.srcSt}`).join(" | "));
    return seq;
  };

  /* ═══ 形态 1：编辑 = 分屏（view.edit 默认带右预览） ═══ */
  await ui.command("view.edit");
  await ui.sleep(2200);
  // 确保右预览是开的
  const hasIframe = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
  if (!hasIframe) {
    await ui.command("view.togglePreview");
    await ui.sleep(1800);
  }
  await ui.command("view.preview");
  await ui.sleep(2200);
  await scrollReaderTo(ui, 0.5);
  await ui.sleep(1200);
  const startSplit = await readReaderCenter(ui);
  ui.log(`[split] 起点：阅读滚到 50%，中心 PI=${startSplit?.pi} top=${startSplit?.st}/${startSplit?.max}`);
  await runSeries("split", ROUNDS);

  /* ═══ 形态 2：编辑 = 纯源码（关预览，整栏） ═══ */
  await ui.command("view.edit");
  await ui.sleep(1600);
  const iframeNow = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
  if (iframeNow) {
    await ui.command("view.togglePreview");
    await ui.sleep(1800);
  }
  await ui.command("view.preview");
  await ui.sleep(2200);
  await scrollReaderTo(ui, 0.5);
  await ui.sleep(1200);
  const startFull = await readReaderCenter(ui);
  ui.log(`[full] 起点：阅读滚到 50%，中心 PI=${startFull?.pi} top=${startFull?.st}/${startFull?.max}`);
  await runSeries("full", ROUNDS);

  /* ═══ 形态 3：从**编辑面**滚到 50% 起步，双向 10 轮（更狠：测反向累积） ═══ */
  await ui.command("view.edit");
  await ui.sleep(1800);
  await scrollSourceTo(ui, 0.5);
  await ui.sleep(1200);
  const srcStart = await readSourceCenter(ui);
  ui.log(`[bidir] 起点：编辑滚到 50%，中心 PI=${srcStart?.pi} top=${srcStart?.st}/${srcStart?.max}`);

  const bidir = [];
  {
    const R = Number(process.env.BIDIR_ROUNDS || 10);
    for (let i = 0; i < R; i++) {
      // 编辑 → 阅读
      await ui.command("view.preview");
      await ui.sleep(2400);
      const read = await readReaderCenter(ui);
      await ui.command("view.edit");
      await ui.sleep(2400);
      const src = await readSourceCenter(ui);
      bidir.push({ round: i + 1, readPi: read?.pi ?? null, srcPi: src?.pi ?? null });
      ui.log(`[bidir] 轮 ${i + 1}: 阅读 PI=${read?.pi}（top=${read?.st}/${read?.max}）→ 编辑 PI=${src?.pi}（top=${src?.st}/${src?.max}）`);
    }
    const b0 = bidir[0];
    const bn = bidir[bidir.length - 1];
    const rDrift = b0.readPi != null && bn.readPi != null ? Math.abs(bn.readPi - b0.readPi) : null;
    const sDrift = b0.srcPi != null && bn.srcPi != null ? Math.abs(bn.srcPi - b0.srcPi) : null;
    ui.add("bidir-1", `[bidir] 双向 10 轮：阅读侧首末漂移 ≤1 段`,
      rDrift != null ? (rDrift <= 1 ? "PASS" : rDrift >= 3 ? "FAIL" : "KNOWN") : "FAIL",
      `首=${b0.readPi} 末=${bn.readPi} 漂移=${rDrift}；序列=${bidir.map((x) => x.readPi).join("→")}`);
    ui.add("bidir-2", `[bidir] 双向 10 轮：编辑侧首末漂移 ≤1 段`,
      sDrift != null ? (sDrift <= 1 ? "PASS" : sDrift >= 3 ? "FAIL" : "KNOWN") : "FAIL",
      `首=${b0.srcPi} 末=${bn.srcPi} 漂移=${sDrift}；序列=${bidir.map((x) => x.srcPi).join("→")}`);
    ui.add("bidir-3", "[bidir] 诊断：10 轮全量", "PASS",
      bidir.map((x) => `R${x.round}: read${x.readPi}/src${x.srcPi}`).join(" | "));
  }

  /* ═══ 诊断：最后 dump 一次 scroll trace（看锚点 vs 百分比） ═══ */
  await ui.ev(`window.__LMD_SCROLL_TRACE = []; return true;`);
  await ui.command("view.edit");
  await ui.sleep(1500);
  await ui.command("view.preview");
  await ui.sleep(1500);
  const tr = await ui.ev(`
    const t = (window.__LMD_SCROLL_TRACE || []).filter(e => /^(cap-|res-)/.test(String(e.event)));
    return t.slice(-14);
  `);
  ui.add("D1", "往返一次后的锚点/恢复埋点（诊断）", "PASS", JSON.stringify(tr));
});

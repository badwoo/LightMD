/**
 * Lead 排查 3：**ghost 出现后能存活多久**（是否被 P0-1 重建冲掉）
 *
 * 上一轮结论：语法栏路径 ghost 出现（1 次），格式栏路径未出现。
 * 但「出现 1 次」不代表「用户能看见」—— 若 50ms 后就被重建冲掉，
 * 用户视觉上仍然等于「没有」。
 *
 * 本轮：
 *   1. 触发 ghost 后，密集轮询（30ms）× 100 次，记录存在/消失时刻
 *   2. 同时记录 CM6 重建时刻
 *   3. 判定：ghost 存活时长；若 < 200ms 则用户不可感知
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# Ghost 存活", "", "第二段落文字", "", "第三段落", ""].join("\n");

const caretToLine = async (ui, lineText) => {
  const r = await ui.ev(`
    const ed = document.querySelector(".cm-editor");
    const lines = Array.from(ed.querySelectorAll(".cm-line"));
    const target = lines.find(l => (l.textContent || "").includes(${JSON.stringify(lineText)}));
    if (!target) return { ok: false };
    const rect = target.getBoundingClientRect();
    window.__T = { x: Math.round(rect.left + 2), y: Math.round(rect.top + rect.height / 2) };
    return { ok: true, x: window.__T.x, y: window.__T.y };
  `);
  if (!r?.ok) return r;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(320);
  return r;
};

await runProbe({ name: "v0170-lead-ghost-life", doc: DOC, docTitle: "Ghost 存活" }, async (ui) => {
  // 页面内高频采样（rAF），不靠 CDP 轮询
  await ui.ev(`
    window.__LIFE = { samples: [], rebuild: 0 };
    const host = document.querySelector(".source-editor-cm6");
    if (host) {
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.removedNodes || [])
          if (n.nodeType === 1 && String(n.className||"").includes("cm-editor")) window.__LIFE.rebuild++;
      }).observe(host, { childList: true, subtree: false });
    }
    const tick = () => {
      const els = document.querySelectorAll(".cm-source-ghost");
      window.__LIFE.samples.push({ t: Date.now(), n: els.length });
      if (window.__LIFE.samples.length < 300) requestAnimationFrame(tick);
    };
    window.__LIFE.start = () => { window.__LIFE.samples = []; window.__LIFE.rebuild = 0; requestAnimationFrame(tick); };
    return true;
  `);

  await caretToLine(ui, "第二段落文字");
  await ui.ev(`window.__LIFE.start(); return true;`);

  // 点语法栏粗体
  await ui.ev(`
    const items = Array.from(document.querySelectorAll(".syntax-helper-item"));
    const it = items.find(x => (x.textContent || "").includes("粗体") && !(x.textContent||"").includes("粗斜"));
    if (it) it.click();
    return !!it;
  `);

  // 等 3 秒让采样跑完（rAF ≈ 16ms × 300 ≈ 4.8s，这里等 3.5s）
  await ui.sleep(3500);

  const life = await ui.ev(`
    const s = window.__LIFE.samples;
    const first = s.find(x => x.n > 0);
    const lastVisible = [...s].reverse().find(x => x.n > 0);
    const t0 = s.length ? s[0].t : 0;
    return {
      totalSamples: s.length,
      appeared: !!first,
      firstAtMs: first ? first.t - t0 : null,
      lastAtMs: lastVisible ? lastVisible.t - t0 : null,
      lifetimeMs: first && lastVisible ? lastVisible.t - first.t : 0,
      rebuildCount: window.__LIFE.rebuild,
      // 是否存在"出现后又消失"
      disappeared: !!first && s[s.length - 1].n === 0,
      visibleSamples: s.filter(x => x.n > 0).length,
    };
  `);
  ui.log("[life] " + JSON.stringify(life));

  ui.add("L1", "★ ghost 出现", life.appeared ? "PASS" : "FAIL",
    `首次出现 t=${life.firstAtMs}ms；可见采样 ${life.visibleSamples}/${life.totalSamples}`);

  ui.add("L2", "★ ghost 存活时长（用户能否看见）",
    !life.appeared ? "FAIL" : life.lifetimeMs >= 1000 ? "PASS" : life.lifetimeMs >= 200 ? "KNOWN" : "FAIL",
    `存活 ${life.lifetimeMs}ms（≥1000ms PASS / 200–1000ms 可感知但偏短 / <200ms 用户不可感知）；` +
    `期间 CM6 重建 ${life.rebuildCount} 次；是否出现后又消失=${life.disappeared}`);

  ui.add("L3", "ghost 未被重建冲掉（消失与重建的因果）",
    life.lifetimeMs >= 1000 ? "PASS" : "FAIL",
    `存活 ${life.lifetimeMs}ms，重建 ${life.rebuildCount} 次`);

  await ui.shot("ghost-life");
});

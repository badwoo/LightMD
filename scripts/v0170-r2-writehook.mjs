/**
 * #10 决定性取证：抓「恢复写入那一刻」的几何 + 调用栈。
 *
 * 上一轮诊断已确认两件事：
 *   1. `cm-scroller.scrollHeight` 在 mount 后**确实会变**（5254 → 6308），
 *      不是采样时机问题，是**布局真的还在长**；
 *   2. 恢复写进去的 `st=2376` 与最终 `max` 反推，写入时 `max ≈ 4761`，
 *      而最终 `max = 5549` → 恢复值偏小 **788px**（percent 0.499 → 0.428）。
 *
 * 本探针用 `Element.prototype.scrollTop` setter hook 精确抓写入时刻：
 *   - 谁写的（调用栈）
 *   - 写的时候 `scrollHeight / clientHeight / max` 是多少
 *   - 之后 `scrollHeight` 又变成了多少
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 写入时刻取证", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
    "",
  );
}
const DOC = parts.join("\n");
const DOC_PATH = "D:/tmp/v0170-r2-writehook.md";

const openDoc = (ui) =>
  ui.ev(`
    window.dispatchEvent(new CustomEvent("lightmd:openFile", {
      detail: { path: ${JSON.stringify(DOC_PATH)}, name: "writehook.md", content: ${JSON.stringify(DOC)} },
    }));
    return true;
  `);

/** 装 hook：记录所有对 .cm-scroller 的 scrollTop 写入 */
const installHook = (ui) =>
  ui.ev(`
    window.__WRITES = [];
    window.__SCROLL_EVENTS = [];
    if (!window.__HOOK_INSTALLED) {
      window.__HOOK_INSTALLED = true;
      const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get() { return d.get.call(this); },
        set(v) {
          try {
            if (this.classList && this.classList.contains("cm-scroller")) {
              window.__WRITES.push({
                t: Math.round(performance.now()),
                v: Math.round(v),
                stAfter: Math.round(d.get.call(this)),
                sh: Math.round(this.scrollHeight),
                h: Math.round(this.clientHeight),
                w: Math.round(this.getBoundingClientRect().width),
                cw: Math.round(this.clientWidth),
                max: Math.round(this.scrollHeight - this.clientHeight),
                lines: document.querySelectorAll(".cm-line").length,
                shellW: (() => { const s = document.querySelector(".split-preview-shell"); return s ? Math.round(s.getBoundingClientRect().width) : -1; })(),
                parentW: (() => { const p = this.parentElement; return p ? Math.round(p.getBoundingClientRect().width) : -1; })(),
                stack: (new Error().stack || "").split("\\n").slice(1, 7).join(" << "),
              });
            }
          } catch (e) { /* ignore */ }
          return d.set.call(this, v);
        },
      });
    }
    return true;
  `);

const geo = (ui) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    return { t: Math.round(performance.now()), st: Math.round(sc.scrollTop),
             sh: Math.round(sc.scrollHeight), h: Math.round(sc.clientHeight),
             max: Math.round(sc.scrollHeight - sc.clientHeight),
             shellW: (() => { const s = document.querySelector(".split-preview-shell"); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
             scrollerW: Math.round(sc.getBoundingClientRect().width) };
  `);

await runBrowserProbe({ name: "v0170-r2-writehook", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2400);
  // 确保预览开着（与用户默认入口一致）
  const hasIframe = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
  if (!hasIframe) { await ui.command("view.togglePreview"); await ui.sleep(1800); }
  await openDoc(ui);
  await ui.sleep(3000);

  await installHook(ui);
  await ui.ev(`window.__WRITES = []; window.__SCROLL_EVENTS = []; return true;`);

  /* 滚到 50%，等落盘 */
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.round(sc.scrollTop);
  `);
  await ui.sleep(7000);
  const before = await geo(ui);
  ui.log(`[before] st=${before.st} max=${before.max} sh=${before.sh} scrollerW=${before.scrollerW} shellW=${before.shellW} pct=${(before.st / before.max).toFixed(4)}`);

  /* reload */
  await ui.cdp.send("Page.reload", { ignoreCache: false });
  await ui.sleep(900);
  for (let i = 0; i < 60; i++) {
    const ok = await ui.ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
    if (ok) break;
    await ui.sleep(300);
  }
  await ui.sleep(1200);
  await installHook(ui);
  await ui.ev(`window.__WRITES = []; window.__SCROLL_EVENTS = []; return true;`);
  await openDoc(ui);

  /* 高频采样 12s：看几何与写入的时序关系 */
  const timeline = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const g = await geo(ui);
    const w = await ui.ev(`return (window.__WRITES || []).length`);
    timeline.push({ ...g, writes: w });
    await ui.sleep(200);
  }
  const writes = await ui.ev(`return window.__WRITES || []`);
  const after = await geo(ui);

  ui.log("[写入记录]");
  for (const w of writes) ui.log(`  t=${w.t} 写 ${w.v} → 实际 ${w.stAfter} | 当时 sh=${w.sh} h=${w.h} max=${w.max} w=${w.w} cw=${w.cw} lines=${w.lines} shellW=${w.shellW} | ${w.stack.slice(0, 200)}`);
  ui.log("[几何时间线（每 1s 抽一条）]");
  timeline.filter((_, i) => i % 5 === 0).forEach((g) => {
    if (g) ui.log(`  t=${g.t} st=${g.st} sh=${g.sh} max=${g.max} scrollerW=${g.scrollerW} shellW=${g.shellW} writes=${g.writes}`);
  });

  const firstWrite = writes[0];
  ui.add("W1", "★ 恢复写入时的几何 vs 最终几何", "PASS",
    firstWrite
      ? `写入值=${firstWrite.v} 当时 max=${firstWrite.max}（sh=${firstWrite.sh}）→ 最终 max=${after.max}（sh=${after.sh}）；` +
        `若按最终 max 应写=${Math.round((before.st / before.max) * after.max)}`
      : "无写入记录");
  ui.add("W2", "★ 写入时 scroller 宽度 vs 最终宽度（软换行数是否变了）", "PASS",
    firstWrite
      ? `写入时 w=${firstWrite.w} cw=${firstWrite.cw} shellW=${firstWrite.shellW}（sh=${firstWrite.sh}）→ 最终 scrollerW=${after.scrollerW} shellW=${after.shellW}`
      : "n/a");
  ui.add("W3", "★ 写入次数（是否只有一次性写入）", writes.length <= 1 ? "PASS" : "KNOWN",
    `${writes.length} 次；时间点=${writes.map((w) => w.t).join(",")}`);
  ui.add("D1", "诊断：最终 pct 与期望 pct", "PASS",
    `期望 pct=${(before.st / before.max).toFixed(4)} 实际 pct=${(after.st / after.max).toFixed(4)}（st=${after.st}/${after.max}）`);
  ui.add("D2", "诊断：调用栈（第一条写入）", "PASS", (firstWrite?.stack || "无").slice(0, 600));
});

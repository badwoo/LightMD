/**
 * C 流 / 定标探针 #8 —— 为「改设置后位置是否保持」选定**与应用实现一致**的判据
 *
 * 背景（重要）：
 * 应用对不同设置用了**两套**不同的补偿机制（读源码确认）：
 *   · docZoom        → PreviewPane 的 docZoom effect：记**滚动百分比**，按新高度还原
 *                      （注释明确："纯缩放是等比变换：滚动百分比天然守恒"）
 *   · lineHeight /
 *     paragraphSpacing /
 *     contentMaxWidth → captureTypographyAnchor：记**视口顶部首个块**的 offsetTop
 * 所以判"位置保持"必须用**各自承诺的口径**，否则会把"契约不同"误判成"缺陷"。
 *
 * 本探针一次性把两套口径都量出来，供写报告时直接引用：
 *   · 百分比守恒（→ 视口中心的内容点是否仍是同一段）
 *   · 顶部锚块 offsetTop（→ 是否仍是同一块、偏移多少）
 *   · 视口中心块 token（用户可感知的辅助口径）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const _p = [];
for (let i = 1; i <= 40; i++) {
  _p.push(
    `这是第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  );
}
const DOC = `# CAL-HEAD 定标文档

${_p.slice(0, 10).join("\n\n")}

## CAL-H2 中段

${_p.slice(10, 20).join("\n\n")}

## CAL-TAIL 结尾

${_p.slice(20, 32).join("\n\n")}
`;

const HELPERS = `
window.__RP2 = {
  _root(mode) { return mode === "edit" ? document.querySelector(".cm-scroller") : document.querySelector(".editor-container"); },
  _els(mode) { return mode === "edit" ? Array.from(document.querySelectorAll(".cm-line"))
                                      : Array.from(document.querySelectorAll(".editor-container .ProseMirror > *")); },
  /** 完整快照：三种位置口径一起量 */
  snap(mode) {
    const root = this._root(mode);
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const max = Math.max(0, root.scrollHeight - root.clientHeight);
    // 顶部锚块
    let top = null;
    for (const el of this._els(mode)) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      if (r.bottom > rr.top + 1) {
        const m = /PI([0-9][0-9])/.exec(el.textContent || "");
        top = { tok: m ? "PI" + m[1] : "(无PI)", offsetTop: Math.round(r.top - rr.top), h: Math.round(r.height) };
        break;
      }
    }
    // 视口中心块
    const mid = rr.top + rr.height / 2;
    let cen = null;
    for (const el of this._els(mode)) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      const m = /PI([0-9][0-9])/.exec(el.textContent || "");
      if (!m) continue;
      const d = Math.abs((r.top + r.height / 2) - mid);
      if (!cen || d < cen.d) cen = { d: Math.round(d), tok: "PI" + m[1], offsetTop: Math.round(r.top - rr.top) };
    }
    return { st: Math.round(root.scrollTop), sh: Math.round(root.scrollHeight),
             ch: Math.round(root.clientHeight), max: Math.round(max),
             pct: max > 0 ? +(root.scrollTop / max).toFixed(5) : null,
             centerPointInContent: Math.round(root.scrollTop + root.clientHeight / 2),
             top, cen };
  },
  /** 指定 token 的 offsetTop */
  tokOffset(mode, tok) {
    const root = this._root(mode);
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    for (const el of this._els(mode)) {
      if ((el.textContent || "").indexOf(tok) < 0) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      return { offsetTop: Math.round(r.top - rr.top), contentY: Math.round(r.top - rr.top + root.scrollTop) };
    }
    return null;
  },
  scrollToPct(mode, pct) {
    const root = this._root(mode);
    if (!root) return null;
    const max = root.scrollHeight - root.clientHeight;
    root.scrollTop = Math.round(max * pct);
    root.dispatchEvent(new Event("scroll"));
    return true;
  },
  typo() {
    const fs = (el) => el ? (function(cs){ return { fontSize: cs.fontSize, lineHeight: cs.lineHeight }; })(getComputedStyle(el)) : null;
    const pmP = document.querySelector(".editor-container .ProseMirror p");
    const sp = document.querySelector(".cm-scroller");
    return { cmLine: fs(document.querySelector(".cm-line")),
             pmP: pmP ? { fontSize: getComputedStyle(pmP).fontSize,
                          lineHeight: getComputedStyle(pmP).lineHeight,
                          marginTop: getComputedStyle(pmP).marginTop } : null,
             padLeft: sp ? getComputedStyle(sp).paddingLeft : null };
  },
  zoom() { return getComputedStyle(document.documentElement).getPropertyValue("--doc-zoom").trim(); },
};
return true;
`;

await runProbe(
  { name: "v0170-probe-rp-cal8", doc: DOC, docTitle: "CAL-HEAD", viewMode: "edit" },
  async (ui) => {
    await ui.ev(HELPERS);

    const openSettings = async () => {
      await ui.command("view.settings");
      await ui.sleep(1500);
      return !!(await ui.waitFor(
        `const el = document.querySelector('[data-testid="settings-content-max-width"]'); return !!el && el.getBoundingClientRect().width > 0;`, 7000));
    };
    const drive = async (testid, v) => {
      await ui.ev(`
        const el = document.querySelector('[data-testid="${testid}"]');
        if (!el) return false;
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        s.call(el, ${JSON.stringify(String(v))});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      `);
      await ui.sleep(1200);
    };
    const wheel = async (mode, times, dir) => {
      const mc = await ui.ev(`
        const el = ${JSON.stringify(mode)} === "edit" ? document.querySelector(".cm-scroller")
                                                      : document.querySelector(".editor-container");
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      `);
      for (let i = 0; i < times; i++) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: mc.x, y: mc.y, deltaX: 0,
          deltaY: dir < 0 ? -120 : 120, modifiers: 2 });
        await ui.sleep(300);
      }
      await ui.sleep(1500);
    };

    /** 对某个设置项：先建基线（滚 50%），改设置，再量 */
    const runCase = async (mode, c) => {
      // 基线
      await ui.ev(`
        const sc = window.__RP2._root(${JSON.stringify(mode)});
        sc.scrollTop = 0;
        return true;
      `);
      await ui.sleep(300);
      await ui.ev(`window.__RP2.scrollToPct(${JSON.stringify(mode)}, 0.5); return true;`);
      await ui.sleep(1500);
      const base = await ui.ev(`return { snap: window.__RP2.snap(${JSON.stringify(mode)}),
        tok: (window.__RP2.snap(${JSON.stringify(mode)})||{}).top,
        typo: window.__RP2.typo(), zoom: window.__RP2.zoom() };`);
      const anchorTok = base.snap?.top?.tok;
      const zoomBefore = base.zoom;

      // 应用变更
      if (c.kind === "zoom") {
        await wheel(mode, c.times, -1);
      } else {
        const op = await openSettings();
        if (!op) return null;
        await drive(c.testid, c.to);
      }
      await ui.sleep(800);
      const after = await ui.ev(`return { snap: window.__RP2.snap(${JSON.stringify(mode)}),
        tokNow: ${JSON.stringify(anchorTok)} ? window.__RP2.tokOffset(${JSON.stringify(mode)}, ${JSON.stringify(anchorTok)}) : null,
        typo: window.__RP2.typo(), zoom: window.__RP2.zoom() };`);

      // 还原
      if (c.kind === "zoom") {
        await wheel(mode, c.times, 1);
      } else {
        await drive(c.testid, c.back);
        await ui.key("Escape", "Escape", 27, 0);
        await ui.sleep(900);
      }

      const b = base.snap, a = after.snap;
      const zoomRatio = parseFloat(after.zoom) / (parseFloat(zoomBefore) || 1);
      // 口径1：视口中心的内容点是否按 zoom 比例缩放（等比变换 ⇒ 同一内容仍在中心）
      const centerRatio = b.centerPointInContent > 0 ? a.centerPointInContent / b.centerPointInContent : null;
      // 口径2：顶部锚块 offsetTop 位移
      const topDelta = (a.top && b.top) ? a.top.offsetTop - b.top.offsetTop : null;
      const topSameBlock = a.top && b.top ? a.top.tok === b.top.tok : null;
      // 口径3：同一 token 的 offsetTop 位移
      const tokDelta = after.tokNow && base.snap?.top ? after.tokNow.offsetTop - base.snap.top.offsetTop : null;
      // 口径4：视口中心块 token 是否仍是同一段
      const cenSame = a.cen && b.cen ? a.cen.tok === b.cen.tok : null;

      return { mode, key: c.key, anchorTok, base: b, after: a,
               topDelta, topSameBlock, tokDelta, cenSame, centerRatio, zoomRatio,
               zoomBefore, zoomAfter: after.zoom, typoB: base.typo, typoA: after.typo };
    };

    const report = (r) => {
      if (!r) { ui.log("  (用例未完成)"); return; }
      ui.log(`  ── ${r.mode} / ${r.key} ──`);
      ui.log(`     基线: st=${r.base.st}/${r.base.max} pct=${r.base.pct} 顶部锚=${r.base.top?.tok}@${r.base.top?.offsetTop} 中心块=${r.base.cen?.tok} 中心内容点=${r.base.centerPointInContent} zoom=${r.zoomBefore}`);
      ui.log(`     改后: st=${r.after.st}/${r.after.max} pct=${r.after.pct} 顶部锚=${r.after.top?.tok}@${r.after.top?.offsetTop} 中心块=${r.after.cen?.tok} 中心内容点=${r.after.centerPointInContent} zoom=${r.zoomAfter}`);
      ui.log(`     ▸ 口径1 中心内容点比值=${r.centerRatio}（zoom 比值=${r.zoomRatio}，等比变换应≈相等）`);
      ui.log(`     ▸ 口径2 顶部锚块 offsetTop Δ=${r.topDelta}px（同块=${r.topSameBlock}）`);
      ui.log(`     ▸ 口径3 同一 token ${r.anchorTok} offsetTop Δ=${r.tokDelta}px`);
      ui.log(`     ▸ 口径4 视口中心块仍是同一段=${r.cenSame}（${r.base.cen?.tok} → ${r.after.cen?.tok}）`);
    };

    const cases = [
      { kind: "zoom", key: "docZoom", times: 4 },
      { kind: "range", key: "lineHeight", testid: "settings-line-height", to: 28, back: 0 },
      { kind: "range", key: "contentMaxWidth", testid: "settings-content-max-width", to: 420, back: 0 },
      { kind: "range", key: "paragraphSpacing", testid: "settings-paragraph-spacing", to: 20, back: 0 },
      { kind: "range", key: "fontSize", testid: "settings-font-size", to: 26, back: 16 },
    ];

    ui.log(`\n═══ 编辑模式（.cm-scroller） ═══`);
    for (const c of cases) {
      if ((await ui.ev(`return document.querySelector(".cm-editor").getBoundingClientRect().width > 0 ? "edit" : "read"`)) !== "edit") {
        await ui.command("view.edit");
        await ui.sleep(3000);
        await ui.ev(HELPERS);
      }
      const r = await runCase("edit", c);
      report(r);
      await ui.sleep(600);
    }

    ui.log(`\n═══ 阅读模式（.editor-container） ═══`);
    await ui.command("view.preview");
    await ui.sleep(3000);
    await ui.ev(HELPERS);
    for (const c of cases) {
      const r = await runCase("read", c);
      report(r);
      await ui.sleep(600);
    }

    ui.log(`errors: ${JSON.stringify(await ui.errors()).slice(0, 300)}`);
  },
);

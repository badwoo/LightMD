/**
 * v0.17.1 · Lead: I2 -- is the jitter a FRAME TIMING problem?
 *
 * ## Established
 * `v0171-lead-i2smooth.mjs` proved the geometry of the preview-close animation is
 * clean on a plain document: content column x moves 134 -> 632 monotonically with
 * 0 direction reversals, content width constant at 734px, scrollHeight constant.
 *
 * So "not smooth" cannot be a position error. The remaining possibility is that the
 * animation DROPS FRAMES: at 60Hz a 498px move spread over 26 painted frames looks
 * smooth; the same move over 8 painted frames with 50-80ms gaps looks like a jump.
 *
 * This probe measures:
 *   1. the interval between consecutive painted frames during the close animation,
 *   2. the per-frame displacement while frames are being lost,
 *   3. whether the two animated properties (shell width, scroller padding-inline)
 *      actually share ONE timing function, or whether the padding transition chases
 *      a moving percentage target (which produces a compound, non-linear easing).
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const LONG = (i) => {
  let s = `P${i + 1}. `;
  const body = "content words repeated so the paragraph spans several visual lines. ";
  while (s.length < 700) s += body;
  return s;
};

/** Heavier document: more DOM, closer to a real long markdown file. */
const DOC = ["# I2 frame timing", "", ...Array.from({ length: 40 }, (_, i) => LONG(i) + "\n")].join("\n");

await runProbe(
  { name: "v0171-lead-i2frames", doc: DOC, docTitle: "I2 frame timing", viewMode: "edit" },
  async (ui) => {
    const ev = ui.ev;
    const add = ui.add;
    const sleep = ui.sleep;

    /* record the CSS timing functions actually in force */
    const css = await ev(`
      const sc = document.querySelector(".cm-scroller");
      const shell = document.querySelector(".split-preview-shell");
      const wrap = document.querySelector(".source-editor-wrapper");
      const host = document.querySelector(".source-editor-cm6");
      const g = (el) => el ? getComputedStyle(el) : null;
      return {
        scrollerPaddingTransition: g(sc) ? g(sc).transition : null,
        scrollerPaddingInline: g(sc) ? g(sc).paddingLeft : null,
        shellTransition: g(shell) ? g(shell).transition : null,
        wrapperTransition: g(wrap) ? g(wrap).transition : null,
        wrapperWidth: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
        hostOutline: g(host) ? g(host).outline : null,
      };
    `);
    add("I2F-0", "record: CSS transitions in force",
      css.shellTransition && css.shellTransition.indexOf("0.42s") >= 0 ? "PASS" : "KNOWN",
      JSON.stringify(css));

    const measureAnim = async (label, action) => {
      await ev(`
        const sc = document.querySelector(".cm-scroller");
        window.__F = { samples: [], longFrames: [] };
        let last = performance.now();
        const t0 = last;
        const tick = () => {
          const now = performance.now();
          const dt = now - last;
          last = now;
          const shell = document.querySelector(".split-preview-shell");
          const cs = document.querySelector(".cm-content");
          const cr = sc.getBoundingClientRect();
          const csr = cs.getBoundingClientRect();
          const rec = { t: Math.round(now - t0), dt: Math.round(dt),
                        shellW: shell ? Math.round(shell.getBoundingClientRect().width) : null,
                        contentL: Math.round(csr.left - cr.left),
                        hostW: Math.round(sc.getBoundingClientRect().width) };
          window.__F.samples.push(rec);
          if (dt > 34) window.__F.longFrames.push(rec);
          if (now - t0 < 1500) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
      `);
      await action();
      await sleep(1900);
      const f = await ev(`return window.__F;`);
      const s = (f && f.samples) || [];
      const dts = s.map((x) => x.dt).filter((d) => d > 0);
      const longFrames = (f && f.longFrames) || [];
      // frames whose interval exceeds two 60Hz periods:
      const stutters = dts.filter((d) => d > 34);
      const maxDt = dts.length ? Math.max(...dts) : 0;
      const avgDt = dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : 0;
      // displacement across each stutter: a large jump delivered in one frame = visible jerk
      let maxJumpDuringStutter = 0;
      for (let i = 1; i < s.length; i++) {
        if (s[i].dt > 34) maxJumpDuringStutter = Math.max(maxJumpDuringStutter, Math.abs(s[i].contentL - s[i - 1].contentL));
      }
      const contentSeries = s.map((x) => x.contentL);
      const hostW = s.map((x) => x.hostW);
      ui.log(`[${label}] frames=${s.length} avgDt=${avgDt.toFixed(1)}ms maxDt=${maxDt}ms stutters=${stutters.length}`);
      ui.log(`[${label}] dt = ${JSON.stringify(dts.filter((_, i) => i % 2 === 0))}`);
      ui.log(`[${label}] contentL = ${JSON.stringify(contentSeries.filter((_, i) => i % 2 === 0))}`);
      ui.log(`[${label}] hostW = ${JSON.stringify(hostW.filter((_, i) => i % 2 === 0))}`);
      return { label, frames: s.length, avgDt, maxDt, stutters: stutters.length,
               maxJumpDuringStutter, contentSeries, hostW };
    };

    /* -------- close the preview -------- */
    const close = await measureAnim("close", async () => {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
    });
    add("I2F-1", "★ close: no dropped frames during the animation (all intervals <=34ms)",
      close.stutters === 0 ? "PASS" : "FAIL",
      `stutters=${close.stutters} avgDt=${close.avgDt.toFixed(1)}ms maxDt=${close.maxDt}ms`);
    add("I2F-2", "★ close: max displacement delivered in a single stutter frame (<=16px = 1 frame worth)",
      close.maxJumpDuringStutter <= 16 ? "PASS" : "FAIL",
      `maxJumpDuringStutter=${close.maxJumpDuringStutter}px`);

    /* -------- open it again -------- */
    const open = await measureAnim("open", async () => {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
    });
    add("I2F-3", "★ open: no dropped frames during the animation",
      open.stutters === 0 ? "PASS" : "FAIL",
      `stutters=${open.stutters} avgDt=${open.avgDt.toFixed(1)}ms maxDt=${open.maxDt}ms`);
    add("I2F-4", "★ open: max displacement delivered in a single stutter frame",
      open.maxJumpDuringStutter <= 16 ? "PASS" : "FAIL",
      `maxJumpDuringStutter=${open.maxJumpDuringStutter}px`);

    /* -------- does the content column move in lockstep with the pane width? -------- */
    /**
     * If the padding transition were chasing a moving percentage target, the content
     * column would lag the pane width. Measure the correlation of their normalised
     * progress: both should reach ~50% at the same frame.
     */
    const progressPairs = (r) => {
      const w0 = r.hostW[0], w1 = r.hostW[r.hostW.length - 1];
      const c0 = r.contentSeries[0], c1 = r.contentSeries[r.contentSeries.length - 1];
      if (!w1 || !c1 || w1 === w0 || c1 === c0) return null;
      let maxSkew = 0, at = null;
      for (let i = 0; i < Math.min(r.hostW.length, r.contentSeries.length); i++) {
        const pw = (r.hostW[i] - w0) / (w1 - w0);
        const pc = (r.contentSeries[i] - c0) / (c1 - c0);
        // only compare while the motion is actually in progress
        if (pw > 0.02 && pw < 0.98) {
          const skew = Math.abs(pw - pc);
          if (skew > maxSkew) { maxSkew = skew; at = i; }
        }
      }
      return { maxSkew, at };
    };
    const sClose = progressPairs(close);
    add("I2F-5", "★ close: content column tracks pane width (lag <=10% of progress)",
      sClose && sClose.maxSkew <= 0.10 ? "PASS" : "FAIL",
      JSON.stringify(sClose));
    const sOpen = progressPairs(open);
    add("I2F-6", "★ open: content column tracks pane width (lag <=10% of progress)",
      sOpen && sOpen.maxSkew <= 0.10 ? "PASS" : "FAIL",
      JSON.stringify(sOpen));
  },
);

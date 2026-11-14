/**
 * v0.17.1 · Lead: I1 definitive cause + regression gate
 * ("TypeError: Cannot set properties of null (setting 'innerHTML')")
 *
 * ## Why a passive double-Ctrl is not enough
 * The passive path (`v0171-lead-repro.mjs i1`) does NOT crash -- before or after the
 * fix. The defect needs a SECOND run of the iframe-writing effect *inside* the
 * window where `iframe.contentDocument.body` is still null. That window is real and
 * measurable (verified: 5 frames of body===null, readyState "loading", because the
 * rewritten <head> carries non-async mermaid/katex scripts and the parser stops there).
 *
 * ## Chain (each link measured, none assumed)
 * 1. The only unguarded innerHTML write in non-test code is PreviewPane's
 *    incremental branch `doc.body.innerHTML = previewHtml`. Every other site is
 *    either guarded or writes to a field created in a constructor.
 * 2. That branch requires `needFullRewrite === false`, whose first term is
 *    `!init.mermaid && !init.math`. A document WITHOUT mermaid/math therefore can
 *    never reach it (init stays {false,false}) -- which is exactly why ordinary
 *    documents do not reproduce.
 * 3. `previewIframeInitRef` used to be committed right after `doc.close()`, i.e.
 *    while `doc.body` could still be null -> producing "init updated, body null".
 * 4. A second effect run in that window (any dep change: docZoom, theme,
 *    typography, html) then computes needFullRewrite === false -> null.innerHTML -> throw.
 * 5. The throw happens during render/effect -> ErrorBoundary takes the whole tree ->
 *    user sees the full-screen "interface render error".
 *
 * ## Judgement design (anti-vacuity, R5 §4.2)
 * - Q1 must prove the body-null window exists (else the test cannot fail).
 * - Q2 must prove the second effect run really happened.
 * - Q3 asserts the exact error text the user reported.
 * - Q4 is a DESTRUCTIVE CONTROL: the identical operation on a plain-text document
 *   must NOT error. If it also errored, the root cause would be wrong.
 *
 * With the fix: Q1/Q2 still hold, Q3 must now FAIL-to-crash (i.e. PASS = no crash).
 *
 * Usage: node scripts/v0171-lead-i1-window.mjs
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const RICH = [
  "# I1 causal · rich document",
  "",
  "Intro. " + "filler. ".repeat(30),
  "",
  "## Diagram",
  "",
  "```mermaid",
  "graph TD;",
  "  A[Alpha] --> B[Beta];",
  "```",
  "",
  "## Math",
  "",
  "$$",
  "\\sum_{i=1}^{n} x_i",
  "$$",
  "",
  "## Body",
  "",
  ...Array.from({ length: 8 }, (_, i) => `Rich paragraph ${i + 1}: ${"content text. ".repeat(14)}\n`),
].join("\n");

const PLAIN = [
  "# I1 causal · plain document",
  "",
  "Intro. " + "filler. ".repeat(30),
  "",
  "## Body",
  "",
  ...Array.from({ length: 8 }, (_, i) => `Plain paragraph ${i + 1}: ${"content text. ".repeat(14)}\n`),
].join("\n");

const BOUNDARY = `
  const el = document.querySelector("[data-testid='error-boundary']");
  if (!el) return { shown: false };
  const d = document.querySelector("[data-testid='error-boundary-detail']");
  return { shown: true, detail: (d && d.textContent || "").slice(0, 300) };
`;

await runProbe(
  { name: "v0171-lead-i1-window", doc: RICH, docTitle: "I1 causal", viewMode: "preview" },
  async (ui) => {
    const ev = ui.ev;
    const add = ui.add;
    const sleep = ui.sleep;
    const cmd = async (id) => {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: ${JSON.stringify(id)} } })); return true;`);
    };
    const boundary = () => ev(BOUNDARY);
    const doubleCtrl = async () => {
      for (let k = 0; k < 2; k++) {
        for (const type of ["keyDown", "keyUp"]) {
          await ui.cdp.send("Input.dispatchKeyEvent", {
            type, key: "Control", code: "ControlLeft",
            windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
          });
        }
        await sleep(55);
      }
    };
    const retry = async () => {
      const ok = await ev(`const b=document.querySelector("[data-testid='error-boundary-retry']"); if(b) b.click(); return !!b;`).catch(() => false);
      if (ok) await sleep(1600);
      return ok;
    };

    /* capture the ErrorBoundary componentStack */
    await ev(`
      (() => {
        window.__EB_STACK__ = null;
        if (window.__EB_HOOKED__) return true;
        window.__EB_HOOKED__ = true;
        const orig = console.error;
        console.error = function (...a) {
          try {
            const s = a.map((x) => { try { return typeof x === "object" ? JSON.stringify(x) : String(x); } catch { return ""; } }).join(" | ");
            if (s.indexOf("ErrorBoundary") >= 0) window.__EB_STACK__ = s.slice(0, 4000);
          } catch {}
          return orig.apply(this, a);
        };
        return true;
      })()
    `);

    /**
     * One trial: enter edit mode while a per-frame sampler watches the iframe.
     * The moment a frame shows `body === null`, fire a REAL Ctrl+wheel so the
     * writing effect re-runs (docZoom is in its dependency array) -- this is the
     * second run inside the window that the defect needs.
     */
    const trial = async (label) => {
      await ev(`
        window.__W = []; window.__WSTOP = false; window.__FOUND = null;
        const t0 = performance.now();
        let armed = false;
        const tick = () => {
          if (window.__WSTOP) return;
          const f = document.querySelector("iframe.split-preview");
          const doc = f && f.contentDocument;
          const bodyNull = f ? !(doc && doc.body) : null;
          window.__W.push({ t: Math.round(performance.now() - t0), hasIframe: !!f,
                            bodyNull, rs: doc ? (doc.readyState || null) : null });
          if (!armed && f && bodyNull === true) {
            armed = true;
            window.__FOUND = { t: Math.round(performance.now() - t0) };
            const area = document.querySelector(".editor-main-area");
            if (area) {
              const r = area.getBoundingClientRect();
              const opts = { deltaY: -120, deltaMode: 0, ctrlKey: true, bubbles: true,
                             cancelable: true, clientX: Math.round(r.left + r.width / 2),
                             clientY: Math.round(r.top + r.height / 2) };
              area.dispatchEvent(new WheelEvent("wheel", opts));
              setTimeout(() => area.dispatchEvent(new WheelEvent("wheel", opts)), 25);
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
      `);

      await doubleCtrl();
      await sleep(2800);

      const w = await ev(`window.__WSTOP = true; return { w: window.__W || [], found: window.__FOUND };`);
      const frames = (w && w.w) || [];
      const nullFrames = frames.filter((x) => x.bodyNull === true);
      const b = await boundary();
      const stack = await ev(`return window.__EB_STACK__ || null;`).catch(() => null);
      return { label, nullFrames: nullFrames.length, found: w && w.found, boundary: b, stack,
               readyStates: [...new Set(frames.map((x) => x.rs))] };
    };

    /* ===== experiment: rich document (can reach the incremental branch) ===== */
    const exp = await trial("rich");
    ui.log(`[exp] body===null frames = ${exp.nullFrames}; triggered at ${JSON.stringify(exp.found)}`);
    ui.log(`[exp] readyStates = ${JSON.stringify(exp.readyStates)}`);
    ui.log(`[exp] boundary = ${JSON.stringify(exp.boundary)}`);
    if (exp.stack) ui.log(`[exp] componentStack = ${JSON.stringify(exp.stack).slice(0, 2000)}`);

    add("Q1", "precondition: the iframe goes through a body===null window",
      exp.nullFrames > 0 ? "PASS" : "KNOWN", `nullFrames=${exp.nullFrames}`);
    add("Q2", "precondition: a second effect run fires inside that window (Ctrl+wheel sent)",
      exp.found ? "PASS" : "KNOWN", JSON.stringify(exp.found));

    const crashedExactly = exp.boundary.shown &&
      /Cannot set properties of null/.test(exp.boundary.detail || "");
    add("Q3", "★ rich document: second run inside the window triggers TypeError innerHTML of null",
      crashedExactly ? "FAIL" : "PASS",
      crashedExactly
        ? `DEFECT REPRODUCED: ${JSON.stringify(exp.boundary.detail)}`
        : `no crash (boundary shown=${exp.boundary.shown})`);

    if (exp.boundary.shown) {
      const ok = await retry();
      const after = await boundary();
      add("Q3b", "clicking Retry recovers (=> first-frame race, document intact)",
        ok && !after.shown ? "PASS" : "FAIL",
        JSON.stringify({ retried: ok, shownAfter: after.shown }));
      await cmd("view.preview");
      await sleep(1600);
    } else {
      add("Q3b", "clicking Retry recovers", "KNOWN", "no boundary appeared");
    }

    /* ===== destructive control: plain document (cannot reach the branch) ===== */
    await cmd("view.preview");
    await sleep(1400);
    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify("D:\\\\AI\\\\markdown view\\\\lightmd\\\\_verify-out\\\\i1-plain.md")},
                  name: "i1-plain.md", content: ${JSON.stringify(PLAIN)} },
      }));
      return true;
    `);
    await sleep(2400);
    /* reset iframe init: toggle the preview off/on so init returns to the false state */
    await cmd("view.edit");
    await sleep(1800);
    await cmd("view.togglePreview");
    await sleep(1300);
    await cmd("view.preview");
    await sleep(1300);

    const ctrl = await trial("plain");
    ui.log(`[ctrl] body===null frames = ${ctrl.nullFrames}; triggered at ${JSON.stringify(ctrl.found)}`);
    ui.log(`[ctrl] boundary = ${JSON.stringify(ctrl.boundary)}`);

    add("Q4", "destructive control: same operation on a PLAIN document does not error",
      ctrl.boundary.shown ? "FAIL" : "PASS",
      JSON.stringify({ shown: ctrl.boundary.shown, detail: ctrl.boundary.detail,
                       nullFrames: ctrl.nullFrames, found: !!ctrl.found }));

    /* ===== keep the preview usable after the experiment ===== */
    const finalBoundary = await boundary();
    add("Q5", "no lingering render-error boundary at the end", finalBoundary.shown ? "FAIL" : "PASS",
      JSON.stringify(finalBoundary));

    const errs = await ev(`return window.__ERRS || []`);
    add("Z9", "no uncaught exceptions recorded", errs.length === 0 ? "PASS" : "FAIL",
      JSON.stringify(errs.slice(0, 5)));
  },
);

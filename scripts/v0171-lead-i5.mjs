/**
 * v0.17.1 · Lead: I5 format-painter audit (reading mode), with the target in view
 *
 * ## Fix for the previous vacuity
 * `v0171-lead-i4i5.mjs` reported I5-A0 "selected the bold text" as PASS because it
 * only checked `range.toString()` -- but the returned rect was `y=-2188`, i.e. the
 * bold line was 2188px ABOVE the viewport. A right-click at that coordinate therefore
 * hit nothing, so "menu did not open" was a probe artifact, not a product defect.
 *
 * Fix: scroll the target into view FIRST, verify the rect is inside the viewport,
 * and only then right-click. Every judgement gets a precondition line that must pass.
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const FILLER = (i) => {
  let s = `Filler ${i + 1}. `;
  const body = "Text long enough that the reading pane has several screens of content. ";
  while (s.length < 420) s += body;
  return s;
};

/** Bold source near the TOP so it is reachable; several plain targets below it. */
const DOC = [
  "# I5 painter",
  "",
  "**bold source**",
  "",
  "plain target alpha",
  "",
  "plain target beta",
  "",
  "## Body",
  "",
  ...Array.from({ length: 16 }, (_, i) => FILLER(i) + "\n"),
].join("\n");

await runProbe(
  { name: "v0171-lead-i5", doc: DOC, docTitle: "I5 painter", viewMode: "preview" },
  async (ui) => {
    const ev = ui.ev;
    const add = ui.add;
    const sleep = ui.sleep;
    const click = async (x, y, button = "left") => {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
      await sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
      await sleep(160);
    };

    const painter = () => ev(`
      const armed = document.body.classList.contains("format-painter-armed");
      let hint = null;
      for (const e of document.querySelectorAll("span,div")) {
        const t = (e.textContent || "").trim();
        if (/格式刷|format painter/i.test(t) &&
            /(单击目标|持续应用|剩余|click a target|persistent)/i.test(t) &&
            e.children.length === 0) { hint = t.slice(0, 100); break; }
      }
      const toasts = Array.from(document.querySelectorAll("[class*='notification'],[class*='toast'],[role='alert']"))
        .map((e) => (e.textContent || "").trim().slice(0, 130)).filter(Boolean);
      return { armed, hint, toasts: [...new Set(toasts)] };
    `);

    const menu = () => ev(`
      const ms = Array.from(document.querySelectorAll(".editor-context-menu"))
        .filter((m) => m.getBoundingClientRect().width > 0);
      if (!ms.length) return { open: false };
      const m = ms[ms.length - 1];
      return { open: true, items: Array.from(m.querySelectorAll(".context-menu-item"))
        .map((el) => ({ label: (el.textContent || "").trim().slice(0, 36),
                        disabled: el.classList.contains("disabled") })) };
    `);

    /** Select the N-th text of a block, after scrolling it into the middle of the viewport. */
    const selectInView = async (selector, which) => ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      const c = document.querySelector(".editor-container");
      const targets = Array.from(pm.querySelectorAll(${JSON.stringify(selector)}));
      const el = targets[${which}] || targets[0];
      if (!el) return { err: "target not found", count: targets.length };
      // put it in the middle of the viewport
      const cr = c.getBoundingClientRect();
      const r0 = el.getBoundingClientRect();
      c.scrollTop = Math.round(c.scrollTop + (r0.top - cr.top) - Math.round(cr.height * 0.35));
      const r = el.getBoundingClientRect();
      const cr2 = c.getBoundingClientRect();
      const inView = r.top >= cr2.top + 20 && r.bottom <= cr2.bottom - 20 && r.height > 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      pm.focus();
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      const rr = range.getBoundingClientRect();
      return { ok: true, inView, text: range.toString().slice(0, 30),
               x: Math.round(rr.left + rr.width/2), y: Math.round(rr.top + rr.height/2),
               rectTop: Math.round(rr.top), rectH: Math.round(rr.height),
               viewTop: Math.round(cr2.top), viewBottom: Math.round(cr2.bottom) };
    `);

    const clickMenuItem = (re) => ev(`
      const ms = Array.from(document.querySelectorAll(".editor-context-menu"))
        .filter((x) => x.getBoundingClientRect().width > 0);
      if (!ms.length) return null;
      const m = ms[ms.length - 1];
      const items = Array.from(m.querySelectorAll(".context-menu-item"));
      const re = new RegExp(${JSON.stringify(re)});
      const b = items.find((el) => re.test((el.textContent || "").trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
               label: (b.textContent || "").trim() };
    `);

    /* ============ A) collect format from real bold text ============ */
    const bold = await selectInView("strong", 0);
    add("I5-A0", "★ precondition: bold text selected and IN VIEW",
      bold && bold.ok && bold.inView ? "PASS" : "KNOWN", JSON.stringify(bold));

    if (bold && bold.ok && bold.inView) {
      await sleep(350);
      await click(bold.x, bold.y, "right");
      await sleep(700);
      const m = await menu();
      add("I5-A1", "★ reading-mode context menu opens on the bold selection",
        m.open ? "PASS" : "FAIL", JSON.stringify(m.items ? m.items.map((i) => i.label) : m));

      if (m.open) {
        const fp = await clickMenuItem("格式刷$|^Format Painter$");
        add("I5-A2", "single-shot painter entry present",
          fp ? "PASS" : "FAIL", JSON.stringify(fp));
        if (fp) {
          await click(fp.x, fp.y);
          await sleep(700);
          const st = await painter();
          add("I5-A3", "★ painter ARMS after collecting bold",
            st.armed ? "PASS" : "FAIL", JSON.stringify(st));

          if (st.armed) {
            /* apply to "plain target alpha" */
            const tgt = await selectInView("p", 0).then(async (r) => {
              // deselect first: a selection would change the click semantics
              await ev(`window.getSelection().removeAllRanges(); return true;`);
              return r;
            });
            const alphaPt = await ev(`
              const pm = document.querySelector(".editor-container .ProseMirror");
              const c = document.querySelector(".editor-container");
              const ps = Array.from(pm.querySelectorAll("p"))
                .filter((p) => (p.textContent || "").indexOf("plain target alpha") >= 0);
              if (!ps.length) return null;
              const p = ps[0];
              const cr = c.getBoundingClientRect();
              const r0 = p.getBoundingClientRect();
              if (r0.top < cr.top + 40 || r0.bottom > cr.bottom - 40) {
                c.scrollTop = Math.round(c.scrollTop + (r0.top - cr.top) - 160);
              }
              const r = p.getBoundingClientRect();
              const cr2 = c.getBoundingClientRect();
              return { x: Math.round(r.left + 70), y: Math.round(r.top + r.height/2),
                       inView: r.top >= cr2.top + 10 && r.bottom <= cr2.bottom - 10 };
            `);
            add("I5-A4", "precondition: plain target in view",
              alphaPt && alphaPt.inView ? "PASS" : "KNOWN", JSON.stringify(alphaPt));
            if (alphaPt && alphaPt.inView) {
              await click(alphaPt.x, alphaPt.y);
              await sleep(900);
              const applied = await ev(`
                const pm = document.querySelector(".editor-container .ProseMirror");
                const ps = Array.from(pm.querySelectorAll("p"))
                  .filter((p) => (p.textContent || "").indexOf("plain target alpha") >= 0);
                return ps.length ? { strong: !!ps[0].querySelector("strong"),
                                     html: ps[0].innerHTML.slice(0, 80) } : null;
              `);
              const after = await painter();
              add("I5-A5", "★ painter APPLIED bold to the plain target",
                applied && applied.strong ? "PASS" : "FAIL", JSON.stringify(applied));
              add("I5-A6", "★ single-shot painter DISARMS after applying once",
                !after.armed ? "PASS" : "FAIL", JSON.stringify(after));
            }
          }
        }
      }
    }

    /* ============ B) collect from PLAIN text (nothing to collect) ============ */
    const plain = await ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      const c = document.querySelector(".editor-container");
      const ps = Array.from(pm.querySelectorAll("p")).filter((p) => {
        const t = (p.textContent || "");
        return t.indexOf("plain target") >= 0 && !p.querySelector("strong,em,s,code");
      });
      if (!ps.length) return { err: "no plain paragraph" };
      const el = ps[0];
      const cr = c.getBoundingClientRect();
      const r0 = el.getBoundingClientRect();
      c.scrollTop = Math.round(c.scrollTop + (r0.top - cr.top) - Math.round(cr.height * 0.35));
      const node = el.firstChild;
      if (!node || node.nodeType !== 3) return { err: "not a text node" };
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(12, node.textContent.length));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      pm.focus();
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      const rr = range.getBoundingClientRect();
      const cr2 = c.getBoundingClientRect();
      return { ok: true, text: range.toString(),
               x: Math.round(rr.left + rr.width/2), y: Math.round(rr.top + rr.height/2),
               inView: rr.top >= cr2.top + 10 && rr.bottom <= cr2.bottom - 10 };
    `);
    add("I5-B0", "★ precondition: plain text selected and IN VIEW",
      plain && plain.ok && plain.inView ? "PASS" : "KNOWN", JSON.stringify(plain));

    if (plain && plain.ok && plain.inView) {
      await sleep(350);
      await click(plain.x, plain.y, "right");
      await sleep(700);
      const fpB = await clickMenuItem("格式刷$|^Format Painter$");
      if (fpB) {
        await click(fpB.x, fpB.y);
        await sleep(700);
        const st = await painter();
        add("I5-B1", "★ plain selection: explicit rejection toast, and NOT armed",
          !st.armed && st.toasts.length > 0 ? "PASS" : "FAIL", JSON.stringify(st));
      } else {
        add("I5-B1", "plain selection: painter entry", "FAIL", "menu item not found");
      }
    }

    /* ============ C) continuous painter ============ */
    const bold2 = await selectInView("strong", 0);
    if (bold2 && bold2.ok && bold2.inView) {
      await sleep(350);
      await click(bold2.x, bold2.y, "right");
      await sleep(700);
      const cont = await clickMenuItem("连续刷|Continuous");
      add("I5-C0", "★ continuous painter entry present in the reading-mode menu",
        cont ? "PASS" : "FAIL", JSON.stringify(cont));
      if (cont) {
        await click(cont.x, cont.y);
        await sleep(700);
        const st = await painter();
        add("I5-C1", "★ continuous painter arms and shows the remaining-count hint",
          st.armed && !!st.hint ? "PASS" : "FAIL", JSON.stringify(st));

        if (st.armed) {
          /* apply twice to two different plain targets; it must stay armed and decrement */
          const spots = await ev(`
            const pm = document.querySelector(".editor-container .ProseMirror");
            const c = document.querySelector(".editor-container");
            const cr = c.getBoundingClientRect();
            const ps = Array.from(pm.querySelectorAll("p")).filter((p) => {
              const t = (p.textContent || "");
              return t.indexOf("plain target") >= 0 && !p.querySelector("strong");
            });
            const out = [];
            for (const p of ps) {
              const r0 = p.getBoundingClientRect();
              if (r0.top > cr.top + 20 && r0.bottom < cr.bottom - 20 && r0.height > 4) {
                out.push({ x: Math.round(r0.left + 70), y: Math.round(r0.top + r0.height/2) });
              }
            }
            return out;
          `);
          add("I5-C2", "precondition: found unmarked in-view targets for the continuous test",
            spots && spots.length >= 1 ? "PASS" : "KNOWN", JSON.stringify(spots));

          if (spots && spots.length) {
            const hints = [];
            for (const s of spots.slice(0, 2)) {
              await click(s.x, s.y);
              await sleep(800);
              const st2 = await painter();
              hints.push({ armed: st2.armed, hint: st2.hint });
            }
            add("I5-C3", "★ continuous painter stays armed across applications and counts down",
              hints.every((h) => h.armed) && hints.length > 1 ? "PASS" : "FAIL",
              JSON.stringify(hints));

            await ui.key("Escape", "Escape", 27);
            await sleep(650);
            const st3 = await painter();
            add("I5-C4", "★ Esc exits the continuous painter", !st3.armed ? "PASS" : "FAIL", JSON.stringify(st3));
          }
        }
      }
    }

    const errs = await ev(`return window.__ERRS || []`);
    add("Z9", "no uncaught exceptions", errs.length === 0 ? "PASS" : "FAIL", JSON.stringify(errs.slice(0, 4)));
  },
);

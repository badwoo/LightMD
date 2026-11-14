/**
 * v0.17.1 · Lead: I4 decisive -- is the apparent jump just bottom-clamping?
 *
 * ## The evidence that needs explaining
 * `v0171-lead-i234.mjs` (real exe) recorded:
 * ```
 * codeblock: baseTop=4787  sh=6038  ch=1250   -> max = 4788   (AT THE BOTTOM)
 *            insert -> insTop=4873  sh=6124   -> max = 4874
 *            Backspace x2 -> endTop = 2307
 * bold:      baseTop=3507  sh=6067  ch=1250   -> max = 4817   (room below)
 *            insert -> insTop=3507  sh=6067
 *            Backspace x2 -> endTop = 2307
 * ```
 * Both landed on the SAME 2307. A shared resting value across two different starting
 * points is the signature of **clamping to a new max**, not of a random jump.
 *
 * And `v0171-lead-i4clean.mjs` -- same operations, but starting with plenty of room
 * below -- measured **0px** jump for both cases, with `scrollHeightRange` 0~144px.
 *
 * So the remaining question is exact: does `scrollHeight` really collapse by ~2500px
 * when the inserted format is deleted? If yes, the viewport move is *forced* by the
 * browser (you cannot keep scrollTop above the new max), and the real defect -- if
 * any -- is the transient height collapse itself, not the scroll write.
 *
 * This probe records `scrollHeight` at every step so the arithmetic closes.
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const MED = (i) => {
  let s = `P${i + 1}. `;
  const body = "content words repeated so this paragraph spans several visual lines in the source pane. ";
  while (s.length < 520) s += body;
  return s;
};

const DOC = ["# I4 clamp", "", ...Array.from({ length: 30 }, (_, i) => MED(i) + "\n")].join("\n");

await runProbe(
  { name: "v0171-lead-i4clamp", doc: DOC, docTitle: "I4 clamp", viewMode: "edit" },
  async (ui) => {
    const ev = ui.ev;
    const add = ui.add;
    const sleep = ui.sleep;
    const click = async (x, y) => {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(150);
    };
    const wheelAt = async (x, y, dy) => {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy, pointerType: "mouse" });
      await sleep(30);
    };

    const G = `
      const sc = document.querySelector(".cm-scroller");
      const c = document.querySelector(".cm-content");
      let len = null, sel = null;
      try { const v = c.cmTile.view; len = v.state.doc.length;
            sel = v.state.selection.main.from; } catch {}
      return { top: Math.round(sc.scrollTop), sh: sc.scrollHeight, ch: sc.clientHeight,
               max: Math.max(0, sc.scrollHeight - sc.clientHeight),
               room: Math.max(0, sc.scrollHeight - sc.clientHeight - Math.round(sc.scrollTop)),
               len, sel };
    `;

    const box = await ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    `);

    /* --- case 1: start AT THE BOTTOM (the configuration that showed a jump) --- */
    for (let i = 0; i < 40; i++) await wheelAt(box.x, box.y, 400);
    await sleep(900);
    const atBottom = await ev(G);
    add("C1-0", "★ precondition: pane parked at the bottom",
      atBottom.room <= 2 ? "PASS" : "FAIL", JSON.stringify(atBottom));

    /* click into the text so the caret is in view (as a user would when typing) */
    await click(box.x, box.y);
    await sleep(400);
    const afterClick = await ev(G);
    add("C1-1", "record: after clicking into the text at the bottom", "PASS", JSON.stringify(afterClick));

    const btn = await ev(`
      const ts = ["代码块", "Code Block"];
      for (const t of ts) {
        const b = Array.from(document.querySelectorAll("button"))
          .find((el) => (el.getAttribute("title") || "").indexOf(t) >= 0);
        if (b) { const r = b.getBoundingClientRect();
                 return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; }
      }
      return null;
    `);
    add("C1-2", "code-block button", btn ? "PASS" : "FAIL", JSON.stringify(btn));
    if (!btn) return;

    const s0 = await ev(G);
    await click(btn.x, btn.y);
    await sleep(800);
    const s1 = await ev(G);
    await ev(`const c=document.querySelector(".cm-content"); try{c.cmTile.view.focus();}catch{} return true;`);
    await sleep(120);
    await ui.key("Backspace", "Backspace", 8);
    await sleep(400);
    const s2 = await ev(G);
    await ui.key("Backspace", "Backspace", 8);
    await sleep(1400);
    const s3 = await ev(G);
    await sleep(1200);
    const s4 = await ev(G);

    add("C1-3", "record: scrollHeight at each step (does it collapse?)",
      "PASS", JSON.stringify({
        before: { top: s0.top, sh: s0.sh, max: s0.max, room: s0.room, len: s0.len },
        afterInsert: { top: s1.top, sh: s1.sh, max: s1.max, room: s1.room, len: s1.len },
        afterBs1: { top: s2.top, sh: s2.sh, max: s2.max, room: s2.room, len: s2.len },
        afterBs2: { top: s3.top, sh: s3.sh, max: s3.max, room: s3.room, len: s3.len },
        settled: { top: s4.top, sh: s4.sh, max: s4.max, room: s4.room, len: s4.len },
      }));

    /**
     * The arithmetic verdict: if the final scrollTop equals the final max (within 2px),
     * the move was CLAMPING -- the browser had no choice. If it does not, some writer
     * put the viewport somewhere of its own choosing and that is the real defect.
     */
    const clamped = Math.abs(s4.top - s4.max) <= 2;
    add("C1-4", "★ verdict: final position is the clamp of the new max (=> forced by the browser)",
      clamped ? "PASS" : "FAIL",
      `finalTop=${s4.top} finalMax=${s4.max} diff=${s4.top - s4.max} ` +
      `(started at max ${s0.max}, now max ${s4.max}: collapse=${s0.max - s4.max}px)`);
    add("C1-5", "record: how much the document height collapsed",
      "PASS", `${s0.sh} -> ${s4.sh} (Δ${s4.sh - s0.sh}px); content length ${s0.len} -> ${s4.len}`);

    /* --- case 2: same but mid-document (control) --- */
    await wheelAt(box.x, box.y, -400);
    await sleep(200);
    let g = await ev(G);
    let guard = 0;
    while (g.room < 800 && g.top > 0 && guard++ < 200) { await wheelAt(box.x, box.y, -150); g = await ev(G); }
    await sleep(700);
    await click(box.x, box.y);
    await sleep(400);
    const m0 = await ev(G);
    add("C2-0", "★ precondition (control): room below >800px",
      m0.room > 800 ? "PASS" : "FAIL", JSON.stringify(m0));

    await ev(`
      const sc = document.querySelector(".cm-scroller");
      window.__S = [];
      const t0 = performance.now();
      const tick = () => {
        window.__S.push({ t: Math.round(performance.now() - t0),
                          top: Math.round(sc.scrollTop), sh: sc.scrollHeight });
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    `);
    await click(btn.x, btn.y);
    await sleep(750);
    await ev(`const c=document.querySelector(".cm-content"); try{c.cmTile.view.focus();}catch{} return true;`);
    await sleep(120);
    await ui.key("Backspace", "Backspace", 8);
    await sleep(300);
    await ui.key("Backspace", "Backspace", 8);
    await sleep(1800);
    const tr = await ev(`return window.__S;`);
    const ss = (tr && tr.s) || [];
    const tops = ss.map((x) => x.top);
    let mj = 0, prev = null;
    for (const t of tops) { if (prev !== null) mj = Math.max(mj, Math.abs(t - prev)); prev = t; }
    const shRange = ss.length ? Math.max(...ss.map((x) => x.sh)) - Math.min(...ss.map((x) => x.sh)) : 0;
    add("C2-1", "★ control: mid-document insert+Backspace does not move the viewport (<=8px)",
      mj <= 8 ? "PASS" : "FAIL", `maxJump=${mj}px scrollHeightRange=${shRange}px`);

    const errs = await ev(`return window.__ERRS || []`);
    add("Z9", "no uncaught exceptions", errs.length === 0 ? "PASS" : "FAIL", JSON.stringify(errs.slice(0, 4)));
  },
);

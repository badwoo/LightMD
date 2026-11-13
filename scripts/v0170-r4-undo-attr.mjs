/**
 * v0.17.0 R4 · T2 · **#3 唯一残留项（标题 Ctrl+2 → 撤销 16px）的写入溯源**
 *
 * ## 已收窄到这一条（`v0170-r4-undo-anchor.mjs` 用连续量复判）
 *
 * | 场景 | 锚段「PI29」屏幕 Y 全程 maxJump | 反转 | 判定 |
 * |---|---|---|---|
 * | **S1 有序列表 Ctrl+T → 撤销（用户报的）** | **0px** | 0 | **本来就是好的** |
 * | S5 引用 → 撤销 | 0px | 0 | 好 |
 * | S6 删除文字 → 撤销 | 0px | 0 | 好 |
 * | S3 标题 Ctrl+2 → 撤销 | **16px** | 2 | **唯一残留** |
 *
 * S3 的曲线形态非常特殊：
 * ```
 * 编辑段：...0,0,0,0,0,0,0,16,0,0,0...     ← 变标题时锚段下移 16px（正常，H2 行高变高）
 * 撤销段：...0,0,0,0,0,0,0,-16,13,0,0...   ← 撤销先回 -16（正确），**紧接着 +13 又推回去**
 * scrollTop：1959 → 1946（我们写了 -13）
 * ```
 * ⇒ 撤销时：内容还原让锚段回到原位（-16），但**我们的 scrollTop 补偿把画面又推了 +13**。
 * 净效果：锚段从 -16 变成 -3（差 3px），但中间那一帧用户看到 13px 的位移 + 一次回摆。
 *
 * ## 嫌疑：`applyHistoryTextRef` 的滚动恢复 + `restoreAfterDiscreteEdit` 的三段重试
 * 阅读面撤销走 `applyHistoryTextRef`（`SourcePane.tsx:663`），其中
 * `restorePreviewScrollFromAnchor` 会 `container.scrollTop = top` —— 那份代码是
 * **R3 就有的三段式（rAF / 60ms / 160ms）**，本轮我**没有**给它加"最小变更后不抢帧"的约束
 * （那是源码面 CM6 的逻辑，阅读面走的是另一套）。
 *
 * 本探针钉死：16px / +13px 分别是谁写的、写了几次、在哪个时间点。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { INSTALL_SPY, wheelTo, waitStableScroll, analyze } from "./v0170-r4-scroll-lib.mjs";

function makeDocWithLists(paras = 60) {
  const parts = ["# 撤销跳动审计", ""];
  for (let i = 1; i <= paras; i++) {
    parts.push(`PI${String(i).padStart(2, "0")} 第 ${i} 段。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`, "");
    if (i % 10 === 0) parts.push(`1. 甲项 PI${String(i).padStart(2, "0")}A`, `2. 乙项 PI${String(i).padStart(2, "0")}B`, `3. 丙项 PI${String(i).padStart(2, "0")}C`, "");
  }
  return parts.join("\n");
}

const DOC = makeDocWithLists(60);
const SC = ".editor-container";

const TRACE = (ms, anchorText) => `
  window.__T = [];
  (function () {
    const T0 = performance.now();
    const AP = ${JSON.stringify(anchorText)};
    const tick = () => {
      const sc = document.querySelector(${JSON.stringify(SC)});
      const rec = { t: Math.round(performance.now() - T0) };
      if (sc) {
        const scR = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        let el = null;
        for (const n of sc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote")) {
          if ((n.textContent || "").indexOf(AP) >= 0) { el = n; break; }
        }
        if (el) rec.anchorY = Math.round((el.getBoundingClientRect().top - scR.top) * 100) / 100;
        // 同时记视口中线所在块的块号（用它的 top 判断"是否换了块"）
        const midY = scR.top + sc.clientHeight / 2;
        for (const n of sc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li")) {
          const r = n.getBoundingClientRect();
          if (r.top <= midY && r.bottom >= midY) { rec.midTag = n.tagName; rec.midTop = Math.round((r.top - scR.top) * 100) / 100; break; }
        }
      }
      window.__T.push(rec);
      if (performance.now() - T0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

await runBrowserProbe({ name: "v0170-r4-undo-attr", doc: DOC }, async (ui) => {
  await ui.command("view.preview");
  await ui.sleep(2200);
  await ui.ev(INSTALL_SPY);

  async function run(cfg) {
    await wheelTo(ui, 0.45, SC, { settle: 700 });
    const pt = await ui.ev(`
      const sc = document.querySelector(${JSON.stringify(SC)});
      const scR = sc.getBoundingClientRect();
      const midY = scR.top + sc.clientHeight / 2;
      let best = null, bestD = Infinity;
      for (const el of sc.querySelectorAll("p, h1, h2, h3, li")) {
        const txt = el.textContent || "";
        if (!/PI\\d{2}/.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.height <= 0) continue;
        const d = Math.abs((r.top + r.bottom) / 2 - midY);
        if (d < bestD) { bestD = d; best = el; }
      }
      if (!best) return null;
      const r = best.getBoundingClientRect();
      const m = /PI(\\d{2})/.exec(best.textContent || "");
      return { x: Math.round(r.left + 24), y: Math.round(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2))), anchorText: "PI" + (m ? m[1] : "29"), tag: best.tagName, text: (best.textContent||"").slice(0,26) };
    `);
    if (!pt) return null;
    ui.log(`[${cfg.id}] 目标 = ${JSON.stringify(pt)}`);
    await ui.click(pt.x, pt.y);
    await ui.sleep(400);
    await waitStableScroll(ui, SC, { need: 4 });

    await ui.ev(`window.__R4_WRITES = []; return true;`);
    await ui.ev(TRACE(cfg.ms ?? 5400, pt.anchorText));
    await ui.sleep(120);

    await cfg.doEdit(ui);
    await ui.sleep(1800);
    const midIdx = await ui.ev(`return (window.__T||[]).length`);
    await ui.ev(`const pm=document.querySelector(".ProseMirror"); if(pm) pm.focus(); return true;`);
    await ui.sleep(150);
    const undoT0 = await ui.ev(`return Math.round(performance.now())`);
    await ui.key("z", "KeyZ", 90, 2);
    await ui.sleep(2400);

    const trace = await ui.ev(`return window.__T || []`);
    const writes = await ui.ev(`return (window.__R4_WRITES||[]).map(w=>({t:w.t,v:w.v,from:w.from,how:w.how,k:w.k,s:(w.stack||[]).slice(0,6)}))`);

    // 只保留撤销后的片段，并把写入对齐到撤销起点
    const undoWrites = writes.filter((w) => w.t >= undoT0 - 50);
    ui.log(`[${cfg.id}] 撤销期写入 ${undoWrites.length} 条：`);
    for (const w of undoWrites) {
      ui.log(`    +${w.t - undoT0}ms ${w.how} ${w.from}->${w.v} @${w.k}`);
      for (const s of (w.s || []).slice(2, 6)) ui.log(`        ${s}`);
    }
    // 打印撤销段逐帧（st + anchorY 一起看）
    const undoFrames = trace.slice(midIdx).map((f) => `t${f.t}:st${f.st}/ay${f.anchorY ?? "?"}/sh${f.sh}`);
    ui.log(`[${cfg.id}] 撤销段逐帧（前 40）=${JSON.stringify(undoFrames.slice(0, 40))}`);

    const aY = trace.filter((f) => typeof f.anchorY === "number");
    const a = analyze(aY.map((f) => f.anchorY), aY.map((f) => f.t), "anchorY");
    const stA = analyze(trace.map((f) => f.st), trace.map((f) => f.t), "st");
    return { ...cfg, pt, trace, writes, undoWrites, undoT0, midIdx, anchor: a, st: stA };
  }

  /* S3 标题：唯一残留 */
  const s3 = await run({ id: "H3", name: "标题 Ctrl+2 → 撤销", async doEdit(u) { await u.key("2", "Digit2", 50, 2); return true; } });
  if (s3) {
    ui.add("H3", "S3 标题撤销期写入溯源",
      s3.undoWrites.length === 0 ? "PASS" : "KNOWN",
      `撤销期写入 ${s3.undoWrites.length} 次：${JSON.stringify(s3.undoWrites.map((w) => `${w.from}->${w.v}@${w.how}`))}；` +
      `锚段Y 全程 maxJump=${s3.anchor.maxJump}px 反转=${s3.anchor.reversals}；scrollTop maxJump=${s3.st.maxJump}px`);
  }

  /* 对照：S1 用户场景（应当 0 写入） */
  const s1 = await run({
    id: "H1", name: "Ctrl+T → 撤销（用户场景，对照）",
    async doEdit(u) {
      const li = await u.ev(`
        const sc = document.querySelector(".editor-container");
        const scR = sc.getBoundingClientRect();
        const midY = scR.top + sc.clientHeight / 2;
        const items = [];
        for (const li of sc.querySelectorAll("ol > li")) { const r = li.getBoundingClientRect(); if (r.height > 0) items.push({ r, d: Math.abs((r.top + r.bottom) / 2 - midY) }); }
        if (!items.length) return null;
        items.sort((a, b) => a.d - b.d);
        return { x: Math.round(items[0].r.left + 24), y: Math.round(items[0].r.top + items[0].r.height / 2) };
      `);
      if (!li) return null;
      await u.click(li.x, li.y); await u.sleep(300);
      await u.key("t", "KeyT", 84, 2);
      return true;
    },
  });
  if (s1) {
    ui.add("H1", "S1 用户场景撤销期写入（对照）",
      s1.undoWrites.length === 0 ? "PASS" : "KNOWN",
      `撤销期写入 ${s1.undoWrites.length} 次；锚段Y maxJump=${s1.anchor.maxJump}px 反转=${s1.anchor.reversals}`);
  }

  await ui.shot("undo-attr");
});

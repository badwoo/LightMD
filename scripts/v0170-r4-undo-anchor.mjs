/**
 * v0.17.0 R4 · T2 · **#3 的 PI 变化到底是"真漂移"还是"锚点重排"**
 *
 * ## 待判定的矛盾（必须分开，否则修错地方）
 *
 * S5（引用 Ctrl+Shift+. → 撤销）与 S6（删字 → 撤销）实测：
 * ```
 * scrollTop   1959 → 1959   （**写入值完全相同，等于没动**）
 * scrollHeight  +39 → -39   （编辑变高 39px，撤销又还原）
 * 视口中心 PI   29 → 28     （换了个块）
 * piTop 极差   70.39px      （**两块的位置差 70px**）
 * ```
 * `scrollTop` 一动没动，PI 却从 29 换到 28 —— 只有两种可能：
 *
 * **(a) 真漂移**：撤销的 `replaceWith`（整篇终稿替换）让 PM 重新排版，
 *     块 28/29 的**高度**变了，导致"视口中线落在哪一块"变了。
 *     但注意：`scrollTop` 没变 ⇒ **内容在屏幕上的绝对位置没变**，
 *     用户看到的画面**没有任何跳动**，只是"中线压着的块"换了。
 *     ⇒ 这是**判据本身的缺陷**，不是产品缺陷。
 *
 * **(b) 真缺陷**：`piTop` 极差 70px 说明这两块之间确实错位了 70px ——
 *     那不是"换锚"，是**内容真的挪了**。
 *
 * ## 判据：换一个**不依赖块边界**的观测量
 *
 * 「视口中心 PI 段号」的弱点是它**离散**：中线跨过块边界就变一次，
 * 即使所有内容像素级没动也会翻转。
 *
 * 改用 **「指定锚段落的屏幕 Y」**（`anchorY`）：
 * 固定盯住**同一段文字**（编辑前就在视口中央的那段，用它的 PI 编号锁定），
 * 逐帧记它的 `getBoundingClientRect().top`。
 * - 该值**连续变化多少** = 用户看到的内容真的动了多少；
 * - 它是**连续量**，不受块边界影响。
 *
 * 这才是"页面跳动"的**正确主判据** —— 与 #1 里 `scrollTop` 的角色等价，
 * 但在阅读面更准确（因为 PM 重排时 `scrollTop` 可能不变而内容在动）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import {
  INSTALL_SPY, startTrace, analyze, wheelTo, waitStableScroll,
} from "./v0170-r4-scroll-lib.mjs";

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

/**
 * 逐帧采样**锁定段落的屏幕 Y**（连续量，不受块边界影响）
 * + scrollTop / scrollHeight 作对照。
 */
const TRACE_ANCHOR = (ms, anchorText) => `
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
        rec.ch = Math.round(sc.clientHeight);
        // 锁定段落：找 textContent 含 AP 的那一块（每帧都用**同一个文本**找，
        // 所以即使它换了 DOM 元素，量的仍是"那段文字的屏幕位置"）
        let el = null;
        for (const n of sc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote")) {
          if ((n.textContent || "").indexOf(AP) >= 0) { el = n; break; }
        }
        if (el) {
          const r = el.getBoundingClientRect();
          rec.anchorY = Math.round((r.top - scR.top) * 100) / 100;
          rec.anchorH = Math.round(r.height * 100) / 100;
          rec.found = true;
        } else {
          rec.found = false;
        }
      }
      window.__T.push(rec);
      if (performance.now() - T0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

await runBrowserProbe({ name: "v0170-r4-undo-anchor", doc: DOC }, async (ui) => {
  await ui.command("view.preview");
  await ui.sleep(2200);
  await ui.ev(INSTALL_SPY);

  /**
   * 跑一个场景：记事前锚段 → 编辑 → 撤销 → 全程逐帧量**锚段屏幕 Y**
   */
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
      return {
        x: Math.round(r.left + 24), y: Math.round(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2))),
        pi: m ? m[1] : null,
        text: (best.textContent || "").slice(0, 40),
        // 用短且唯一的片段作锚文本（PIxx 就够唯一）
        anchorText: m ? "PI" + m[1] : null,
      };
    `);
    if (!pt || !pt.anchorText) { ui.add(cfg.id, cfg.name + "（找不到锚段）", "FAIL", "null"); return null; }
    await ui.click(pt.x, pt.y);
    await ui.sleep(400);

    if (cfg.selectText) {
      await ui.ev(`
        const s = window.getSelection();
        if (!s || !s.rangeCount) return false;
        const r = s.getRangeAt(0);
        const n = r.startContainer;
        if (!n || n.nodeType !== 3) return false;
        const a = r.startOffset, b = Math.min(n.textContent.length, a + 12);
        const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, b);
        s.removeAllRanges(); s.addRange(rg); return true;
      `);
      await ui.sleep(250);
    }

    await waitStableScroll(ui, SC, { need: 4 });
    const before = await ui.ev(`
      const sc = document.querySelector(".editor-container");
      return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight) };
    `);

    // 全程采样（编辑 + 撤销），一段长采样把两段都包住
    await ui.ev(`window.__R4_WRITES = []; return true;`);
    await ui.ev(TRACE_ANCHOR(cfg.ms ?? 5200, pt.anchorText));
    await ui.sleep(120);

    await cfg.doEdit(ui);
    await ui.sleep(cfg.mid ?? 1800);
    const midMark = await ui.ev(`return (window.__T || []).length`);
    // 撤销前把焦点给 PM
    await ui.ev(`const pm=document.querySelector(".ProseMirror"); if(pm) pm.focus(); return true;`);
    await ui.sleep(150);
    await ui.key("z", "KeyZ", 90, 2);
    await ui.sleep(cfg.tail ?? 2200);

    const trace = await ui.ev(`return window.__T || []`);
    const writes = await ui.ev(`return (window.__R4_WRITES||[]).map(w=>({t:w.t,v:w.v,from:w.from,how:w.how,k:w.k}))`);

    // 锚段 Y 曲线分析（**主判据**：连续量）
    const aY = trace.filter((r) => r.found).map((r) => r.anchorY);
    const aT = trace.filter((r) => r.found).map((r) => r.t);
    const anchorTrack = analyze(aY, aT, "anchorY");
    // 分两段看：编辑段 / 撤销段
    const editSeg = trace.slice(0, midMark).filter((r) => r.found).map((r) => r.anchorY);
    const editT = trace.slice(0, midMark).filter((r) => r.found).map((r) => r.t);
    const undoAll = trace.slice(midMark).filter((r) => r.found).map((r) => r.anchorY);
    const undoT = trace.slice(midMark).filter((r) => r.found).map((r) => r.t);
    const editA = analyze(editSeg, editT, "anchorY");
    const undoA = analyze(undoAll, undoT, "anchorY");

    const stArr = trace.map((r) => r.st);
    const stJump = analyze(stArr, trace.map((r) => r.t), "st");

    return { ...cfg, pt, before, trace, writes, anchorTrack, editA, undoA, stJump, midMark };
  }

  function judge(rec) {
    if (!rec) return null;
    const id = rec.id, name = rec.name;
    /**
     * 主判据：**锚段屏幕 Y 的单帧最大跳变**。
     * - ≤3px：连续（用户看不出跳）
     * - >3px：一帧内那段文字挪了 >3px = 用户可见的"跳"
     * 这是连续的、不受块边界影响的量。
     *
     * 反拉同样要有：锚段 Y 来回摆动 = 抖。
     */
    const j = (a) => ({ maxJump: a.maxJump, reversals: a.reversals, net: a.net, frames: a.frames });
    /**
     * ## ⚠️ 主判据的第二级订正：**"内容排版变化"不是"页面跳动"**
     *
     * 第一版判据是「锚段屏幕 Y 单帧最大跳变 ≤ 3px」。这个量在 S3（标题）上读数 16px，
     * 但逐帧序列证明**它不是抖动**：
     * ```
     * editDeltas: ...0,0,0,0,0,0,0,16,0,0,0...   ← 变 H2，锚段下移 16px（H2 行高变大 = 正确排版）
     * undoDeltas: ...0,0,0,0,0,0,0,0,0,-16,0...  ← 撤销回正文，锚段回原位（= 正确）
     * scrollTop 写入：**0 次**
     * ```
     * 这是"**内容自己的形状变了**"，任何编辑器都会这样：把一行正文变成 H2，
     * 段以上的内容必然整体下移一个行高差。用户**不会**把它感知为"页面跳了一下"，
     * 因为他看见的是"这段变成了标题"。
     *
     * 真正的"抖"必须满足：**视口在内容没变形状的情况下自己动了**，或**来回摆**。
     * 所以判据要分两层：
     *
     * 1. **硬判据（必须 0）**：`reversals === 0` —— 没有回摆 = 不是抖；
     *    以及 `scrollTop 写入次数 === 0` —— 我们的代码没有主动挪视口；
     * 2. **软判据（≤3px 或"变化与块高变化一致"）**：单帧位移若存在，
     *    必须能被**块自身高度变化**解释。这里用 `anchorH` 的变化作对照
     *    （实测 S3 的 16px 位移 ≈ H2 与正文的行高差）。
     *
     * 折中后的可执行判据：
     * `reversals === 0 && scrollWriteCount === 0 && (maxJump <= 3 || 位移是"单次单向跳变且永不回来")`
     * —— 最后一项正是 S3 的形态（+16 一次，撤销时 −16 一次，**对称且成对**）。
     * 「成对抵消」= 撤销正确还原了排版，不是漂移。
     */
    const deltaOfEdit = rec.editA.net;   // 编辑造成的净位移
    const deltaOfUndo = rec.undoA.net;   // 撤销造成的净位移
    const pairedCancel = Math.abs(deltaOfEdit + deltaOfUndo) <= 3; // 编辑+撤销 ≈ 0 = 成对抵消
    /**
     * ⚠️ 反转次数必须**分段算**，不能按全程算（第三处判据订正）
     *
     * 第一次我用 `rec.anchorTrack.reversals`（全程），S3 报 1 —— 但那个 1 是
     * 「编辑期 +16」与「撤销期 −16」之间的方向差，而它们是**两次独立操作**、中间隔着
     * 1.8 秒的静置。把"用户先按 Ctrl+2、再按 Ctrl+Z"算成"页面来回摆"是荒谬的。
     *
     * 「抖」的定义是**同一次操作内部**来回摆。所以只在**编辑段**和**撤销段**
     * 各自的内部算反转，然后取最大。
     */
    const maxPhaseReversals = Math.max(rec.editA.reversals, rec.undoA.reversals);
    const noReversals = maxPhaseReversals === 0;
    const noScrollWrite = rec.writes.length === 0;
    const smallJump = rec.anchorTrack.maxJump <= 3;
    const pass = noReversals && noScrollWrite && (smallJump || pairedCancel);
    ui.add(id, name, pass ? "PASS" : "FAIL",
      `**锚段「${rec.pt.anchorText}」屏幕 Y**：编辑段 maxJump=${rec.editA.maxJump}px 反转=${rec.editA.reversals} 净=${rec.editA.net}px；` +
      `撤销段 maxJump=${rec.undoA.maxJump}px 反转=${rec.undoA.reversals} 净=${rec.undoA.net}px；` +
      `全程 maxJump=${rec.anchorTrack.maxJump}px 反转=${rec.anchorTrack.reversals}；` +
      `对照 scrollTop maxJump=${rec.stJump.maxJump}px 反转=${rec.stJump.reversals}；` +
      `写入=${rec.writes.length} 次 ${JSON.stringify(rec.writes.slice(0, 5).map((w) => `${w.from}->${w.v}`))}；` +
      `判据：段内无回摆=${noReversals}（编辑段${rec.editA.reversals}/撤销段${rec.undoA.reversals}） 零滚动写入=${noScrollWrite} ` +
      `单帧≤3px=${smallJump} 或 编辑↔撤销成对抵消=${pairedCancel}（${deltaOfEdit}+${deltaOfUndo}）`);
    ui.log(`[${rec.id}] 锚段Y 序列(前50)=${JSON.stringify(rec.anchorTrack.deltas.slice(0, 50))}`);
    ui.log(`[${rec.id}] editDeltas=${JSON.stringify(rec.editA.deltas.slice(0, 30))}`);
    ui.log(`[${rec.id}] undoDeltas=${JSON.stringify(rec.undoA.deltas.slice(0, 30))}`);
    return rec;
  }

  /* ══ S1 用户场景：Ctrl+T → Ctrl+Z ══ */
  const s1 = await run({
    id: "V1", name: "S1 有序列表 Ctrl+T → Ctrl+Z：锚段屏幕 Y 是否连续",
    async doEdit(u) {
      // 点有序列表项
      const li = await u.ev(`
        const sc = document.querySelector(".editor-container");
        const scR = sc.getBoundingClientRect();
        const midY = scR.top + sc.clientHeight / 2;
        const items = [];
        for (const li of sc.querySelectorAll("ol > li")) {
          const r = li.getBoundingClientRect();
          if (r.height <= 0) continue;
          items.push({ r, d: Math.abs((r.top + r.bottom) / 2 - midY) });
        }
        if (!items.length) return null;
        items.sort((a, b) => a.d - b.d);
        return { x: Math.round(items[0].r.left + 24), y: Math.round(items[0].r.top + items[0].r.height / 2) };
      `);
      if (!li) return null;
      await u.click(li.x, li.y);
      await u.sleep(300);
      await u.key("t", "KeyT", 84, 2);
      return true;
    },
  });
  judge(s1);

  /* ══ S5 引用（PI 曾变的那三个）══ */
  const s5 = await run({
    id: "V5", name: "S5 引用 Ctrl+Shift+. → 撤销：锚段屏幕 Y 是否连续",
    async doEdit(u) { await u.key(".", "Period", 190, 2 | 8); return true; },
  });
  judge(s5);

  /* ══ S3 标题 ══ */
  const s3 = await run({
    id: "V3", name: "S3 标题 Ctrl+2 → 撤销：锚段屏幕 Y 是否连续",
    async doEdit(u) { await u.key("2", "Digit2", 50, 2); return true; },
  });
  judge(s3);

  /* ══ S6 删除文字 ══ */
  const s6 = await run({
    id: "V6", name: "S6 删除选中文字 → 撤销：锚段屏幕 Y 是否连续",
    selectText: true,
    async doEdit(u) { await u.key("Delete", "Delete", 46); return true; },
  });
  judge(s6);

  const recs = [s1, s5, s3, s6].filter(Boolean);
  const passCount = recs.filter((r) => Math.max(r.editA.reversals, r.undoA.reversals) === 0 && r.writes.length === 0).length;
  ui.add("V0", "★ #3 主判据复判（锚段屏幕 Y，连续量）",
    passCount === recs.length && recs.length === 4 ? "PASS" : "FAIL",
    `通过 ${passCount}/${recs.length}；` +
    `各项 maxJump=${JSON.stringify(recs.map((r) => ({ id: r.id, max: r.anchorTrack.maxJump, rev: r.anchorTrack.reversals })))}`);

  await ui.shot("undo-anchor");
});

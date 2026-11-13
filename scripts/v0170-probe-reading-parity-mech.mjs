/**
 * C 流 / 机制确认探针 #5
 * 目标（为出报告前把机制钉死，不靠推测）：
 *  1. CM6 下 `.cm-scroller` 滚动 → 谁写 fileScrollProgress？宿主 div 的 scroll 监听是否永久哑火？
 *  2. 编辑→阅读 的 percent 来源到底是哪一个值？
 *  3. 切模式是否触发 CM6 重建（P0-1 旁证）？用 MutationObserver。
 *  4. 阅读→编辑 "看起来保住了" 是不是其实"根本没动"（cm-scroller 原值未变）？
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const paras = [];
for (let i = 1; i <= 36; i++) {
  paras.push(
    `这是第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位使用。` +
      `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  );
}
const DOC = `# MECH-HEAD 机制确认

${paras.slice(0, 9).join("\n\n")}

## MECH-H2

${paras.slice(9, 18).join("\n\n")}

## MECH-TAIL

${paras.slice(18, 30).join("\n\n")}
`;

await runProbe(
  { name: "v0170-probe-rp-mech", doc: DOC, docTitle: "MECH-HEAD", viewMode: "edit" },
  async (ui) => {
    // ── 装 localStorage 写监听 + 重建观察器 + scroll 事件监听 ──
    await ui.ev(`
      window.__LOG = { ls: [], scrolls: [], rm: { del: 0, add: 0 } };

      // 1) localStorage.setItem 监听
      const origSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).indexOf("lightmd") >= 0) {
          window.__LOG.ls.push({ k: String(k), v: String(v).slice(0, 200), t: Math.round(performance.now()) });
        }
        return origSet.call(this, k, v);
      };

      // 2) scroll 事件监听（捕获阶段，能听到所有后代滚动）
      document.addEventListener("scroll", (e) => {
        const t = e.target;
        if (!t || t.nodeType !== 1) return;
        const cls = String(t.className || "").slice(0, 40);
        window.__LOG.scrolls.push({ cls, st: Math.round(t.scrollTop || 0), t: Math.round(performance.now()) });
        if (window.__LOG.scrolls.length > 300) window.__LOG.scrolls.shift();
      }, true);

      // 3) CM6 重建观察器（观察真正的父级，subtree 覆盖）
      const host = document.querySelector(".source-editor-cm6");
      window.__LOG.hostCls = host ? String(host.className) : "none";
      const mo = new MutationObserver((ms) => {
        for (const m of ms) {
          for (const n of (m.removedNodes || []))
            if (n.nodeType === 1 && String(n.className || "").includes("cm-editor")) window.__LOG.rm.del++;
          for (const n of (m.addedNodes || []))
            if (n.nodeType === 1 && String(n.className || "").includes("cm-editor")) window.__LOG.rm.add++;
        }
      });
      if (host) mo.observe(host, { childList: true, subtree: true });
      return { hostCls: window.__LOG.hostCls };
    `);

    // ── 1. 谁在响应 .cm-scroller 滚动 ──
    const s1 = await ui.ev(`
      window.__LOG.ls.length = 0; window.__LOG.scrolls.length = 0;
      const sc = document.querySelector(".cm-scroller");
      const max = sc.scrollHeight - sc.clientHeight;
      sc.scrollTop = Math.round(max * 0.5);
      return { st: Math.round(sc.scrollTop), max: Math.round(max) };
    `);
    await ui.sleep(1400);
    const s1b = await ui.ev(`
      return { scrolls: window.__LOG.scrolls.slice(-6), lsWrites: window.__LOG.ls.slice(-4),
               progress: localStorage.getItem("lightmd-scroll-progress") };
    `);
    ui.log(`[mech] 1. .cm-scroller 滚到 ${s1.st}/${s1.max}`);
    ui.log(`[mech] 1a. 捕获到的 scroll 事件: ${JSON.stringify(s1b.scrolls)}`);
    ui.log(`[mech] 1b. localStorage 写入: ${JSON.stringify(s1b.lsWrites)}`);
    ui.log(`[mech] 1c. progress=${s1b.progress}`);

    // ── 1d. 关键：宿主 div 上派发 scroll 能否让 percent 更新 ──
    // 用同一文档的 progress 值间接观察：滚 .cm-scroller 若未写 progress → 监听哑火
    const hostScrollTest = await ui.ev(`
      window.__LOG.ls.length = 0;
      const host = document.querySelector(".source-editor-cm6");
      // 宿主 div 不可滚动；但仍派发合成 scroll 事件试探监听是否存在
      host.dispatchEvent(new Event("scroll", { bubbles: false }));
      host.dispatchEvent(new Event("scroll", { bubbles: true }));
      return { hostScrollable: host.scrollHeight > host.clientHeight + 4,
               hostSH: host.scrollHeight, hostCH: host.clientHeight };
    `);
    ui.sleep(600);
    const hostScrollTest2 = await ui.ev(`return { lsWrites: window.__LOG.ls.slice(-3), progress: localStorage.getItem("lightmd-scroll-progress") };`);
    ui.log(`[mech] 1d. 宿主不可滚动=${!hostScrollTest.hostScrollable} (sh=${hostScrollTest.hostSH} ch=${hostScrollTest.hostCH})；派发合成 scroll 后写入=${JSON.stringify(hostScrollTest2.lsWrites)}`);

    // ── 2. 编辑→阅读：percent 来源 + 重建旁证 ──
    const pre = await ui.ev(`
      window.__LOG.ls.length = 0; window.__LOG.scrolls.length = 0;
      window.__LOG.rm.del = 0; window.__LOG.rm.add = 0;
      const sc = document.querySelector(".cm-scroller");
      const max = sc.scrollHeight - sc.clientHeight;
      sc.scrollTop = Math.round(max * 0.72);
      return { st: Math.round(sc.scrollTop), max: Math.round(max), pct: 0.72 };
    `);
    await ui.sleep(1200);
    ui.log(`[mech] 2a. 编辑滚到 72%: st=${pre.st}/${pre.max}`);

    await ui.command("view.preview");
    await ui.sleep(2800);
    const post = await ui.ev(`
      const c = document.querySelector(".editor-container");
      const cm = document.querySelector(".cm-editor");
      const max = c.scrollHeight - c.clientHeight;
      return { readSt: Math.round(c.scrollTop), readMax: Math.round(max),
               readPct: max > 0 ? +(c.scrollTop / max).toFixed(4) : null,
               cmVisible: !!cm && cm.getBoundingClientRect().width > 0,
               rm: window.__LOG.rm,
               lsWrites: window.__LOG.ls.slice(-5),
               progress: localStorage.getItem("lightmd-scroll-progress") };
    `);
    ui.log(`[mech] 2b. 切阅读后: readSt=${post.readSt}/${post.readMax} pct=${post.readPct}（期望≈0.72）`);
    ui.log(`[mech] 2c. CM6 重建计数 del=${post.rm.del} add=${post.rm.add}（>0 说明切模式触发重建）`);
    ui.log(`[mech] 2d. 切模式期间 localStorage 写入: ${JSON.stringify(post.lsWrites)}`);

    // ── 3. 阅读→编辑：是"恢复正确"还是"根本没动"（对照实验） ──
    // 先把编辑侧残留值改掉：切回编辑后手动写一个明显不同的值，再切阅读再切回
    const back1 = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      return { st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight),
               rm: window.__LOG.rm };
    `);
    ui.log(`[mech] 3a. 切回编辑后（未做任何事）: st=${back1.st} rm=${JSON.stringify(back1.rm)}`);

    // 阅读滚到 90%，切回编辑 → 编辑应跟随到 ≈90%
    await ui.command("view.preview");
    await ui.sleep(2600);
    const r90 = await ui.ev(`
      const c = document.querySelector(".editor-container");
      const max = c.scrollHeight - c.clientHeight;
      c.scrollTop = Math.round(max * 0.9);
      c.dispatchEvent(new Event("scroll"));
      return { st: Math.round(c.scrollTop), max: Math.round(max) };
    `);
    await ui.sleep(1200);
    ui.log(`[mech] 3b. 阅读滚到 90%: ${r90.st}/${r90.max}`);
    await ui.command("view.edit");
    await ui.sleep(3000);
    const back2 = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const max = sc.scrollHeight - sc.clientHeight;
      return { st: Math.round(sc.scrollTop), max: Math.round(max),
               pct: max > 0 ? +(sc.scrollTop / max).toFixed(4) : null,
               rm: window.__LOG.rm };
    `);
    ui.log(`[mech] 3c. 切回编辑后: st=${back2.st}/${back2.max} pct=${back2.pct}（期望≈0.9）rm=${JSON.stringify(back2.rm)}`);

    // ── 4. 对照：完全不动编辑侧，直接切模式两圈，看 st 是否一直被保留（P0 重建会归零） ──
    const setv = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      sc.scrollTop = 777;
      return { st: Math.round(sc.scrollTop) };
    `);
    await ui.sleep(500);
    await ui.command("view.preview");
    await ui.sleep(2600);
    const c1 = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      return { cmSt: Math.round(sc.scrollTop), rm: window.__LOG.rm,
               cmVisible: !!sc && sc.getBoundingClientRect().width > 0 };
    `);
    await ui.command("view.edit");
    await ui.sleep(2800);
    const c2 = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const max = sc.scrollHeight - sc.clientHeight;
      return { st: Math.round(sc.scrollTop), max: Math.round(max),
               rm: window.__LOG.rm,
               pct: max > 0 ? +(sc.scrollTop / max).toFixed(4) : null };
    `);
    ui.log(`[mech] 4. 手动写 st=777 → 阅读(隐藏期 cmSt=${c1.cmSt}) → 切回编辑 st=${c2.st} pct=${c2.pct} rm=${JSON.stringify(c2.rm)}`);

    const errs = await ui.errors();
    ui.log(`[mech] errors: ${JSON.stringify(errs).slice(0, 300)}`);
  },
);

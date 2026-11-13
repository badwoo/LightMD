/**
 * P0-1 **修复验收探针**（fix-p0-remount 所有）
 *
 * ## 为什么不能只用 Lead 的 `v0170-lead-rootcause.mjs`
 *
 * 那个探针的 [B]/[C] 两条断言是**"抓缺陷"极性**：
 * ```js
 * ui.add("B", "内容变化 1 字符 → 发生重建", cB.del > 0 ? "PASS" : "FAIL", …)
 * ```
 * 它断言的是「**重建发生了**」——因为当时要证明缺陷存在。
 * 修复之后重建理应变成 0，于是这两条会**正确地变成 FAIL**（断言极性反了），
 * 而 [E] 综合结论也会显示"与预测不符"。
 *
 * 所以修复验收需要一套**"断言正确行为"极性**的探针。本文件就是它：
 * 同样的观测手段（宿主内 `.cm-editor` 的 MutationObserver），断言反过来写。
 *
 * ## 覆盖的验收项
 *
 * | # | 验收项 | 断言 |
 * |---|---|---|
 * | 1 | 打开文档后 `.cm-line` 有内容 | 防 `initialText` 时序回归（commit bfa67a6 修的那个缺陷） |
 * | 2 | 连续输入 10 字符全落地 | `Δ === 10`，且 `del/add === 0` |
 * | 3 | 内容变化时重建次数 | `=== 0` |
 * | 4 | 撤销（内容变化）时重建次数 | `=== 0` |
 * | 5 | 光标移动 / 滚动（内容不变） | `=== 0`（对照组，确认观测器本身没漏报） |
 * | 6 | 焦点在打字期间不离开 | `focusout === 0`，结束时 `activeElement` 仍在编辑区 |
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# 修复验收",
  "",
  "第一段正文，用于确认 initialText 时序未回归。",
  "",
  "第二段正文。",
  "",
].join("\n");

const clickContent = async (ui) => {
  const box = await ui.ev(`
    const c = document.querySelector(".cm-content");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 12) };
  `);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(300);
  return true;
};

/**
 * 装计数器。**每次都先 disconnect 旧观察器**（`v0170-p01-diag-observer-artifact.mjs`
 * 已实测证明：不 disconnect 而只重置计数，会让 N 个存活观察器各计一次 →
 * 把"1 次重建"读成"N 次重建"。Lead 报告里的 del=2/3、del=8 就是这么来的）。
 */
const resetCounter = async (ui) => ui.ev(`
  (window.__MOS || []).forEach((mo) => { try { mo.disconnect(); } catch (e) {} });
  window.__MOS = [];
  window.__RM = { del: 0, add: 0 };
  const host = document.querySelector(".source-editor-cm6");
  if (!host) return false;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.removedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) window.__RM.del++;
      for (const n of m.addedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) window.__RM.add++;
    }
  });
  mo.observe(host, { childList: true, subtree: false });
  window.__MOS.push(mo);
  return true;
`);

const readCounter = async (ui) => ui.ev(`return window.__RM || { del: -1, add: -1 }`);

await runProbe({
  name: "v0170-p01-acceptance",
  doc: DOC,
  docTitle: "修复验收",
}, async (ui) => {
  /* ══ ① 打开文档后源码面必须有内容（initialText 时序回归守卫）══ */
  const lines = await ui.ev(`
    const cm = document.querySelector(".cm-editor");
    if (!cm) return null;
    const ls = Array.from(cm.querySelectorAll(".cm-line")).map((l) => l.textContent || "");
    return { count: ls.length, nonEmpty: ls.filter((t) => t.trim().length > 0).length,
             chars: ls.join("\\n").length, first: ls[0] || "" };
  `);
  const srcText = await ui.readSourceText();
  const titlePresent = (srcText || "").includes("修复验收");
  ui.log(`[①] .cm-line: ${JSON.stringify(lines)}；源码面含标题=${titlePresent}`);
  ui.add("A1", "★ 打开文档后源码面 .cm-line 有内容（initialText 时序回归守卫）",
    lines && lines.count > 0 && lines.nonEmpty >= 2 && titlePresent ? "PASS" : "FAIL",
    `行数=${lines?.count} 非空行=${lines?.nonEmpty} 首行=${JSON.stringify(lines?.first)} ` +
    `含标题=${titlePresent} → CM6 挂载时拿到了真实 initialText`);

  /* ══ ② 连打 10 字符，中间不点击、不 eval 查询（真实用户节奏）══ */
  await clickContent(ui);
  await resetCounter(ui);
  const before = ((await ui.readSourceText()) || "").length;
  const focusOut = { n: 0 };
  await ui.ev(`
    (window.__FO || []).forEach((h) => document.removeEventListener("focusout", h, true));
    window.__FO = [];
    window.__FOCUS = [];
    const h = (e) => {
      window.__FO.push(String((e.target && e.target.className) || ""));
      window.__FOCUS.push("out:" + String((e.target && e.className) || ""));
    };
    document.addEventListener("focusout", h, true);
    document.addEventListener("focusin", (e) => window.__FOCUS.push("in:" + String((e.target && e.className) || "")), true);
    window.__FO.push;
    return true;
  `);
  for (const ch of "0123456789") {
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
    await ui.sleep(170);
  }
  await ui.sleep(900);
  const after = ((await ui.readSourceText()) || "").length;
  const cnt = await readCounter(ui);
  const fo = await ui.ev(`return { outCount: window.__FO.length, focus: window.__FOCUS.slice(0, 10),
      active: document.activeElement ? document.activeElement.tagName : null,
      activeInCm: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".cm-editor")) }`);
  const landed = after - before;
  ui.log(`[②] 长度 ${before}→${after}（Δ=${landed}）；重建=${JSON.stringify(cnt)}；focusout=${fo.outCount}；active=${fo.active}`);
  ui.add("A2", "★ 连打 10 字符，全部落地（不点击、连续输入）", landed === 10 ? "PASS" : "FAIL",
    `Δ=${landed}/10（修复前为 Δ=1/10）`);
  ui.add("A3", "★ 连打 10 字符期间 CM6 重建次数 = 0", cnt.del === 0 && cnt.add === 0 ? "PASS" : "FAIL",
    `del=${cnt.del} add=${cnt.add}（修复前为 del=1~2 add=1~2）`);
  ui.add("A4", "★ 打字期间焦点未离开编辑区", fo.outCount === 0 && fo.activeInCm ? "PASS" : "FAIL",
    `focusout=${fo.outCount}；activeElement=${fo.active}；仍在 .cm-editor 内=${fo.activeInCm}`);

  /* ══ ③ 单次内容变化 → 重建 = 0（rootcause 的同款场景，极性反写）══ */
  await resetCounter(ui);
  const b3 = ((await ui.readSourceText()) || "").length;
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "X", text: "X", unmodifiedText: "X" });
  await ui.sleep(900);
  const c3 = await readCounter(ui);
  const a3 = ((await ui.readSourceText()) || "").length;
  ui.log(`[③] 输入 1 字符：重建=${JSON.stringify(c3)}；长度 ${b3}→${a3}`);
  ui.add("A5", "★ 内容变化 1 字符 → CM6 重建次数 = 0（修复前 = 1）",
    c3.del === 0 && c3.add === 0 && a3 > b3 ? "PASS" : "FAIL",
    `del=${c3.del} add=${c3.add}；字符落地=${a3 > b3}（${b3}→${a3}）`);

  /* ══ ④ 撤销（内容变化）→ 重建 = 0 ══ */
  await resetCounter(ui);
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(1100);
  const c4 = await readCounter(ui);
  ui.log(`[④] 撤销：重建=${JSON.stringify(c4)}`);
  ui.add("A6", "★ 撤销（非键盘输入路径改内容）→ CM6 重建次数 = 0",
    c4.del === 0 && c4.add === 0 ? "PASS" : "FAIL",
    `del=${c4.del} add=${c4.add}（修复前 = 1~3）`);

  /* ══ ⑤ 对照组：内容不变时应为 0（确认观测器本身有效，不是"永远 0"）══ */
  await resetCounter(ui);
  await ui.key("ArrowDown", "ArrowDown", 40);
  await ui.key("ArrowRight", "ArrowRight", 39);
  await ui.key("Home", "Home", 36);
  await ui.ev(`const sc = document.querySelector(".cm-scroller"); if (sc) sc.scrollTop = 30; return true;`);
  await ui.sleep(700);
  const c5 = await readCounter(ui);
  ui.add("A7", "对照组：光标移动 + 滚动（内容不变）→ 重建 = 0", c5.del === 0 && c5.add === 0 ? "PASS" : "FAIL",
    `del=${c5.del} add=${c5.add}`);

  /* ══ ⑥ 观测器有效性自检：故意触发一次 DOM 替换，确认能读到 ══
   *
   * 这一条是**防「护栏恒真」**的关键（缺陷报告 §5.2 第 2 条教训）：
   * 若 A3/A5/A6 全是 0，我们必须证明这个观测器**在真的发生替换时能看见**，
   * 否则"0"可能只是观测器坏了。
   */
  await resetCounter(ui);
  const sawForced = await ui.ev(`
    const host = document.querySelector(".source-editor-cm6");
    const cm = host.querySelector(".cm-editor");
    if (!cm) return { ok: false, why: "no .cm-editor" };
    cm.remove();
    host.appendChild(cm);
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true, rm: window.__RM };
  `);
  ui.log(`[⑥] 观测器自检（人为 remove+append）：${JSON.stringify(sawForced)}`);
  ui.add("A8", "★ 观测器有效性自检：人为替换 DOM 能被计入（防「护栏恒真」）",
    sawForced?.ok && sawForced.rm?.del >= 1 && sawForced.rm?.add >= 1 ? "PASS" : "FAIL",
    `人为 remove+append 后 del=${sawForced?.rm?.del} add=${sawForced?.rm?.add} → ` +
    (sawForced?.rm?.del >= 1 ? "观测器有效（所以前面的 0 是真 0）" : "观测器失效，前面的 0 不可信"));

  /* ══ ⑦ 观测器要清理干净，别留给后续探针 ══ */
  await ui.ev(`
    (window.__MOS || []).forEach((mo) => { try { mo.disconnect(); } catch (e) {} });
    window.__MOS = [];
    return true;
  `);

  await ui.shot("acceptance");
});

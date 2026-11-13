/**
 * Lead 决定性实验：**连续打字时焦点是否真的丢失**（中间不做任何 DOM 查询）
 *
 * 三种跑法对比，用来区分「产品缺陷」与「探针 artifacts」：
 *   T1 连发 10 个字符，中间**完全不 eval**，最后只查一次文本长度 → 10 个都应落地
 *   T2 连发 10 个字符，**每次之间 ev al 一次** → 若只有 1 个落地，说明是"插入了触发重新渲染导致焦点丢失"
 *   T3 连发 10 个字符，中间只 sleep 不 eval → 隔离出"eval 是否影响"
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 连续打字", "", "正文一。", "", "正文二。", ""].join("\n");

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
  await ui.sleep(350);
  return true;
};

const typeChar = async (ui, ch) => {
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
};

const len = async (ui) => ((await ui.readSourceText()) || "").length;

await runProbe({ name: "v0170-lead-focus-decisive", doc: DOC, docTitle: "连续打字" }, async (ui) => {
  // ── T1：连发，中间不 eval ──
  await clickContent(ui);
  const l0 = await len(ui);
  for (const ch of "ABCDEFGHIJ") { await typeChar(ui, ch); await ui.sleep(120); }
  await ui.sleep(600);
  const l1 = await len(ui);
  const t1 = await ui.readSourceText();
  const gained1 = l1 - l0;
  ui.log(`[T1] ${l0} → ${l1}（Δ${gained1}），末尾=${JSON.stringify((t1 || "").slice(0, 30))}`);
  ui.add("T1", "连发10字符且中间不 eval：落地字符数", gained1 >= 10 ? "PASS" : gained1 >= 1 ? "KNOWN" : "FAIL",
    `Δ=${gained1}/10`);
  const text1 = t1;

  // ── T2：连发，每次之间 eval ──
  await clickContent(ui);
  const l2 = await len(ui);
  const per = [];
  for (const ch of "KLMNOPQRST") {
    await typeChar(ui, ch);
    await ui.sleep(150);
    per.push({ ch, len: await len(ui) });
  }
  await ui.sleep(500);
  const l3 = await len(ui);
  const gained2 = l3 - l2;
  ui.log(`[T2] ${l2} → ${l3}（Δ${gained2}）明细=${JSON.stringify(per)}`);
  ui.add("T2", "连发10字符但每次 eval：落地字符数", gained2 >= 10 ? "PASS" : gained2 >= 1 ? "KNOWN" : "FAIL",
    `Δ=${gained2}/10`);

  // ── T3：连发，只 sleep 不 eval ──
  await clickContent(ui);
  const l4 = await len(ui);
  for (const ch of "uvwxyz0123") { await typeChar(ui, ch); await ui.sleep(150); }
  await ui.sleep(600);
  const l5 = await len(ui);
  const gained3 = l5 - l4;
  const t3 = await ui.readSourceText();
  ui.log(`[T3] ${l4} → ${l5}（Δ${gained3}），末尾=${JSON.stringify((t3 || "").slice(0, 40))}`);
  ui.add("T3", "连发10字符但只 sleep：落地字符数", gained3 >= 10 ? "PASS" : gained3 >= 1 ? "KNOWN" : "FAIL",
    `Δ=${gained3}/10`);

  // ── 对照：全程的字符是否按顺序拼在一起（说明是"连续输入"而非"跳位置"）──
  const finalText = await ui.readSourceText();
  ui.log("[final] 全文: " + JSON.stringify(finalText));
  const hasChain1 = /ABCDEFGHIJ/.test(finalText || "");
  const hasChain3 = /uvwxyz0123/.test(finalText || "");
  ui.add("T4", "T1 的 10 个字符连续成串（未跳位置/未丢中间）", hasChain1 ? "PASS" : "FAIL", `ABCDEFGHIJ 连续=${hasChain1}`);
  ui.add("T5", "T3 的 10 个字符连续成串", hasChain3 ? "PASS" : "FAIL", `uvwxyz0123 连续=${hasChain3}`);

  // ── 焦点快照（只在最后查一次）──
  const f = await ui.ev(`
    const a = document.activeElement;
    return { tag: a ? a.tagName : null, cls: a ? String(a.className||"").slice(0,30) : null };
  `);
  ui.log("[final] 焦点: " + JSON.stringify(f));

  await ui.shot("decisive-final");
});

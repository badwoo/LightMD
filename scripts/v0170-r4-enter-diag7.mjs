/**
 * T3 诊断 7（重写版）：**排除探针伪影** —— 对象形式 `scrollTo()` 归 0 到底是谁的行为？
 *
 * ## 为什么要重写
 * 第一版把 `${...}` 插值写进了模板字面量（外层 Node 的模板也吃 ${}），
 * 生成了非法 JS（页面内 SyntaxError: Unexpected identifier 'Promise'），**零结论**。
 * 教训记在这里：**探针自身报错必须当"无数据"处理，绝不能拿上一次的数字凑结论。**
 *
 * ## 本次要分清的三层（全部**不装任何 hook**，纯轮询读 scrollTop）
 * | 组 | 目标 | 写法 | 若归 0 说明 |
 * |---|---|---|---|
 * | N1 | `.cm-scroller`（CM6） | `scrollTo({top, behavior:"instant"})` | CM6/元素层 |
 * | N2 | `.cm-scroller` | `scrollTo(0, top)` 两参数 | 对照：旧式签名 |
 * | N3 | `.cm-scroller` | `scrollTop = top` | 对照：裸赋值 |
 * | N4 | **同页新建的普通 div**（overflow:auto，内容 4000px） | `scrollTo({top, behavior:"instant"})` | **浏览器/Chromium 层**（与 CM6 无关） |
 * | N5 | 普通 div | `scrollTo(0, top)` | 对照 |
 * | N6 | 普通 div | `scrollTop = top` | 对照 |
 *
 * N4 是决定性的一组：
 * - N4 也归 0 → 是这个 Chromium（headless）对**对象形式 scrollTo** 的环境行为，
 *   **不是 LightMD 的缺陷** → 我必须在报告里明确写"环境限制，不作为产品结论"；
 * - N4 正常、N1 归 0 → 差异来自 `.cm-scroller`/CM6，属产品层。
 *
 * ⚠️ 每组都从"非 0 起点"出发（起点 < 1000 直接判该组无效）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-diag7", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);

  /* ── 采样器：纯轮询，不 hook 任何 API ───────────────────── */
  const startSample = (ms) => ui.ev(
    "window.__P = [];\n" +
    "(function () {\n" +
    "  var t0 = performance.now();\n" +
    "  function read() {\n" +
    "    var sc = document.querySelector('.cm-scroller');\n" +
    "    var plain = document.getElementById('__plain_scroller');\n" +
    "    var rec = { t: Math.round(performance.now() - t0) };\n" +
    "    if (sc) { rec.st = Math.round(sc.scrollTop * 100) / 100; rec.sh = Math.round(sc.scrollHeight); }\n" +
    "    if (plain) { rec.pst = Math.round(plain.scrollTop * 100) / 100; }\n" +
    "    window.__P.push(rec);\n" +
    "  }\n" +
    "  function raf() { read(); if (performance.now() - t0 < " + ms + ") requestAnimationFrame(raf); }\n" +
    "  requestAnimationFrame(raf);\n" +
    "  function tm() { read(); if (performance.now() - t0 < " + ms + ") setTimeout(tm, 0); }\n" +
    "  setTimeout(tm, 0);\n" +
    "})();\n" +
    "return true;"
  );

  const wheelTo50 = async () => {
    const box = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2) };
    `);
    let cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    let guard = 0;
    while (cur > 8 && guard++ < 400) {
      await ui.wheel(box.x, box.y, -Math.min(560, cur));
      cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    }
    const max = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return Math.round(sc.scrollHeight-sc.clientHeight);`);
    const target = Math.round(max * 0.5);
    guard = 0;
    while (cur < target - 8 && guard++ < 800) {
      await ui.wheel(box.x, box.y, Math.min(140, target - cur));
      const next = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
      if (next === cur) break;
      cur = next;
    }
    await ui.sleep(600);
    return await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
  };

  /** 跑一组：action 返回 { wrote, r1 }；同时给出轮询最小值 */
  const runCm = async (tag, bodyFn) => {
    const base = await wheelTo50();
    if (base < 1000) { ui.add(`N-${tag}`, "基线复位失败", "FAIL", `st=${base}`); return null; }
    await startSample(1100);
    await ui.sleep(60);
    // 采样启动后立刻再确认一次起点（防止别的写者在这 60ms 里动过）
    const st0 = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    const ret = await ui.ev(bodyFn(st0));
    await ui.sleep(1300);
    const P = await ui.ev(`return window.__P || []`);
    const seq = P.map((p) => p.st).filter((v) => typeof v === "number");
    const min = seq.length ? Math.min(...seq) : null;
    const reset = min !== null && min < st0 * 0.5;
    ui.log(`[${tag}] base=${base} st0=${st0} ret=${JSON.stringify(ret)} min=${min} 归0=${reset}`);
    ui.log(`[${tag}] 轨迹=${JSON.stringify(P.slice(0, 18).map((p) => `${p.t}:${p.st}`))}`);
    return { tag, base, st0, min, reset, ret };
  };

  const cmBody = (st0, how) => {
    // how: "object" | "2arg" | "bare"
    const body = `
      const sc = document.querySelector(".cm-scroller");
      const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
      const t = Math.max(0, Math.min(max, ${st0} - 320));
      ${how === "object" ? 'sc.scrollTo({ top: t, behavior: "instant" });' : ""}
      ${how === "2arg" ? "sc.scrollTo(0, t);" : ""}
      ${how === "bare" ? "sc.scrollTop = t;" : ""}
      return { wrote: t, r1: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), ch: sc.clientHeight };
    `;
    return body;
  };

  /* ── 建普通滚动 div ─────────────────────────────────────── */
  const plainInit = await ui.ev(`
    let d = document.getElementById("__plain_scroller");
    if (!d) {
      d = document.createElement("div");
      d.id = "__plain_scroller";
      d.style.cssText = "position:fixed;left:-9999px;top:0;width:200px;height:300px;overflow:auto;";
      const inner = document.createElement("div");
      inner.style.cssText = "height:4000px;width:10px;";
      d.appendChild(inner);
      document.body.appendChild(d);
    }
    d.scrollTop = 1200;
    return { st: Math.round(d.scrollTop), max: Math.round(d.scrollHeight - d.clientHeight) };
  `);
  ui.log("[plain] init = " + JSON.stringify(plainInit));

  const runPlain = async (tag, how) => {
    const base = await ui.ev(`
      const d = document.getElementById("__plain_scroller");
      d.scrollTop = 1200;
      return Math.round(d.scrollTop);
    `);
    await ui.sleep(80);
    const st0 = await ui.ev(`return Math.round(document.getElementById("__plain_scroller").scrollTop)`);
    await startSample(900);
    await ui.sleep(50);
    const ret = await ui.ev(`
      const d = document.getElementById("__plain_scroller");
      const t = Math.max(0, Math.min(d.scrollHeight - d.clientHeight, ${st0} - 320));
      ${how === "object" ? 'd.scrollTo({ top: t, behavior: "instant" });' : ""}
      ${how === "2arg" ? "d.scrollTo(0, t);" : ""}
      ${how === "bare" ? "d.scrollTop = t;" : ""}
      return { wrote: t, r1: Math.round(d.scrollTop) };
    `);
    await ui.sleep(1100);
    const P = await ui.ev(`return window.__P || []`);
    const seq = P.map((p) => p.pst).filter((v) => typeof v === "number");
    const min = seq.length ? Math.min(...seq) : null;
    const reset = min !== null && min < st0 * 0.5;
    ui.log(`[${tag}] base=${base} st0=${st0} ret=${JSON.stringify(ret)} min=${min} 归0=${reset}`);
    ui.log(`[${tag}] 轨迹=${JSON.stringify(P.slice(0, 14).map((p) => `${p.t}:${p.pst}`))}`);
    return { tag, base, st0, min, reset, ret };
  };

  /* ── 顺序执行（先 cm 三组，再 plain 三组）────────────────── */
  const n1 = await runCm("N1-cm-object", (st0) => cmBody(st0, "object"));
  const n2 = await runCm("N2-cm-2arg", (st0) => cmBody(st0, "2arg"));
  const n3 = await runCm("N3-cm-bare", (st0) => cmBody(st0, "bare"));
  const n4 = await runPlain("N4-plain-object", "object");
  const n5 = await runPlain("N5-plain-2arg", "2arg");
  const n6 = await runPlain("N6-plain-bare", "bare");

  ui.log("[SUMMARY] " + JSON.stringify({
    cm: { object: { reset: n1?.reset, min: n1?.min, st0: n1?.st0, ret: n1?.ret },
           twoArg: { reset: n2?.reset, min: n2?.min, st0: n2?.st0, ret: n2?.ret },
           bare:   { reset: n3?.reset, min: n3?.min, st0: n3?.st0, ret: n3?.ret } },
    plain: { object: { reset: n4?.reset, min: n4?.min, st0: n4?.st0, ret: n4?.ret },
             twoArg: { reset: n5?.reset, min: n5?.min, st0: n5?.st0, ret: n5?.ret },
             bare:   { reset: n6?.reset, min: n6?.min, st0: n6?.st0, ret: n6?.ret } },
  }, null, 1));

  ui.add("N1", "CM6 `.cm-scroller` + `scrollTo({...})`（无 hook）",
    n1 ? (n1.reset ? "FAIL" : "PASS") : "FAIL",
    n1 ? `st0=${n1.st0} → 轮询最小 ${n1.min}；调用后立即读 ${n1.ret?.r1}` : "无数据");
  ui.add("N2", "CM6 `.cm-scroller` + `scrollTo(0,top)` 两参数",
    n2 ? (n2.reset ? "FAIL" : "PASS") : "FAIL",
    n2 ? `st0=${n2.st0} → 最小 ${n2.min}；调用后立即读 ${n2.ret?.r1}` : "无数据");
  ui.add("N3", "CM6 `.cm-scroller` + 裸赋值 `scrollTop=`",
    n3 ? (n3.reset ? "FAIL" : "PASS") : "FAIL",
    n3 ? `st0=${n3.st0} → 最小 ${n3.min}；调用后立即读 ${n3.ret?.r1}` : "无数据");
  ui.add("N4", "★ 普通 div + `scrollTo({...})`（区分浏览器层 / CM6 层）",
    n4 ? (n4.reset ? "FAIL" : "PASS") : "FAIL",
    n4 ? `st0=${n4.st0} → 最小 ${n4.min}；调用后立即读 ${n4.ret?.r1}` : "无数据");
  ui.add("N5", "普通 div + `scrollTo(0,top)`",
    n5 ? (n5.reset ? "FAIL" : "PASS") : "FAIL",
    n5 ? `st0=${n5.st0} → 最小 ${n5.min}` : "无数据");
  ui.add("N6", "普通 div + 裸赋值",
    n6 ? (n6.reset ? "FAIL" : "PASS") : "FAIL",
    n6 ? `st0=${n6.st0} → 最小 ${n6.min}` : "无数据");

  await ui.shot("diag7");
});

/**
 * Lead · 诊断：右屏 `scrollHeight` 为什么从 6130 暴涨到 175363？
 *
 * 上一轮（`_lead-p4c-coords.mjs`）实测：
 * ```
 * 右屏(未处理)    : sh=6130   每段 h=86.4     ← 正常
 * 右屏(开合一次后): sh=175363 每段 h=2879.7   ← ★ 每段高 33 倍
 * 右屏(手动滚50%) : sh=175363 每段 h=2879.7
 * ```
 * 每段高度暴涨 33 倍 = 段落没有正常排版（可能 CSS 未生效、字体未加载、
 * 或内容被重复插入/嵌套）。这会让"右屏 scriollHeight 与左屏完全不同量级"，
 * 于是任何百分比/锚点映射都必然错 —— 这才是"右屏没对齐"的真因。
 *
 * 本探针检查：
 *   ① body 子元素数量（是否内容被重复追加）
 *   ② 是否有 <style>/<link> 生效（getComputedStyle 的 font-size/line-height）
 *   ③ body / p 的实际布局盒（是否 block 变成别的显示模式）
 *   ④ 是否出现纵向排列异常（每段 h=2879 ≈ 视口 3.8 倍）
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

function makeDoc(n) {
  const out = ["# 右屏撑坏诊断", ""];
  for (let i = 1; i <= n; i++) {
    out.push(
      `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet ` +
        `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`,
      "",
    );
  }
  return out.join("\n");
}
const DOC = makeDoc(60);

const INSPECT = `
  const f = document.querySelector(".split-preview-shell iframe") || document.querySelector("iframe");
  const d = f && f.contentDocument;
  if (!d) return { ok: false, why: "no-doc" };
  const sc = d.scrollingElement || d.documentElement || d.body;
  const body = d.body;
  const p1 = d.querySelector("p");
  const cs = p1 ? d.defaultView.getComputedStyle(p1) : null;
  const bs = body ? d.defaultView.getComputedStyle(body) : null;
  const html = d.documentElement;
  const hs = d.defaultView.getComputedStyle(html);
  return {
    ok: true,
    bodyChildren: body ? body.children.length : -1,
    bodyScrollH: body ? body.scrollHeight : -1,
    bodyClientH: body ? body.clientHeight : -1,
    htmlScrollH: html.scrollHeight,
    scTag: sc.tagName, scScrollH: sc.scrollHeight, scClientH: sc.clientHeight,
    styleSheets: d.styleSheets.length,
    styleSheetHrefs: Array.from(d.styleSheets).map(s => (s.href || "inline").slice(-40)).slice(0, 6),
    linkCount: d.querySelectorAll("link[rel=stylesheet]").length,
    styleTagCount: d.querySelectorAll("style").length,
    p1: p1 ? {
      text: (p1.textContent || "").slice(0, 30),
      rectH: Math.round(p1.getBoundingClientRect().height * 10) / 10,
      rectW: Math.round(p1.getBoundingClientRect().width * 10) / 10,
      fontSize: cs.fontSize, lineHeight: cs.lineHeight, display: cs.display,
      margin: cs.margin, padding: cs.padding,
      writingMode: cs.writingMode, whiteSpace: cs.whiteSpace,
      wordBreak: cs.wordBreak, width: cs.width, height: cs.height,
    } : null,
    body: bs ? { fontSize: bs.fontSize, lineHeight: bs.lineHeight, display: bs.display,
      margin: bs.margin, width: bs.width, writingMode: bs.writingMode } : null,
    html: hs ? { fontSize: hs.fontSize, lineHeight: hs.lineHeight, writingMode: hs.writingMode,
      height: hs.height, overflow: hs.overflow } : null,
    // 关键：body 里第一个元素的实际高度 vs 字数的关系
    firstFew: Array.from(d.querySelectorAll("body *")).slice(0, 6).map(el => ({
      tag: el.tagName, cls: (el.className || "").toString().slice(0, 30),
      h: Math.round(el.getBoundingClientRect().height * 10) / 10,
      w: Math.round(el.getBoundingClientRect().width * 10) / 10,
      textLen: (el.textContent || "").length,
    })),
  };
`;

await runBrowserProbe({ name: "lead-p4d-iframe-layout", doc: DOC, docTitle: "右屏撑坏诊断" }, async (ui) => {
  await ui.command("view.edit");
  await sleep(2400);
  ui.log(`[p4d] === 刚进编辑模式（预览刚建）===`);
  ui.log(`[p4d] ${JSON.stringify(await ui.ev(INSPECT))}`);

  // 双击 Shift 关→开，观察是否撑坏
  const dblShift = async () => {
    for (let i = 0; i < 2; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await sleep(70);
    }
  };

  const isOpen = () => ui.ev(`
    const s=document.querySelector(".split-preview-shell"); return !!s && s.getBoundingClientRect().width>40;`);

  ui.log(`[p4d] 初始 open=${await isOpen()}`);
  // 关
  await dblShift(); await sleep(2000);
  ui.log(`[p4d] 关闭后 open=${await isOpen()}`);
  const closedState = await ui.ev(INSPECT);
  ui.log(`[p4d] 关闭态: ${JSON.stringify(closedState)}`);

  // 开
  await dblShift(); await sleep(2500);
  ui.log(`[p4d] 再打开 open=${await isOpen()}`);
  const reopenState = await ui.ev(INSPECT);
  ui.log(`[p4d] 重开态: ${JSON.stringify(reopenState)}`);

  ui.add("P4d-1", "重开预览后 iframe 内 body 子元素数 == 段落数（未被重复追加）",
    reopenState && reopenState.bodyChildren <= 62 ? "PASS" : "FAIL",
    `bodyChildren=${reopenState && reopenState.bodyChildren}（文档 60 段 + 标题 + 空行）`);

  ui.add("P4d-2", "★ 重开预览后 p 元素高度正常（>0 且 <300px）",
    reopenState && reopenState.p1 && reopenState.p1.rectH > 0 && reopenState.p1.rectH < 300 ? "PASS" : "FAIL",
    `p1.rectH=${reopenState && reopenState.p1 && reopenState.p1.rectH}（正常应 ~86）` +
    ` styleSheets=${reopenState && reopenState.styleSheets} links=${reopenState && reopenState.linkCount} inlineStyle=${reopenState && reopenState.styleTagCount}`);

  fs.writeFileSync(path.join(os.tmpdir(), "lead-p4d.json"),
    JSON.stringify({ closedState, reopenState }, null, 1), "utf8");
});

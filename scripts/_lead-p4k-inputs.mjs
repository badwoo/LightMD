/**
 * Lead · 决定性诊断：**开合路径 vs 滚动路径，syncToPreview 的输入有何不同？**
 *
 * ## 已复现的用户现象（`_lead-p4j-rollvs-toggle.mjs`，真实文档）
 * ```
 *                     右屏同内容相对Y（0=与左屏顶对齐）
 * 双击Shift打开后        -792px / -1037px      ← 右屏落后近 1 屏
 * 滚一下之后             -27.6px               ← 几乎对齐
 * ```
 * 平均绝对偏差：**915px → 28px**。用户"滚一下就对齐了"完全复现。
 *
 * ## 为什么这个差异是决定性的
 * 两条路径最终都调用 `syncToPreview()` → `computePreviewTarget()` →
 * `mapSourceLineToPreviewScroll(anchors, topLine, preview.clientHeight)`。
 * **同一个函数，两种结果** ⇒ 差别一定在**输入**或**调用的时机/次数**：
 *   - 输入：`topLine`（currentTopSourceLine）在开合瞬间是否读到了错误值？
 *   - 输入：`anchors` 在开合瞬间是否还是旧文档/未贴标？
 *   - 时机：`finalize` 只在固定时点调 4 次，之后就不再纠；而滚动是持续的
 *
 * ## 本探针：把每次 computePreviewTarget 的关键输入/输出全部打点
 * 通过 hook `Element.prototype.scrollTop` 的 setter 抓"右屏被写成什么"，
 * 并在每次写入时记录当时的 `sourceTop`（左屏）+ `topLine` + 结果。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const USER_DOC = process.env.P4_DOC || "D:\\10254\\桌面\\job plan\\明途知识产权-高级数据工程师-沟通场景表.md";
function fixture(n) {
  const out = ["# 输入对账", ""];
  for (let i = 1; i <= n; i++) {
    out.push(`第 ${i} 段。PI${String(i).padStart(2, "0")} 标记。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.`, "");
  }
  return out.join("\n");
}
const USING = fs.existsSync(USER_DOC);
const DOC = USING ? fs.readFileSync(USER_DOC, "utf8") : fixture(60);

/** 在 iframe realm 与主文档都装 hook：记录右屏/左屏 scrollTop 写入 + 调用栈 */
const INSTALL_HOOK = `
  if (window.__IH) return "already";
  window.__IH = true;
  window.__IW = [];
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (!desc || !desc.set) return "no-setter";
  Object.defineProperty(Element.prototype, "scrollTop", {
    get: desc.get,
    set: function (v) {
      try {
        const cls = (this.className || "") + "";
        const tag = this.tagName || "";
        const isCm = cls.indexOf("cm-scroller") >= 0 || tag === "HTML" || cls.indexOf("cm-") === 0;
        const isEc = cls.indexOf("editor-container") >= 0;
        if (isCm || isEc) {
          const st = (new Error().stack || "").split("\\n").slice(2,6)
            .map(s => s.trim().replace(/^at\\s+/, "").replace(/\\(.*?:\\d+:\\d+\\)$/, "").slice(0,48));
          window.__IW.push({ t: Math.round(performance.now()),
            who: isEc ? "reader" : (tag === "HTML" ? "iframe" : "cm"),
            from: Math.round(desc.get.call(this)), to: Math.round(v), st });
        }
      } catch(e) {}
      return desc.set.call(this, v);
    },
    configurable: true,
  });
  return "ok";
`;

const LEFT = `
  const sc=document.querySelector(".cm-scroller"); if(!sc)return null;
  return {st:Math.round(sc.scrollTop), sh:sc.scrollHeight, ch:sc.clientHeight,
    max:Math.round(sc.scrollHeight-sc.clientHeight), w:sc.clientWidth};
`;
const RIGHT = `
  const f=document.querySelector(".split-preview-shell iframe"); const d=f&&f.contentDocument;
  if(!d)return null; const sc=d.scrollingElement||d.documentElement||d.body;
  const h=sc.clientHeight; if(!(h>0))return null;
  const sh=sc.scrollHeight, max=Math.max(0,sh-h);
  return {st:Math.round(sc.scrollTop), sh, ch:h, max:Math.round(max), w:sc.clientWidth,
    pct:max>0?Math.round(sc.scrollTop/max*1000)/1000:null,
    tagged: d.querySelectorAll("[data-src-line]").length};
`;

await runBrowserProbe({ name: "lead-p4k-inputs", doc: DOC, docTitle: USING ? "明途知识产权" : "输入对账" }, async (ui) => {
  const L = () => ui.ev(LEFT);
  const R = () => ui.ev(RIGHT);
  const isOpen = () => ui.ev(`const s=document.querySelector(".split-preview-shell");return !!s&&s.getBoundingClientRect().width>40;`);
  const dblShift = async () => {
    for (let i = 0; i < 2; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await sleep(70);
    }
  };

  ui.log(`[p4k] 文档=${USING ? "用户真实文档" : "夹具"}`);
  await ui.command("view.edit");
  await sleep(2400);
  if (await isOpen()) { await dblShift(); await sleep(2200); }

  // 装 hook（主文档）
  const h1 = await ui.ev(INSTALL_HOOK);
  ui.log(`[p4k] hook 主文档 = ${h1}`);

  // 滚左屏到 ~50%
  for (let i = 0; i < 60; i++) {
    const c = await L();
    if (!c || c.max <= 0) break;
    const d = Math.round(c.max * 0.5) - c.st;
    if (Math.abs(d) < 40) break;
    await ui.wheel(1000, 500, Math.max(-900, Math.min(900, d)));
    await sleep(45);
  }
  await sleep(500);
  const closed = await L();
  ui.log(`[p4k] 关闭态 左=${JSON.stringify(closed)}`);

  // 清记录 + 打开预览
  await ui.ev(`window.__IW = []; return true;`);
  await dblShift();
  await sleep(3200);
  const openL = await L();
  const openR = await R();
  ui.log(`[p4k] 开合后 左=${JSON.stringify(openL)} 右=${JSON.stringify(openR)}`);

  const w1 = await ui.ev(`
    return (window.__IW||[]).map(x => ({t:x.t, who:x.who, from:x.from, to:x.to, st:x.st.join(" < ")}));
  `);
  ui.log(`[p4k] === 开合期间写入 ${w1.length} 次 ===`);
  for (const w of w1) ui.log(`[p4k]   t=${w.t} ${w.who} ${w.from}→${w.to}  ← ${w.st}`);

  // 再滚一下（用户动作），看写入序列差异
  await ui.ev(`window.__IW = []; return true;`);
  await ui.wheel(1000, 500, 150);
  await sleep(1400);
  const rollL = await L();
  const rollR = await R();
  ui.log(`[p4k] 滚动后 左=${JSON.stringify(rollL)} 右=${JSON.stringify(rollR)}`);
  const w2 = await ui.ev(`
    return (window.__IW||[]).map(x => ({t:x.t, who:x.who, from:x.from, to:x.to, st:x.st.join(" < ")}));
  `);
  ui.log(`[p4k] === 滚动期间写入 ${w2.length} 次 ===`);
  for (const w of w2) ui.log(`[p4k]   t=${w.t} ${w.who} ${w.from}→${w.to}  ← ${w.st}`);

  // 核心对账：两次的"右屏 max / 左屏 max"比例是否一致
  ui.log(`[p4k] ===== 对账 =====`);
  ui.log(`[p4k] 开合后 右%=${openR && openR.pct}  左%=${openL && Math.round(openL.st/openL.max*1000)/1000}`);
  ui.log(`[p4k] 滚动后 右%=${rollR && rollR.pct}  左%=${rollL && Math.round(rollL.st/rollL.max*1000)/1000}`);
  ui.log(`[p4k] 右屏 tagged: 开合后=${openR && openR.tagged} 滚动后=${rollR && rollR.tagged}`);

  fs.writeFileSync(path.join("D:/AI/markdown view/lightmd/_verify-out", "lead-p4k-inputs.json"),
    JSON.stringify({ closed, openL, openR, rollL, rollR, writesOnToggle: w1, writesOnRoll: w2 }, null, 1), "utf8");
});

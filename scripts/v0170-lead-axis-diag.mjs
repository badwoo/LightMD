/**
 * Lead 诊断：P1-3 修复后为何对齐仍 0/4？
 *
 * 读修复者加的运行时诊断（`window.__LMD_AXIS_SOURCE` / `__LMD_AXIS_DEGRADE`），
 * 判断到底是：
 *   (a) 仍然走了 textarea 分支（修复未生效）
 *   (b) 走了 surface 分支但行轴为 null（surfaceMeasureSource 本身失败）
 *   (c) 行轴有值但对齐算法没消费它
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const parts = ["# 行轴诊断", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`## 第 ${i} 节标题`, "");
  parts.push(`第 ${i} 节的正文段落。这一段用于制造可滚动的行数与均匀的块结构，使左右两侧的「第 N 个顶层块」能够一一对应。长度保持均匀便于对比。`, "");
  parts.push(`- 要点 ${i}.1：对齐测试条目`, `- 要点 ${i}.2：对齐测试条目`, "");
}
const DOC = parts.join("\n");

await runProbe({ name: "v0170-lead-axis-diag", doc: DOC, docTitle: "第 40 节" }, async (ui) => {
  // 已进编辑模式+分屏（viewMode=edit 默认）
  // 触发一次行轴构建：滚动
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (sc) { sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight) * 0.4;
              sc.dispatchEvent(new Event("scroll", { bubbles: false })); }
    return true;
  `);
  await ui.sleep(1500);

  const diag = await ui.ev(`
    return {
      axisSource: window.__LMD_AXIS_SOURCE ?? null,
      degrade: (window.__LMD_AXIS_DEGRADE || []).slice(0, 12),
      degradeCount: (window.__LMD_AXIS_DEGRADE || []).length,
      axisObj: window.__LMD_AXIS ? Object.keys(window.__LMD_AXIS) : null,
      axisDegrade: window.__LMD_AXIS && window.__LMD_AXIS.degrade ? window.__LMD_AXIS.degrade.slice(0,12) : null,
      hostTag: (() => { const h = document.querySelector(".source-editor"); return h ? h.tagName : null; })(),
      hostValueType: (() => { const h = document.querySelector(".source-editor"); return h ? typeof h.value : "n/a"; })(),
    };
  `);
  ui.log("[diag] " + JSON.stringify(diag, null, 1));

  ui.add("D1", "行轴走的是哪个源（应 = surface）",
    diag.axisSource === "surface" ? "PASS" : "FAIL",
    `axisSource=${diag.axisSource}（期望 "surface"；若 "textarea" 说明修复未生效）`);

  ui.add("D2", "surface 分支是否有降级记录",
    (diag.degradeCount === 0) ? "PASS" : "KNOWN",
    `degradeCount=${diag.degradeCount}；样本=${JSON.stringify(diag.degrade || diag.axisDegrade)}`);

  ui.add("D3", "宿主确为非 textarea（前提核对）",
    diag.hostTag === "DIV" && diag.hostValueType === "undefined" ? "PASS" : "FAIL",
    `tag=${diag.hostTag} typeof value=${diag.hostValueType}`);

  await ui.shot("axis-diag");
});

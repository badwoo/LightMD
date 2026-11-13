/**
 * Lead 诊断 4：用**正确的诊断字段**（`window.__LMD_AXIS = { source, degrade }`）取证。
 *
 * 之前我读的是 `window.__LMD_AXIS_SOURCE`，但修复者实际用的是
 * `window.__LMD_AXIS.source`（零开销设计：未安装接收器时一行都不执行）。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const parts = ["# 行轴诊断4", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`## 第 ${i} 节标题`, "");
  parts.push(`第 ${i} 节的正文段落。这一段用于制造可滚动的行数与均匀的块结构，使左右两侧的「第 N 个顶层块」能够一一对应。长度保持均匀便于对比。`, "");
  parts.push(`- 要点 ${i}.1：对齐测试条目`, `- 要点 ${i}.2：对齐测试条目`, "");
}
const DOC = parts.join("\n");

await runProbe({ name: "v0170-lead-axis-diag4", doc: DOC, docTitle: "第 40 节" }, async (ui) => {
  // ★ 关键：必须在滚动/对齐发生**之前**安装接收器
  await ui.ev(`window.__LMD_AXIS = { source: "", degrade: [] }; return true;`);

  const box = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);
  for (let i = 0; i < 10; i++) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 400, modifiers: 0 });
    await ui.sleep(130);
  }
  await ui.sleep(1800);

  const st = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const f = document.querySelector("iframe.split-preview");
    return {
      leftTop: sc ? Math.round(sc.scrollTop) : null,
      leftMax: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : null,
      rightScrollY: f && f.contentWindow ? Math.round(f.contentWindow.scrollY) : null,
      axis: window.__LMD_AXIS || null,
    };
  `);
  ui.log("[diag4] " + JSON.stringify(st, null, 1));

  const src = st.axis && st.axis.source;
  const deg = (st.axis && st.axis.degrade) || [];
  ui.add("G1", "★ 行轴实际走的源", src === "surface" ? "PASS" : src === "textarea" ? "FAIL" : "KNOWN",
    `source="${src}"（期望 "surface"；空=getSourceLineAxis 未执行；textarea=修复未生效）`);
  ui.add("G2", "行轴构建是否降级", deg.length === 0 ? "PASS" : "FAIL",
    `degrade=${JSON.stringify(deg)}（非空即行轴没建成，原因在这里）`);

  await ui.shot("axis-diag4");
});

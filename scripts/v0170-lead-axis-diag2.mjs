/**
 * Lead 诊断 2：用**真实滚轮事件**驱动分屏联动，再看行轴来源。
 *
 * 上一条诊断 `axisSource=null`，原因是我直接写 `scrollTop` + 派发合成 scroll，
 * 可能被方向锁/冻结窗口拦住，导致 `syncToPreview` 根本没跑（因此没调 getSourceLineAxis）。
 * 这次用 CDP 真实滚轮（Input.dispatchMouseEvent type=mouseWheel），最接近用户操作。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const parts = ["# 行轴诊断2", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`## 第 ${i} 节标题`, "");
  parts.push(`第 ${i} 节的正文段落。这一段用于制造可滚动的行数与均匀的块结构，使左右两侧的「第 N 个顶层块」能够一一对应。长度保持均匀便于对比。`, "");
  parts.push(`- 要点 ${i}.1：对齐测试条目`, `- 要点 ${i}.2：对齐测试条目`, "");
}
const DOC = parts.join("\n");

await runProbe({ name: "v0170-lead-axis-diag2", doc: DOC, docTitle: "第 40 节" }, async (ui) => {
  // 真实滚轮滚左屏
  const box = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);
  for (let i = 0; i < 12; i++) {
    await ui.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 400, modifiers: 0,
    });
    await ui.sleep(120);
  }
  await ui.sleep(1800);

  const st = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const f = document.querySelector("iframe.split-preview");
    const d = f && f.contentDocument;
    return {
      leftTop: sc ? Math.round(sc.scrollTop) : null,
      leftMax: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : null,
      rightScrollY: f && f.contentWindow ? Math.round(f.contentWindow.scrollY) : null,
      rightMax: d ? Math.round((d.scrollingElement||d.documentElement).scrollHeight - (d.scrollingElement||d.documentElement).clientHeight) : null,
      axisSource: window.__LMD_AXIS_SOURCE ?? null,
      degrade: (window.__LMD_AXIS_DEGRADE || []).slice(0, 8),
      axisKeys: window.__LMD_AXIS ? Object.keys(window.__LMD_AXIS) : null,
    };
  `);
  ui.log("[diag2] " + JSON.stringify(st, null, 1));

  ui.add("E1", "真实滚轮后左屏确实滚动了", (st.leftTop || 0) > 100 ? "PASS" : "FAIL",
    `leftTop=${st.leftTop}/${st.leftMax}`);
  ui.add("E2", "右屏跟随滚动", (st.rightScrollY || 0) > 100 ? "PASS" : "FAIL",
    `rightScrollY=${st.rightScrollY}/${st.rightMax}`);
  ui.add("E3", "★ 行轴来源（应 surface）",
    st.axisSource === "surface" ? "PASS" : st.axisSource === "textarea" ? "FAIL" : "KNOWN",
    `axisSource=${st.axisSource}（null=getSourceLineAxis 未被调用；textarea=修复未生效；surface=已生效）`);
  ui.add("E4", "surface 分支降级记录", (st.degrade || []).length === 0 ? "PASS" : "KNOWN",
    JSON.stringify(st.degrade));

  await ui.shot("axis-diag2");
});

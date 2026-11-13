/**
 * 冒烟探针（#2 五轮冷启动之前的低成本验证）。
 *
 * 目的：确认 exe 没坏、CDP 能连、编辑模式能进、CM6 有内容。
 * 跑一次 ≈ 40s；#2 五轮 ≈ 8 分钟。先冒烟能省掉"exe 坏了还跑五轮"的浪费。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 冒烟", "", "第 1 段。SMOKE01 标记。", "", "第 2 段。正文内容。", ""].join("\n");

await runProbe({ name: "v0170-r2-smoke-exe", doc: DOC, docTitle: "SMOKE01", viewMode: "raw" }, async (ui) => {
  await ui.add("M1", "CDP 连接 + Tauri 环境", "PASS", `port=${ui.port}`);

  // 冷启动后立即切编辑（与 #2 的触发动作一致）
  await ui.command("view.edit");
  await ui.sleep(2600);

  const st = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const ec = document.querySelector(".editor-container");
    const boundary = document.querySelector(".error-boundary, [data-testid='error-boundary']");
    return {
      hasCm: !!document.querySelector(".cm-editor"),
      cmLines: document.querySelectorAll(".cm-line").length,
      srcVisible: !!sc && sc.clientHeight > 0,
      readVisible: !!ec && ec.clientHeight > 0,
      hasIframe: !!document.querySelector("iframe.split-preview"),
      boundary: !!boundary,
      boundaryText: boundary ? (boundary.textContent || "").slice(0, 200) : null,
      persistKey: localStorage.getItem("lightmd-view-mode"),
    };
  `);
  ui.log(`[smoke] ${JSON.stringify(st)}`);

  await ui.add("M2", "切编辑后 CM6 已渲染且有内容", st.hasCm && st.cmLines > 1 ? "PASS" : "FAIL",
    `cm=${st.hasCm} lines=${st.cmLines}`);
  await ui.add("M3", "无错误边界", st.boundary ? "FAIL" : "PASS", st.boundaryText || "无");
  await ui.add("M4", "viewMode 持久化写入生效", st.persistKey ? "PASS" : "KNOWN", st.persistKey || "尚无（600ms 合批可能未到）");

  // 等合批后复查
  await ui.sleep(1200);
  const key2 = await ui.ev(`return localStorage.getItem("lightmd-view-mode")`);
  await ui.add("M5", "600ms 合批后持久化 key 存在", key2 ? "PASS" : "FAIL", key2 || "缺失");
  await ui.shot("smoke");
});

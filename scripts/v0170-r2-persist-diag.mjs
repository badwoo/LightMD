/**
 * 临时诊断（#10）：编辑态滚动进度是否真的落盘 + viewMode 是否持久化 + 重启后能否恢复。
 *
 * 浏览器内用 Page.reload 模拟"关掉再开"（同 origin → localStorage 保留），
 * 这足以验证 localStorage 语义与恢复链；窗口级/WebView2 侧仍须真机复验。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 持久化诊断", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(`第 ${i} 段。PI${String(i).padStart(2, "0")}。Lorem ipsum dolor sit amet, consectetur adipiscing elit.`, "");
}
const DOC = parts.join("\n");

const dumpStorage = (ui) =>
  ui.ev(`
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("lightmd")) continue;
      const v = localStorage.getItem(k) || "";
      out[k] = v.length > 160 ? v.slice(0, 160) + "…" : v;
    }
    return out;
  `);

const readState = (ui) =>
  ui.ev(`
    const store = window.__LMD_EDITOR_STORE__ || null;
    return {
      viewMode: store ? store.viewMode : null,
      splitPreviewOpen: store ? store.splitPreviewOpen : null,
      hasShell: !!document.querySelector(".split-preview-shell"),
      hasCm: !!document.querySelector(".cm-editor"),
      hasPmVisible: (() => { const c = document.querySelector(".editor-container"); return !!c && c.clientHeight > 0; })(),
      cmTop: (() => { const s = document.querySelector(".cm-scroller"); return s ? Math.round(s.scrollTop) : null; })(),
    };
  `);

const readCenter = (ui) =>
  ui.ev(`
    const pick = (sel, root) => {
      const sc = document.querySelector(sel);
      if (!sc) return null;
      const r = sc.getBoundingClientRect();
      const mid = r.top + sc.clientHeight / 2;
      const els = Array.from((root || document).querySelectorAll(root ? ".cm-line" : ".editor-container .ProseMirror > *"));
      let best = null;
      for (const el of els) {
        const b = el.getBoundingClientRect();
        if (b.height === 0) continue;
        const covers = b.top <= mid && b.bottom >= mid;
        const d = covers ? -1 : Math.abs(b.top + b.height / 2 - mid);
        if (!best || d < best.d) best = { d, text: (el.textContent || "").trim() };
      }
      const m = best && best.text.match(/PI(\\d+)/);
      return m ? parseInt(m[1], 10) : null;
    };
    return { readPi: pick(".editor-container"), srcPi: pick(".cm-scroller") };
  `);

await runBrowserProbe({ name: "v0170-r2-persist-diag", doc: DOC }, async (ui) => {
  /* 记录 reload 前坐标系（reload 后 CDP target 不变，evaluate 仍可用） */
  await ui.command("view.edit");
  await ui.sleep(2200);
  const opener = `
    (() => {
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify("D:/tmp/persist-diag.md")}, name: "persist-diag.md", content: ${JSON.stringify(DOC)} },
      }));
      return true;
    })()
  `;
  await ui.ev(opener);
  await ui.sleep(1500);

  /* 滚编辑面到 50% */
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight) * 0.5;
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.round(sc.scrollTop);
  `);
  await ui.sleep(7000); // 等 5s 心跳落盘
  const beforeState = await readState(ui);
  const beforeCenter = await readCenter(ui);
  const beforeStorage = await dumpStorage(ui);
  ui.add("B1", "【修前】编辑态滚动后 scroll-progress 是否有值", "PASS", JSON.stringify(beforeStorage["lightmd-scroll-progress"] ?? "(缺失)"));
  ui.add("B2", "【修前】viewMode 是否有持久化键（关软件能记住）",
    "PASS", Object.keys(beforeStorage).filter((k) => /view|mode|editor/.test(k)).join(",") || "(无任何 view/mode 键)");
  ui.add("B3", "【修前】滚动前状态", "PASS", JSON.stringify(beforeState) + " 中心=" + JSON.stringify(beforeCenter));

  /* reload 模拟重启 */
  await ui.cdp.send("Page.reload", { ignoreCache: false });
  await ui.sleep(1200);
  // 等 React 重新挂载
  for (let i = 0; i < 40; i++) {
    const ok = await ui.ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
    if (ok) break;
    await ui.sleep(300);
  }
  await ui.sleep(1500);
  const afterReload = await readState(ui);
  ui.add("B4", "【修前】reload 后仍是编辑模式？", afterReload.viewMode === "edit" ? "PASS" : "FAIL",
    `viewMode=${afterReload.viewMode} splitPreviewOpen=${afterReload.splitPreviewOpen}`);

  /* reload 后重新打开同一文件，看进度是否恢复 */
  await ui.ev(opener);
  await ui.sleep(2600);
  await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
  await ui.sleep(2600);
  const restored = await readState(ui);
  const restoredCenter = await readCenter(ui);
  ui.add("B5", "【修前】reload+重开文件后滚动位置恢复（编辑面）", "PASS",
    `cmTop=${restored.cmTop}（应≈50% 处），中心 PI=${restoredCenter.srcPi}（reload 前中心 PI=${beforeCenter.srcPi}）`);
});

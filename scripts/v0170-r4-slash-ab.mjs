/**
 * v0.17.0 R4 · T2 · 斜杠菜单出现瞬间页面发生了什么（单变量：点空行 vs 不点）
 *
 * ## 两次实验的差异（必须钉死，否则结论会互相矛盾）
 *
 * | 实验 | 点空行 | 敲 `/` 后 `.cm-editor` | 斜杠菜单 |
 * |---|---|---|---|
 * | `v0170-r4-remount` | **是** | **消失（nEditor=0）** | 无 |
 * | `v0170-r4-slash-root` | 否 | 正常（nEditor=1） | 无 |
 *
 * 两个实验唯一差别就是「光标是否在空行行首」。所以本次把这一变量单独拿出来：
 * - A 组：**不点**，直接敲 `/`（光标在原来位置，不在行首）→ 预期无菜单、无异常
 * - B 组：**点空行**行首 → 敲 `/` → 重点观察
 *
 * 每组都记 `body.innerText` 前 160 字 + 关键节点数，避免"节点数为 0 但页面其实正常"
 * 这类误读（也可能是探针在错误时刻读数）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

const SNAP = `
  const cnt = (s) => document.querySelectorAll(s).length;
  return {
    nEditor: cnt(".cm-editor"), nContent: cnt(".cm-content"), nScroller: cnt(".cm-scroller"),
    nEditorContainer: cnt(".editor-container"), nApp: cnt(".app"),
    nSlashMenu: cnt(".slash-command-menu"), nSlashItem: cnt(".slash-command-item"),
    nToolbar: cnt(".source-format-toolbar"), nSyntax: cnt(".syntax-helper"),
    text: (document.body.innerText || "").slice(0, 160).replace(/\\n/g, " | "),
    st: (() => { const s = document.querySelector(".cm-scroller"); return s ? Math.round(s.scrollTop) : null; })(),
    err: (window.__ERRS || []).slice(0, 3),
  };
`;

const VIEWLEN = `
  const c = document.querySelector(".cm-content");
  const v = (c && c.cmTile && c.cmTile.view) || window.__V0 || null;
  if (!v) return { ok: false };
  return { ok: true, len: v.state.doc.length, destroyed: !!v.isDestroyed };
`;

const READ_LINE = `
  const c = document.querySelector(".cm-content");
  const v = (c && c.cmTile && c.cmTile.view) || window.__V0 || null;
  if (!v) return { ok: false };
  const m = v.state.selection.main;
  const line = v.state.doc.lineAt(m.head);
  return { ok: true, col: m.head - line.from, lineText: line.text.slice(0, 24), len: v.state.doc.length };
`;

await runBrowserProbe({ name: "v0170-r4-slash-ab", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  await ui.ev(`
    window.__ERRS = [];
    window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e).slice(0, 120)));
    window.onunhandledrejection = (e) => window.__ERRS.push("rej:" + String((e.reason && e.reason.message) || e.reason).slice(0, 120));
    window.__V0 = (() => { const c = document.querySelector(".cm-content"); return (c && c.cmTile && c.cmTile.view) || null; })();
    return true;
  `);

  /* ══ A 组：不点，直接敲 `/` ══ */
  ui.log("=== A 组：不点空行，直接敲 / ===");
  ui.log("[A-t0] " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[A-t0] line = " + JSON.stringify(await ui.ev(READ_LINE)));
  await ui.key("/", "Slash", 191);
  await ui.sleep(150);
  ui.log("[A+150ms] " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[A+150ms] line = " + JSON.stringify(await ui.ev(READ_LINE)));
  await ui.sleep(1000);
  ui.log("[A+1150ms] " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[A] view = " + JSON.stringify(await ui.ev(VIEWLEN)));

  /* ══ B 组：点空行行首，再敲 `/` ══ */
  ui.log("=== B 组：点空行行首，再敲 / ===");
  // 先把 A 组多出来的 `/` 撤掉
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(600);

  const cand = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    const out = [];
    for (const l of sc.querySelectorAll(".cm-line")) {
      if ((l.textContent || "").trim() !== "") continue;
      const r = l.getBoundingClientRect();
      if (r.height <= 0 || r.top < scR.top + 30 || r.bottom > scR.bottom - 30) continue;
      out.push({ x: Math.round(r.left + 5), y: Math.round(r.top + r.height / 2), d: Math.round(Math.abs((r.top + r.bottom) / 2 - midY)) });
    }
    out.sort((a, b) => a.d - b.d);
    return out[0] || null;
  `);
  ui.log("[B] 空行候选 = " + JSON.stringify(cand));
  if (!cand) { ui.add("N0", "B 组：找到空行", "FAIL", "无"); return; }

  await ui.click(cand.x, cand.y);
  await ui.sleep(450);
  ui.log("[B] 点击后 " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[B] 点击后 line = " + JSON.stringify(await ui.ev(READ_LINE)));

  await ui.key("/", "Slash", 191);
  await ui.sleep(100);
  ui.log("[B+100ms] " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[B+100ms] line = " + JSON.stringify(await ui.ev(READ_LINE)));
  await ui.sleep(200);
  ui.log("[B+300ms] " + JSON.stringify(await ui.ev(SNAP)));
  await ui.sleep(1200);
  ui.log("[B+1500ms] " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[B] view = " + JSON.stringify(await ui.ev(VIEWLEN)));

  await ui.shot("slash-ab");

  // 结论行（用数据说话，不预设）
  const finalB = await ui.ev(SNAP);
  ui.add("N1", "B 组（空行行首敲 /）：编辑器是否仍在 DOM",
    finalB.nEditor > 0 ? "PASS" : "FAIL",
    `nEditor=${finalB.nEditor} nContent=${finalB.nContent} nApp=${finalB.nApp}；页面文本=${JSON.stringify(finalB.text.slice(0, 90))}`);
  ui.add("N2", "斜杠菜单是否弹出",
    finalB.nSlashMenu > 0 ? "PASS" : "FAIL",
    `nSlashMenu=${finalB.nSlashMenu} nSlashItem=${finalB.nSlashItem}`);
});

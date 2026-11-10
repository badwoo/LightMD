/**
 * LightMD v0.17.0 探针：源码面 Tab / Shift-Tab 与焦点保持
 *
 * ## 这个探针为什么存在
 * 主探针 `v0170-probe-cm6.mjs` 的判定项 3b（Shift-Tab）一直是 FAIL，
 * 但失败详情是 `active=mode-switch-btn` —— 焦点不在编辑器里，判据不成立。
 * 本探针用**纯键盘导航**（不依赖元素坐标）重测，并在过程中显式断言焦点位置，
 * 从而区分「产品缺陷」与「探针缺陷」。
 *
 * ## 判定项
 *  1. CM6 真实启用
 *  2. 文档正确装入（含目标标记）
 *  3. Tab 在行首插入缩进单位（Δ 长度 = +2）
 *  4. **Tab 后焦点仍在编辑器内** ← v0.15.6「焦点逃逸」的回归检查
 *  5. Shift-Tab 反缩进（Δ 长度 = -2，回到 Tab 之前）
 *
 * 用法：node scripts/v0170-probe-shifttab.mjs
 * 前置：npx tauri build --no-bundle（本脚本会校验 exe 内联 dist）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9471;
const OUT_JSON = "D:\\AI\\markdown view\\_verify-out\\v0170-probe-shifttab.json";
const OUT_TXT = "D:\\AI\\markdown view\\_verify-out\\v0170-probe-shifttab.txt";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/** 带结构块的文档：表格/代码块挂 NodeView，是反查 EditorView 的既有入口 */
const DOC = [
  "# SHIFTTAB 标题",
  "",
  "SHIFTTAB 目标行内容",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "尾部段落",
  "",
].join("\n");
const TARGET_LINE_INDEX = 2;   // 「SHIFTTAB 目标行内容」在文档中的 0 基行号

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      res({
        send(m, q) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: q }));
          return new Promise((a, b) => {
            pending.set(i, { a, b });
            setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 30000);
          });
        },
        close() { ws.close(); },
      }),
    );
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
}

async function main() {
  // ── exe 内联 dist 校验（设计稿 §4-30 铁律：防止测到旧二进制）──
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!hm) throw new Error("dist/index.html 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(hm[1]))) {
    throw new Error(`exe 内联 dist 不一致（找不到 ${hm[1]}）→ 请执行 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hm[1]}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-st-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "shifttab.md");
  fs.writeFileSync(docFile, DOC, "utf8");

  let child = null;
  let cdp = null;
  const results = [];
  const add = (id, name, status, detail) => {
    results.push({ id, name, status, detail });
    const tag = status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL ";
    log(`${tag} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 140 && !cdp; i++) {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })
        ).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (r.result?.result?.value) { cdp = c; break; }
          c.close();
        }
      } catch { /* WebView2 尚未就绪 */ }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 WebView2 CDP target（端口占用 / 单实例抢锁）");

    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      }
      return r.result?.result?.value;
    };

    // ── 打开文档：循环派发直到装入（单发不可靠）；判据用阅读面 .ProseMirror ──
    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: {
            path: ${JSON.stringify(docFile)},
            name: ${JSON.stringify(path.basename(docFile))},
            content: ${JSON.stringify(DOC)},
          },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return !!pm && (pm.textContent || "").indexOf("SHIFTTAB") >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入（25 次 openFile 均未生效）");
    log("[probe] 文档已装入");

    // ── 切编辑模式（稳定类名；aria-label 随模式翻转，不能按文字匹配）──
    const switched = await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (!b) return JSON.stringify({ error: "no mode-switch-btn" });
      const before = b.getAttribute("aria-label");
      b.click();
      await new Promise((r) => setTimeout(r, 1300));
      const after = document.querySelector(".mode-switch-btn")?.getAttribute("aria-label");
      return JSON.stringify({ before, after, changed: before !== after });
    `);
    log("[probe] 模式切换：" + switched);

    // ── 等内容渲染进 CM6 ──
    let loadedText = "";
    for (let i = 0; i < 25; i++) {
      loadedText = await ev(
        `return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join(String.fromCharCode(10));`,
      );
      if (loadedText && loadedText.indexOf("SHIFTTAB") >= 0) break;
      await sleep(500);
    }
    if (!loadedText || loadedText.indexOf("SHIFTTAB") < 0) {
      throw new Error(`文档未渲染进 CM6，后续断言无意义（读到 ${JSON.stringify((loadedText || "").slice(0, 60))}）`);
    }
    add("1", "CM6 启用且文档已装入", "PASS", `文本长度=${loadedText.length}`);

    const readText = () =>
      ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join(String.fromCharCode(10));`);
    const activeClass = () =>
      ev(`return (document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || "";`);

    // ── 只在内容区中心点一次建立焦点（远离任何按钮）──
    const box = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    if (!box) throw new Error("找不到 .cm-content");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(300);

    /** 发送一个键（CDP modifiers: 8 = Shift） */
    const press = async (keyName, code, vk, modifiers = 0) => {
      const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(200);
    };

    // ── 纯键盘导航到目标行行首：Ctrl+Home → ↓×N → Home ──
    await press("Home", "Home", 36, 2);
    for (let i = 0; i < TARGET_LINE_INDEX; i++) await press("ArrowDown", "ArrowDown", 40);
    await press("Home", "Home", 36);
    await sleep(250);

    const beforeText = await readText();
    const focusBefore = await activeClass();
    log(`[probe] 落位：焦点=${focusBefore} 文本长度=${(beforeText || "").length}`);

    // ── 判定 2：Tab 插入缩进 ──
    await press("Tab", "Tab", 9);
    await sleep(450);
    const afterTabText = await readText();
    const indented = /(^|\n)( {2,}|\t)SHIFTTAB 目标行内容/.test(afterTabText || "");
    const deltaTab = (afterTabText || "").length - (beforeText || "").length;
    add(
      "2",
      "Tab 在行首插入缩进单位",
      indented ? "PASS" : "FAIL",
      `行首缩进=${indented}，长度 ${(beforeText || "").length}→${(afterTabText || "").length}（Δ${deltaTab}）`,
    );

    // ── 判定 3：Tab 后焦点仍在编辑器内（v0.15.6 焦点逃逸回归）──
    const focusAfterTab = await activeClass();
    const focusKept = String(focusAfterTab).indexOf("cm-") >= 0;
    add(
      "3",
      "Tab 后焦点仍在编辑器内（v0.15.6 焦点逃逸回归检查）",
      focusKept ? "PASS" : "FAIL",
      `焦点=${focusAfterTab || "(空)"}`,
    );

    // ── 判定 4：Shift-Tab 反缩进 ──
    // 若焦点已逃逸，先复位（否则测的是"焦点不在编辑器"而非反缩进逻辑本身）
    if (!focusKept) {
      await ev(`const c = document.querySelector(".cm-content"); if (c) c.focus(); return true;`);
      await sleep(300);
      log("[probe] （焦点已逃逸，已复位以单独验证 Shift-Tab 逻辑）");
    }
    await press("Tab", "Tab", 9, 8);
    await sleep(550);
    const afterShiftTabText = await readText();
    const outdented = !/(^|\n)( {2,}|\t)SHIFTTAB 目标行内容/.test(afterShiftTabText || "");
    const lenRestored = (afterShiftTabText || "").length === (beforeText || "").length;
    add(
      "4",
      "Shift-Tab 反缩进（行首缩进已移除）",
      outdented && lenRestored ? "PASS" : "FAIL",
      `缩进已移除=${outdented}，长度 ${(afterTabText || "").length}→${(afterShiftTabText || "").length}（应回到 ${(beforeText || "").length}）`,
    );

    log("");
    const fails = results.filter((r) => r.status === "FAIL");
    log(`[probe] PASS=${results.filter((r) => r.status === "PASS").length} FAIL=${fails.length}`);
  } catch (err) {
    log(`[probe] 异常：${err?.message || String(err)}`);
    results.push({ id: "E", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }

    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify({ generatedAt: new Date().toISOString(), doc: DOC, results }, null, 1),
      "utf8",
    );
    log(`[probe] 产物：${OUT_JSON}`);
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}

main();

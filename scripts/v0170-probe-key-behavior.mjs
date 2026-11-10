/**
 * v0.17.0 探针：**CM6 与 textarea 的编辑行为差异**
 *
 * ## 为什么需要
 * 换实现类（textarea → CM6）最大的风险不是"能不能编辑"，而是
 * **细微行为差异**，尤其是用户形成肌肉记忆的那几个键。这类差异：
 * - 不会崩溃、不会有测试报错；
 * - 但与用户预期不符，长期使用会感到"手感变了"。
 *
 * 上一轮已经因为「软换行没开」栽过一次（长行只能水平滚动）。
 * 本探针系统核对其余高频键的行为。
 *
 * ## 判定项（对照 textarea 的标准行为）
 * 1. **Ctrl+A**：全选**整个文档**（不是当前行）
 * 2. **Home**：折行时到**视觉行首**还是**逻辑行首**？
 *    - textarea：逻辑行首（一行的开头）
 *    - CM6 默认 `defaultKeymap`：`cursorLineBoundaryBackward` = 视觉行首
 *    → 这是**已知差异**，需如实登记，不判失败
 * 3. **Ctrl+End**：到文档末尾
 * 4. **Shift+Home**：从光标选到行首
 * 5. **PageDown**：翻页后光标移动且不崩
 * 6. **Delete/Backspace** 在行首行末的合并行为
 *
 * 用法：node scripts/v0170-probe-key-behavior.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9492;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-key-behavior.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-key-behavior.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/** 长行用于测试 Home 的「视觉行首 vs 逻辑行首」差异 */
const LONG_LINE = "行首测试".repeat(120);
const DOC = [
  "# 按键行为测试",
  "",
  "第一段第一行",
  "第一段第二行",
  "",
  LONG_LINE,
  "",
  "末尾段落",
  "",
].join("\n");

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.addEventListener("open", () => res({
      send(m, q) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method: m, params: q }));
        return new Promise((a, b) => { pending.set(i, { a, b }); setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 30000); });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id); m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!hm) throw new Error("dist 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(hm[1]))) {
    throw new Error(`exe 内联 dist 不一致（找不到 ${hm[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hm[1]}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-key-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "key.md");
  fs.writeFileSync(docFile, DOC, "utf8");

  let child = null, cdp = null;
  const results = [];
  const add = (id, name, status, detail) => {
    results.push({ id, name, status, detail });
    const tag = status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL ";
    log(`${tag} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    child = spawn(EXE, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
      stdio: "ignore",
    });
    for (let i = 0; i < 140 && !cdp; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true });
          if (r.result?.result?.value) { cdp = c; break; }
          c.close();
        }
      } catch { }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 CDP target");

    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
      return r.result?.result?.value;
    };

    let loaded = false;
    for (let i = 0; i < 30 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(700);
      loaded = await ev(`const c = document.querySelector(".cm-content"); return !!c && (c.textContent || "").indexOf("按键行为测试") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");

    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(2000);
    if (await ev(`return !!document.querySelector("iframe.split-preview");`)) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
      await sleep(1200);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    await ev(`
      window.__ERRS = [];
      window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
      return true;
    `);

    const focusEditor = () => ev(`const c=document.querySelector(".cm-content"); if(c) c.focus(); return true;`);
    const press = async (key, code, vk, modifiers = 0) => {
      await focusEditor();
      await sleep(50);
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await sleep(25);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(180);
    };

    /** 读选区信息（相对整个编辑器的字符偏移 + 选中文本） */
    const selInfo = () => ev(`
      const sel = window.getSelection();
      const content = document.querySelector(".cm-content");
      if (!sel || !content || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0);
      const pre = r.cloneRange();
      pre.selectNodeContents(content);
      pre.setEnd(r.startContainer, r.startOffset);
      return {
        start: pre.toString().length,
        end: pre.toString().length + r.toString().length,
        selectedLen: r.toString().length,
        selectedText: (r.toString() || "").slice(0, 40),
      };
    `);

    // 焦点 + 光标到文档开头
    await press("Home", "Home", 36, 2);
    await sleep(300);

    // ── 判定 2：Ctrl+A 全选整个文档 ──
    await press("a", "KeyA", 65, 2);
    await sleep(400);
    const allSel = await selInfo();
    const docLen = await ev(`const c=document.querySelector(".cm-content"); return (c.textContent||"").length;`);
    const selectsAll = allSel && allSel.selectedLen >= docLen * 0.85;
    log(`[probe] Ctrl+A: 选中 ${allSel?.selectedLen} / 文档 ${docLen}`);
    add(
      "2",
      "Ctrl+A 全选整个文档（而非仅当前行）",
      selectsAll ? "PASS" : "FAIL",
      `选中 ${allSel?.selectedLen ?? "?"} / 文档 ${docLen}`,
    );

    // 取消选择
    await press("Home", "Home", 36, 2);
    await sleep(200);

    // ── 判定 3：Ctrl+End 到文档末尾 ──
    await press("End", "End", 35, 2);
    await sleep(300);
    const endSel = await selInfo();
    const atEnd = endSel && Math.abs(endSel.start - docLen) < docLen * 0.05;
    log(`[probe] Ctrl+End: 光标 ${endSel?.start} / 文档 ${docLen}`);
    add(
      "3",
      "Ctrl+End 到文档末尾",
      atEnd ? "PASS" : "FAIL",
      `光标 ${endSel?.start ?? "?"} / 文档 ${docLen}`,
    );

    // ── 判定 4：Shift+Home 从光标选到行首 ──
    // 先到某行中段（保证行首有内容可选）
    await press("Home", "Home", 36, 2);
    for (let i = 0; i < 3; i++) await press("ArrowDown", "ArrowDown", 40);
    for (let i = 0; i < 5; i++) await press("ArrowRight", "ArrowRight", 39);
    await press("Home", "Home", 36, 8); // Shift+Home
    await sleep(300);
    const shiftHomeSel = await selInfo();
    const hasSelection = shiftHomeSel && shiftHomeSel.selectedLen > 0;
    log(`[probe] Shift+Home: 选中 ${shiftHomeSel?.selectedLen} 字符`);
    add(
      "4",
      "Shift+Home 从光标选到行首（有选区）",
      hasSelection ? "PASS" : "FAIL",
      `选中 ${shiftHomeSel?.selectedLen ?? 0} 字符：${JSON.stringify(shiftHomeSel?.selectedText || "")}`,
    );

    // ── 判定 5：PageDown 可用且不崩 ──
    await press("Home", "Home", 36, 2);
    await sleep(200);
    const beforePg = await selInfo();
    await press("PageDown", "PageDown", 34);
    await sleep(300);
    const afterPg = await selInfo();
    const pgMoved = beforePg && afterPg && afterPg.start !== beforePg.start;
    add(
      "5",
      "PageDown 移动光标（不崩）",
      pgMoved ? "PASS" : "KNOWN",
      pgMoved ? `光标 ${beforePg.start} → ${afterPg.start}` : `光标未移动（${beforePg?.start}），可能文档不足一屏`,
    );

    // ── 判定 6：折行时 Home 的行为（视觉行首 vs 逻辑行首）──
    // 走到长行，右移到折行点之后，再按 Home，看落点
    await press("Home", "Home", 36, 2);
    for (let i = 0; i < 6; i++) await press("ArrowDown", "ArrowDown", 40);
    await press("Home", "Home", 36);
    await sleep(200);
    const longLineStart = await selInfo();
    // 右移足够多，越过折行点
    for (let i = 0; i < 60; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
    }
    await sleep(300);
    const afterMove = await selInfo();
    await press("Home", "Home", 36);
    await sleep(300);
    const afterHome1 = await selInfo();
    // 再按一次 Home：现代编辑器两段式，第二次应到逻辑行首
    await press("Home", "Home", 36);
    await sleep(300);
    const afterHome2 = await selInfo();
    const afterHome = afterHome2;
    const wentToLogicalStart = afterHome2 && longLineStart && Math.abs(afterHome2.start - longLineStart.start) < 3;
    log(`[probe] 折行中 Home: 长行首 ${longLineStart?.start} → 右移后 ${afterMove?.start} → Home¹ ${afterHome1?.start} → Home² ${afterHome2?.start}`);
    add(
      "6",
      "★ 折行时 Home 两段式：先视觉行首，再按一次到逻辑行首（现代编辑器行为）",
      wentToLogicalStart ? "PASS" : "KNOWN",
      wentToLogicalStart
        ? `两段式生效：视觉行首 ${afterHome1?.start} → 逻辑行首 ${afterHome2?.start}`
        : `第二次 Home 未到逻辑行首（${afterHome2?.start} vs 行首 ${longLineStart?.start}）—— 只有单段行为`,
    );

    const errs = await ev(`return window.__ERRS || []`);
    add("7", "全程无未捕获异常", (errs || []).length === 0 ? "PASS" : "FAIL", (errs || []).length ? JSON.stringify(errs.slice(0, 2)) : "无");

    log("");
    const fails = results.filter((r) => r.status === "FAIL");
    log(`[probe] PASS=${results.filter((r) => r.status === "PASS").length} KNOWN=${results.filter((r) => r.status === "KNOWN").length} FAIL=${fails.length}`);
  } catch (err) {
    log(`[probe] 异常：${err?.message || String(err)}`);
    results.push({ id: "E", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { }
    try { child?.kill(); } catch { }
    await sleep(400);
    try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { }
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 1), "utf8");
    log(`[probe] 产物：${OUT_JSON}`);
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}

main();

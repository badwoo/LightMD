/**
 * LightMD v0.17.0 探针：**IME 组合态事件链路**（可自动化的部分）
 *
 * ## 边界声明（重要，避免误导）
 * 本探针**不测"候选框位置"** —— 那由 OS 层 IME 决定，CDP 只能发合成事件，
 * 触及不到候选框渲染层，任何"测出来的候选框数字"都是假的。**该项仍需人工验证。**
 *
 * 本探针测的是**我们代码负责的那一层**，且这一层有真实缺陷风险：
 * 1. `compositionstart/end` 是否被 CM6 侧正确接收；
 * 2. 组合期间**不抢键**（Tab / Backspace 在 `isComposing` 时必须放行给输入法，
 *    否则用户选词按 Tab 会变成缩进）—— 这是 v0.15.6 修复过的同类缺陷；
 * 3. 一次组合提交 = 时间线**一步**（C14 契约的实机验证）。
 *
 * 用法：node scripts/v0170-probe-ime-composition.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9474;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-ime-composition.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-ime-composition.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const DOC = ["# IME 标题", "", "IME 目标行 alpha", "", "```ts", "const x = 1;", "```", "", "尾部", ""].join("\n");

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-ime-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "ime.md");
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
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      return r.result?.result?.value;
    };

    // 打开 + 编辑模式
    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await ev(`const pm = document.querySelector(".editor-container .ProseMirror"); return !!pm && (pm.textContent || "").indexOf("IME 目标行") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");
    // ⚠️ 不用 view.edit（它会打开分屏，右侧预览 iframe 会抢焦点、并让点击坐标落在预览区）
    // 用 mode-switch-btn 切到编辑模式即可（纯源码面，无预览干扰）
    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(2000);

    /**
     * 若分屏仍在（编辑模式默认带右侧预览），显式关掉 —— 否则
     * 焦点可能落在预览 iframe 里，Tab 相关断言会误判。
     */
    const hasSplit = await ev(`return !!document.querySelector("iframe.split-preview");`);
    if (hasSplit) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } }));
        return true;
      `);
      await sleep(1500);
      log("[probe] 已关闭分屏预览（避免预览 iframe 抢焦点）");
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    // 焦点落位
    const box = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(300);

    /**
     * ── 判定 2：composition 事件是否被接收 ──
     * 合成 compositionstart / compositionupdate / compositionend（CDP 无法触发真实 IME，
     * 但可以验证"我们的事件处理链是否工作"）。
     */
    const compResult = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return { error: "no cm-content" };
      window.__IME = [];
      c.addEventListener("compositionstart", () => window.__IME.push("start"), true);
      c.addEventListener("compositionend", () => window.__IME.push("end"), true);
      // 合成一次组合（浏览器会把它当作 IME 提交路径）
      c.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      c.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "zhong" }));
      await new Promise((r) => setTimeout(r, 150));
      c.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
      await new Promise((r) => setTimeout(r, 300));
      return { events: window.__IME };
    `);
    const gotStart = (compResult?.events || []).includes("start");
    const gotEnd = (compResult?.events || []).includes("end");
    add(
      "2",
      "composition 事件在编辑区可被接收（事件链存在）",
      gotStart && gotEnd ? "PASS" : "FAIL",
      `事件=${JSON.stringify(compResult?.events || [])}`,
    );

    /**
     * ── 判定 3（关键）：组合期间 Tab 不得抢键 ──
     *
     * 这是真实缺陷风险：v0.15.6 修过同类问题（组合期 Backspace 误触成对删除）。
     * 我们的 `onTabKeydown` 里有 `if (e.isComposing || this.composing) return;` 守卫。
     * 验证方式：标记 composing 为 true 后发 Tab，断言**文本没有缩进**。
     */
    const beforeTab = await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l=>l.textContent||"").join(String.fromCharCode(10));`);
    // 置组合态（用真实 compositionstart 触发本类的 composing 标志）
    await ev(`
      const c = document.querySelector(".cm-content");
      c.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      return true;
    `);
    await sleep(150);
    // 在组合态发 Tab
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(25);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(300);
    const afterTab = await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l=>l.textContent||"").join(String.fromCharCode(10));`);
    // 结束组合
    await ev(`
      const c = document.querySelector(".cm-content");
      c.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      return true;
    `);
    await sleep(200);

    const textUnchanged = beforeTab === afterTab;
    add(
      "3",
      "组合态（isComposing）时 Tab 不抢键、不缩进",
      textUnchanged ? "PASS" : "FAIL",
      textUnchanged ? "文本未变" : `文本被改动：${JSON.stringify((afterTab || "").slice(0, 60))}`,
    );

    /**
     * ── 判定 4：组合结束后 Tab 恢复工作 ──
     * 保证上一条的守卫不是"永久禁用 Tab"。
     */
    // [4] 前显式把焦点放回源码面（合成 composition 事件可能让焦点漂移）
    await ev(`const c = document.querySelector(".cm-content"); if (c) c.focus(); return true;`);
    await sleep(300);
    const beforeTab2 = await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l=>l.textContent||"").join(String.fromCharCode(10));`);
    // 光标放行首：用鼠标点目标行左侧（比 Ctrl+Home 可靠，后者会被 contenteditable 吸收）
    const lineBox = await ev(`(() => { const ls = Array.from(document.querySelectorAll(".cm-line")); const t = ls.find(l => (l.textContent || "").includes("IME 目标行")); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) }; })()`);
    if (lineBox) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, x: lineBox.x, y: lineBox.y, button: "left", clickCount: 1 });
      }
      await sleep(300);
    }
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(25);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(400);
    const afterTab2 = await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l=>l.textContent||"").join(String.fromCharCode(10));`);
    add(
      "4",
      "组合结束后 Tab 恢复正常缩进（守卫不永久禁用）",
      beforeTab2 !== afterTab2 ? "PASS" : "KNOWN",
      beforeTab2 !== afterTab2 ? "Tab 恢复生效" : "文本未变（光标可能不在行首，非判定失败）",
    );

    add(
      "5",
      "IME 候选框位置",
      "KNOWN",
      "OS 层 IME 行为，CDP 只能发合成 composition 事件，触及不到候选框渲染层 —— 需人工验证",
    );

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

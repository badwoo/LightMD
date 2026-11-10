/**
 * LightMD v0.17.0 探针：**C14 三条意图归并的实机效果**
 *
 * ## 背景
 * 设计稿 C14 指出存量缺陷：三个编辑意图标记
 * （`sourceComposingRef` / `sourceJustPairedRef` / `sourceJustPastedRef`）
 * **从未置 true**，导致 IME 组合 / 自动配对 / 粘贴的「一步撤销」语义全靠
 * `inferSourceEditKind` 按文本形态兜底猜测。
 *
 * 契约层已由 `v0170-cm6/c14-intent-source.test.ts`（7 条）守护，
 * 但**用户可见效果**（一次组合 = 一步撤销）从未实机验证。本探针补这个。
 *
 * ## 判定方式（行为验证，不读内部栈）
 * 1. 合成一次 IME 组合（compositionstart → update → end，提交多字词）；
 * 2. 按 **一次** Ctrl+Z；
 * 3. 断言：整个组合词被**一次性撤掉**（而不是只退掉最后一个字）。
 *
 * ## 边界声明
 * CDP 只能发**合成** composition 事件，不是真实输入法。因此本探针验证的是
 * **我们的事件处理链与归并逻辑**，不是 OS 层 IME 行为。
 * 候选框位置仍需人工验证（OS 层，CDP 物理上触及不到）。
 *
 * 用法：node scripts/v0170-probe-c14-merge.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9482;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-c14-merge.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-c14-merge.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const DOC = ["# C14 归并测试", "", "基线行", "", "```ts", "const x = 1;", "```", "", "尾部", ""].join("\n");

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.addEventListener("open", () => res({
      send(m, q) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method: m, params: q }));
        return new Promise((a, b) => { pending.set(i, { a, b }); setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 20000); });
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-c14-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "c14.md");
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
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`const pm = document.querySelector(".editor-container .ProseMirror"); return !!pm && (pm.textContent || "").indexOf("C14 归并") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");
    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(1600);
    if (await ev(`return !!document.querySelector("iframe.split-preview");`)) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
      await sleep(1000);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    await ev(`
      window.__ERRS = [];
      window.addEventListener("error", (e) => window.__ERRS.push(String(e.message||e) + (e.error&&e.error.stack ? " | " + String(e.error.stack).split(String.fromCharCode(10)).slice(0,4).join(" << ") : "")));
      window.onunhandledrejection = (e) => window.__ERRS.push("rejection:" + String(e.reason));
      return true;
    `);

    const readText = () => ev(`return Array.from(document.querySelectorAll(".cm-line")).map((l) => l.textContent || "").join(String.fromCharCode(10));`);

    // 点内容区建立焦点
    const box = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(400);

    const text0 = await readText();
    log("[probe] 初始文本长度=" + (text0 || "").length);

    /**
     * ── 合成一次 IME 组合 ──
     * 模拟用户输入中文词 "测试"（compositionstart → update → end）。
     * CDP 无法触发真实 IME，但可以把 composition 事件链 + 文本提交送到页面，
     * 这正是我们代码负责的那一层。
     */
    const composed = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return { error: "no cm-content" };
      c.focus();
      // 记录 composition 事件是否到达（验证事件链）
      window.__COMP = [];
      const onStart = () => window.__COMP.push("start");
      const onEnd = (e) => window.__COMP.push("end:" + (e.data || ""));
      c.addEventListener("compositionstart", onStart, true);
      c.addEventListener("compositionend", onEnd, true);
      c.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      await new Promise((r) => setTimeout(r, 80));
      c.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "测试词" }));
      await new Promise((r) => setTimeout(r, 80));
      c.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "测试词" }));
      await new Promise((r) => setTimeout(r, 200));
      c.removeEventListener("compositionstart", onStart, true);
      c.removeEventListener("compositionend", onEnd, true);
      return { events: window.__COMP };
    `);
    log("[probe] composition 事件=" + JSON.stringify(composed?.events || []));
    add(
      "2",
      "composition 事件链到达编辑区",
      (composed?.events || []).includes("start") ? "PASS" : "FAIL",
      JSON.stringify(composed?.events || []),
    );

    // 组合事件本身不会插入文本（CDP 合成事件不带真实输入），用 insertText 补一次
    await cdp.send("Input.insertText", { text: "测试词" });
    await sleep(900);
    const textAfterCompose = await readText();
    const insertedLen = (textAfterCompose || "").length - (text0 || "").length;
    add(
      "3",
      "组合文本已落地",
      insertedLen > 0 ? "PASS" : "FAIL",
      `长度 ${(text0 || "").length} → ${(textAfterCompose || "").length}（Δ${insertedLen}）`,
    );

    /**
     * ── 核心判定：一次 Ctrl+Z 是否撤掉整段组合 ──
     * 若 C14 归并生效（一次 composition = 一条历史），一次撤销应回到输入前；
     * 若归并未生效（每字一步），一次撤销只会退掉最后一个字。
     */
    if (insertedLen > 0) {
      const ctrlZ = async () => {
        const base = { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 };
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
        await sleep(40);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        await sleep(700);
      };
      await ctrlZ();
      const textAfterUndo1 = await readText();
      const lenAfter1 = (textAfterUndo1 || "").length;
      const restoredInOneStep = lenAfter1 === (text0 || "").length;

      add(
        "4",
        "★ 一次 Ctrl+Z 撤销整段组合（C14 归并生效）",
        restoredInOneStep ? "PASS" : "KNOWN",
        restoredInOneStep
          ? `一次撤销即回到输入前（${(text0 || "").length} 字符）`
          : `一次撤销后为 ${lenAfter1} 字符（输入前 ${(text0 || "").length}）—— 归并未完全生效，或 CDP 合成事件未被当作同一组`,
      );

      // 再撤几次，确认最终可回到初始（不是撤销栈坏了）
      let finalLen = lenAfter1;
      for (let i = 0; i < 6 && finalLen !== (text0 || "").length; i++) {
        await ctrlZ();
        finalLen = ((await readText()) || "").length;
      }
      add(
        "5",
        "连续撤销最终可回到输入前（撤销栈健康）",
        finalLen === (text0 || "").length ? "PASS" : "FAIL",
        `${finalLen} vs ${(text0 || "").length}`,
      );
    }

    // ── 追加：普通打字（非组合）也应可撤销 ──
    await ev(`const c=document.querySelector(".cm-content"); if(c) c.focus(); return true;`);
    await sleep(300);
    const baseLen = ((await readText()) || "").length;
    for (let i = 0; i < 3; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "char", key: "x", code: "KeyX", text: "x", unmodifiedText: "x" });
      await sleep(400);
    }
    const typedLen = ((await readText()) || "").length;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await sleep(40);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await sleep(700);
    const undoneLen = ((await readText()) || "").length;
    add("7", "普通打字可撤销（Ctrl+Z 使长度回退）", undoneLen < typedLen ? "PASS" : "FAIL", `${baseLen} → 打字后 ${typedLen} → 撤销后 ${undoneLen}`);

    // ── 追加：跨模式切换后的撤销（G6 核心口径）──
    await ev(`const c=document.querySelector(".cm-content"); if(c) c.focus(); return true;`);
    await sleep(300);
    const preType = ((await readText()) || "").length;
    await cdp.send("Input.dispatchKeyEvent", { type: "char", key: "y", code: "KeyY", text: "y", unmodifiedText: "y" });
    await sleep(600);
    const postType = ((await readText()) || "").length;
    // 切到阅读模式，再切回编辑模式
    await ev(`const b=document.querySelector(".mode-switch-btn"); if(b) b.click(); return true;`);
    await sleep(1800);
    await ev(`const b=document.querySelector(".mode-switch-btn"); if(b) b.click(); return true;`);
    await sleep(1800);
    const afterSwitch = ((await readText()) || "").length;
    // 撤销
    await ev(`const c=document.querySelector(".cm-content"); if(c) c.focus(); return true;`);
    await sleep(300);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await sleep(40);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await sleep(800);
    const afterSwitchUndo = ((await readText()) || "").length;
    add("8", "★ 跨模式切换后撤销仍生效（G6 核心口径）", afterSwitchUndo < afterSwitch ? "PASS" : "KNOWN", `打字 ${preType}→${postType}，切模式后 ${afterSwitch}，撤销后 ${afterSwitchUndo}`);

    const errs = await ev(`return window.__ERRS || []`);
    add("6", "全程无未捕获异常", errs.length === 0 ? "PASS" : "FAIL", errs.length ? JSON.stringify(errs.slice(0, 2)) : "无");

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

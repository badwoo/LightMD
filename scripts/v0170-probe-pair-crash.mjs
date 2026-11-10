/**
 * LightMD v0.17.0 探针：**配对交互路径是否会崩溃**（Backspace 成对删除 / Tab 跳出配对）
 *
 * ## 背景
 * `SourcePane` 的 Backspace / Tab-跳出配对分支仍用
 * `sourceTextareaRef.current` + `buildSourcePairInput(ta, ta.selectionStart, ...)`。
 * A3 之后该 ref 在 CM6 下是**中性 div**（非 null），而 `buildSourcePairInput` 内部读
 * `ta.value` → 传给 `isInCodeBlock` → `undefined.substring` **抛异常**。
 *
 * 注释里写的是"CM6 路径下 ref 为 null"——**这个前提是错的**，所以 `if (ta)` 守卫无效。
 *
 * 本探针的职责：确认这两条真实按键路径**不崩溃**。
 *
 * 用法：node scripts/v0170-probe-pair-crash.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9478;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-pair-crash.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-pair-crash.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const DOC = ["# 配对测试", "", "配对目标行 alpha", "", "```ts", "const x = 1;", "```", "", "尾部", ""].join("\n");

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-pair-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "pair.md");
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

    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await ev(`const pm = document.querySelector(".editor-container .ProseMirror"); return !!pm && (pm.textContent || "").indexOf("配对目标行") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");
    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(1800);
    if (await ev(`return !!document.querySelector("iframe.split-preview");`)) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
      await sleep(1200);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    // 装错误收集器
    await ev(`
      window.__ERRS = [];
      window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
      window.onunhandledrejection = (e) => window.__ERRS.push("rejection:" + String(e.reason));
      return true;
    `);

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
    await ev(`const c=document.querySelector(".cm-content"); if(c) c.focus(); return true;`);
    await sleep(300);

    const press = async (key, code, vk, modifiers = 0) => {
    await ev(`const c=document.querySelector(".cm-content"); if(c) c.focus(); return true;`);
    await sleep(60);
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await sleep(30);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(250);
    };

    const stateOf = () => ev(`
      return {
        cmEditor: !!document.querySelector(".cm-editor"),
        cmLines: document.querySelectorAll(".cm-line").length,
        errorBoundary: (document.body.textContent || "").indexOf("界面渲染出错") >= 0,
        errs: (window.__ERRS || []).slice(0, 3),
      };
    `);

    const before = await stateOf();
    log("[probe] 起始状态：" + JSON.stringify(before));

    // ── 判定 2：Backspace（成对删除路径）──
    // 先输一个左括号触发自动配对（生成 () 且光标居中），再退格测试成对删除
    await cdp.send("Input.dispatchKeyEvent", { type: "char", key: "(", code: "Digit9", text: "(", unmodifiedText: "(" });
    await sleep(400);
    await press("Backspace", "Backspace", 8);
    const afterBs = await stateOf();
    add(
      "2",
      "★ Backspace（成对删除路径）不崩溃",
      afterBs.errs.length === 0 && afterBs.cmEditor && !afterBs.errorBoundary ? "PASS" : "FAIL",
      afterBs.errs.length ? `异常：${JSON.stringify(afterBs.errs)}` : `编辑器存活=${afterBs.cmEditor}`,
    );

    // ── 判定 3：Tab 跳出配对路径（同时验证缩进仍正常）──
    await press("Home", "Home", 36, 2);
    await press("Tab", "Tab", 9);
    const afterTab = await stateOf();
    add(
      "3",
      "★ Tab（配对跳出/缩进路径）不崩溃",
      afterTab.errs.length === 0 && afterTab.cmEditor && !afterTab.errorBoundary ? "PASS" : "FAIL",
      afterTab.errs.length ? `异常：${JSON.stringify(afterTab.errs)}` : `编辑器存活=${afterTab.cmEditor}`,
    );

    // ── 判定 4：连续混合按键（更接近真实使用）──
    for (const [k, c, v] of [["a", "KeyA", 65], ["Backspace", "Backspace", 8], ["Tab", "Tab", 9], ["Escape", "Escape", 27]]) {
      const base = { key: k, code: c, windowsVirtualKeyCode: v, nativeVirtualKeyCode: v };
      if (k === "a") {
        await cdp.send("Input.dispatchKeyEvent", { type: "char", key: k, code: c, text: k, unmodifiedText: k });
        await sleep(120);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      } else {
        await press(k, c, v);
      }
      await sleep(120);
    }
    const afterMix = await stateOf();
    add(
      "4",
      "★ 连续混合按键（输入/退格/Tab/Esc）不崩溃",
      afterMix.errs.length === 0 && afterMix.cmEditor && !afterMix.errorBoundary ? "PASS" : "FAIL",
      afterMix.errs.length ? `异常：${JSON.stringify(afterMix.errs)}` : `编辑器存活=${afterMix.cmEditor}`,
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

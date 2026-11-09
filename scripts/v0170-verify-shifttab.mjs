/**
 * v0.17.0 验证：Shift-Tab 反缩进是否真的走 `handleTab(true)`
 *
 * ## 为什么单独写这个
 * Lead 的探针在 3b（Shift-Tab）FAIL，但失败详情是 `active=mode-switch-btn`
 * —— 焦点跑到模式切换按钮上了，不在 CM6 编辑区。原因是它用
 * `getBoundingClientRect` 算点击坐标，而 Tab 插入缩进后行宽变化、坐标失效。
 *
 * ## 本探针的规避手法（不靠坐标点击）
 * 1. **程序化聚焦** `.cm-content`（`el.focus()`），不点鼠标；
 * 2. 光标用 CM6 自己的 API 之外的方式无法可靠设置，因此：
 *    先发 Ctrl+A 全选→再折叠？—— 过重。改为：用 `document.execCommand("selectAll")`
 *    也不可靠。**最终采用：聚焦后按 Home 到行首，再 Shift-Tab**；
 * 3. **同时用日志判定** `handleTab(outdent=true)` 是否被调用
 *    —— 这条是"接线是否正确"的直接证据，不依赖任何坐标或视觉。
 *
 * 判定分两层：
 * - 日志层：`[TABDIAG] handleTab called, outdent=true` 是否出现（接线正确性）；
 * - 文本层：行首缩进单位是否减少（行为正确性）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9457;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const p = new Map();
    ws.addEventListener("open", () =>
      res({
        send(m, q) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: q }));
          return new Promise((a, b) => {
            p.set(i, { a, b });
            setTimeout(() => { if (p.delete(i)) b(new Error("timeout " + m)); }, 25000);
          });
        },
        close() { ws.close(); },
      }),
    );
    ws.addEventListener("message", (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.method === "Runtime.consoleAPICalled") {
        logs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
      const it = p.get(m.id);
      if (!it) return;
      p.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws")));
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmdt-"));
const profile = path.join(tmp, "profile");
fs.mkdirSync(profile, { recursive: true });
// 注意：第 2 行**已带 4 空格缩进**，这样 Shift-Tab 有东西可退
const DOC = "# H\n\n    INDENTED line\n";
const docFile = path.join(tmp, "t.md");
fs.writeFileSync(docFile, DOC, "utf8");

let child = null;
let cdp = null;
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
      const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
      for (const t of ts) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        const c = await connect(t.webSocketDebuggerUrl);
        await c.send("Runtime.enable");
        const r = await c.send("Runtime.evaluate", {
          expression: `typeof window.__TAURI_INTERNALS__!=="undefined"`,
          returnByValue: true,
        });
        if (r.result?.result?.value) { cdp = c; break; }
        c.close();
      }
    } catch { /* ignore */ }
    if (!cdp) await sleep(350);
  }
  if (!cdp) throw new Error("no target");

  const ev = async (e) => {
    const r = await cdp.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) };
    return r.result?.result?.value;
  };

  // 打开文件（与 Lead 探针同一通道）
  await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(docFile)},content:${JSON.stringify(DOC)}}}));true`);
  await sleep(2800);
  await ev(`const b=Array.from(document.querySelectorAll("button")).find(x=>/编辑|Edit/i.test((x.textContent||"")+(x.title||"")));if(b)b.click();true`);
  await sleep(2800);

  const text = () => ev(`Array.from(document.querySelectorAll(".cm-line")).map(l=>l.textContent).join("\\n")`);
  const state = () => ev(`(()=>({cmEditor:!!document.querySelector(".cm-editor"), ta:!!document.querySelector("textarea.source-editor"), active:(document.activeElement&&document.activeElement.className)||""}))()`);

  console.log("STATE:", JSON.stringify(await state()));
  console.log("TEXT BEFORE:", JSON.stringify(await text()));

  // ⭐ 程序化聚焦，不点坐标
  await ev(`(()=>{const c=document.querySelector(".cm-content");if(c){c.focus();return true}return false})()`);
  await sleep(400);
  console.log("FOCUSED:", JSON.stringify(await state()));

  // 把光标移到"已缩进那一行"的行首：先点行内文本（用 DOM 的 Range 定位，不用坐标）
  await ev(`
    (() => {
      const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").includes("INDENTED"));
      if (!line) return "no-line";
      const range = document.createRange();
      range.selectNodeContents(line);
      range.collapse(true);           // 折叠到行首
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const c = document.querySelector(".cm-content");
      if (c) c.focus();
      return "ok";
    })()
  `);
  await sleep(400);
  console.log("TEXT AT CURSOR:", JSON.stringify(await text()));

  // ── 发真实 Shift+Tab（modifiers=8 是 Shift）──
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 });
  await sleep(700);
  console.log("TEXT AFTER Shift-Tab:", JSON.stringify(await text()));

  // 再试一次普通 Tab（对照组：应增加缩进）
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0 });
  await sleep(700);
  console.log("TEXT AFTER Tab:", JSON.stringify(await text()));

  console.log("=== TABDIAG 日志 ===");
  const tabLogs = logs.filter((l) => /TABDIAG/.test(l));
  console.log(tabLogs.length ? tabLogs.join(" | ") : "(none — handleTab 从未被调用)");
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }
}

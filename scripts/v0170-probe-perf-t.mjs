/**
 * v0.17.0 诊断：**每键处理耗时（T）的精确测量**
 *
 * ## 要回答的问题
 * 「p95 < 16ms」的门禁口径是 `keydown → 第一个 rAF`，它 = T + 等帧相位。
 * 相位上界 16.67ms，故 **15.83ms + T < 16ms ⇒ T < 0.17ms** 才可能达标。
 *
 * 此前的 T ≈ 0.6–1.2ms 是**从 p50/p95 反推的间接估计**。
 * 本探针改用**源码内埋点直接测**：
 * - 埋点 1：`domEventHandlers.keydown` 入口记 `performance.now()`
 * - 埋点 2：`EditorView.updateListener` 收到 `docChanged` 时记差值
 *
 * 差值 = CM6 dispatch 完成时刻 - keydown 时刻，即**纯处理耗时**（不含等帧）。
 *
 * ## 为什么这个数很重要
 * - 若 T < 0.17ms → 门禁**理论上可达**，只是当前没优化到；
 * - 若 T 明显 > 0.17ms 且无压缩空间 → 门禁结构性不可达。
 *
 * 用法：node scripts/v0170-probe-perf-t.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9494;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-perf-t.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-perf-t.txt");
const DOC_KB = Number(process.env.DOC_KB || 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

function makeDoc(bytes) {
  const parts = ["# T 测量", ""];
  let i = 0;
  while (Buffer.byteLength(parts.join("\n"), "utf8") < bytes) {
    i++;
    switch (i % 4) {
      case 1: parts.push(`## 第 ${i} 节`, "", `第 ${i} 节正文内容。`, ""); break;
      case 2: parts.push(`- 要点 ${i}.1`, ""); break;
      case 3: parts.push("```ts", `const v${i} = ${i};`, "```", ""); break;
      default: parts.push(`> 引用 ${i}`, ""); break;
    }
  }
  return parts.join("\n");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.addEventListener("open", () => res({
      send(m, q) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method: m, params: q }));
        return new Promise((a, b) => { pending.set(i, { a, b }); setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 60000); });
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
  log(`[T] exe 内联 dist 校验通过：${hm[1]}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-t-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const DOC = makeDoc(DOC_KB * 1024);
  const docFile = path.join(tmp, "t.md");
  fs.writeFileSync(docFile, DOC, "utf8");
  log(`[T] 文档 ${(Buffer.byteLength(DOC, "utf8") / 1024).toFixed(0)}KB / ${DOC.split("\n").length} 行`);

  let child = null, cdp = null;
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
    for (let i = 0; i < 30 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(800);
      loaded = await ev(`const c = document.querySelector(".cm-content"); return !!c && (c.textContent || "").length > 200;`);
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
    log(`[T] impl = ${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    const box = await ev(`
      const c = document.querySelector(".cm-content");
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(500);

    // 重置埋点 + 装起点监听（document 捕获阶段，与 perf-bench 口径一致）
    await ev(`
      window.__pdCommitted = []; window.__pdT0 = undefined;
      if (!window.__pdHook) {
        window.__pdHook = true;
        document.addEventListener("keydown", function (ev) {
          if (!ev.isComposing) {
            window.__pdT0 = performance.now();
            window.__pdDisp = (window.__pdDisp||[]).concat([+(performance.now() - ev.timeStamp).toFixed(2)]);
          }
        }, true);
      }
      return true;
    `);

    const chars = "abcdefghijklmnopqrstuvwxyz";
    const t0 = Date.now();
    let sent = 0;
    await ev(`const c=document.querySelector(".cm-content"); if(c) c.focus(); return true;`);
    await sleep(300);
    while (Date.now() - t0 < 12000) {
      // 焦点守卫：CM6 重渲染可能丢焦（实测 activeEl 会变 BODY）
      await ev(`const c=document.querySelector(".cm-content"); if(c && document.activeElement!==c) c.focus(); return true;`);
      const ch = chars[sent % chars.length];
      const vk = ch.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        code: "Key" + ch.toUpperCase(), key: ch, text: ch, unmodifiedText: ch,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        code: "Key" + ch.toUpperCase(), key: ch,
      });
      sent++;
      const elapsed = Date.now() - t0;
      const wait = sent * 100 - elapsed;
      if (wait > 0) await sleep(wait);
    }
    await sleep(600);

    const committed = await ev(`return window.__pdCommitted || [];`);
    const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * p)] : null; };

    const result = {
      docKb: DOC_KB,
      keysSent: sent,
      committedSamples: committed.length,
      Tms: {
        p50: q(committed, 0.5),
        p90: q(committed, 0.9),
        p95: q(committed, 0.95),
        p99: q(committed, 0.99),
        max: committed.length ? Math.max(...committed) : null,
      },
      phaseModel: {
        frameMs: +(1000 / 60).toFixed(2),
        p95FloorIfT0: +((0.95 * 1000) / 60).toFixed(2),
        TRequiredForP95Under16: +(16 - (0.95 * 1000) / 60).toFixed(2),
      },
    };

    log("");
    log("=== 每键处理耗时 T（keydown → CM6 docChanged）===");
    log(`样本 ${committed.length} 个 / 按键 ${sent} 次`);
    log("[T] CDP派发开销(事件timeStamp→我们的监听)" + JSON.stringify(await ev(`const a=window.__pdDisp||[];const s=a.slice().sort((x,y)=>x-y);return {n:s.length,p50:s[Math.floor(s.length*0.5)],p95:s[Math.floor(s.length*0.95)]}`)));
    log(`p50=${result.Tms.p50}ms  p90=${result.Tms.p90}ms  p95=${result.Tms.p95}ms  p99=${result.Tms.p99}ms  max=${result.Tms.max}ms`);
    log("");
    log(`【判定】门禁要求 T < ${result.phaseModel.TRequiredForP95Under16}ms 才可能 p95<16`);
    log(`实测 T(p50)=${result.Tms.p50}ms → ${result.Tms.p50 !== null && result.Tms.p50 < result.phaseModel.TRequiredForP95Under16 ? "在阈值内（理论可达！）" : "超出阈值"}`);

    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 1), "utf8");
    log(`[T] 产物：${OUT_JSON}`);
  } finally {
    try { cdp?.close(); } catch { }
    try { child?.kill(); } catch { }
    await sleep(400);
    try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { }
  }
}

main();

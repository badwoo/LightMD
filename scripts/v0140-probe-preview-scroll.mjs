/**
 * 探针 v2：v0.14.0 需求2 —— 「阅读 ↔ 编辑」往返时，**右侧预览（iframe）**的进度是否保留。
 *
 * 背景：v0.14.0 把「分屏」并进了编辑模式，编辑模式默认显示右侧预览。
 * 用户看到的"文档"在右屏 iframe 里，左屏是源码。所以判断"阅读进度是否丢失"
 * 必须看 iframe 的 scrollTop，而不是左侧 textarea。
 *
 * 场景：
 *  P1. 阅读模式滚到 50% → 点标题栏「编辑」（= 打开预览）→ 右屏 iframe 是否在 50%
 *  P2. 编辑模式（预览开）右屏滚到 60% → 点「阅读」→ 阅读是否在 60%
 *  P3. 编辑模式右屏滚到 60% → 关闭预览 → 再打开预览：右屏是否保留 60%
 *  P4. 编辑模式左屏滚到 40% → 关预览 → 开预览：左屏是否保留 40%
 *
 * 用法：node scripts/v0140-probe-preview-scroll.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_PSCROLL_PORT || 9282);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-preview-scroll.txt";

const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      ws,
      send(method, params, timeoutMs = 30000) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
          pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
        });
      },
      close() { try { ws.close(); } catch {} },
    });
  });
}

const main = async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-pscroll-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const doc = path.join(tmpDir, "长文档.md");
  const parts = ["# 长文档标题", ""];
  for (let i = 1; i <= 200; i++) parts.push(`第 ${i} 段正文内容，用来把文档撑长以便验证滚动位置是否保留。`, "");
  fs.writeFileSync(doc, parts.join("\n"));

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdio: "ignore",
  });
  let cdp = null;
  for (let i = 0; i < 50 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true });
          if (r.result?.result?.value === true) { cdp = c; break; }
          c.close();
        } catch {}
      }
    } catch {}
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("no target");
  await cdp.send("Page.enable");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const rect = (sel) => ev(`const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
  const click = async (sel, wait = 600) => {
    const r = await rect(sel);
    if (!r) throw new Error(`no el ${sel}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(wait);
  };

  const st = () => ev(`
    const c = document.querySelector(".editor-container");
    const ta = document.querySelector("textarea.source-editor");
    const ifr = document.querySelector(".split-preview-shell iframe");
    const shell = document.querySelector(".split-preview-shell");
    const isTa = !!(ta && ta.offsetParent);
    const pct = (el) => { if (!el) return null; const m = el.scrollHeight - el.clientHeight; return m > 0 ? +(el.scrollTop / m).toFixed(3) : null; };
    let iframeDoc = null;
    try { iframeDoc = ifr && ifr.contentDocument; } catch {}
    const iScroller = iframeDoc ? (iframeDoc.scrollingElement || iframeDoc.documentElement) : null;
    return {
      mode: isTa ? "edit" : "preview",
      previewShown: shell ? Math.round(shell.getBoundingClientRect().width) > 0 : false,
      pmPercent: pct(c),
      taPercent: pct(ta),
      iframePercent: pct(iScroller),
      iframeMax: iScroller ? iScroller.scrollHeight - iScroller.clientHeight : -1,
    };
  `);

  const setPm = (f) => ev(`const el=document.querySelector(".editor-container"); const m=el.scrollHeight-el.clientHeight; el.scrollTop=Math.round(m*${f}); el.dispatchEvent(new Event("scroll")); return {top:el.scrollTop,max:m};`);
  const setTa = (f) => ev(`const el=document.querySelector("textarea.source-editor"); const m=el.scrollHeight-el.clientHeight; el.scrollTop=Math.round(m*${f}); el.dispatchEvent(new Event("scroll")); return {top:el.scrollTop,max:m};`);
  const setIframe = (f) => ev(`
    const ifr=document.querySelector(".split-preview-shell iframe");
    const d=ifr && ifr.contentDocument; if(!d) return null;
    const s=d.scrollingElement||d.documentElement; const m=s.scrollHeight-s.clientHeight;
    s.scrollTop=Math.round(m*${f}); s.dispatchEvent(new Event("scroll"));
    return {top:s.scrollTop,max:m};
  `);

  try {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(doc)}}})); return 1;`);
    await sleep(1800);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.preview"}})); return 1;`);
    await sleep(900);

    log("=== P1. 阅读 50% → 点「编辑」→ 右屏 iframe 是否在 50% ===");
    log(`阅读滚到 50%: ${JSON.stringify(await setPm(0.5))}`);
    await sleep(500);
    log(`阅读态: ${JSON.stringify(await st())}`);
    await click(".titlebar-mode-switch button:nth-child(2)", 1200);
    log(`点编辑后: ${JSON.stringify(await st())}`);
    const p1 = await st();
    const p1ok = p1.iframePercent !== null && Math.abs(p1.iframePercent - 0.5) < 0.08;
    log(`${p1ok ? "PASS" : "FAIL"}  P1: 右屏继承阅读进度（期望 0.5，实际 ${p1.iframePercent}）`);

    log("");
    log("=== P2. 编辑模式右屏滚到 60% → 点「阅读」→ 阅读是否在 60% ===");
    log(`右屏滚到 60%: ${JSON.stringify(await setIframe(0.6))}`);
    await sleep(600);
    log(`编辑态: ${JSON.stringify(await st())}`);
    await click(".titlebar-mode-switch button:nth-child(1)", 1200);
    log(`点阅读后: ${JSON.stringify(await st())}`);
    const p2 = await st();
    const p2ok = p2.pmPercent !== null && Math.abs(p2.pmPercent - 0.6) < 0.08;
    log(`${p2ok ? "PASS" : "FAIL"}  P2: 阅读继承右屏进度（期望 0.6，实际 ${p2.pmPercent}）`);

    log("");
    log("=== P3. 编辑模式右屏滚到 60% → 关闭预览 → 再打开：右屏是否保留 ===");
    await click(".titlebar-mode-switch button:nth-child(2)", 1200);
    log(`进编辑: ${JSON.stringify(await st())}`);
    log(`右屏滚到 60%: ${JSON.stringify(await setIframe(0.6))}`);
    await sleep(600);
    log(`关预览前: ${JSON.stringify(await st())}`);
    await click('[data-testid="split-preview-toggle"]', 1200);
    log(`关预览后: ${JSON.stringify(await st())}`);
    await click('[data-testid="split-preview-toggle"]', 1400);
    const p3 = await st();
    log(`重开预览后: ${JSON.stringify(p3)}`);
    const p3ok = p3.iframePercent !== null && Math.abs(p3.iframePercent - 0.6) < 0.1;
    log(`${p3ok ? "PASS" : "FAIL"}  P3: 关/开预览后右屏保留（期望 0.6，实际 ${p3.iframePercent}）`);

    log("");
    log("=== P4. 编辑模式左屏滚到 40% → 关预览 → 开预览：左屏是否保留 ===");
    log(`左屏滚到 40%: ${JSON.stringify(await setTa(0.4))}`);
    await sleep(600);
    log(`关预览前: ${JSON.stringify(await st())}`);
    await click('[data-testid="split-preview-toggle"]', 1200);
    await click('[data-testid="split-preview-toggle"]', 1400);
    const p4 = await st();
    log(`重开预览后: ${JSON.stringify(p4)}`);
    const p4ok = p4.taPercent !== null && Math.abs(p4.taPercent - 0.4) < 0.1;
    log(`${p4ok ? "PASS" : "FAIL"}  P4: 关/开预览后左屏保留（期望 0.4，实际 ${p4.taPercent}）`);
  } finally {
    try { cdp?.close(); } catch {}
    try { child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  console.log(`\n报告：${OUT}`);
};

main().catch((e) => { console.error("探针异常：", e); process.exit(1); });

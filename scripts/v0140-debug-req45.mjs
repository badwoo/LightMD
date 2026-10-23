/**
 * 调试探针：需求4/5 在实机里的真实状态
 * - 打印 panel 的 docKey / collectFiles 列表（key + 前 40 字）/ 当前文本
 * - 打印条幅条目
 * - 切标签后再打印一次
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.PORT_DBG || 9292);
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
      send(method, params, timeoutMs = 40000) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("timeout " + method)), timeoutMs);
          pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
        });
      },
    });
  });
}

const DOC_A = ["# 文档 A 标题", "", "cat 单独出现", "concat 包含", "", "第二段。", ""].join("\n");
const DOC_B = ["# 文档 B 标题", "", "这里有 cat 一次", "还有 cat 第二次", ""].join("\n");
const DOC_T = ["# 表格文档", "", "| 姓名 | 年龄 |", "| --- | --- |", "| 李四 | 40 |", ""].join("\n");

const main = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbg45-"));
  const profile = path.join(tmp, "p");
  fs.mkdirSync(profile, { recursive: true });
  const fA = path.join(tmp, "文档A.md"), fB = path.join(tmp, "文档B.md"), fT = path.join(tmp, "表格.md");
  fs.writeFileSync(fA, DOC_A); fs.writeFileSync(fB, DOC_B); fs.writeFileSync(fT, DOC_T);
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  const child = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile }, stdio: "ignore" });
  let cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__!=="undefined"`, returnByValue: true });
          if (r.result?.result?.value === true) { cdp = c; break; }
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
  const click = async (sel, w = 600) => { const r = await rect(sel); if (!r) throw new Error("no el " + sel); await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 }); await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 }); await sleep(w); };
  const cmd = async (id, w = 600) => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`); await sleep(w); };
  const openPath = async (p) => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`); await sleep(1600); };
  const activeTab = () => ev(`return (document.querySelector(".tab-item.tab-active .tab-name")?.textContent||"").trim();`);
  const switchTab = async (kw) => {
    const res = await ev(`
      const tabs=[...document.querySelectorAll(".tab-item")];
      const el=tabs.find((x)=>(x.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(kw)}));
      if(!el) return null; el.click();
      return (el.querySelector(".tab-name")?.textContent||"").trim();
    `);
    await sleep(1200);
    return await activeTab();
  };

  try {
    await openPath(fA); await openPath(fB); await openPath(fT);
    await switchTab("文档A");
    await cmd("view.edit", 800);
    await cmd("edit.find", 900);

    const dbg = () => ev(`
      const st = window.__lightmdDebugCollect;
      const panel = document.querySelector(".search-replace");
      const cnt = (document.querySelector('[data-testid="search-count"]')?.textContent||"").trim();
      const tabs = [...document.querySelectorAll(".tab-item")].map(t=>({
        name:(t.querySelector(".tab-name")?.textContent||"").trim(),
        active: t.classList.contains("tab-active"),
        dirty: !!t.querySelector(".tab-dirty"),
      }));
      return { count: cnt, panel: !!panel, tabs, hasHook: !!st, hookOut: st ? st() : null };
    `);

    // 在页面里挂一个能读到 store 的钩子（仅调试用，不修改产品代码）
    await ev(`
      // 通过 React fiber 拿不到 store，改为直接读 localStorage 快照 + 源码 textarea
      window.__lightmdDebugCollect = () => {
        const ta = document.querySelector("textarea.source-editor");
        return { taHead: (ta?.value||"").slice(0,60), taLen: (ta?.value||"").length };
      };
      return 1;
    `);

    console.log("初始:", JSON.stringify(await dbg()));

    // 输入 cat
    const si = await rect(".search-row .search-input");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: si.x, y: si.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: si.x, y: si.y, button: "left", clickCount: 1 });
    await sleep(300);
    // 清空已有内容
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await cdp.send("Input.insertText", { text: "cat" });
    await sleep(900);
    console.log("搜索 cat 后:", JSON.stringify(await dbg()));

    await click('[data-testid="search-find-in-open-files"]', 1200);
    const banner = await ev(`
      const box=document.querySelector('[data-testid="search-results"]');
      if(!box) return null;
      return {
        summary:(box.querySelector('[data-testid="search-results-summary"]')?.textContent||"").trim(),
        items:[...box.querySelectorAll('[data-testid="search-result-item"]')].map(i=>({
          file:(i.querySelector('[data-testid="search-result-file"]')?.textContent||"").trim(),
          line:(i.querySelector('[data-testid="search-result-line"]')?.textContent||"").trim(),
        })),
      };
    `);
    console.log("条幅:", JSON.stringify(banner, null, 1));

    // 切到 表格 文档，看搜索是否跟随
    const t2 = await switchTab("表格");
    console.log("切到:", t2, JSON.stringify(await dbg()));

    // 搜「李四」
    const si2 = await rect(".search-row .search-input");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: si2.x, y: si2.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: si2.x, y: si2.y, button: "left", clickCount: 1 });
    await sleep(200);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await cdp.send("Input.insertText", { text: "李四" });
    await sleep(1200);
    console.log("表格里搜李四:", JSON.stringify(await dbg()));

    // 再切回 A 再切到表格（模拟"面板不动、只切标签"）
    await switchTab("文档A");
    await sleep(600);
    await switchTab("表格");
    await sleep(1200);
    console.log("切回表格后:", JSON.stringify(await dbg()));
  } finally {
    try { cdp?.close(); } catch {}
    try { child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  }
};
main().catch((e) => { console.error(e); process.exit(1); });

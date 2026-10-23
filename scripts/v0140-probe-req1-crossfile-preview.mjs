/**
 * 定位探针：v0.14.0 第三批 需求1「阅读模式下搜索和替换，文本没有立即生效」。
 *
 * 已排除的可能（都已实测 PASS，见 v0140-probe-req1-effective.txt / -cases.txt）：
 * - 阅读模式「替换 / 全部替换」（面板自己的 PM 分支）在 DOM、底层内容、切回编辑后的源码三层都生效；
 * - .txt / 代码块 / 列表 / 引用 / 表格 / 长文档 都正常。
 *
 * 本探针验证**最可能的那条路径**：
 *   条幅展开（「查找所有打开文件」）后再点「全部替换（所有文件）」——
 *   这条路径的当前文档分支走的是 `onSourceContentChange`（源码态写回通道），
 *   在**阅读模式**下它只更新 `sourceContent`（隐藏的 textarea 状态），
 *   而**不会** dispatch 到 ProseMirror → 用户眼前的阅读视图一个字都不变。
 *
 * 场景：
 *  T1. 阅读模式 → 条幅展开 → 全部替换（所有文件）→ 看当前文档 PM 是否变
 *  T2. 阅读模式 → 条幅展开 → 全部替换 → 切编辑模式 → 看源码是否变了（若变 = 只写到了源码态）
 *  T3. 对照：阅读模式 → 条幅**收起** → 全部替换（面板自己的 PM 分支）→ PM 是否变
 *
 * 用法：node scripts/v0140-probe-req1-crossfile-preview.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_R1X_PORT || 9299);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-req1-crossfile-preview.txt";

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
      send(method, params, timeoutMs = 90000) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("timeout " + method)), timeoutMs);
          pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
        });
      },
      close() { try { ws.close(); } catch {} },
    });
  });
}

const DOC_A = ["# 文档 A", "", "cat 在 A 里出现", "", "第二段 cat", ""].join("\n");
const DOC_B = ["# 文档 B", "", "cat 在 B 里出现", ""].join("\n");

const main = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r1x-probe-"));
  const profile = path.join(tmp, "p");
  fs.mkdirSync(profile, { recursive: true });
  const fA = path.join(tmp, "文档A.md");
  const fB = path.join(tmp, "文档B.md");
  const write = () => { fs.writeFileSync(fA, DOC_A); fs.writeFileSync(fB, DOC_B); };
  write();

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdio: "ignore",
  });
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
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true }, 90000);
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  const rect = (sel) => ev(`const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
  const clickSel = async (sel, w = 600) => {
    const r = await rect(sel);
    if (!r) throw new Error("no el " + sel);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await sleep(w);
  };
  const clickXY = async (x, y, w = 400) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(w);
  };
  const setInput = async (sel, text) => {
    const r = await rect(sel);
    if (!r) throw new Error("no input " + sel);
    await clickXY(r.x, r.y, 200);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await sleep(120);
    await cdp.send("Input.insertText", { text });
    await sleep(700);
  };
  const cmd = async (id, w = 700) => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`); await sleep(w); };
  const waitPanel = async () => {
    for (let i = 0; i < 20; i++) {
      if (await ev(`return !!document.querySelector(".search-row .search-input");`)) return true;
      await sleep(250);
    }
    return false;
  };
  const ensureReplaceRow = async () => {
    if (await ev(`return !!document.querySelector(".replace-row .search-input");`)) return true;
    await clickSel(".search-toggle-btn", 500);
    for (let i = 0; i < 20; i++) {
      if (await ev(`return !!document.querySelector(".replace-row .search-input");`)) return true;
      await sleep(250);
    }
    return false;
  };
  const closeSearch = async () => { await ev(`const b=document.querySelector('.search-close-btn'); if(b) b.click(); return 1;`); await sleep(600); };
  const switchTab = async (kw) => {
    await ev(`
      const tabs=[...document.querySelectorAll(".tab-item")];
      const el=tabs.find((x)=>(x.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(kw)}));
      if(el) el.click(); return 1;
    `);
    await sleep(1300);
  };
  const openPath = async (p) => {
    for (let i = 0; i < 4; i++) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
      await sleep(1600);
      const base = p.split(/[\\/]/).pop();
      const has = await ev(`return [...document.querySelectorAll(".tab-item .tab-name")].some(n=>(n.textContent||"").includes(${JSON.stringify(base)}));`);
      if (has) return true;
    }
    return false;
  };

  /** PM 可见文字 / 隐藏 textarea / localStorage 三层的 cat-dog 计数（只读 TreeWalker，跳过重复渲染层） */
  const counts = () => ev(`
    const DUP = [".code-block-highlight",".code-block-line-numbers",".mermaid-rendered",".math-rendered",".katex",".prism-highlighted"];
    const pm = document.querySelector(".ProseMirror");
    const pt = document.querySelector(".plaintext-preview");
    const ta = document.querySelector("textarea.source-editor");
    const collect = (root) => {
      if (!root || root.offsetParent === null) return "";
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let out = "", n;
      while ((n = w.nextNode())) {
        let skip = false, p = n.parentElement;
        while (p && p !== root) { if (DUP.some(s => p.matches && p.matches(s))) { skip = true; break; } p = p.parentElement; }
        if (!skip) out += n.nodeValue || "";
      }
      return out;
    };
    const vis = collect(pm) + "\\u0000" + collect(pt);
    const hidden = ta?.value || "";
    const ls = localStorage.getItem("lightmd-content") || "";
    const c = (s, w) => (s.match(new RegExp(w, "g")) || []).length;
    return {
      visible: { cat: c(vis,"cat"), dog: c(vis,"DOG") },
      textarea: { cat: c(hidden,"cat"), dog: c(hidden,"DOG") },
      storage:  { cat: c(ls,"cat"), dog: c(ls,"DOG") },
    };
  `);

  try {
    await openPath(fA);
    await openPath(fB);

    // ═══ T1：阅读模式 → 条幅展开 → 全部替换（所有文件） ═══
    log("=== T1 阅读模式 + 条幅展开 → 「全部替换（所有文件）」 ===");
    await switchTab("文档A");
    await cmd("view.preview", 1000);
    await cmd("edit.replace", 800);
    if (!(await waitPanel())) throw new Error("面板未挂载");
    await setInput(".search-row .search-input", "cat");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "DOG");
    await clickSel('[data-testid="search-find-in-open-files"]', 1300);
    const banner = await ev(`
      const b=document.querySelector('[data-testid="search-results"]');
      return b ? (b.querySelector('[data-testid="search-results-summary"]')?.textContent||"").trim() : null;
    `);
    log(`条幅汇总: ${banner}`);
    const before = await counts();
    log(`替换前三层: ${JSON.stringify(before)}`);
    const rall = await ev(`
      const b=document.querySelector('[data-testid="search-replace-all"]');
      if(!b) return null; const r=b.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled};
    `);
    log(`按钮: ${JSON.stringify(rall)}`);
    await clickXY(rall.x, rall.y, 2000);
    const after = await counts();
    log(`替换后三层: ${JSON.stringify(after)}`);
    log(`${after.visible.dog >= before.visible.cat && after.visible.cat === 0 ? "PASS" : "FAIL"}  T1-a: **阅读视图**里的文字立即生效`);
    log(`${after.storage.dog >= before.storage.cat && after.storage.cat === 0 ? "PASS" : "FAIL"}  T1-b: 底层内容生效`);
    log(`${after.textarea.dog >= before.textarea.cat && after.textarea.cat === 0 ? "PASS" : "FAIL"}  T1-c: 隐藏 textarea 同步（源码态）`);

    // ═══ T2：切到编辑模式看源码 ═══
    log("");
    log("=== T2 切到编辑模式看源码 ===");
    await closeSearch();
    await cmd("view.edit", 1300);
    const edit = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      const v = ta?.value || "";
      const c=(s,w)=>(s.match(new RegExp(w,"g"))||[]).length;
      return { cat: c(v,"cat"), dog: c(v,"DOG"), sample: v.split("\\n").filter(Boolean).slice(0,4) };
    `);
    log(`编辑模式源码: ${JSON.stringify(edit)}`);
    log(`${edit.dog >= 2 && edit.cat === 0 ? "PASS" : "FAIL"}  T2: 切编辑模式后源码是 DOG（说明替换确实落到了内容层）`);

    // ═══ T3：对照 —— 条幅收起时的「全部替换」 ═══
    log("");
    log("=== T3 对照：条幅收起 → 「全部替换」（面板自己的 PM 分支） ===");
    write(); // 恢复文件
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(fA)}}})); return 1;`);
    await sleep(1600);
    await switchTab("文档A");
    await cmd("view.preview", 1000);
    await cmd("edit.replace", 800);
    await waitPanel();
    // 确保条幅是收起的（若上次展开过，再点一次收起）
    const bannerOpen = await ev(`return !!document.querySelector('[data-testid="search-results"]');`);
    if (bannerOpen) await clickSel('[data-testid="search-find-in-open-files"]', 900);
    await setInput(".search-row .search-input", "cat");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "DOG");
    const b3 = await counts();
    const btns = await ev(`
      const l=[...document.querySelectorAll(".replace-row .replace-btn")];
      return l.map(b=>{const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim()};});
    `);
    log(`按钮: ${JSON.stringify(btns)}`);
    await clickXY(btns[btns.length-1].x, btns[btns.length-1].y, 1800);
    const a3 = await counts();
    log(`替换前三层: ${JSON.stringify(b3)}`);
    log(`替换后三层: ${JSON.stringify(a3)}`);
    log(`${a3.visible.dog >= b3.visible.cat && a3.visible.cat === 0 ? "PASS" : "FAIL"}  T3: 条幅收起时阅读视图也立即生效（对照组）`);
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

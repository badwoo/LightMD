/**
 * 聚焦探针：v0.14.0 第三批 需求2 —— **跨文件替换后，切到那个文件也能撤销/恢复**。
 *
 * 用户原话：「……而且跨文件搜索和替换，切换到对应文件后也能使用撤销或恢复。」
 *
 * 为什么单独写一个探针（不复用 v0140-probe-search-replace.mjs 的 P5）：
 * 长链路里前面的用例会把文档内容改掉/撤销掉，导致"跨文件替换"那一步的命中数被污染
 * （实测最后一步按钮变成 disabled，是探针状态问题而非产品缺陷）。
 * 这里每个场景都用**全新临时目录 + 全新文件内容**，互不干扰。
 *
 * 场景（两轮，各自独立重启）：
 *  R1. 阅读模式：A 里搜 cat，条幅列出 A+B → 「全部替换（所有文件）」
 *      → 切到 B（B 从未被激活过）→ 撤销 → B 内容应回到 cat
 *  R2. 源码模式：同样的链路，验证切过去后 Ctrl+Z（源码栈 + 跨文件记录）也生效
 *  R3. 撤销后再「恢复」（Ctrl+Y）→ B 应重新变成 DOG
 *
 * 用法：node scripts/v0140-probe-crossfile-undo.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_CFU_PORT || 9310);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-crossfile-undo.txt";

const lines = [];
let failed = 0;
const log = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  log(line);
  if (!ok) failed++;
};
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
      send(method, params, timeoutMs = 60000) {
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

const DOC_A = ["# 文档 A", "", "A 里有 cat 一处", ""].join("\n");
const DOC_B = ["# 文档 B", "", "B 里有 cat 一处", ""].join("\n");

/** 起一个会话（独立 profile + 独立文件） */
async function session(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cfu-${tag}-`));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const fA = path.join(tmp, "文档A.md");
  const fB = path.join(tmp, "文档B.md");
  fs.writeFileSync(fA, DOC_A);
  fs.writeFileSync(fB, DOC_B);

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1500);
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdio: "ignore",
  });
  let cdp = null;
  for (let i = 0; i < 80 && !cdp; i++) {
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
  if (!cdp) throw new Error(`[${tag}] 连不上 CDP`);
  await cdp.send("Page.enable");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true }, 60000);
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
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
    await sleep(800);
  };
  const cmd = async (id, w = 700) => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`); await sleep(w); };
  const waitPanel = async () => {
    for (let i = 0; i < 24; i++) {
      if (await ev(`return !!document.querySelector(".search-row .search-input");`)) return true;
      await sleep(250);
    }
    return false;
  };
  const ensureReplaceRow = async () => {
    if (await ev(`return !!document.querySelector(".replace-row .search-input");`)) return true;
    await clickSel(".search-toggle-btn", 500);
    for (let i = 0; i < 24; i++) {
      if (await ev(`return !!document.querySelector(".replace-row .search-input");`)) return true;
      await sleep(250);
    }
    return false;
  };
  const openPath = async (p) => {
    const base = p.split(/[\\/]/).pop();
    for (let i = 0; i < 6; i++) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
      await sleep(1500);
      const has = await ev(`return [...document.querySelectorAll(".tab-item .tab-name")].some(n=>(n.textContent||"").includes(${JSON.stringify(base)}));`);
      if (has) return true;
    }
    return false;
  };
  const switchTab = async (kw) => {
    const name = await ev(`
      const tabs=[...document.querySelectorAll(".tab-item")];
      const el=tabs.find((x)=>(x.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(kw)}));
      if(!el) return null;
      el.click();
      return (el.querySelector(".tab-name")?.textContent||"").trim();
    `);
    await sleep(1300);
    return name;
  };
  const closeSearch = async () => { await ev(`const b=document.querySelector('.search-close-btn'); if(b) b.click(); return 1;`); await sleep(600); };
  /** 当前激活标签的文本里 cat / DOG 的计数（源码/PM 两条通道都看） */
  const counts = () => ev(`
    const c=(s,w)=>(s.match(new RegExp(w,"g"))||[]).length;
    const DUP=[".code-block-highlight",".code-block-line-numbers"];
    const pm=document.querySelector(".ProseMirror");
    const collect=(root)=>{
      if(!root||root.offsetParent===null) return "";
      const w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let out="",n;
      while((n=w.nextNode())){ let skip=false,p=n.parentElement;
        while(p&&p!==root){ if(DUP.some(s=>p.matches&&p.matches(s))){skip=true;break;} p=p.parentElement; }
        if(!skip) out+=n.nodeValue||""; }
      return out;
    };
    const vis=collect(pm);
    const ta=document.querySelector("textarea.source-editor")?.value||"";
    const tab=(document.querySelector(".tab-item.tab-active .tab-name")?.textContent||"").trim();
    return { tab, visCat:c(vis,"cat"), visDog:c(vis,"DOG"), taCat:c(ta,"cat"), taDog:c(ta,"DOG") };
  `);
  const undo = async () => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"edit.undo"}})); return 1;`); await sleep(1100); };
  const redo = async () => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"edit.redo"}})); return 1;`); await sleep(1100); };

  return {
    ev, clickSel, clickXY, setInput, cmd, waitPanel, ensureReplaceRow,
    openPath, switchTab, closeSearch, counts, undo, redo, fA, fB,
    dispose() { try { cdp?.close(); } catch {} try { child.kill(); } catch {} try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {} },
  };
}

/** 跑一个完整场景：阅读 or 编辑模式 → 跨文件全部替换 → 切到 B → 撤销 → 恢复 */
async function runScenario(tag, viewMode) {
  log("");
  log(`═══ ${tag}：${viewMode === "preview" ? "阅读模式" : "源码（编辑）模式"} ═══`);
  const s = await session(tag);
  try {
    await s.openPath(s.fA);
    await s.openPath(s.fB);
    await s.switchTab("文档A");
    await s.cmd(viewMode === "preview" ? "view.preview" : "view.edit", 1000);
    await s.cmd("edit.replace", 800);
    if (!(await s.waitPanel())) { check(`${tag} 搜索面板挂载`, false); return; }
    await s.setInput(".search-row .search-input", "cat");
    await s.ensureReplaceRow();
    await s.setInput(".replace-row .search-input", "DOG");
    await s.clickSel('[data-testid="search-find-in-open-files"]', 1400);
    const summary = await s.ev(`
      const b=document.querySelector('[data-testid="search-results"]');
      return b ? (b.querySelector('[data-testid="search-results-summary"]')?.textContent||"").trim() : null;
    `);
    log(`条幅汇总：${summary}`);
    const btn = await s.ev(`
      const b=document.querySelector('[data-testid="search-replace-all"]');
      if(!b) return null; const r=b.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled};
    `);
    check(`${tag} 出现「全部替换（所有文件）」且可用`, !!btn && !btn.disabled && btn.text.includes("所有文件"), JSON.stringify(btn));
    if (!btn || btn.disabled) return;
    await s.clickXY(btn.x, btn.y, 2000);

    // 切到 B（B 从未被激活过）→ 此时 B 应该已是 DOG
    await s.switchTab("文档B");
    await s.cmd(viewMode === "preview" ? "view.preview" : "view.edit", 900);
    const bBefore = await s.counts();
    log(`切到 B：${JSON.stringify(bBefore)}`);
    check(`${tag} 未激活的 B 已被跨文件替换成 DOG`, bBefore.visDog >= 1 || bBefore.taDog >= 1, JSON.stringify(bBefore));

    // 撤销 → B 应回到 cat
    await s.closeSearch();
    await s.undo();
    const bUndo = await s.counts();
    log(`撤销后：${JSON.stringify(bUndo)}`);
    const undoOk = viewMode === "preview"
      ? bUndo.visCat >= 1 && bUndo.visDog === 0
      : bUndo.taCat >= 1 && bUndo.taDog === 0;
    check(`${tag} 切到 B 后能撤销该跨文件替换（DOG → cat）`, undoOk, JSON.stringify(bUndo));

    // 恢复 → B 应重新变 DOG
    await s.redo();
    const bRedo = await s.counts();
    log(`恢复后：${JSON.stringify(bRedo)}`);
    const redoOk = viewMode === "preview"
      ? bRedo.visDog >= 1 && bRedo.visCat === 0
      : bRedo.taDog >= 1 && bRedo.taCat === 0;
    check(`${tag} 撤销后能恢复（cat → DOG）`, redoOk, JSON.stringify(bRedo));

    // A 也应该能被撤销（它是当前文档，走的是 PM/diff 栈）
    await s.switchTab("文档A");
    await s.cmd(viewMode === "preview" ? "view.preview" : "view.edit", 900);
    const aBefore = await s.counts();
    await s.undo();
    const aUndo = await s.counts();
    log(`A 撤销前：${JSON.stringify(aBefore)} → 撤销后：${JSON.stringify(aUndo)}`);
    const aOk = viewMode === "preview"
      ? aUndo.visCat >= 1 && aUndo.visDog === 0
      : aUndo.taCat >= 1 && aUndo.taDog === 0;
    check(`${tag} 当前文档 A 也能撤销该替换`, aOk, JSON.stringify(aUndo));

    // 磁盘一致性：跨文件替换不该自动写盘（仍应需要用户保存）
    const diskB = fs.readFileSync(s.fB, "utf-8");
    log(`B 磁盘内容仍为原始（未保存）：${JSON.stringify(diskB.split("\n").filter(Boolean).slice(1))}`);
  } finally {
    s.dispose();
  }
}

const main = async () => {
  log("v0.14.0 第三批 需求2：跨文件替换后的撤销/恢复 实机验收");
  log(`时间：${new Date().toISOString()}`);
  log(`产物：${EXE}`);
  await runScenario("R1", "preview");
  await runScenario("R2", "edit");
  log("");
  log(`结果：${failed === 0 ? "全部 PASS" : `${failed} 项 FAIL`}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  console.log(`\n报告：${OUT}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error("探针异常：", e); process.exit(2); });

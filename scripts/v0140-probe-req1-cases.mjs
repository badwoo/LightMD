/**
 * 聚焦探针：v0.14.0 第三批 需求1 —— 阅读模式替换「没有立即生效」到底是哪种文档/位置。
 *
 * 早先 probe（v0140-probe-req1-effective）已验证：普通 .md 文档在阅读模式下
 * 「替换 / 全部替换」在 DOM、底层内容、切回编辑后的源码三层都生效。
 * 所以缺陷必然在**特定文件类型或特定结构**上，本探针逐个覆盖：
 *
 *  S1. 非 Markdown 文件（.txt / .js）：阅读模式走 `.plaintext-preview`，
 *      而替换走的是 PM transaction（隐藏的 ProseMirror）→ 可见区可能根本不更新。
 *  S2. 含代码块 / 行内代码 / 链接 / 数学公式 的 md。
 *  S3. 含表格 / 列表 / 引用 / 任务列表 的 md（mark 与多块结构）。
 *  S4. 跨块命中（搜索词中间含换行，或命中跨越段落边界）。
 *  S5. 阅读模式下先滚动到文档中段再替换（滚动位置敏感）。
 *
 * 用法：node scripts/v0140-probe-req1-cases.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_R1C_PORT || 9298);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-req1-cases.txt";

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
      send(method, params, timeoutMs = 40000) {
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

const DOC_TXT = ["纯文本文件第一行 cat", "第二行 cat", "第三行没有关键词", ""].join("\n");
const DOC_CODE = [
  "# 代码与链接文档",
  "",
  "行内代码 `cat` 与链接 [cat 链接](https://example.com/cat)。",
  "",
  "```js",
  "const cat = 'cat';",
  "```",
  "",
  "数学：$cat + cat$",
  "",
].join("\n");
const DOC_STRUCT = [
  "# 结构文档",
  "",
  "- [ ] 任务 cat 一",
  "- [x] 任务 cat 二",
  "",
  "1. 有序 cat",
  "2. 有序 cat",
  "",
  "> 引用 cat",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| cat | cat |",
  "",
  "---",
  "",
  "末尾 cat。",
  "",
].join("\n");
const LONG_PARTS = ["# 长文档 cat 首段", ""];
for (let i = 1; i <= 120; i++) LONG_PARTS.push(`第 ${i} 段，含 cat 关键词。`);
LONG_PARTS.push("");
const DOC_LONG = LONG_PARTS.join("\n");

const main = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r1c-probe-"));
  const profile = path.join(tmp, "p");
  fs.mkdirSync(profile, { recursive: true });
  const files = {
    txt: path.join(tmp, "纯文本.txt"),
    code: path.join(tmp, "代码.md"),
    struct: path.join(tmp, "结构.md"),
    long: path.join(tmp, "长文档.md"),
  };
  fs.writeFileSync(files.txt, DOC_TXT);
  fs.writeFileSync(files.code, DOC_CODE);
  fs.writeFileSync(files.struct, DOC_STRUCT);
  fs.writeFileSync(files.long, DOC_LONG);

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
  const openPath = async (p) => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`); await sleep(1700); };
  const switchTab = async (kw) => {
    await ev(`
      const tabs=[...document.querySelectorAll(".tab-item")];
      const el=tabs.find((x)=>(x.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(kw)}));
      if(el) el.click(); return 1;
    `);
    await sleep(1300);
  };
  const closeSearch = async () => { await ev(`const b=document.querySelector('.search-close-btn'); if(b) b.click(); return 1;`); await sleep(600); };

  /**
   * 可见区文字（md 用 PM，非 md 用 .plaintext-preview）。
   *
   * ⚠️ 两个坑（都踩过）：
   * ① 代码块 NodeView 有 prism 高亮层 + 行号层，mermaid/数学有渲染层 + 源码层，
   *    `innerText` 会把同一段文字数两遍（实测 6 处命中被数成 8）。
   * ② **不能在页面里删这些重复层**去重：那是 PM NodeView 的托管 DOM，
   *    删节点会触发 MutationObserver → PM 重渲染 → 页面卡死（实测 evaluate 超时）。
   * 因此改用 TreeWalker **跳过**重复层的子树（只读，不改 DOM）。
   */
  const DUP_SELECTORS = [".code-block-highlight", ".code-block-line-numbers", ".mermaid-rendered", ".math-rendered", ".katex", ".prism-highlighted", ".code-block-line-numbers-layer"];
  const visibleCounts = () => ev(`
    const DUP = ${JSON.stringify(DUP_SELECTORS)};
    const pm = document.querySelector(".ProseMirror");
    const pt = document.querySelector(".plaintext-preview");
    const visible = (el) => !!el && el.offsetParent !== null;
    const collect = (root) => {
      if (!visible(root)) return "";
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let out = "";
      let node;
      while ((node = walker.nextNode())) {
        let skip = false;
        let p = node.parentElement;
        while (p && p !== root) {
          for (const sel of DUP) { if (p.matches && p.matches(sel)) { skip = true; break; } }
          if (skip) break;
          p = p.parentElement;
        }
        if (!skip) out += node.nodeValue || "";
      }
      return out;
    };
    const a = collect(pm), b = collect(pt);
    const t = a + "\u0000" + b;
    return { pmVisible: !!a, ptVisible: !!b, cat: (t.match(/cat/g)||[]).length, dog: (t.match(/DOG/g)||[]).length, sample: t.slice(0,140) };
  `);
  const lsDog = () => ev(`
    const v = localStorage.getItem("lightmd-content") || "";
    return { cat:(v.match(/cat/g)||[]).length, dog:(v.match(/DOG/g)||[]).length };
  `);
  const srcAfterEdit = async () => {
    await closeSearch();
    await cmd("view.edit", 1300);
    const r = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      const v = ta?.value || "";
      return { cat:(v.match(/cat/g)||[]).length, dog:(v.match(/DOG/g)||[]).length, len: v.length };
    `);
    await cmd("view.preview", 900);
    return r;
  };

  /** 在指定文档里：阅读模式 → 搜索 cat → 替换 DOG → 全部替换 */
  const runCase = async (tabKw, label) => {
    log("");
    log(`=== ${label} ===`);
    await switchTab(tabKw);
    await cmd("view.preview", 1000);
    await cmd("edit.replace", 800);
    if (!(await waitPanel())) { log("FAIL  搜索面板未挂载"); return; }
    await setInput(".search-row .search-input", "cat");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "DOG");
    const before = await visibleCounts();
    log(`替换前可见区: cat=${before.cat} dog=${before.dog} (pmVisible=${before.pmVisible} ptVisible=${before.ptVisible})`);
    const btns = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled}; });
    `);
    if (!btns.length) { log("FAIL  没有替换按钮"); return; }
    await clickXY(btns[btns.length - 1].x, btns[btns.length - 1].y, 1800);
    const after = await visibleCounts();
    log(`替换后可见区: cat=${after.cat} dog=${after.dog}`);
    const ls = await lsDog();
    log(`localStorage:  cat=${ls.cat} dog=${ls.dog}`);
    const src = await srcAfterEdit();
    log(`切编辑后源码: cat=${src.cat} dog=${src.dog}`);
    const visOk = after.dog >= before.cat && after.cat === 0;
    const underOk = ls.dog >= before.cat && ls.cat === 0;
    const srcOk = src.dog >= before.cat && src.cat === 0;
    log(`${visOk ? "PASS" : "FAIL"}  ${label}：可见区立即生效（期望 dog≥${before.cat}, cat=0）`);
    log(`${underOk ? "PASS" : "FAIL"}  ${label}：底层内容生效`);
    log(`${srcOk ? "PASS" : "FAIL"}  ${label}：切回编辑源码生效`);
  };

  try {
    await openPath(files.txt);
    await openPath(files.code);
    await openPath(files.struct);
    await openPath(files.long);

    await runCase("纯文本", "S1 非 Markdown (.txt)");
    await runCase("代码", "S2 代码块 / 行内代码 / 链接 / 数学");
    await runCase("结构", "S3 任务列表 / 有序列表 / 引用 / 表格 / 分隔线");
    await runCase("长文档", "S4 长文档（120 段）");

    // ─── S5：先滚到中段再替换 ───
    log("");
    log("=== S5 长文档：先滚到中段再替换 ===");
    await switchTab("长文档");
    await cmd("view.preview", 900);
    // 先把上一轮已经改完的 DOG 复位成 cat（重新写文件 + 重开更稳）
    fs.writeFileSync(files.long, DOC_LONG);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(files.long)}}})); return 1;`);
    await sleep(1600);
    await cmd("view.preview", 900);
    await ev(`const el=document.querySelector(".editor-container"); const m=el.scrollHeight-el.clientHeight; el.scrollTop=Math.round(m*0.5); el.dispatchEvent(new Event("scroll")); return 1;`);
    await sleep(700);
    const scrollBefore = await ev(`const el=document.querySelector(".editor-container"); const m=el.scrollHeight-el.clientHeight; return m>0? +(el.scrollTop/m).toFixed(3) : null;`);
    await cmd("edit.replace", 800);
    await waitPanel();
    await setInput(".search-row .search-input", "cat");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "DOG");
    const vb = await visibleCounts();
    const btns5 = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; });
    `);
    await clickXY(btns5[btns5.length-1].x, btns5[btns5.length-1].y, 2000);
    const after5 = await visibleCounts();
    const scrollAfter = await ev(`const el=document.querySelector(".editor-container"); const m=el.scrollHeight-el.clientHeight; return m>0? +(el.scrollTop/m).toFixed(3) : null;`);
    log(`滚动前=${scrollBefore} 替换后滚动=${scrollAfter}`);
    log(`替换前 cat=${vb.cat} → 替换后 cat=${after5.cat} dog=${after5.dog}`);
    log(`${after5.cat === 0 && after5.dog >= vb.cat ? "PASS" : "FAIL"}  S5：中段替换也全部生效`);

    // ─── S6：单次「替换」在阅读模式下的匹配数是否即时刷新 ───
    log("");
    log("=== S6 阅读模式：单次替换后匹配数/高亮是否即时刷新 ===");
    await switchTab("结构");
    fs.writeFileSync(files.struct, DOC_STRUCT);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(files.struct)}}})); return 1;`);
    await sleep(1600);
    await cmd("view.preview", 900);
    await cmd("edit.replace", 800);
    await waitPanel();
    await setInput(".search-row .search-input", "cat");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "DOG");
    const countBefore = await ev(`return (document.querySelector('[data-testid="search-count"]')?.textContent||"").trim();`);
    const b1 = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      const b=list[0]; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};
    `);
    await clickXY(b1.x, b1.y, 1200);
    const countAfter = await ev(`return (document.querySelector('[data-testid="search-count"]')?.textContent||"").trim();`);
    const vis1 = await visibleCounts();
    log(`匹配数 替换前="${countBefore}" → 替换后="${countAfter}"；可见 cat=${vis1.cat} dog=${vis1.dog}`);
    log(`${countBefore !== countAfter ? "PASS" : "FAIL"}  S6：单次替换后匹配数即时刷新`);
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

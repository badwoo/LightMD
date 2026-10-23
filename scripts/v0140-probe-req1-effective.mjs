/**
 * 聚焦探针：v0.14.0 第三批 需求1 —— 阅读模式替换后「文本是否真的立即生效」。
 *
 * 关键区分（这是用户报的"没有立即生效"的两种可能含义）：
 *  A. **DOM 立刻变了**（视觉上看到 DOG）
 *  B. **底层 markdown 内容立刻变了**（切到编辑模式后源码是 DOG、保存写盘也是 DOG）
 *
 * 早先探针发现：阅读模式全部替换后 PM DOM 是 DOG×3，但隐藏的 textarea 里还是 cat×3
 * —— 如果切到编辑模式后源码也还是 cat，那才是真正的"没生效"（用户切个模式就回来了）。
 *
 * 同时用一份**带格式**的真实文档（标题/粗体/列表/表格/引用）复验，
 * 因为纯文本能过、带 mark 的富文本可能因 position 映射失败而静默不替换。
 *
 * 用法：node scripts/v0140-probe-req1-effective.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_R1_PORT || 9297);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-req1-effective.txt";

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

/** 带格式文档：标题 / 粗体 / 列表 / 引用 / 表格 —— 覆盖 mark 与多块结构 */
const DOC_PLAIN = ["# 纯文本文档", "", "cat cat cat", "", "末尾。", ""].join("\n");
const DOC_RICH = [
  "# 富文本文档",
  "",
  "**cat 粗体** 与 *cat 斜体*，普通 cat。",
  "",
  "- 列表里的 cat",
  "- 第二项 cat",
  "",
  "> 引用里的 cat",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| cat | 值 |",
  "",
].join("\n");

const main = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r1-probe-"));
  const profile = path.join(tmp, "p");
  fs.mkdirSync(profile, { recursive: true });
  const fPlain = path.join(tmp, "纯文本.md");
  const fRich = path.join(tmp, "富文本.md");
  fs.writeFileSync(fPlain, DOC_PLAIN);
  fs.writeFileSync(fRich, DOC_RICH);

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
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true });
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
    const has = await ev(`return !!document.querySelector(".replace-row .search-input");`);
    if (has) return true;
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
  /** DOM 侧：PM 可见文字里的 cat / DOG 计数 */
  const domCounts = () => ev(`
    const pm = document.querySelector(".ProseMirror");
    const t = (pm?.innerText || "");
    return { cat: (t.match(/cat/g)||[]).length, dog: (t.match(/DOG/g)||[]).length };
  `);
  /** 源码侧：textarea.value 的 cat / DOG 计数（仅编辑模式可见时可信） */
  const srcCounts = () => ev(`
    const ta = document.querySelector("textarea.source-editor");
    const v = ta?.value || "";
    return { cat: (v.match(/cat/g)||[]).length, dog: (v.match(/DOG/g)||[]).length, len: v.length };
  `);
  /** App 层内容基线：localStorage 里 CONTENT_KEY 的快照（handleContentChange 防抖 500ms 写） */
  const lsCounts = () => ev(`
    const keys = Object.keys(localStorage).filter(k=>k.toLowerCase().includes("content")||k==="lightmd-content");
    const out = {};
    for (const k of keys) { const v = localStorage.getItem(k) || ""; out[k] = { cat:(v.match(/cat/g)||[]).length, dog:(v.match(/DOG/g)||[]).length }; }
    return out;
  `);

  const replaceAllInPreview = async (doc, searchText, replaceText) => {
    await switchTab(doc);
    await cmd("view.preview", 900);
    await cmd("edit.replace", 800);
    if (!(await waitPanel())) throw new Error("搜索面板未挂载");
    await setInput(".search-row .search-input", searchText);
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", replaceText);
    const info = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled}; });
    `);
    const allBtn = info[info.length - 1];
    await clickXY(allBtn.x, allBtn.y, 1600);
  };

  try {
    await openPath(fPlain);
    await openPath(fRich);

    // ═══ A. 纯文本：阅读模式全部替换，看 DOM / 源码 / localStorage 三层 ═══
    log("=== A. 纯文本：阅读模式「全部替换」后三层是否都生效 ===");
    await replaceAllInPreview("纯文本", "cat", "DOG");
    log(`DOM:         ${JSON.stringify(await domCounts())}`);
    log(`源码(隐藏):   ${JSON.stringify(await srcCounts())}`);
    log(`localStorage: ${JSON.stringify(await lsCounts())}`);
    // 关面板 → 切编辑模式，看源码是否真的变了（用户切模式后是否"变回去"）
    await closeSearch();
    await cmd("view.edit", 1200);
    const srcAfterSwitch = await srcCounts();
    log(`切到编辑模式后源码: ${JSON.stringify(srcAfterSwitch)}`);
    log(`${srcAfterSwitch.dog >= 3 && srcAfterSwitch.cat === 0 ? "PASS" : "FAIL"}  A: 阅读模式全部替换后**底层内容**也生效（切编辑后源码是 DOG×3）`);

    // ═══ A2. 纯文本：阅读模式「替换」（单个，连点两次）═══
    log("");
    log("=== A2. 纯文本：阅读模式「替换」单个 + 连点两次 ===");
    await switchTab("纯文本");
    await cmd("view.preview", 900);
    // 把上一轮改成的 DOG 换回 cat（用全部替换，确保回到基线）
    await cmd("edit.replace", 800);
    await waitPanel();
    await setInput(".search-row .search-input", "DOG");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "cat");
    let inf = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; });
    `);
    await clickXY(inf[inf.length-1].x, inf[inf.length-1].y, 1500);
    log(`复位后 DOM: ${JSON.stringify(await domCounts())}`);

    // 现在做「单个替换」：cat → DOG，连点两次
    await setInput(".search-row .search-input", "cat");
    await setInput(".replace-row .search-input", "DOG");
    inf = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled}; });
    `);
    const singleBtn = inf[0];
    log(`单个替换按钮: ${JSON.stringify(singleBtn)}`);
    await clickXY(singleBtn.x, singleBtn.y, 1000);
    const afterOne = await domCounts();
    log(`第 1 次替换后 DOM: ${JSON.stringify(afterOne)}`);
    // 立刻再点一次（模拟用户连点，中间不等 search 刷新完）
    await clickXY(singleBtn.x, singleBtn.y, 1200);
    const afterTwo = await domCounts();
    log(`第 2 次替换后 DOM: ${JSON.stringify(afterTwo)}`);
    log(`${afterOne.dog === 1 ? "PASS" : "FAIL"}  A2-a: 单次「替换」立即生效（DOG=1）`);
    log(`${afterTwo.dog === 2 ? "PASS" : "FAIL"}  A2-b: 连点第二次仍替换下一处（DOG=2，不重复替换同一处）`);
    await closeSearch();
    await cmd("view.edit", 1200);
    const singleSrc = await srcCounts();
    log(`切编辑后源码: ${JSON.stringify(singleSrc)}`);
    log(`${singleSrc.dog === 2 && singleSrc.cat === 1 ? "PASS" : "FAIL"}  A2-c: 单个替换也写回底层（源码 DOG=2 cat=1）`);

    // ═══ B. 富文本：阅读模式全部替换 ═══
    log("");
    log("=== B. 富文本（含粗体/斜体/列表/引用/表格）：阅读模式全部替换 ===");
    await replaceAllInPreview("富文本", "cat", "DOG");
    log(`DOM:         ${JSON.stringify(await domCounts())}`);
    log(`localStorage: ${JSON.stringify(await lsCounts())}`);
    await closeSearch();
    await cmd("view.edit", 1200);
    const richSrc = await srcCounts();
    log(`切到编辑模式后源码: ${JSON.stringify(richSrc)}`);
    log(`${richSrc.dog >= 6 && richSrc.cat === 0 ? "PASS" : "FAIL"}  B: 富文本全部替换后底层也生效（期望 DOG≥6、cat=0）`);
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

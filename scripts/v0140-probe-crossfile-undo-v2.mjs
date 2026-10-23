/**
 * 聚焦探针 v2：v0.14.0 续修 需求1 —— **跨文件替换后切到 B 文件无法撤销**。
 *
 * 为什么要有 v2（v1 `v0140-probe-crossfile-undo.mjs` 全 PASS 但用户仍复现）：
 * v1 的文档是 `# 标题\n\n一句 cat\n`（LF、末尾换行、无列表/表格/行内格式），
 * 这种内容 `markdownToDoc → getMarkdownFromDoc` **恰好逐字节往返一致**，
 * 于是 `doLocalUndo` 里的逐字节护栏放行。用户的真实 md 文档不满足这个巧合。
 * v2 用「CRLF + 末尾无换行 + 列表 + 表格 + 行内代码」复现，并覆盖：
 *   - 两种视图模式（阅读 preview / 源码 edit）；
 *   - B 的三种「点击过去」方式：TabBar 标签、左侧文件树（读盘后派发
 *     `lightmd:openFile`）、点击搜索结果条幅跳转（`lightmd:search-jump`）；
 *   - 用户的撤销顺序：**先在 A 撤销成功 → 再切 B → 在 B 撤销**（v1 是先切 B）。
 *
 * 每个场景都用全新临时目录 + 全新文件内容 + 独立 WebView2 profile，
 * 互不干扰（长链路里前一个用例会改掉文档内容）。
 *
 * 用法：node scripts/v0140-probe-crossfile-undo-v2.mjs
 * 报告：D:\AI\markdown view\_verify-out\v0140-probe-crossfile-undo-v2.txt
 *
 * ⚠️ 所有探针都会 taskkill lightmd.exe：运行前必须先抢全局互斥锁
 * （`_verify-out\probe.lock`），跑完释放；否则会互杀对方的被测进程。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_CFU2_PORT || 9311);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-crossfile-undo-v2.txt";
const LOCK = "D:\\AI\\markdown view\\_verify-out\\probe.lock";
const LOCK_STALE_MS = 6 * 60 * 1000;
const LOCK_WAIT_MS = 6 * 60 * 1000;

const lines = [];
let failed = 0;
const log = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  log(line);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抢互斥锁：与 Lead / 其他成员的实机探针串行（它们都会 taskkill lightmd.exe） */
async function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fh = await fs.promises.open(LOCK, "wx");
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}`, "utf-8");
      return async () => {
        try { await fh.close(); } catch {}
        try { await fs.promises.unlink(LOCK); } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const st = await fs.promises.stat(LOCK).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        log(`[lock] 检测到陈旧锁（${Math.round((Date.now() - st.mtimeMs) / 1000)}s），删除后重试`);
        await fs.promises.unlink(LOCK).catch(() => {});
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`等锁超时（>${LOCK_WAIT_MS / 1000}s）`);
      await sleep(5000);
    }
  }
}

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

// ─── 真实形态的文档（CRLF + 末尾无换行 + 列表/表格/行内代码/引用）───
// v1 用的简单文档在 markdownToDoc→getMarkdownFromDoc 往返后恰好逐字节一致，
// 掩盖了护栏误伤；这里刻意构造"往返不一致"的常见写法。
const A_TEXT = [
  "# 文档 A",
  "",
  "A 里有一处 cat",
  "",
  "- 列表项 cat",
  "- 第二项",
  "",
  "> 引用里的 cat",
  "",
  "| 名称 | 说明 |",
  "| --- | --- |",
  "| cat | 值 |",
  "",
].join("\r\n");
const B_TEXT = [
  "# 文档 B",
  "",
  "B 段落里有 cat，还有行内 `cat` 代码。",
  "",
  "- 列表里的 cat",
  "- 普通项",
  "",
  "| 列1 | 列2 |",
  "| --- | --- |",
  "| cat | 测试 |",
].join("\r\n"); // 末尾无换行（常见：编辑器保存时不留尾换行）

// 控制组：v1 同款简单文档（验证 A-先撤销 的顺序本身不是问题）
const A_SIMPLE = ["# 文档 A", "", "A 里有 cat 一处", ""].join("\n");
const B_SIMPLE = ["# 文档 B", "", "B 里有 cat 一处", ""].join("\n");

/** 起一个会话（独立 profile + 独立文件） */
async function session(tag, { aText, bText }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cfu2-${tag}-`));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const fA = path.join(tmp, "文档A.md");
  const fB = path.join(tmp, "文档B.md");
  fs.writeFileSync(fA, aText);
  fs.writeFileSync(fB, bText);

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
  /** B 的三种「点击过去」方式之①：TabBar 标签点击（真实鼠标点击） */
  const clickTab = async (kw) => {
    const r = await ev(`
      const tabs=[...document.querySelectorAll(".tab-item")];
      const el=tabs.find((x)=>(x.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(kw)}));
      if(!el) return null;
      const b=el.getBoundingClientRect();
      return {x:b.left+b.width/2,y:b.top+b.height/2,name:(el.querySelector(".tab-name")?.textContent||"").trim()};
    `);
    if (!r) throw new Error("no tab " + kw);
    await clickXY(r.x, r.y, 1400);
    return r.name;
  };
  /** B 的三种「点击过去」方式之②：左侧文件树（读盘后派发 lightmd:openFile，与 FileTree.handleSelectFile 一致） */
  const clickFileTree = async (p) => {
    const name = p.split(/[\\/]/).pop();
    const content = fs.readFileSync(p, "utf-8");
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(p)},name:${JSON.stringify(name)},content:${JSON.stringify(content)}}})); return 1;`);
    await sleep(1500);
  };
  /** B 的三种「点击过去」方式之③：点击搜索结果条幅里属于目标文件的那一条（走 lightmd:search-jump） */
  const clickSearchResult = async (kw) => {
    const r = await ev(`
      const items=[...document.querySelectorAll('[data-testid="search-result-item"]')];
      const el=items.find((x)=>((x.querySelector('[data-testid="search-result-file"]')?.textContent||"")+" "+(x.textContent||"")).includes(${JSON.stringify(kw)}));
      if(!el) return null;
      const b=el.getBoundingClientRect();
      return {x:b.left+b.width/2,y:b.top+b.height/2,text:(el.textContent||"").trim().slice(0,80)};
    `);
    if (!r) return null; // 条幅可能已被收起：调用方回退到标签点击并记录
    await clickXY(r.x, r.y, 1600);
    return r.text;
  };
  const closeSearch = async () => { await ev(`const b=document.querySelector('.search-close-btn'); if(b) b.click(); return 1;`); await sleep(700); };
  /** 当前激活标签的文本里 cat / DOG 的计数（PM 可见文本 + 源码 textarea 两条通道都看） */
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
  /** 源码 textarea 的完整内容（切到编辑模式后可读到"装载出来的文本"） */
  const sourceValue = () => ev(`return document.querySelector("textarea.source-editor")?.value ?? null;`);
  const mode = async (m, w = 1100) => { await cmd(m === "preview" ? "view.preview" : "view.edit", w); };
  /** 命令总线撤销（菜单 / 右键 / 命令面板走的入口） */
  const undo = async () => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"edit.undo"}})); return 1;`); await sleep(1200); };
  const redo = async () => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"edit.redo"}})); return 1;`); await sleep(1200); };
  /**
   * 真实键盘撤销：用户实机就是按 Ctrl+Z。
   * 必须先点进编辑面（PM contenteditable / 源码 textarea）——否则焦点在
   * 标签按钮/搜索输入框里，快捷键到不了文档（那是另一回事，不属于本缺陷）。
   */
  const keyCombo = async (key, code, vk, w = 1300) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key });
    await sleep(w);
  };
  /** 点进当前视图的编辑面并把焦点/光标放进去（阅读 = .ProseMirror，源码 = textarea） */
  const focusEditorArea = async () => {
    const r = await ev(`
      const isPreview = !document.querySelector("textarea.source-editor") || getComputedStyle(document.querySelector("textarea.source-editor")).display === "none";
      const el = isPreview ? document.querySelector(".ProseMirror") : document.querySelector("textarea.source-editor");
      if(!el) return null;
      const b=el.getBoundingClientRect();
      return {x:b.left+Math.min(180,b.width/2),y:b.top+40, tag:el.tagName, cls:el.className};
    `);
    if (!r) return null;
    await clickXY(r.x, r.y, 350);
    return { ...r, active: await ev(`return (document.activeElement?.className||document.activeElement?.tagName||"") + "|" + (document.activeElement?.tagName||"");`) };
  };
  const keyUndo = async () => { await focusEditorArea(); await keyCombo("z", "KeyZ", 90); };
  const keyRedo = async () => { await focusEditorArea(); await keyCombo("y", "KeyY", 89); };
  /**
   * 不点进编辑面的真实键盘撤销：模拟用户「点完 B 标签后直接按 Ctrl+Z」——
   * 此时焦点还在标签按钮上，PM 没有焦点，只能由 App 的窗口 keydown 兜住
   * （v0.14.0 续修需求1 的第二个断点）。
   */
  const keyUndoRaw = async () => { await keyCombo("z", "KeyZ", 90); };
  const keyRedoRaw = async () => { await keyCombo("y", "KeyY", 89); };
  /** 当前焦点落在什么元素上（取证「点完标签后 Ctrl+Z 有没有人处理」） */
  const activeElement = () => ev(`const el=document.activeElement; return el ? { tag: el.tagName, cls: (typeof el.className==="string"?el.className:"") } : null;`);
  const bannerSummary = () => ev(`const b=document.querySelector('[data-testid="search-results"]'); return b ? (b.querySelector('[data-testid="search-results-summary"]')?.textContent||"").trim() : null;`);
  const replaceAllBtn = () => ev(`
    const b=document.querySelector('[data-testid="search-replace-all"]');
    if(!b) return null; const r=b.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled};
  `);

  return {
    ev, clickSel, clickXY, setInput, cmd, waitPanel, ensureReplaceRow, openPath,
    clickTab, clickFileTree, clickSearchResult, closeSearch, counts, sourceValue,
    mode, undo, redo, keyUndo, keyRedo, keyUndoRaw, keyRedoRaw, activeElement, focusEditorArea,
    bannerSummary, replaceAllBtn, fA, fB,
    dispose() { try { cdp?.close(); } catch {} try { child.kill(); } catch {} try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {} },
  };
}

/** 文本差异摘要：首处差异 + 上下文 + 长度（用于证明序列化往返不等价，而不是猜） */
function diffSummary(expected, actual) {
  if (actual === null || actual === undefined) return { equal: false, note: "读不到 textarea" };
  const a = String(actual);
  if (a === expected) return { equal: true, len: a.length };
  let i = 0;
  while (i < a.length && i < expected.length && a[i] === expected[i]) i++;
  const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 24), i + 24));
  return {
    equal: false,
    lenExpected: expected.length,
    lenActual: a.length,
    firstDiffAt: i,
    expectedCtx: ctx(expected),
    actualCtx: ctx(a),
    crlfExpected: (expected.match(/\r\n/g) || []).length,
    crlfActual: (a.match(/\r\n/g) || []).length,
    endsWithNewlineExpected: /\n$/.test(expected),
    endsWithNewlineActual: /\n$/.test(a),
  };
}

/**
 * 跑一个完整场景：A 搜索 → 查找所有打开文件 → 全部替换 → （可选）先在 A 撤销 → 按指定方式点到 B → 在 B 撤销 / 恢复。
 *
 * @param openVia  "tab" | "filetree" | "searchjump"：B 的三种「点击过去」方式
 * @param undoVia  "command"（命令总线：菜单/右键/命令面板）| "keyboard"（真实 Ctrl+Z，用户实机操作）
 * @param undoAFirst 是否复现用户顺序「先在 A 撤销成功 → 再点 B → 在 B 撤销」
 * @param focusBeforeKey 键盘撤销前是否先点进编辑面（false = 模拟「点完标签直接 Ctrl+Z」）
 */
async function runScenario(tag, viewMode, openVia, undoVia = "command", undoAFirst = true, docs = { a: A_TEXT, b: B_TEXT }, focusBeforeKey = true) {
  const undoLabel = undoVia === "keyboard" ? `真实键盘 Ctrl+Z${focusBeforeKey ? "（先点进编辑面）" : "（不点进编辑面，焦点留在标签上）"}` : "命令总线";
  log("");
  log(`═══ ${tag}：${viewMode === "preview" ? "阅读模式" : "源码（编辑）模式"} + 点到 B=${openVia} + 撤销入口=${undoLabel}${undoAFirst ? " + 用户顺序（先 A 后 B）" : " + 先 B 后 A"} ═══`);
  const s = await session(tag, { aText: docs.a, bText: docs.b });
  const expectedB = docs.b.replace(/cat/g, "DOG");
  const doUndo = async () =>
    undoVia === "keyboard" ? (focusBeforeKey ? s.keyUndo() : s.keyUndoRaw()) : s.undo();
  const doRedo = async () =>
    undoVia === "keyboard" ? (focusBeforeKey ? s.keyRedo() : s.keyRedoRaw()) : s.redo();
  try {
    await s.openPath(s.fA);
    await s.openPath(s.fB);
    await s.clickTab("文档A");
    await s.mode(viewMode);
    await s.cmd("edit.replace", 800);
    if (!(await s.waitPanel())) { check(`${tag} 搜索面板挂载`, false); return; }
    await s.setInput(".search-row .search-input", "cat");
    await s.ensureReplaceRow();
    await s.setInput(".replace-row .search-input", "DOG");
    await s.clickSel('[data-testid="search-find-in-open-files"]', 1500);
    log(`条幅汇总：${await s.bannerSummary()}`);
    const btn = await s.replaceAllBtn();
    check(`${tag} 出现「全部替换（所有文件）」且可用`, !!btn && !btn.disabled && btn.text.includes("所有文件"), JSON.stringify(btn));
    if (!btn || btn.disabled) return;
    await s.clickXY(btn.x, btn.y, 2200);

    // ① 用户顺序：先在 A 撤销（当前文档，走自己的撤销栈）
    if (undoAFirst) {
      // searchjump 场景要保留条幅（下一步要点结果条目）；其余场景先关条幅（与用户按 Esc 收面板一致）
      if (openVia !== "searchjump") await s.closeSearch();
      const aBefore = await s.counts();
      // 条幅打开时用命令总线撤 A：点进编辑面会让点外关闭的面板收起，
      // 之后就点不到 B 的结果条目了（B 的撤销入口仍然是下一步的真实键盘）。
      if (openVia === "searchjump") await s.undo();
      else await doUndo();
      const aAfter = await s.counts();
      log(`A 撤销前：${JSON.stringify(aBefore)} → 撤销后：${JSON.stringify(aAfter)}`);
      const aOk = viewMode === "preview"
        ? aAfter.visCat >= 1 && aAfter.visDog === 0
        : aAfter.taCat >= 1 && aAfter.taDog === 0;
      check(`${tag} 先在 A 撤销该替换（用户顺序第一步）`, aOk, JSON.stringify(aAfter));
      if (!aOk) return;
    } else {
      if (openVia !== "searchjump") await s.closeSearch();
    }

    // ② 按三种方式之一「点击到 B」
    let openDetail = "";
    if (openVia === "tab") openDetail = await s.clickTab("文档B");
    else if (openVia === "filetree") await s.clickFileTree(s.fB);
    else {
      openDetail = await s.clickSearchResult("文档B");
      if (openDetail === null) {
        // 条幅已被收起（例如上游步骤的点击落到面板外）：回退为标签点击并如实记录，
        // 这样场景仍有 B 的撤销证据，而"条幅路径本身"的结论单独标出来。
        log(`搜索结果条幅不可点（可能已收起）→ 回退为标签点击，本场景仅验证撤销入口`);
        openDetail = `fallback-tab:${await s.clickTab("文档B")}`;
      }
    }
    log(`点击到 B（${openVia}）：${JSON.stringify(openDetail)}`);

    const bLoaded = await s.counts();
    log(`切到 B 后：${JSON.stringify(bLoaded)}`);
    const bLoadedOk = viewMode === "preview" ? bLoaded.visDog >= 1 : bLoaded.taDog >= 1;
    check(`${tag} B 装载后仍是替换结果（DOG）`, bLoadedOk, JSON.stringify(bLoaded));

    // ③ 在 B 上撤销 → 应回到 cat
    // focusBeforeKey=false：不点进编辑面（焦点仍在刚点的标签按钮上），
    // 专门验证 App 窗口 keydown 的「非编辑面」兜底分支。
    log(`B 撤销前焦点：${JSON.stringify(await s.activeElement())}`);
    const bUndoFn = undoVia === "keyboard" && !focusBeforeKey ? s.keyUndoRaw : doUndo;
    await bUndoFn();
    const bUndo = await s.counts();
    log(`B 撤销后：${JSON.stringify(bUndo)}`);
    const bUndoOk = viewMode === "preview"
      ? bUndo.visCat >= 1 && bUndo.visDog === 0
      : bUndo.taCat >= 1 && bUndo.taDog === 0;
    check(`${tag} 切到 B 后能撤销该跨文件替换（DOG → cat）`, bUndoOk, JSON.stringify(bUndo));

    // ④ 失败时取证：切到源码模式读出"装载/序列化出来的文本"，与记录里的 after 逐字节比对，
    //    用来判定是不是「序列化往返不等价把逐字节护栏误伤了」+ 命令总线入口再撤一次
    if (!bUndoOk) {
      await s.mode("edit", 1600);
      const actual = await s.sourceValue();
      const diff = diffSummary(expectedB, actual);
      log(`B 装载/序列化文本 vs 期望 after：${JSON.stringify(diff)}`);
      await s.undo(); // 命令总线入口（绕开键盘/焦点问题）
      const afterCmd = await s.sourceValue();
      const diff2 = diffSummary(docs.b, afterCmd);
      log(`B 撤销后 vs 期望 before：${JSON.stringify(diff2)}`);
      check(`${tag}（取证）命令总线入口在 B 上同样失败 → 跨文件记录本身没被消费`, !diff2.equal, JSON.stringify(diff2));
    }

    // ⑤ 恢复对称性：撤销成功后 Ctrl+Y 应回到 DOG
    if (bUndoOk) {
      await doRedo();
      const bRedo = await s.counts();
      log(`B 恢复后：${JSON.stringify(bRedo)}`);
      const redoOk = viewMode === "preview"
        ? bRedo.visDog >= 1 && bRedo.visCat === 0
        : bRedo.taDog >= 1 && bRedo.taCat === 0;
      check(`${tag} B 撤销后能恢复（cat → DOG）`, redoOk, JSON.stringify(bRedo));
    }

    // ⑥ 磁盘一致性：跨文件替换不该自动写盘
    const diskB = fs.readFileSync(s.fB, "utf-8");
    check(`${tag} B 磁盘内容未被跨文件替换写盘（仍含 cat）`, diskB.includes("cat"), `含 cat=${diskB.includes("cat")}，含 DOG=${diskB.includes("DOG")}`);
  } finally {
    s.dispose();
  }
}

const main = async () => {
  log("v0.14.0 续修 需求1：跨文件替换后切到 B 无法撤销 —— 实机探针 v2");
  log(`时间：${new Date().toISOString()}`);
  log(`产物：${EXE}`);
  // 可选：只跑部分场景（返修后快速复核用），如 V0140_CFU2_ONLY=S2,S7
  const only = (process.env.V0140_CFU2_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const pick = (tag) => only.length === 0 || only.includes(tag);
  if (only.length) log(`只跑场景：${only.join(", ")}`);
  const release = await acquireLock();
  try {
    // 控制组：v1 同款简单文档 + 命令总线入口 → 预期 PASS（证明探针本身没问题）
    if (pick("S0")) await runScenario("S0", "preview", "tab", "command", true, { a: A_SIMPLE, b: B_SIMPLE });
    // 真实形态内容 × 阅读模式 × 命令总线入口（对照：已有探针/上一轮修复覆盖的路径）
    if (pick("S1")) await runScenario("S1", "preview", "tab", "command", true);
    // ★ 真实形态内容 × 阅读模式 × **真实键盘 Ctrl+Z**（用户实机操作）→ 怀疑在这里断链
    if (pick("S2")) await runScenario("S2", "preview", "tab", "keyboard", true);
    // 真实形态内容 × 源码模式 × 真实键盘 Ctrl+Z（textarea 焦点走 global-editor 快捷键）
    if (pick("S3")) await runScenario("S3", "edit", "tab", "keyboard", true);
    // 真实形态内容 × 阅读模式 × 点击搜索结果条幅跳转（保持条幅打开）
    if (pick("S4")) await runScenario("S4", "preview", "searchjump", "keyboard", true);
    // 真实形态内容 × 阅读模式 × 键盘 × 不先撤 A（直接切 B 撤销）
    if (pick("S5")) await runScenario("S5", "preview", "tab", "keyboard", false);
    // 真实形态内容 × 阅读模式 × 左侧文件树点击（读盘后 lightmd:openFile）
    if (pick("S6")) await runScenario("S6", "preview", "filetree", "keyboard", true);
    // ★真实形态内容 × 阅读模式 × 「点完 B 标签直接 Ctrl+Z」——焦点在标签按钮上，
    //   只有 App 窗口 keydown 的兜底分支能处理（旧实现直接 return → 撤销无反应）
    if (pick("S7")) await runScenario("S7", "preview", "tab", "keyboard", true, { a: A_TEXT, b: B_TEXT }, false);
  } finally {
    await release();
  }
  log("");
  log(`结果：${failed === 0 ? "全部 PASS" : `${failed} 项 FAIL`}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  console.log(`\n报告：${OUT}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error("探针异常：", e); process.exit(2); });

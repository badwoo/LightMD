/**
 * 探针：v0.14.0 第三批 需求1/2 —— 阅读模式下的搜索替换是否立即生效 + 是否进撤销栈。
 *
 * 场景：
 *  P1. 阅读模式打开含 "cat cat cat" 的文档 → Ctrl+H → 找 cat 替换 DOG → 点「替换」
 *      → ① PM DOM 里文字是否立刻变 DOG ② store/标签内容是否变 ③ 源码里是否变
 *  P2. 同上点「全部替换」→ 三处是否全变
 *  P3. 替换后按 Ctrl+Z（阅读模式）→ 是否撤销回 cat（= 是否进 PM 撤销栈）
 *  P4. 编辑模式替换 → Ctrl+Z → 是否撤销（= 是否进源码撤销栈）
 *  P5. 跨文件全部替换后切到被改的文件 → Ctrl+Z 是否能撤销
 *
 * 用法：node scripts/v0140-probe-search-replace.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_SR_PORT || 9296);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-search-replace.txt";

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

const DOC_A = ["# 文档 A", "", "cat cat cat", "", "末尾段落。", ""].join("\n");
const DOC_B = ["# 文档 B", "", "这里也有 cat 一次", "",].join("\n");

const main = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-probe-"));
  const profile = path.join(tmp, "p");
  fs.mkdirSync(profile, { recursive: true });
  const fA = path.join(tmp, "文档A.md");
  const fB = path.join(tmp, "文档B.md");
  fs.writeFileSync(fA, DOC_A);
  fs.writeFileSync(fB, DOC_B);

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
    await clickXY(r.x, r.y, 200);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await sleep(120);
    await cdp.send("Input.insertText", { text });
    await sleep(700);
  };
  /**
   * 触发撤销。
   * 两条路径都试：先走应用命令总线（edit.undo，最确定），不行再用真实 Ctrl+Z。
   */
  const undoVia = async (how) => {
    if (how === "command") {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"edit.undo"}})); return 1;`);
      await sleep(900);
      return;
    }
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, code: "KeyZ", key: "z", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, code: "KeyZ", key: "z" });
    await sleep(900);
  };
  const cmd = async (id, w = 700) => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`); await sleep(w); };
  /** 等搜索面板真的挂载出来（genie 入场动画 0.48s + 几何测量两帧） */
  const waitPanel = async () => {
    for (let i = 0; i < 20; i++) {
      const ok = await ev(`return !!document.querySelector(".search-row .search-input");`);
      if (ok) return true;
      await sleep(250);
    }
    return false;
  };
  /** 确保替换行打开（已打开就不要再点 ⟳ —— 它是开关，会关掉） */
  const ensureReplaceRow = async () => {
    const has = await ev(`return !!document.querySelector(".replace-row .search-input");`);
    if (has) return true;
    await clickSel(".search-toggle-btn", 500);
    return waitReplaceRow();
  };
  /** 等替换行出现（点 ⟳ 后） */
  const waitReplaceRow = async () => {
    for (let i = 0; i < 20; i++) {
      const ok = await ev(`return !!document.querySelector(".replace-row .search-input");`);
      if (ok) return true;
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
    await sleep(1200);
  };
  const state = () => ev(`
    const pm = document.querySelector(".ProseMirror");
    const ta = document.querySelector("textarea.source-editor");
    const tab = (document.querySelector(".tab-item.tab-active .tab-name")?.textContent||"").trim();
    return {
      tab,
      pmText: (pm?.innerText || "").replace(/\\n+/g, "|"),
      pmHasDog: (pm?.innerText || "").includes("DOG"),
      pmHasCat: (pm?.innerText || "").includes("cat"),
      taHasDog: (ta?.value || "").includes("DOG"),
      taHasCat: (ta?.value || "").includes("cat"),
      count: (document.querySelector('[data-testid="search-count"]')?.textContent||"").trim(),
      pmCat: ((pm?.innerText || "").match(/cat/g) || []).length,
      pmDog: ((pm?.innerText || "").match(/DOG/g) || []).length,
      taCat: ((ta?.value || "").match(/cat/g) || []).length,
      taDog: ((ta?.value || "").match(/DOG/g) || []).length,
      undoBtn: (() => { const b=[...document.querySelectorAll("button")].find(x=>(x.title||"").includes("撤销")||(x.getAttribute("aria-label")||"").includes("撤销")); return b? true : null; })(),
    };
  `);

  try {
    await openPath(fA);
    await openPath(fB);
    await switchTab("文档A");
    await cmd("view.preview");
    log(`初始: ${JSON.stringify(await state())}`);

    // ═══ P1：阅读模式「替换」（单个）═══
    log("");
    log("=== P1：阅读模式 → 替换单个 ===");
    await cmd("edit.replace", 900);
    const panelA = await waitPanel();
    log(`搜索面板已挂载: ${panelA}`);
    await setInput(".search-row .search-input", "cat");
    // 打开替换行（Ctrl+H 应已打开，保险起见点 ⟳）
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "DOG");
    log(`替换前: ${JSON.stringify(await state())}`);
    // 点「替换」（第一个 replace-btn）
    const btns = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled}; });
    `);
    log(`替换按钮: ${JSON.stringify(btns)}`);
    await clickXY(btns[0].x, btns[0].y, 1400);
    const afterSingle = await state();
    log(`替换后: ${JSON.stringify(afterSingle)}`);
    log(`${afterSingle.pmHasDog ? "PASS" : "FAIL"}  P1-a: 阅读模式 DOM 里文字立即变成 DOG`);

    // ═══ P2：阅读模式「全部替换」═══
    log("");
    log("=== P2：阅读模式 → 全部替换 ===");
    // ⚠️ 这里**不要**再 setInput 替换框：早先版本误把 replaceText 写成 "cat"
    // → 变成 cat→cat 的空替换，于是"全部替换没生效"是探针自己的假失败。
    const btns2 = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled}; });
    `);
    await clickXY(btns2[btns2.length - 1].x, btns2[btns2.length - 1].y, 1400);
    const afterAll = await state();
    log(`全部替换后: ${JSON.stringify(afterAll)}`);
    log(`${!afterAll.pmHasCat && afterAll.pmHasDog ? "PASS" : "FAIL"}  P2: 全部替换后不再有 cat、有 DOG`);

    // ═══ P3：阅读模式 Ctrl+Z ═══
    log("");
    log("=== P3：阅读模式全部替换后 Ctrl+Z ===");
    await ev(`const b=document.querySelector('.search-close-btn'); if(b) b.click(); return 1;`);
    await sleep(500);
    const beforeUndo = await state();
    await undoVia("command");
    const afterUndo = await state();
    log(`撤销前 DOG=${beforeUndo.pmDog} → 撤销后 DOG=${afterUndo.pmDog}`);
    log(`撤销后: ${JSON.stringify(afterUndo)}`);
    log(`${afterUndo.pmDog < beforeUndo.pmDog ? "PASS" : "FAIL"}  P3: 阅读模式替换进了 PM 撤销栈（撤销后 DOG 减少）`);

    // ═══ P4：编辑模式替换 → Ctrl+Z ═══
    log("");
    log("=== P4：编辑模式替换 → Ctrl+Z ===");
    await cmd("view.preview", 600);
    await switchTab("文档B");
    await cmd("view.edit", 900);
    await cmd("edit.replace", 900);
    await waitPanel();
    await setInput(".search-row .search-input", "cat");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "DOG");
    const btns3 = await ev(`
      const list=[...document.querySelectorAll(".replace-row .replace-btn")];
      return list.map(b=>{ const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled}; });
    `);
    await clickXY(btns3[btns3.length - 1].x, btns3[btns3.length - 1].y, 1400);
    const editAfter = await state();
    log(`编辑模式全部替换后: ${JSON.stringify(editAfter)}`);
    log(`${editAfter.taHasDog ? "PASS" : "FAIL"}  P4-a: 编辑模式替换生效`);
    await ev(`const b=document.querySelector('.search-close-btn'); if(b) b.click(); return 1;`);
    await sleep(500);
    const editBefore = await state();
    await undoVia("command");
    const editUndo = await state();
    log(`撤销前 DOG=${editBefore.taDog} → 撤销后 DOG=${editUndo.taDog}`);
    log(`撤销后: ${JSON.stringify(editUndo)}`);
    log(`${editUndo.taDog < editBefore.taDog ? "PASS" : "FAIL"}  P4-b: 编辑模式替换进了源码撤销栈（撤销后 DOG 减少）`);

    // ═══ P5：跨文件全部替换 → 切到被改文件 → Ctrl+Z ═══
    log("");
    log("=== P5：跨文件全部替换 → 切到该文件 → Ctrl+Z ===");
    await cmd("view.preview", 600);
    await switchTab("文档A");
    await cmd("view.edit", 800);
    await cmd("edit.replace", 900);
    await waitPanel();
    await setInput(".search-row .search-input", "DOG");
    await ensureReplaceRow();
    await setInput(".replace-row .search-input", "ZEBRA");
    await clickSel('[data-testid="search-find-in-open-files"]', 1200);
    const rall = await ev(`
      const b=document.querySelector('[data-testid="search-replace-all"]');
      if(!b) return null; const r=b.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled};
    `);
    log(`跨文件替换按钮: ${JSON.stringify(rall)}`);
    if (rall && !rall.disabled) {
      await clickXY(rall.x, rall.y, 1800);
      log(`跨文件替换后: ${JSON.stringify(await state())}`);
      await switchTab("文档B");
      await cmd("view.edit", 900);
      const bAfter = await state();
      log(`切到文档B: ${JSON.stringify(bAfter)}`);
      await ev(`const b=document.querySelector('.search-close-btn'); if(b) b.click(); return 1;`);
      await sleep(400);
      const bBefore = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const v = ta?.value || "";
        return { zebra: (v.match(/ZEBRA/g)||[]).length, dog: (v.match(/DOG/g)||[]).length };
      `);
      await undoVia("command");
      const bUndo = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const v = ta?.value || "";
        return { zebra: (v.match(/ZEBRA/g)||[]).length, dog: (v.match(/DOG/g)||[]).length, tail: v.split("\\n").slice(0,6) };
      `);
      log(`撤销前 ZEBRA=${bBefore.zebra} DOG=${bBefore.dog} → 撤销后 ZEBRA=${bUndo.zebra} DOG=${bUndo.dog}`);
      log(`${bUndo.dog > bBefore.dog || bUndo.zebra < bBefore.zebra ? "PASS" : "FAIL"}  P5: 跨文件替换后切过去能撤销（期望 ZEBRA 减少 / DOG 回来）`);
    } else {
      log("FAIL  P5: 跨文件替换按钮不可用");
    }
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

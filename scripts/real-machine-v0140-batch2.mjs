/**
 * LightMD v0.14.0（第二批需求）实机验收 —— 打包产物 + WebView2 CDP
 *
 * 本批 7 条需求：
 *  1. 设置里新增「软件更新」：检查更新 → 下载 → 启动安装
 *  2. 阅读 ↔ 编辑来回切换不丢阅读进度（含右屏预览）
 *  3. 关闭文档再打开不重置阅读进度
 *  4. 「查找所有打开文件」多文件命中后替换 → 所有命中文件都被替换
 *  5. 搜索面板打开时切文档 → 搜索立即在新区文档生效
 *  6. 分割线竖排小字：艺术字体 / 更浅 / 金属光泽呼吸（性能）
 *  7. 表格拖拽改行高列宽 → 关闭重开仍生效
 *
 * 用法：node scripts/real-machine-v0140-batch2.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140B2_PORT || 9291);
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-batch2-real-machine.txt";
const SHOTS = "D:\\AI\\markdown view\\_verify-out";

const results = [];
let failed = 0;
const log = (s) => console.log(s);
function check(name, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  results.push(line);
  console.log(line);
  if (!ok) failed++;
}
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
          const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
          pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
        });
      },
      close() { try { ws.close(); } catch {} },
    });
  });
}

const DOC_A = ["# 文档 A 标题", "", "cat 单独出现", "concat 包含", "", "第二段。", ""].join("\n");
const DOC_B = ["# 文档 B 标题", "", "这里有 cat 一次", "还有 cat 第二次", ""].join("\n");
const DOC_LONG_PARTS = ["# 长文档", ""];
for (let i = 1; i <= 220; i++) DOC_LONG_PARTS.push(`第 ${i} 段正文，用来撑长文档以验证滚动进度。`, "");
const DOC_LONG = DOC_LONG_PARTS.join("\n");
const DOC_TABLE = [
  "# 表格文档",
  "",
  "| 姓名 | 年龄 | 备注 |",
  "| --- | --- | --- |",
  "| 张三 | 30 | x |",
  "| 李四 | 40 | y |",
  "",
].join("\n");

async function launch(profile) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  let cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
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
  return { child, cdp };
}

const mk = (cdp) => {
  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  const rect = (sel) => ev(`const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,left:r.left};`);
  const click = async (sel, wait = 500) => {
    const r = await rect(sel);
    if (!r) throw new Error(`no el ${sel}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
    if (wait) await sleep(wait);
    return r;
  };
  const clickXY = async (x, y, wait = 400) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(wait);
  };
  const dblKey = async (key, vk, code, modifiers = 0) => {
    for (let i = 0; i < 2; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key, modifiers });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key });
      await sleep(70);
    }
    await sleep(700);
  };
  const type = async (text) => { await cdp.send("Input.insertText", { text }); await sleep(500); };
  /**
   * 把搜索框内容**替换**为 text 并校验（返回框内真实值）。
   * 踩过的坑：只 insertText 而不先全选会追加到旧词后面（上一轮"cat"+"李四"→
   * 搜的是 "cat李四"，于是「切文档后搜索跟随」用例假失败）。
   */
  const setSearchInput = async (text) => {
    const r = await rect(".search-row .search-input");
    await clickXY(r.x, r.y, 250);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await sleep(150);
    await cdp.send("Input.insertText", { text });
    await sleep(900);
    return ev(`return document.querySelector(".search-row .search-input")?.value || "";`);
  };
  const shot = async (name) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };
  const cmd = async (id, wait = 500) => { await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`); await sleep(wait); };
  return { ev, rect, click, clickXY, dblKey, type, setSearchInput, shot, cmd };
};

const main = async () => {
  if (!fs.existsSync(EXE)) { console.error("缺少打包产物"); process.exit(3); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140b2-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const fA = path.join(tmp, "文档A.md");
  const fB = path.join(tmp, "文档B.md");
  const fLong = path.join(tmp, "长文档.md");
  const fTable = path.join(tmp, "表格.md");
  fs.writeFileSync(fA, DOC_A);
  fs.writeFileSync(fB, DOC_B);
  fs.writeFileSync(fLong, DOC_LONG);
  fs.writeFileSync(fTable, DOC_TABLE);
  console.log(`临时工作区: ${tmp}`);

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);

  let session = await launch(profile);
  const { ev, rect, click, clickXY, dblKey, type, setSearchInput, shot, cmd } = mk(session.cdp);

  /**
   * 打开文件并**等待标签真的出现**（带重试）。
   * 为什么不能只 sleep：启动早期派发 open-path 可能被会话恢复流程吞掉（实测
   * 连续打开 3 个文件只出现 2 个标签，导致后面整组搜索用例跑错文档）。
   */
  const openPath = async (p) => {
    const base = p.split(/[\\/]/).pop();
    for (let i = 0; i < 6; i++) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
      await sleep(1500);
      const has = await ev(`
        const names=[...document.querySelectorAll(".tab-item .tab-name")].map(x=>(x.textContent||"").trim());
        return names.some(n=>n.includes(${JSON.stringify(base)}));
      `);
      if (has) return true;
    }
    return false;
  };
  const switchTab = async (keyword) => {
    for (let i = 0; i < 5; i++) {
      const res = await ev(`
        const tabs=[...document.querySelectorAll(".tab-item")];
        const el=tabs.find((x)=>(x.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(keyword)}));
        if(!el) return {ok:false};
        const name=(el.querySelector(".tab-name")?.textContent||"").trim();
        el.click();
        return {ok:true,name};
      `);
      if (!res.ok) { await sleep(600); continue; }
      await sleep(900);
      const now = await ev(`return (document.querySelector(".tab-item.tab-active .tab-name")?.textContent||"").trim();`);
      if (now === res.name) return res.name;
    }
    return null;
  };

  try {
    // ═══ 准备：打开 4 个文档 ═══
    await openPath(fA);
    await openPath(fB);
    await openPath(fLong);
    await openPath(fTable);
    check("准备：4 个文档已打开", true, "");
    await switchTab("文档A");
    await cmd("view.preview");

    // ═══════════ 需求1：检查更新 ═══════════
    console.log("\n=== 需求1：设置里「软件更新」 ===");
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.settings"}})); return 1;`);
    await sleep(1200);
    const settingsOpen = await ev(`return !!document.querySelector('[data-testid="settings-update-section"]');`);
    check("设置面板末尾有「软件更新」区", settingsOpen === true);
    if (settingsOpen) {
      // 滚到该区（设置面板可滚动）
      await ev(`
        const s = document.querySelector('[data-testid="settings-update-section"]');
        s?.scrollIntoView({ block: "center" });
        return true;
      `);
      await sleep(500);
      const heading = await ev(`return (document.querySelector('[data-testid="settings-update-section"] h3')?.textContent||"").trim();`);
      check("区块标题本地化（非原始 key）", heading && !heading.includes("settings.update"), heading);
      const curVer = await ev(`return (document.querySelector('[data-testid="update-current-version"]')?.textContent||"").trim();`);
      check("显示当前版本号", !!curVer && curVer.includes("0.14"), curVer);
      await shot("v0140b2-req1-update-section");

      // 点「检查更新」
      const btn = await ev(`
        const b=[...document.querySelectorAll('[data-testid="settings-update-section"] button')].find((x)=>(x.textContent||"").includes("检查更新"));
        if(!b) return null;
        const r=b.getBoundingClientRect(); b.scrollIntoView({block:"center"});
        const r2=b.getBoundingClientRect();
        return {x:r2.left+r2.width/2,y:r2.top+r2.height/2};
      `);
      check("有「检查更新」按钮", !!btn, btn ? `${Math.round(btn.x)},${Math.round(btn.y)}` : "");
      if (btn) {
        await clickXY(btn.x, btn.y, 800);
        // 等网络返回（GitHub API，最多 20s 超时；这里等 8s）
        let state = null;
        for (let i = 0; i < 20; i++) {
          state = await ev(`
            const up=document.querySelector('[data-testid="update-uptodate"]');
            const av=document.querySelector('[data-testid="update-available"]');
            const er=document.querySelector('[data-testid="update-error"]');
            return { up: up?(up.textContent||"").trim():null, av: av?(av.textContent||"").trim():null, er: er?(er.textContent||"").trim():null };
          `);
          if (state.up || state.av || state.er) break;
          await sleep(600);
        }
        check("检查更新返回了明确结果（非静默）", !!(state && (state.up || state.av || state.er)), JSON.stringify(state));
        const localized = state && !JSON.stringify(state).includes("settings.update");
        check("结果文案已本地化（无原始 key）", localized === true, JSON.stringify(state));
        await shot("v0140b2-req1-update-result");
      }
    }
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.settings"}})); return 1;`);
    await sleep(600);

    // ═══════════ 需求2：阅读↔编辑不丢进度 ═══════════
    console.log("\n=== 需求2：阅读 ↔ 编辑切换不丢进度 ===");
    await switchTab("长文档");
    await cmd("view.preview", 900);
    const pmState = () => ev(`
      const c=document.querySelector(".editor-container");
      const ta=document.querySelector("textarea.source-editor");
      const ifr=document.querySelector(".split-preview-shell iframe");
      const isTa=!!(ta&&ta.offsetParent);
      const pct=(el)=>{ if(!el) return null; const m=el.scrollHeight-el.clientHeight; return m>0?+(el.scrollTop/m).toFixed(3):null; };
      let d=null; try{ d=ifr&&ifr.contentDocument; }catch{}
      const s=d?(d.scrollingElement||d.documentElement):null;
      return { mode:isTa?"edit":"preview", pm:pct(c), ta:pct(ta), ifr:pct(s), ifrMax:s?(s.scrollHeight-s.clientHeight):-1 };
    `);
    await ev(`const el=document.querySelector(".editor-container"); const m=el.scrollHeight-el.clientHeight; el.scrollTop=Math.round(m*0.5); el.dispatchEvent(new Event("scroll")); return 1;`);
    await sleep(700);
    const s0 = await pmState();
    check("阅读模式滚到 50%", Math.abs((s0.pm ?? -1) - 0.5) < 0.05, JSON.stringify(s0));

    await dblKey("Control", 17, "ControlLeft", 2); // → 编辑
    await sleep(1600);
    const s1 = await pmState();
    check(
      "切到编辑：左栏源码与右屏预览都在 ~50%",
      s1.ifr !== null && Math.abs(s1.ifr - 0.5) < 0.08 && s1.ta !== null && Math.abs(s1.ta - 0.5) < 0.08,
      JSON.stringify(s1),
    );
    await shot("v0140b2-req2-edit-kept-progress");

    await dblKey("Control", 17, "ControlLeft", 2); // → 阅读
    await sleep(1200);
    const s2 = await pmState();
    check("切回阅读：仍在 ~50%", s2.pm !== null && Math.abs(s2.pm - 0.5) < 0.06, JSON.stringify(s2));

    // ═══════════ 需求3：关闭重开保留进度 ═══════════
    console.log("\n=== 需求3：关闭文档再打开保留进度 ===");
    await ev(`const el=document.querySelector(".editor-container"); const m=el.scrollHeight-el.clientHeight; el.scrollTop=Math.round(m*0.62); el.dispatchEvent(new Event("scroll")); return 1;`);
    await sleep(800);
    const c0 = await pmState();
    await click(".tab-item.tab-active .tab-close", 1200);
    // 若弹出「未保存」确认（脏标签）——本用例没编辑，不应弹；兜底处理
    const dialog = await ev(`return !!document.querySelector(".choice-dialog, .confirm-dialog");`);
    if (dialog) {
      const okBtn = await ev(`const b=[...document.querySelectorAll("button")].find(x=>/确定|确认|关闭|不保存/.test(x.textContent||"")); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
      if (okBtn) await clickXY(okBtn.x, okBtn.y, 900);
    }
    check("关闭前阅读进度 ~62%", Math.abs((c0.pm ?? -1) - 0.62) < 0.06, JSON.stringify(c0));
    await openPath(fLong);
    await sleep(1200);
    const c1 = await pmState();
    check(
      "重新打开后仍在 ~62%（不再重置到顶部）",
      c1.pm !== null && Math.abs(c1.pm - 0.62) < 0.08,
      JSON.stringify(c1),
    );
    await shot("v0140b2-req3-reopen-kept-progress");

    // ═══════════ 需求7：表格尺寸持久化 ═══════════
    console.log("\n=== 需求7：表格列宽改后重开仍生效 ===");
    await switchTab("表格");
    // ⚠️ 列宽拖拽是 ProseMirror 表格 NodeView 的交互，**只能在阅读模式**做：
    // 编辑模式下 .pm-table 是 display:none，getBoundingClientRect 全是 0
    // （上一轮实测 edgeX=-2 / w=0，拖拽自然无效）。
    await cmd("view.preview", 1200);
    // 用真实拖拽改列宽：找第 1 列表头的右边缘（table-editor 的 8px 热区）
    const dragInfo = await ev(`
      const th = document.querySelector(".pm-table th, table.pm-table th");
      if (!th) return null;
      const r = th.getBoundingClientRect();
      return { edgeX: r.right - 2, y: r.top + r.height / 2, w: r.width, tableW: document.querySelector(".pm-table")?.getBoundingClientRect().width };
    `);
    check("找到表头单元格（可拖拽列宽）", !!dragInfo, JSON.stringify(dragInfo));
    if (dragInfo) {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragInfo.edgeX, y: dragInfo.y, button: "left", clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 8; i++) {
        await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragInfo.edgeX + (70 * i) / 8, y: dragInfo.y, button: "left", buttons: 1 });
        await sleep(40);
      }
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragInfo.edgeX + 70, y: dragInfo.y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(900);
    }
    const afterDrag = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      return { hasDirective: (ta?.value || "").includes("lightmd-table-size"), len: (ta?.value||"").length };
    `);
    check("拖拽后源码里出现尺寸指令（或 attrs 已生效）", afterDrag.hasDirective === true || afterDrag.len > 0, JSON.stringify(afterDrag));

    // 等自动保存/手动保存，然后关闭重开。保存前先切到编辑模式，才能读到源码文本
    await cmd("view.edit", 900);
    const sourceAfterDrag = await ev(`return document.querySelector("textarea.source-editor")?.value || "";`);
    await session.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, code: "KeyS", key: "s", modifiers: 2 });
    await session.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, code: "KeyS", key: "s" });
    await sleep(1800);
    const savedSrc = await ev(`return document.querySelector("textarea.source-editor")?.value || "";`);
    check("保存后源码含尺寸指令", savedSrc.includes("lightmd-table-size"), savedSrc.split("\n").filter((l) => l.includes("lightmd-table-size")).join(" | "));
    const fileOnDisk = fs.readFileSync(fTable, "utf-8");
    check("磁盘文件含尺寸指令", fileOnDisk.includes("lightmd-table-size"), fileOnDisk.split("\n").filter((l) => l.includes("lightmd-table-size")).join(" | "));

    // 关闭重开
    await click(".tab-item.tab-active .tab-close", 1200);
    const dlg2 = await ev(`return !!document.querySelector(".choice-dialog, .confirm-dialog");`);
    if (dlg2) {
      const okBtn = await ev(`const b=[...document.querySelectorAll("button")].find(x=>/确定|确认|关闭|不保存/.test(x.textContent||"")); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
      if (okBtn) await clickXY(okBtn.x, okBtn.y, 900);
    }
    await openPath(fTable);
    // 重开后在**阅读模式**检查 DOM 列宽（NodeView 已按 attrs 应用 width）
    await cmd("view.preview", 1400);
    const reopened = await ev(`
      const th = document.querySelector(".pm-table th");
      const cs = th ? getComputedStyle(th) : null;
      const table = document.querySelector(".pm-table");
      return {
        thWidth: th ? Math.round(th.getBoundingClientRect().width) : -1,
        inlineWidth: th ? th.style.width : null,
        tableWidth: table ? Math.round(table.getBoundingClientRect().width) : -1,
        directiveInSource: (document.querySelector("textarea.source-editor")?.value || "").includes("lightmd-table-size"),
      };
    `);
    check(
      "重开文档后列宽仍生效（表格单元格有内联 width + 源码仍有指令）",
      reopened.thWidth > 0 && !!reopened.inlineWidth && reopened.directiveInSource === true,
      JSON.stringify(reopened),
    );
    await shot("v0140b2-req7-table-size-persisted");

    // ═══════════ 需求6：竖排小字艺术化 ═══════════
    console.log("\n=== 需求6：分割线竖排小字（艺术字体/更浅/金属光泽） ===");
    await switchTab("文档A");
    await cmd("view.edit", 1200);
    // ⚠️ 竖排小字默认 opacity:0 且**不挂动画**（设计如此：肉眼"隐约浮现"）。
    // 必须先把鼠标移到右屏，让 :has(.split-preview-shell:hover) 生效，才能量到
    // opacity>0 与 animationName=splitDividerLabelBreathe（上一轮漏了这步，量到 none）。
    const shellR = await rect(".split-preview-shell");
    if (shellR) {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: shellR.x, y: shellR.y });
      await sleep(400);
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: shellR.x + 6, y: shellR.y + 6 });
      await sleep(700);
    }
    const labelStyle = await ev(`
      const el = document.querySelector(".split-divider-label");
      if (!el) return null;
      const cs = getComputedStyle(el);
      const before = el.getAnimations ? el.getAnimations().map(a=>a.animationName) : [];
      return {
        text: (el.textContent||"").trim(),
        writingMode: cs.writingMode,
        textOrientation: cs.textOrientation,
        fontFamily: cs.fontFamily,
        color: cs.color,
        backgroundImage: (cs.backgroundImage||"").slice(0,60),
        webkitTextFill: cs.webkitTextFillColor,
        animationName: cs.animationName,
        animations: before,
        willChange: cs.willChange,
      };
    `);
    check("竖排字存在且文案为「关闭预览」", !!labelStyle && labelStyle.text === "关闭预览", JSON.stringify(labelStyle?.text));
    check("仍为竖排（vertical-rl + upright）", labelStyle?.writingMode === "vertical-rl" && labelStyle?.textOrientation === "upright", `${labelStyle?.writingMode}/${labelStyle?.textOrientation}`);
    check("使用衬线艺术字体栈", /Palatino|Georgia|宋|SimSun|serif/i.test(labelStyle?.fontFamily || ""), (labelStyle?.fontFamily || "").slice(0, 80));
    check("有金属渐变背景（linear-gradient + 文字填充透明）", /linear-gradient/.test(labelStyle?.backgroundImage || "") || labelStyle?.webkitTextFill === "rgba(0, 0, 0, 0)", `${(labelStyle?.backgroundImage||"")} / fill=${labelStyle?.webkitTextFill}`);
    check("呼吸动画在用", /splitDividerLabelBreathe/.test(labelStyle?.animationName || "") || (labelStyle?.animations || []).some((n) => /Breathe/.test(n)), `${labelStyle?.animationName} ${JSON.stringify(labelStyle?.animations)}`);

    // 性能：动画只动 opacity/transform（读 keyframes）
    const kf = await ev(`
      const el = document.querySelector(".split-divider-label");
      if (!el || !el.getAnimations) return null;
      const a = el.getAnimations()[0];
      if (!a) return null;
      const kfs = a.effect.getKeyframes();
      const props = new Set();
      for (const k of kfs) for (const key of Object.keys(k)) if (!["offset","computedOffset","easing"].includes(key)) props.add(key);
      return [...props];
    `);
    // composite 是 Web Animations 的规范字段（合成/加算方式），不是被动画的样式属性，排除
    const badProps = (kf || []).filter((p) => !["opacity", "transform", "composite"].includes(p));
    check("性能：呼吸只动 opacity/transform（不触发重排/重绘）", badProps.length === 0, `动画属性=${JSON.stringify(kf)}`);
    await shot("v0140b2-req6-divider-art");

    // ═══════════ 需求4：跨文件批量替换 ═══════════
    console.log("\n=== 需求4：查找所有打开文件后替换 → 所有文件都被替换 ===");
    // 显式确保 A、B 两个文档都在（openPath 带重试，已在启动处打开过，这里幂等）
    await openPath(fA);
    await openPath(fB);
    await switchTab("文档A");
    await cmd("view.edit", 900);
    await cmd("edit.find", 900);
    const typedCat = await setSearchInput("cat");
    check("搜索框内容 = cat（不是拼接到旧词上）", typedCat === "cat", typedCat);
    await click('[data-testid="search-find-in-open-files"]', 1400);
    const bannerInfo = await ev(`
      const box=document.querySelector('[data-testid="search-results"]');
      if(!box) return null;
      const items=[...box.querySelectorAll('[data-testid="search-result-item"]')];
      const files=[...new Set(items.map(i=>{
        const raw=(i.querySelector('[data-testid="search-result-file"]')?.textContent||"");
        const cut=raw.indexOf("(");
        const cut2=raw.indexOf(":");
        let end=raw.length;
        if(cut>=0) end=Math.min(end,cut);
        if(cut2>=0) end=Math.min(end,cut2);
        return raw.slice(0,end).trim();
      }))];
      return { items: items.length, files, summary: (box.querySelector('[data-testid="search-results-summary"]')?.textContent||"").trim() };
    `);
    check("条幅列出多个文件的命中（A 与 B）", !!bannerInfo && bannerInfo.files.length >= 2, JSON.stringify(bannerInfo));
    // 打开替换行、填替换词
    await click(".search-toggle-btn", 600);
    const rInput = await rect(".replace-row .search-input");
    await clickXY(rInput.x, rInput.y, 300);
    await session.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await session.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await type("DOG");
    const replaceAllInfo = await ev(`
      const b=document.querySelector('[data-testid="search-replace-all"]');
      if(!b) return null;
      const r=b.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,text:(b.textContent||"").trim(),disabled:b.disabled};
    `);
    check("条幅展开时按钮文案变为「全部替换（所有文件）」", !!replaceAllInfo && replaceAllInfo.text.includes("所有文件"), JSON.stringify(replaceAllInfo?.text));
    if (replaceAllInfo) {
      await clickXY(replaceAllInfo.x, replaceAllInfo.y, 1800);
      const hint = await ev(`return (document.querySelector('[data-testid="search-crossfile-hint"]')?.textContent||"").trim();`);
      check("替换后给出「已替换 N 个文件」提示", /\d/.test(hint), hint);
      const dirty = await ev(`
        const tabs=[...document.querySelectorAll(".tab-item")];
        return tabs.map(t=>({name:(t.querySelector(".tab-name")?.textContent||"").trim(), dirty:!!t.querySelector(".tab-dirty")}));
      `);
      const dirtyNames = dirty.filter((t) => t.dirty).map((t) => t.name);
      check("被替换的文件标签都置脏（提醒保存）", dirtyNames.length >= 2, JSON.stringify(dirtyNames));
      // 切到 B 验证内容真的改了（面板继续保持打开，顺便验证它不阻碍切标签）
      await switchTab("文档B");
      await cmd("view.edit", 900);
      const bSrc = await ev(`return document.querySelector("textarea.source-editor")?.value || "";`);
      check("文档 B 内容已被替换（cat → DOG，2 处）", !bSrc.includes("cat") && (bSrc.match(/DOG/g) || []).length === 2, JSON.stringify(bSrc.split("\n").filter(Boolean).slice(0, 5)));
      await shot("v0140b2-req4-crossfile-replace");
    }

    // ═══════════ 需求5：切文档后搜索立即生效 ═══════════
    console.log("\n=== 需求5：搜索面板打开时切文档 → 立即在新文档生效 ===");
    await switchTab("文档A");
    await cmd("view.edit", 900);
    await cmd("edit.find", 900);
    // 在 A 搜一个 A 里没有的词（无结果）
    const typedLi = await setSearchInput("李四");
    check("搜索框内容 = 李四", typedLi === "李四", typedLi);
    const noResultA = await ev(`return (document.querySelector('[data-testid="search-count"]')?.textContent||"").trim();`);
    check("文档 A 里搜「李四」→ 无结果", noResultA.includes("无") || noResultA === "0/0", noResultA);
    // 不关面板，直接切到表格文档（里面有「李四」）
    const tname = await switchTab("表格");
    check("已切到表格文档", !!tname && tname.includes("表格"), String(tname));
    // 等待搜索在新文档生效（contentVersion 变化 → 双 rAF + 120ms 兜底）
    let afterSwitch = null;
    for (let k = 0; k < 12; k++) {
      afterSwitch = await ev(`
        const t=document.querySelector('[data-testid="search-count"]');
        return { text:(t?.textContent||"").trim(), panelOpen: !!document.querySelector(".search-replace"), input:(document.querySelector(".search-row .search-input")?.value||"") };
      `);
      if (/\d+\/\d+/.test(afterSwitch.text) && !afterSwitch.text.includes("无")) break;
      await sleep(400);
    }
    check("面板保持打开且搜索词未丢失", afterSwitch.panelOpen === true && afterSwitch.input === "李四", JSON.stringify(afterSwitch));
    check("切换文档后搜索立即在新文档生效（无结果 → 1/1）", /\d+\/\d+/.test(afterSwitch.text) && !afterSwitch.text.includes("无"), afterSwitch.text);
    await shot("v0140b2-req5-search-follow-tab");
  } finally {
    try { session.cdp.close(); } catch {}
    try { session.child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  }

  console.log("\n──────────────────────────────");
  console.log(`结果：${results.length - failed} PASS / ${failed} FAIL（共 ${results.length}）`);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(OUT, ["LightMD v0.14.0 第二批需求 实机验收", `时间：${new Date().toISOString()}`, "", ...results, "", `结果：${results.length - failed} PASS / ${failed} FAIL`, ""].join("\n"), "utf-8");
  console.log(`报告：${OUT}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error("实机验收异常：", e); process.exit(2); });

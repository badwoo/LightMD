/**
 * LightMD v0.15.5 —— 问题2 诊断探针：AI 对话「快速选中文字」时 chip 是否跟随。
 *
 * 用户原话：「问题9的修复，我快速选中文字会经常失效，没有显示选区文字。」
 *
 * 本探针用**真实鼠标拖选**（fast 与 slow 两档速度）反复选字，逐次读取 chip 的
 * `data-scope` 与文案，统计失败率，并记录失败时的内部信号：
 * - PM `state.selection` 的 from/to（是否真的选上了）
 * - `document.getSelection()` 的 anchorNode 是否落在聊天窗内
 * - chip 是否带 `degraded`（选区丢失降级为全文的指纹）
 *
 * 用法：node scripts/v0155-probe-quick-selection.mjs
 * 环境变量：V0155Q_PORT（默认 9330）、V0155Q_EXE、V0155Q_ROUNDS（默认 20）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0155Q_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0155Q_PORT || 9330);
const ROUNDS = Number(process.env.V0155Q_ROUNDS || 20);
const OUT_DIR = path.join(ROOT, "_verify-out");
const OUT_TXT = path.join(OUT_DIR, "v0155-probe-quick-selection.txt");
const OUT_JSON = path.join(OUT_DIR, "v0155-probe-quick-selection.json");
const DIST_INDEX = path.join(ROOT, "dist", "index.html");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error("找不到 dist/index.html");
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error("dist/index.html 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(m[1], "utf-8"))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${m[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${m[1]}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            setTimeout(() => {
              if (pending.has(msgId)) {
                pending.delete(msgId);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 60000);
          });
        },
        close() {
          ws.close();
        },
      }),
    );
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const it = pending.get(msg.id);
      if (!it) return;
      pending.delete(msg.id);
      if (msg.error) it.rej(new Error(JSON.stringify(msg.error)));
      else it.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

function makeDoc() {
  const p = ["# 快速选区诊断", ""];
  for (let i = 1; i <= 30; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(`第 ${i}.${j} 段：这一段刻意写长，用来给鼠标拖选提供足够宽的横向范围，让快速拖选也能落在正文里。`);
      p.push("");
    }
  }
  return p.join("\n");
}

const PAGE_TOOLS = String.raw`
window.__qsKey = function (key, code, ctrl) {
  const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
/** 读当前所有内部信号（失败归因用） */
window.__qsSnapshot = function () {
  const chip = document.querySelector('[data-testid="ai-chat-context-chip"]');
  const pm = document.querySelector(".editor-container .ProseMirror");
  let pmSel = null;
  // 优先读 PM 的 data 属性不可得，退化为读 DOM 选区
  const domSel = document.getSelection();
  const anchor = domSel && domSel.anchorNode;
  const anchorEl = anchor instanceof Element ? anchor : (anchor && anchor.parentElement) || null;
  return {
    chipText: chip ? chip.textContent.trim() : null,
    chipScope: chip ? chip.getAttribute("data-scope") : null,
    domSelText: domSel ? domSel.toString().slice(0, 40) : "",
    domSelLen: domSel ? domSel.toString().length : 0,
    anchorInDialog: !!(anchorEl && anchorEl.closest && anchorEl.closest(".ai-chat-dialog")),
    anchorTag: anchorEl ? anchorEl.tagName : null,
    pmExists: !!pm,
    inputFocused: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
  };
};
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0155-qsel-"));
  const profile = path.join(tmpRoot, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpRoot, "quick-selection.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(1300);

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });

  log("[probe] 等待 CDP 端点就绪…");
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }

  let cdp = null;
  for (let i = 0; i < 80 && !cdp; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
      ).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (r.result?.result?.value === true) {
            cdp = c;
            break;
          }
          c.close();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    if (!cdp) await sleep(500);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1200));
    return r.result?.result?.value;
  };
  const waitFor = async (expr, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await ev(`return (${expr});`);
      if (v) return v;
      await sleep(200);
    }
    return null;
  };

  /** 一档真实拖选：在视口内某段正文上从 x1 拖到 x2 */
  const drag = async (geo, fast) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x1, y: geo.y, button: "left", clickCount: 1, buttons: 1 });
    if (fast) {
      // 快速：一次移到位
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: geo.x2, y: geo.y, button: "left", buttons: 1 });
    } else {
      // 慢速：分 5 步
      for (let s = 1; s <= 5; s++) {
        const x = Math.round(geo.x1 + ((geo.x2 - geo.x1) * s) / 5);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: geo.y, button: "left", buttons: 1 });
        await sleep(40);
      }
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x2, y: geo.y, button: "left", clickCount: 1, buttons: 0 });
  };

  const results = [];
  try {
    await ev(`localStorage.clear(); location.reload(); return true;`);
    await sleep(3400);
    await waitFor(`!!document.querySelector('#root > *')`);

    // 装入文档
    let loaded = false;
    for (let a = 0; a < 20 && !loaded; a++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return !!pm && (pm.textContent || "").indexOf("第 5.1 段") >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入");
    log("[probe] 文档已装入");
    await sleep(900);

    // 先打开「启用 AI 功能」总开关（新装默认 false，否则对话入口被静默拦截）
    await ev(`
      const st = window.__LMD_SETTINGS_STORE__;
      // 通过设置弹窗的 select 打开总开关（与用户操作一致）
      window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.settings" } }));
      await new Promise((r) => setTimeout(r, 1200));
      const en = document.querySelector('[data-testid="ai-enabled"]');
      if (en && en.value !== "on") {
        en.value = "on";
        en.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 600));
      // 关掉设置弹窗
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    `);
    await sleep(600);
    const aiOn = await ev(`
      const raw = localStorage.getItem("lightmd-settings");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.state ? parsed.state.aiEnabled : null;
    `);
    log(`[probe] aiEnabled=${aiOn}`);
    // 打开 AI 对话（并让输入框获得焦点 —— 这是最容易触发失效的状态）
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "ai.chat" } })); return true;`);
    await waitFor(`!!document.querySelector('[data-testid="ai-chat-dialog"]')`, 12000);
    await sleep(800);
    await ev(`
      const inp = document.querySelector('[data-testid="ai-chat-input"]');
      if (inp) inp.focus();
      return true;
    `);
    await sleep(400);

    const before = await ev(`return JSON.stringify(__qsSnapshot());`);
    log(`  初始快照：${before}`);

    // 找一段可拖选的正文几何
    const geo = await ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      const sc = document.querySelector(".editor-container");
      if (!pm || !sc) return null;
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.35);
      await new Promise((r) => setTimeout(r, 400));
      const paras = Array.from(pm.children).filter((c) => c.tagName === "P" && (c.textContent || "").includes("第 "));
      for (const p of paras) {
        const r = p.getBoundingClientRect();
        const scR = sc.getBoundingClientRect();
        if (r.top > scR.top + 120 && r.bottom < scR.bottom - 120 && r.width > 300) {
          return { x1: Math.round(r.left + 8), x2: Math.round(r.left + 200), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    `);
    log(`  拖选几何：${JSON.stringify(geo)}`);
    if (!geo) throw new Error("找不到可拖选段落");

    /** 读 chip 当前状态 */
    const chipNow = async () =>
      JSON.parse(await ev(`return JSON.stringify(__qsSnapshot());`));

    /** 清空选区：点视口下方空白（不落在段落上） */
    const clearSel = async () => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x1, y: geo.y + 260, button: "left", clickCount: 1, buttons: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x1, y: geo.y + 260, button: "left", clickCount: 1, buttons: 0 });
      await sleep(650);
    };


    /** 选第 k 个正文段落：先滚到视口中央再拖，返回是否真的选上 */
    const dragPara = async (k, fast = true) => {
      const g = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        const sc = document.querySelector(".editor-container");
        const paras = Array.from(pm.children).filter((c) => c.tagName === "P" && (c.textContent || "").includes("第 "));
        const p = paras[${k}];
        if (!p) return null;
        p.scrollIntoView({ block: "center" });
        await new Promise((r) => setTimeout(r, 350));
        const r = p.getBoundingClientRect();
        const scR = sc.getBoundingClientRect();
        if (r.top < scR.top + 60 || r.bottom > scR.bottom - 60) return null;
        return { x1: Math.round(r.left + 8), x2: Math.round(r.left + 170), y: Math.round(r.top + r.height / 2) };
      `);
      if (!g) return null;
      await drag(g, fast);
      await sleep(650);
      return g;
    };

    // ── 场景 M：多种「手快」时序，全部在打开对话窗且焦点曾落在输入框的状态下 ──
    const quickScenarios = [];
    const record = (name, ok, snap, extra = "") => {
      quickScenarios.push({ name, ok, snap, extra });
      log(`  [${name}] ${ok ? "PASS" : "FAIL"}  chip=${snap && snap.chipText} scope=${snap && snap.chipScope} domSelLen=${snap && snap.domSelLen} inDialog=${snap && snap.anchorInDialog} ${extra}`);
    };

    // M1：拖选后立刻（120ms）看 chip —— 用户手快，防抖可能还没跑
    await clearSel();
    await drag(geo, true);
    await sleep(120);
    const m1 = await chipNow();
    record("M1 选中后 120ms 立刻看 chip", m1.chipScope === "selection", m1, "（250ms 防抖未跑完属预期滞后，记录用）");

    // M2：拖选后 300ms 看（防抖刚过）
    await sleep(200);
    const m2 = await chipNow();
    record("M2 选中后 ~320ms", m2.chipScope === "selection", m2);

    // M3：选中后**立刻点击对话窗输入框**（用户手快去看输入框）再看 chip
    await clearSel();
    await drag(geo, true);
    await ev(`const i = document.querySelector('[data-testid="ai-chat-input"]'); if (i) i.focus(); return true;`);
    await sleep(700);
    const m3 = await chipNow();
    record("M3 选中后立刻点输入框", m3.chipScope === "selection", m3);

    // M4：双击选词（不拖拽）
    await clearSel();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x1 + 40, y: geo.y, button: "left", clickCount: 2, buttons: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x1 + 40, y: geo.y, button: "left", clickCount: 2, buttons: 0 });
    await sleep(700);
    const m4 = await chipNow();
    record("M4 双击选词", m4.chipScope === "selection" && /选区/.test(m4.chipText || ""), m4);

    // M5：键盘选字（点段落内 → Shift+Right 多次）
    await clearSel();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x1 + 10, y: geo.y, button: "left", clickCount: 1, buttons: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x1 + 10, y: geo.y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(500);
    for (let k = 0; k < 8; k++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, code: "ArrowRight", key: "ArrowRight", modifiers: 8 });
      await sleep(30);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, code: "ArrowRight", key: "ArrowRight", modifiers: 8 });
    }
    await sleep(700);
    const m5 = await chipNow();
    record("M5 Shift+方向键选字", m5.chipScope === "selection", m5);

    // M6：连续快速选**不同**段落（间隔 < 250ms 防抖）—— 用户"快速选中"最典型
    await clearSel();
    let m6fail = 0;
    for (let k = 0; k < 4; k++) {
      const g2 = await dragPara(k + 2, true);
      if (!g2) { log(`  [M6] 段落 ${k + 2} 不可见，跳过`); continue; }
      await sleep(120); // 故意不等防抖完
    }
    await sleep(800);
    const m6 = await chipNow();
    m6fail = m6.chipScope === "selection" ? 0 : 1;
    record("M6 连续快速选不同段落", m6.chipScope === "selection", m6);

    // M7：先选一段（chip=选区），**锁定**后点 chip 切全文，再快速选新段落（应解锁跟随）
    await clearSel();
    await drag(geo, true);
    await sleep(700);
    await ev(`document.querySelector('[data-testid="ai-chat-context-chip"]')?.click(); return true;`);
    await sleep(400);
    await clearSel();
    const g7 = await dragPara(7, true);
    if (!g7) log("  [M7] 段落 7 不可见，跳过");
    await sleep(800);
    const m7 = await chipNow();
    record("M7 手动锁定后快速选新段落（应解锁跟随）", m7.chipScope === "selection", m7);

    const qFails = quickScenarios.filter((x) => !x.ok && !x.name.startsWith("M1"));
    log("");
    log(`手快场景：${quickScenarios.length} 项，失败 ${quickScenarios.filter((x) => !x.ok).length} 项（M1 为防抖滞后记录项）`);

    // 交替 fast / slow 各 ROUNDS 次
    for (let round = 0; round < ROUNDS; round++) {
      const fast = round % 2 === 0;
      // 先把选区清掉（点空白处），确保每次都从「无选区」开始
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x1, y: geo.y + 220, button: "left", clickCount: 1, buttons: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x1, y: geo.y + 220, button: "left", clickCount: 1, buttons: 0 });
      await sleep(700);
      await drag(geo, fast);
      // 等足防抖窗口
      await sleep(600);
      const snap = JSON.parse(await ev(`return JSON.stringify(__qsSnapshot());`));
      const ok = snap.chipScope === "selection" && /选区/.test(snap.chipText || "");
      results.push({ round, fast, ok, snap });
      log(`  #${String(round + 1).padStart(2)} ${fast ? "fast" : "slow"}  ${ok ? "PASS" : "FAIL"}  chip=${snap.chipText} scope=${snap.chipScope} domSelLen=${snap.domSelLen} anchorInDialog=${snap.anchorInDialog} focusOn=${snap.inputFocused}`);
      await sleep(300);
    }

    const fastRuns = results.filter((r) => r.fast);
    const slowRuns = results.filter((r) => !r.fast);
    const failFast = fastRuns.filter((r) => !r.ok).length;
    const failSlow = slowRuns.filter((r) => !r.ok).length;
    log("");
    log(`快速拖选：${fastRuns.length} 次，失败 ${failFast} 次（失败率 ${(failFast / Math.max(1, fastRuns.length) * 100).toFixed(0)}%）`);
    log(`慢速拖选：${slowRuns.length} 次，失败 ${failSlow} 次（失败率 ${(failSlow / Math.max(1, slowRuns.length) * 100).toFixed(0)}%）`);

    const fails = results.filter((r) => !r.ok);
    if (fails.length) {
      log("");
      log("失败样本（前 6 条，用于归因）：");
      for (const r of fails.slice(0, 6)) {
        log(`  #${r.round + 1} ${r.fast ? "fast" : "slow"}: ${JSON.stringify(r.snap)}`);
      }
    }

    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ results, failFast, failSlow, rounds: ROUNDS, quickScenarios }, null, 2), "utf-8");
    log(`报告已写入：${OUT_TXT}`);

    cdp.close();
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  } catch (e) {
    log(`[probe] 失败：${String(e && e.message ? e.message : e)}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw e;
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

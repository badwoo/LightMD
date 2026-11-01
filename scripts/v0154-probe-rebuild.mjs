/**
 * LightMD v0.15.4 —— **微观探针**：一次按键 / 一次 Ctrl+Z 之后，「文档自动刷新」到底换了什么。
 *
 * v0154-probe-visual-jitter 已确认：阅读模式下输入 1 个字符，屏幕中央块**节点身份被换掉**、
 * 屏幕 Y 从 725.6 直接变 0（节点脱离 DOM）。这就是用户说的「文档自动刷新抖动一下」。
 *
 * 本探针只做一件事：把 `.ProseMirror` 的直接子节点打上稳定 id（`data-vj-id`），
 * 记录每次 childList 变更的 added/removed 节点名单，以及变更后还有多少个 id 存活。
 * - 若只有 1~2 个子节点变动 = 正常的局部重绘
 * - 若几十个子节点同时消失 = **整篇 doc 重建**（这才是抖动来源）
 *
 * 用法：node scripts/v0154-probe-rebuild.mjs
 * 环境变量：V0154R_PORT（默认 9304）、V0154R_EXE
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0154R_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0154R_PORT || 9304);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0154-probe-rebuild.txt");
const OUT_JSON = path.join(OUT_DIR, "v0154-probe-rebuild.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";

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
  const hash = m[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hash, "utf-8"))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${hash}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hash}`);
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
            }, 30000);
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
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

function makeDoc() {
  const p = ["# 重建取证", ""];
  for (let i = 1; i <= 40; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(`第 ${i}.${j} 段：这一段刻意写长，让两个面都产生可滚动内容。`);
      p.push("");
    }
  }
  return p.join("\n");
}

const PAGE_TOOLS = String.raw`
/** 给 .ProseMirror 直接子节点打稳定标记，并用 MutationObserver 记录变更名单 */
window.__rbArm = function () {
  const pm = document.querySelector(".editor-container .ProseMirror");
  if (!pm) return { ok: false, why: "no-pm" };
  window.__rbPm = pm;
  window.__rbLog = [];
  window.__rbSeq = 0;
  for (const child of pm.children) {
    if (!child.dataset) continue;
    if (!child.getAttribute("data-rb-id")) child.setAttribute("data-rb-id", String(++window.__rbSeq));
  }
  window.__rbBaseline = Array.from(pm.children).map((c) => c.getAttribute("data-rb-id"));
  if (window.__rbObs) { try { window.__rbObs.disconnect(); } catch (e) {} }
  window.__rbObs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type !== "childList") {
        window.__rbLog.push({ t: +performance.now().toFixed(1), type: r.type, attr: r.attributeName || null, target: r.target && r.target.nodeName });
        continue;
      }
      const added = Array.from(r.addedNodes || []).map((n) => ({
        name: n.nodeName,
        id: n.getAttribute ? n.getAttribute("data-rb-id") : null,
        text: (n.textContent || "").replace(/\s+/g, "").slice(0, 20),
      }));
      const removed = Array.from(r.removedNodes || []).map((n) => ({
        name: n.nodeName,
        id: n.getAttribute ? n.getAttribute("data-rb-id") : null,
        text: (n.textContent || "").replace(/\s+/g, "").slice(0, 20),
      }));
      window.__rbLog.push({ t: +performance.now().toFixed(1), type: "childList", added, removed });
    }
  });
  window.__rbObs.observe(pm, { childList: true, subtree: true, attributes: true });
  return { ok: true, children: pm.children.length, seq: window.__rbSeq };
};

window.__rbReport = function () {
  const pm = document.querySelector(".editor-container .ProseMirror");
  const now = pm ? Array.from(pm.children).map((c) => c.getAttribute("data-rb-id")) : [];
  const before = window.__rbBaseline || [];
  const survivors = before.filter((id) => now.includes(id)).length;
  const childListTop = (window.__rbLog || []).filter(
    (r) => r.type === "childList" && r.removed && r.removed.length > 0,
  );
  const topRemoved = childListTop.reduce((a, b) => a + b.removed.length, 0);
  const topAdded = childListTop.reduce((a, b) => a + b.added.length, 0);
  return JSON.stringify({
    beforeCount: before.length,
    nowCount: now.length,
    survivors,
    topLevelReplaceEvents: childListTop.length,
    topRemovedCount: topRemoved,
    topAddedCount: topAdded,
    attrEvents: (window.__rbLog || []).filter((r) => r.type === "attributes").length,
    charEvents: (window.__rbLog || []).filter((r) => r.type === "characterData").length,
    detail: (window.__rbLog || []).slice(0, 12),
  });
};

window.__rbKey = function (key, code, ctrl) {
  const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-rebuild-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "rebuild.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(1200);

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
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const doubleCtrl = async () => {
    await ev(`
      await new Promise((r) => setTimeout(r, 320));
      __rbKey("Control", "ControlLeft", false);
      await new Promise((r) => setTimeout(r, 60));
      __rbKey("Control", "ControlLeft", false);
      return true;
    `);
  };

  const modeNow = () =>
    ev(`
      const sc = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
    `);

  const report = async (label) => {
    const r = JSON.parse(await ev(`return __rbReport();`));
    log(`  ${label}：子节点 ${r.beforeCount} → ${r.nowCount}，存活 ${r.survivors}；顶层替换事件 ${r.topLevelReplaceEvents}（removed ${r.topRemovedCount} / added ${r.topAddedCount}），attr ${r.attrEvents}，char ${r.charEvents}`);
    for (const d of r.detail.slice(0, 8)) {
      log(`      ${JSON.stringify(d)}`);
    }
    return r;
  };

  try {
    const probeMark = "第 5.1 段";
    let loaded = false;
    for (let a = 0; a < 25 && !loaded; a++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        if (!pm) return false;
        return (pm.textContent || "").indexOf(${JSON.stringify(probeMark)}) >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入（判定会失真，中止）");
    log("[probe] 文档已装入");
    await sleep(900);

    // 阅读模式
    let mode = await modeNow();
    if (mode !== "preview") {
      await doubleCtrl();
      await sleep(1400);
    }
    log("");
    log("════════ 阅读模式：一次按键 ══════");
    await ev(`
      const sc = document.querySelector(".editor-container");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.45);
      sc.dispatchEvent(new Event("scroll", { bubbles: false }));
      return sc.scrollTop;
    `);
    await sleep(700);
    const rect = await ev(`
      const sc = document.querySelector(".editor-container");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.round(r.height / 2)) };
    `);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await sleep(500);
    const armed = await ev(`return JSON.stringify(__rbArm());`);
    log(`  已装观察器：${armed}`);
    await cdp.send("Input.insertText", { text: "字" });
    await sleep(700);
    const rTyping = await report("输入 1 字后");
    check(
      "R1-PM 输入：顶层子节点存活率 ≥ 95%（整篇重建会让存活率暴跌）",
      rTyping.beforeCount > 0 && rTyping.survivors / rTyping.beforeCount >= 0.95,
      `存活 ${rTyping.survivors}/${rTyping.beforeCount}`,
    );
    check(
      "R2-PM 输入：顶层 removed 节点数 ≤ 2",
      rTyping.topRemovedCount <= 2,
      `removed=${rTyping.topRemovedCount} added=${rTyping.topAddedCount}`,
    );

    log("");
    log("════════ 阅读模式：一次 Ctrl+Z ══════");
    await sleep(400);
    await ev(`__rbArm(); return true;`);
    await ev(`__rbKey("z", "KeyZ", true); return true;`);
    await sleep(700);
    const rUndo = await report("撤销后");
    check(
      "R3-PM 撤销：顶层子节点存活率 ≥ 95%",
      rUndo.beforeCount > 0 && rUndo.survivors / rUndo.beforeCount >= 0.95,
      `存活 ${rUndo.survivors}/${rUndo.beforeCount}`,
    );
    check(
      "R4-PM 撤销：顶层 removed 节点数 ≤ 2",
      rUndo.topRemovedCount <= 2,
      `removed=${rUndo.topRemovedCount} added=${rUndo.topAddedCount}`,
    );

    // 源码模式（textarea 没有 DOM 块，改为量 value 重设 + 段落节点无意义 → 用 scrollHeight 变化次数）
    log("");
    log("════════ 源码模式：一次按键 ══════");
    mode = await modeNow();
    if (mode !== "edit") {
      await doubleCtrl();
      await sleep(1400);
    }
    const srcBefore = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      ta.focus();
      ta.scrollTop = Math.round((ta.scrollHeight - ta.clientHeight) * 0.45);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
      const approx = Math.round((ta.scrollTop + ta.clientHeight / 2) / lh);
      const ls = ta.value.split("\\n");
      let pick = Math.max(0, Math.min(ls.length - 1, approx));
      for (let k = 0; k < 80; k++) {
        const cand = pick + (k % 2 === 0 ? k / 2 : -Math.ceil(k / 2));
        if (cand < 0 || cand >= ls.length) continue;
        const t = (ls[cand] || "").trim();
        if (t && !"#|>-:".includes(t.charAt(0))) { pick = cand; break; }
      }
      let pos = 0;
      for (let i = 0; i < pick; i++) pos += ls[i].length + 1;
      pos += Math.min(ls[pick].length, 8);
      ta.setSelectionRange(pos, pos);
      window.__rbSrcSH = [];
      const t0 = performance.now();
      const tick = () => {
        window.__rbSrcSH.push({ t: +(performance.now() - t0).toFixed(1), sh: ta.scrollHeight, top: +ta.scrollTop.toFixed(2), val: ta.value.length });
        if (performance.now() - t0 < 700) setTimeout(tick, 16);
      };
      tick();
      return { pick, pos, top: ta.scrollTop };
    `);
    log(`  光标落点：${JSON.stringify(srcBefore)}`);
    await cdp.send("Input.insertText", { text: "字" });
    await sleep(820);
    const srcAfter = JSON.parse(await ev(`return JSON.stringify(window.__rbSrcSH || []);`));
    const shChanges = srcAfter.filter((s, i) => i > 0 && s.sh !== srcAfter[i - 1].sh).length;
    const tops = srcAfter.map((s) => s.top);
    let rev = 0;
    let lastDir = 0;
    for (let i = 1; i < tops.length; i++) {
      const d = tops[i] - tops[i - 1];
      if (Math.abs(d) < 0.5) continue;
      const dir = Math.sign(d);
      if (lastDir !== 0 && dir !== lastDir) rev++;
      lastDir = dir;
    }
    const span = tops.length ? Math.max(...tops) - Math.min(...tops) : 0;
    log(`  源码输入：scrollHeight 变化 ${shChanges} 次，scrollTop 振幅 ${span.toFixed(2)}px，反转 ${rev} 次`);
    log(`    top 序列：${JSON.stringify(tops.slice(0, 20).map((v) => +v.toFixed(1)))}`);
    check("R5-SRC 输入：scrollHeight 变化 ≤ 1 次（多次 = 内容被整体重写）", shChanges <= 1, `变化=${shChanges}`);
    check("R6-SRC 输入：scrollTop 反转 = 0", rev === 0, `反转=${rev} 振幅=${span.toFixed(2)}px`);

    const pass = checks.filter((c) => c.ok).length;
    log("");
    log(`结论：${pass} PASS / ${checks.length - pass} FAIL`);
    log(`报告已写入：${OUT_TXT}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ checks, rTyping, rUndo }, null, 2), "utf-8");
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

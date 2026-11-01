/**
 * LightMD v0.15.4 —— **归因探针**：抓「整篇 ProseMirror 重建」的 JS 调用栈。
 *
 * 上游探针（`v0154-probe-rebuild.mjs`）已确认：阅读模式下**输入 1 个字符**或**按一次 Ctrl+Z**，
 * `.editor-container .ProseMirror` 的 161 个顶层子节点**全部被换掉**（存活 0/161）。
 * 这就是用户说的「文档自动刷新抖动一下」。
 *
 * 本探针用最直接的办法归因：hook `Node.prototype.insertBefore / removeChild / replaceChild`，
 * 只对 `.ProseMirror` 目标的调用记录 `new Error().stack`。整篇重建时第一个到达的调用栈
 * 就是真凶（PM 的 DOM 更新器在 `updateState` 内同步跑，栈里能直接看到调用者）。
 *
 * 用法：node scripts/v0154-probe-rebuild-stack.mjs
 * 环境变量：V0154S_PORT（默认 9305）、V0154S_EXE、V0154S_ACTION=type|undo
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0154S_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0154S_PORT || 9305);
const ACTION = process.env.V0154S_ACTION || "type";
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0154-probe-rebuild-stack.txt");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}`);
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
  const p = ["# 归因取证", ""];
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
window.__stInstall = function () {
  if (window.__stOn) return "already";
  window.__stOn = true;
  window.__stLog = [];
  const isPmTarget = (node) => {
    try {
      if (!node) return false;
      const pm = window.__stPm;
      if (!pm) return false;
      if (node === pm) return true;
      // 父节点是 .ProseMirror（顶层替换）
      return node.nodeType === 1 && node.parentNode === pm;
    } catch (e) { return false; }
  };
  const wrap = (proto, name) => {
    const orig = proto[name];
    if (!orig || orig.__stWrapped) return;
    const wrapped = function (...args) {
      try {
        if (window.__stArmed && isPmTarget(this)) {
          const st = (new Error().stack || "").split("\n").slice(1, 12).map((s) => s.trim().slice(0, 160));
          window.__stLog.push({ op: name, t: +performance.now().toFixed(1), frames: st });
        }
      } catch (e) {}
      return orig.apply(this, args);
    };
    wrapped.__stWrapped = true;
    proto[name] = wrapped;
  };
  wrap(Node.prototype, "insertBefore");
  wrap(Node.prototype, "removeChild");
  wrap(Node.prototype, "replaceChild");
  wrap(Node.prototype, "appendChild");
  return "installed";
};

window.__stArm = function (ms) {
  window.__stPm = document.querySelector(".editor-container .ProseMirror");
  window.__stLog = [];
  window.__stArmed = true;
  window.__stT0 = performance.now();
  setTimeout(() => { window.__stArmed = false; }, ms);
  return !!window.__stPm;
};

window.__stDump = function () {
  return JSON.stringify((window.__stLog || []).slice(0, 40));
};
window.__stCount = function () {
  return JSON.stringify({ n: (window.__stLog || []).length, ops: (window.__stLog || []).reduce((a, b) => { a[b.op] = (a[b.op] || 0) + 1; return a; }, {}) });
};
window.__stKey = function (key, code, ctrl) {
  const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-rebuildstack-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "rebuild-stack.md");
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
    if (!loaded) throw new Error("文档未装入");
    log("[probe] 文档已装入");
    await sleep(900);

    const mode = await ev(`
      const sc = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
    `);
    log(`[probe] 模式=${mode}`);
    if (mode !== "preview") {
      await ev(`
        await new Promise((r) => setTimeout(r, 320));
        __stKey("Control", "ControlLeft", false);
        await new Promise((r) => setTimeout(r, 60));
        __stKey("Control", "ControlLeft", false);
        return true;
      `);
      await sleep(1400);
    }

    const inst = await ev(`return __stInstall();`);
    log(`[probe] 归因探针：${inst}`);

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

    log("");
    if (ACTION === "union") {
      // 输入 + 撤销各抓一次，合并看
      await ev(`__stArm(900); return true;`);
      await cdp.send("Input.insertText", { text: "字" });
      await sleep(900);
      log("── 输入 1 字：调用栈 ──");
      const d1 = JSON.parse(await ev(`return __stDump();`));
      const c1 = JSON.parse(await ev(`return __stCount();`));
      log(`  调用次数：${JSON.stringify(c1.ops)} 总 ${c1.n}`);
      for (const r of d1.slice(0, 6)) {
        log(`  [${r.op} @${r.t}]`);
        for (const f of r.frames.slice(0, 9)) log(`     ${f}`);
      }
      await sleep(400);
      await ev(`__stArm(900); return true;`);
      await ev(`__stKey("z", "KeyZ", true); return true;`);
      await sleep(900);
      log("── Ctrl+Z：调用栈 ──");
      const d2 = JSON.parse(await ev(`return __stDump();`));
      const c2 = JSON.parse(await ev(`return __stCount();`));
      log(`  调用次数：${JSON.stringify(c2.ops)} 总 ${c2.n}`);
      for (const r of d2.slice(0, 6)) {
        log(`  [${r.op} @${r.t}]`);
        for (const f of r.frames.slice(0, 9)) log(`     ${f}`);
      }
    } else {
      await ev(`__stArm(900); return true;`);
      if (ACTION === "undo") await ev(`__stKey("z", "KeyZ", true); return true;`);
      else await cdp.send("Input.insertText", { text: "字" });
      await sleep(900);
      log(`── 动作 ${ACTION}：调用栈 ──`);
      const d = JSON.parse(await ev(`return __stDump();`));
      const c = JSON.parse(await ev(`return __stCount();`));
      log(`  调用次数：${JSON.stringify(c)}`);
      for (const r of d.slice(0, 8)) {
        log(`  [${r.op} @${r.t}]`);
        for (const f of r.frames.slice(0, 10)) log(`     ${f}`);
      }
    }

    log(`报告已写入：${OUT_TXT}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
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

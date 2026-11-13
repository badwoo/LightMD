/**
 * LightMD v0.17.0 复核期 —— **共享实机探针骨架**（Lead 所有，队友只读使用）
 *
 * ## 为什么需要这个文件
 *
 * 1. **单实例限制**：`src-tauri` 启用了 `tauri-plugin-single-instance`，
 *    第二个 `lightmd.exe` 进程会立刻 forward argv 给主实例并 `exit(0)`。
 *    实测：并发起 3 个实例 → 只有 1 个能连上 CDP，另外两个 `code=0` 秒退。
 *    所以**同一时刻只能跑一个探针**，必须用跨进程锁串行化。
 *
 * 2. **WebView2 版本坑**：本机 WebView2 是 Edg/157，CDP 握手要求
 *    `--remote-allow-origins=*`，否则 `/json/list` 拿得到、WebSocket 连不上。
 *    现有 `v0170-probe-*.mjs` 都没带这个参数 —— 在本机会全部连不上（历史产物是旧 WebView2 跑的）。
 *
 * 3. 现有探针结尾都有 `taskkill /F /IM lightmd.exe` —— 会**误杀用户自己装的那份 LightMD**
 *    （`%LOCALAPPDATA%\LightMD\lightmd.exe`，实测确实在跑）。本骨架只杀自己 spawn 的 PID。
 *
 * ## 用法
 *
 * ```js
 * import { runProbe } from "./_lib/probe-harness.mjs";
 *
 * await runProbe({
 *   name: "v0170-probe-xxx",
 *   doc: "# 标题\n\n正文…",       // 探针文档内容
 *   docTitle: "标题",             // 用于确认装入成功的关键词
 * }, async (ui) => {
 *   ui.add("1", "判定名", "PASS", "细节");
 *   const text = await ui.readCmText();
 *   await ui.shot("after-edit");  // 截图存 _verify-out/shots/
 * });
 * ```
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const ROOT = "D:\\AI\\markdown view\\lightmd";
/**
 * ⚠️ v0.17.0 第二轮新增的**必需前提**（Lead 实测，别跳过）
 *
 * `tauri-plugin-single-instance` 在 Windows 上用 Win32 互斥量 `{identifier}-sim` 判重，
 * 而用户自己装的 LightMD（`%LOCALAPPDATA%\LightMD\lightmd.exe`）常常常驻。
 * 一旦它在跑，本仓库 spawn 的 `release/lightmd.exe`（同 identifier `com.lightmd.app`）
 * **立刻 code=0 退出** —— 表现为"应用提前退出（code=0）"，而不是任何可读错误。
 *
 * 解法（一次性，之后所有探针通用）：
 * ```bash
 * cmd /c '"C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && \
 *   npx tauri build --no-bundle -c _plan/probe-config.json'
 * ```
 * `_plan/probe-config.json` 把 `identifier` 换成 `com.lightmd.probe`、关掉 bundle，
 * 产物仍落在同一路径 `src-tauri/target/release/lightmd.exe` → 本骨架无需改路径。
 *
 * ⚠️ 这个产物**不能用来发布**（identifier 不同、且未打包）。发版前必须
 * 不带 `-c` 重新 `npx tauri build`（或 `--no-bundle` 出正式 exe）。
 */
export const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
export const OUT_DIR = path.join(ROOT, "_verify-out");
export const SHOT_DIR = path.join(OUT_DIR, "shots");
export const LOCK_FILE = path.join(OUT_DIR, ".lmd-probe.lock");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

/* ─────────────────────────── 跨进程锁 ─────────────────────────── */

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

/** 清掉死进程留下的锁（进程已不在 → 锁必然失效） */
function clearStaleLock() {
  const l = readLock();
  if (!l) return false;
  if (l.pid && pidAlive(l.pid)) return false;
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  return true;
}

/**
 * 获取锁：`wx` 打开保证原子性。
 * 超时默认 20 分钟（单个探针通常 < 3 分钟，留足余量给排队）。
 */
async function acquireLock(owner, timeoutMs = 20 * 60 * 1000) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  let announced = false;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeSync(fd, JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } };
    } catch {
      clearStaleLock();
      const cur = readLock();
      if (!announced) {
        console.log(`[lock] 等待中的锁持有者：${cur ? `${cur.owner} (pid ${cur.pid})` : "未知"}`);
        announced = true;
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`获取实例锁超时（${Math.round(timeoutMs / 1000)}s）；持有者=${cur ? cur.owner : "未知"}`);
      }
      await sleep(1500);
    }
  }
}

/* ─────────────────────────── 端口 ─────────────────────────── */

async function portFree(port) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(false); });
    s.on("error", () => res(true));
    s.setTimeout(600, () => { s.destroy(); res(true); });
  });
}

/** 在 9700-9899 里找一个空闲端口（避开历史探针用的 9418/9472/9480） */
export async function pickPort() {
  for (let i = 0; i < 60; i++) {
    const p = 9700 + Math.floor(Math.random() * 200);
    if (await portFree(p)) return p;
  }
  throw new Error("找不到空闲调试端口");
}

/* ─────────────────────────── CDP ─────────────────────────── */

function wsConnect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => res({
      send(method, params) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((a, b) => {
          pending.set(i, { a, b });
          setTimeout(() => { if (pending.delete(i)) b(new Error("CDP timeout: " + method)); }, 45000);
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    }));
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error).slice(0, 300))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("CDP ws error")));
    setTimeout(() => rej(new Error("CDP ws open timeout")), 30000);
  });
}

/* ─────────────────────────── 主入口 ─────────────────────────── */

/**
 * @param {object} opts
 * @param {string} opts.name      探针名（决定产物文件名，必须唯一，避免队友互相覆盖）
 * @param {string} opts.doc       测试文档内容
 * @param {string} [opts.docTitle] 用于确认装入成功的关键词（默认取 doc 第一行去掉 #）
 * @param {number} [opts.viewMode] "edit"（默认，编辑+分屏）| "read"（阅读）| "raw"（不动）
 * @param {number} [opts.bootTimeoutMs]
 * @param {string} [opts.profileDir] ⚠️ **v0.17.0 第二轮新增（可选，向后兼容）**
 *   复用指定的 WebView2 `WEBVIEW2_USER_DATA_FOLDER`。
 *
 *   ## 为什么需要（#10「重启后恢复」必须真机验）
 *   默认行为是每次 `fs.mkdtempSync` 新建 profile → **localStorage 是空的**。
 *   要测"关掉软件再打开"，必须让两个进程共用**同一个 profile 目录**
 *   （localStorage / IndexedDB 都落在 profile 里）。
 *
 *   ## 用法（两步，同一个 profile）
 *   ```js
 *   const profile = await makeProfileDir("coldstart");
 *   await runProbe({ ...opts, profileDir: profile, name: "a" }, async (ui) => { ...改模式、滚动... });
 *   await runProbe({ ...opts, profileDir: profile, name: "b" }, async (ui) => { ...读恢复结果... });
 *   ```
 *   两次调用之间**必须**确保上一个实例已完全退出（`runProbe` 的 finally 会 taskkill
 *   整个进程树并等端口释放，已覆盖）。
 *
 *   ⚠️ 同一个 profile 不能被两个实例**同时**打开（WebView2 会拒绝并复用/崩溃），
 *   所以必须顺序执行 —— 本骨架的跨进程锁不保护 profile 维度，调用方自己保证串行。
 * @param {string} [opts.keepProfile] 为 true 时不删 profile（调试用；默认随 tmp 保留，
 *   `profileDir` 由调用方创建时也不会被本骨架删除）
 */
export async function runProbe(opts, body) {
  const {
    name,
    doc,
    docTitle = (doc.match(/[^\n#*\s][^\n]*/) || ["文档"])[0].slice(0, 12),
    viewMode = "edit",
    bootTimeoutMs = 90000,
    profileDir = null,
  } = opts;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const lines = [];
  const log = (t = "") => { lines.push(t); console.log(t); };
  const results = [];
  const add = (id, name_, status, detail) => {
    results.push({ id, name: name_, status, detail });
    const tag = status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL ";
    log(`${tag} [${id}] ${name_}${detail ? ` — ${detail}` : ""}`);
  };

  const release = await acquireLock(name);
  log(`[probe] ${name} 已获得实例锁`);

  // exe 内联 dist 一致性（沿用 §4-30 铁律）
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!hm) throw new Error("dist/index.html 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(hm[1]))) {
    throw new Error(`exe 内联 dist 不一致（找不到 ${hm[1]}）→ 需重新 npx tauri build --no-bundle`);
  }
  log(`[probe] dist 入口 ${hm[1]}（exe 内联一致）`);

  const tmp = profileDir
    ? path.dirname(profileDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "lmd-probe-"));
  const profile = profileDir ?? path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, `${name}.md`);
  fs.writeFileSync(docFile, doc, "utf8");
  log(`[probe] 文档 ${doc.length} 字符 / ${doc.split("\n").length} 行`);
  log(`[probe] profile = ${profile}${profileDir ? "（复用，跨实例保留 localStorage）" : "（新建）"}`);

  const port = await pickPort();
  let child = null;
  let cdp = null;
  let ui = null;

  const killSelf = () => {
    try { child?.kill(); } catch { /* ignore */ }
    try { if (child?.pid) process.kill(child.pid, "SIGKILL"); } catch { /* ignore */ }
    // 只杀本实例的 WebView2 子进程树（按 UserDataFolder 匹配不到，改用 pid 树）
    if (child?.pid) {
      try {
        // Windows: 杀整个进程树，避免残留 msedgewebview2 占据端口
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      } catch { /* ignore */ }
    }
  };

  try {
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        // ⚠️ --remote-allow-origins=* 是本机 WebView2 157 的必需项
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
      stdio: "ignore",
    });
    const exited = { v: false, code: null };
    child.on("exit", (c) => { exited.v = true; exited.code = c; });

    const t0 = Date.now();
    for (let i = 0; i < 400 && !cdp; i++) {
      if (exited.v) {
        throw new Error(
          `应用提前退出（code=${exited.code}）—— 若提示单实例冲突，说明有别的 LightMD 实例在跑，` +
          `或锁未生效/残留进程未清`,
        );
      }
      if (Date.now() - t0 > bootTimeoutMs) throw new Error(`启动超时 ${bootTimeoutMs}ms`);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const c = await wsConnect(t.webSocketDebuggerUrl).catch(() => null);
          if (!c) continue;
          await c.send("Runtime.enable").catch(() => {});
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true }).catch(() => null);
          if (r?.result?.result?.value) { cdp = c; break; }
          c.close();
        }
      } catch { /* not ready */ }
      if (!cdp) await sleep(300);
    }
    if (!cdp) throw new Error("找不到 CDP target");
    log(`[probe] CDP 已连接（port ${port}，启动 ${Date.now() - t0}ms）`);

    await cdp.send("Page.enable").catch(() => {});

    const ev = async (bodyRaw) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${bodyRaw} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error("页面内异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 700));
      }
      return r.result?.result?.value;
    };

    /* ── 装文档 ── */
    let loaded = false;
    for (let i = 0; i < 30 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(doc)} },
        }));
        return true;
      `);
      await sleep(550);
      loaded = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
        return !!pm && (pm.textContent || "").indexOf(${JSON.stringify(docTitle)}) >= 0;
      `);
    }
    if (!loaded) throw new Error(`文档未装入（找不到关键词「${docTitle}」）`);

    /* ── 视图模式 ── */
    if (viewMode === "edit") {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
      await sleep(2400);
      const split = await ev(`return !!document.querySelector("iframe.split-preview")`);
      if (!split) {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
        await sleep(1800);
      }
    } else if (viewMode === "read") {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.read" } })); return true;`);
      await sleep(2200);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : (document.querySelector("textarea.source-editor") || document.querySelector("textarea") ? "textarea" : "none")`);
    log(`[probe] 源码面实现 = ${impl}`);

    // 未捕获异常收集
    await ev(`
      window.__ERRS = [];
      window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
      window.onunhandledrejection = (e) => window.__ERRS.push("rejection:" + String(e.reason && e.reason.message || e.reason));
      return true;
    `);

    /* ── 构造 ui 对象 ── */
    ui = {
      name, doc, docFile, port, impl,
      ev, cdp, log, add, results, lines, sleep,
      fs, path,

      /** 当前源码面文本（CM6 读 .cm-line，textarea 读 value） */
      async readSourceText() {
        return await ev(`
          const cm = document.querySelector(".cm-editor");
          if (cm) return Array.from(cm.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n");
          const ta = document.querySelector("textarea.source-editor") || document.querySelector("textarea");
          return ta ? ta.value : null;
        `);
      },

      /** 预览 iframe（分屏右屏）正文 */
      async readPreviewText() {
        return await ev(`
          const f = document.querySelector("iframe.split-preview");
          const d = f && f.contentDocument;
          if (!d || !d.body) return null;
          return (d.body.textContent || "").replace(/\\s+/g, " ").trim();
        `);
      },

      /** 阅读模式 ProseMirror 正文 */
      async readPmText() {
        return await ev(`
          const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
          return pm ? (pm.textContent || "").replace(/\\s+/g, " ").trim() : null;
        `);
      },

      /** 当前 docZoom（CSS 变量） */
      async readDocZoom() {
        return await ev(`
          const v = getComputedStyle(document.documentElement).getPropertyValue("--doc-zoom").trim();
          return v;
        `);
      },

      /** 焦点进源码面 */
      async focusSource() {
        await ev(`
          const cm = document.querySelector(".cm-content");
          if (cm) { cm.focus(); return true; }
          const ta = document.querySelector("textarea.source-editor") || document.querySelector("textarea");
          if (ta) { ta.focus(); return true; }
          return false;
        `);
        await sleep(250);
      },

      /** 派发命令总线命令 */
      async command(id) {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: ${JSON.stringify(id)} } })); return true;`);
      },

      /**
       * 真实按键（CDP）。
       *
       * ⚠️ 2026-11-10 修正：**单字符可打印键必须带 `text`**，否则 keyDown 只带
       * `windowsVirtualKeyCode` 不会产生任何字符输入。此前本方法漏了 `text`，
       * 导致用 `ui.key("1", …)` 打字的探针「0 个字符落地」，被误读成产品缺陷。
       *
       * 规则（与 CM6 的真实受理路径一致）：
       * - 单字符且非修饰键 → 发 `keyDown`(带 text) + `keyUp`（**不要**再发 `char`，会重复插入）
       * - 功能键（Enter/Tab/方向键/Esc…）→ 不带 text
       * - 组合键（modifiers !== 0）→ 不带 text，由浏览器/应用自行消费
       */
      async key(key, code, vk, modifiers = 0) {
        const isPrintable = key.length === 1 && modifiers === 0;
        const base = {
          key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
          ...(isPrintable ? { text: key, unmodifiedText: key } : {}),
        };
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
        await sleep(35);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        await sleep(60);
      },

      /**
       * 输入一段文本（优先 Input.insertText，失败逐字符）。
       *
       * ⚠️ 2026-11-10 修正（D 流实测发现）：**只对源码面（CM6/textarea）有效**。
       * 该方法用 `readSourceText()` 校验落地，而 `readSourceText()` 只读源码面，
       * 所以对**搜索框 / 对话框输入框**等非源码面元素：
       * 1. 校验恒失败 → 走逐字符兜底 → **文本被重复写入**
       *    （实测：向搜索框输入 "ABC" → 值变成 "ABCABCSEARCHNEEDLE"）；
       * 2. 兜底里的 `Input.dispatchKeyEvent` 与 insertText 都打到焦点元素上，可能双重写入。
       *
       * 结论：**非源码面的输入框，请直接 `await ui.cdp.send("Input.insertText", { text })`**
       * （先 focus 目标元素），不要用本方法。
       */
      async typeText(text) {
        await cdp.send("Input.insertText", { text });
        await sleep(250);
        const t = await ui.readSourceText();
        if (t && t.includes(text)) return true;
        for (const ch of text) {
          await cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, code: "", text: ch, unmodifiedText: ch });
          await sleep(90);
        }
        await sleep(250);
        return false;
      },

      /**
       * 向**任意输入框**（搜索框 / 对话框 input 等）原子写入文本。
       *
       * 与 `typeText` 的区别：只发一次 `Input.insertText`，**不做源码面校验、不逐字符兜底**
       * —— 这正是 D 流踩过的坑（校验对象不对 → 重复写入）。
       *
       * @param selector 目标 input/textarea 的 CSS 选择器；省略则写入当前焦点元素
       */
      async typeInto(selector, text) {
        if (selector) {
          await ev(`
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el) { el.focus(); el.select && el.select(); }
            return !!el;
          `);
          await sleep(120);
        }
        await cdp.send("Input.insertText", { text });
        await sleep(350);
        return await ev(`
          const el = document.activeElement;
          return el && typeof el.value === "string" ? el.value : null;
        `);
      },

      /** 截图（存 _verify-out/shots/<name>-<label>.png） */
      async shot(label) {
        try {
          const r = await cdp.send("Page.captureScreenshot", { format: "png" });
          const b64 = r.result?.data;
          if (!b64) return null;
          const p = path.join(SHOT_DIR, `${name}-${label}.png`);
          fs.writeFileSync(p, Buffer.from(b64, "base64"));
          log(`[probe] 截图 → ${p}`);
          return p;
        } catch (e) {
          log(`[probe] 截图失败：${String(e.message).slice(0, 120)}`);
          return null;
        }
      },

      /** 未捕获异常 */
      async errors() {
        return await ev(`return window.__ERRS || []`);
      },

      /** 等某个条件成立 */
      async waitFor(fnBody, timeoutMs = 10000, intervalMs = 300) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const v = await ev(fnBody);
          if (v) return v;
          await sleep(intervalMs);
        }
        return null;
      },
    };

    await body(ui);

    const errs = await ui.errors();
    add("Z9", "全程无未捕获异常", errs.length === 0 ? "PASS" : "FAIL", errs.length ? JSON.stringify(errs.slice(0, 3)) : "无");
  } catch (err) {
    log(`[probe] 异常：${err?.message || String(err)}`);
    results.push({ id: "E", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    killSelf();
    await sleep(900);
    // 等端口真正释放
    for (let i = 0; i < 20; i++) { if (await portFree(port)) break; await sleep(250); }
    release();
    log("[probe] 已释放实例锁");

    const pass = results.filter((r) => r.status === "PASS").length;
    const known = results.filter((r) => r.status === "KNOWN").length;
    const fail = results.filter((r) => r.status === "FAIL").length;
    log("");
    log(`[probe] PASS=${pass} KNOWN=${known} FAIL=${fail}`);

    const outTxt = path.join(OUT_DIR, `${name}.txt`);
    const outJson = path.join(OUT_DIR, `${name}.json`);
    fs.writeFileSync(outTxt, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(outJson, JSON.stringify({
      generatedAt: new Date().toISOString(),
      probe: name,
      doc: { chars: doc.length, lines: doc.split("\n").length },
      results,
    }, null, 1), "utf8");
    log(`[probe] 产物：${outJson}`);
    if (fail > 0) process.exitCode = 1;
  }
}

/* ─────────────────────── 判据辅助 ─────────────────────── */

/**
 * v0.17.0 第二轮新增（可选，向后兼容）：创建一个**可跨 runProbe 调用复用**的 profile 目录。
 *
 * 用途见 `runProbe` 的 `opts.profileDir` 注释 —— 测"关软件再打开"必须复用同一
 * `WEBVIEW2_USER_DATA_FOLDER`，否则 localStorage 是空的。
 *
 * ⚠️ 调用方负责顺序（同一 profile 不允许两个实例同时打开）。
 *
 * @param {string} tag 目录名标签（便于在 %TEMP% 里认出是谁的）
 * @returns {string} profile 的绝对路径
 */
export function makeProfileDir(tag = "reuse") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lmd-profile-${tag}-`));
  fs.mkdirSync(dir, { recursive: true });
  console.error(`[probe] 新建复用 profile：${dir}`);
  return dir;
}

/** 三档判定：好/可接受/坏 */
export function grade(good, acceptable, detailGood, detailOk, detailBad) {
  if (good) return ["PASS", detailGood];
  if (acceptable) return ["KNOWN", detailOk];
  return ["FAIL", detailBad];
}

/** 中位数 */
export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

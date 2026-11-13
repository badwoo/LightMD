/**
 * 浏览器内探针骨架（v0.17.0 第二轮）
 *
 * ## 为什么需要它（本轮新发现的阻塞）
 *
 * `tauri-plugin-single-instance` 用 Win32 互斥量 `{identifier}-sim` 判重。
 * 用户自己装了 LightMD（`%LOCALAPPDATA%\LightMD\lightmd.exe`）并在跑 →
 * 探针 spawn 的 release exe **立刻 code=0 退出**（实测），整个实机探针链路阻塞。
 *
 * 解法：`dist/` 是纯前端（Tauri 侧能力都有 `isTauri()` 守卫），
 * 用 Chromium 打开同一份 `dist/` 即可跑几何/样式/状态类判定：
 * - 覆盖：#1 插入符号颜色、#4 专注遮罩、#5 页面框线、#11 模式过渡、#12 预览开合抖动
 * - 不覆盖：真实文件写盘、Rust 命令、WebView2 特有行为（这些仍须最终在 exe 上复验）
 *
 * ⚠️ 与真机探针的差异必须在最终报告里写明，不能用浏览器结果冒充实机结论。
 *
 * ## 用法
 * ```js
 * import { runBrowserProbe } from "./_lib/browser-probe.mjs";
 * await runBrowserProbe({ name: "xxx", doc: "..." }, async (ui) => {
 *   ui.add("1", "判定", "PASS", "细节");
 * });
 * ```
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const ROOT = "D:\\AI\\markdown view\\lightmd";
/**
 * 被测的静态目录。
 *
 * ⚠️ 并行开发时必须用 `BROWSER_PROBE_DIST` 指向**自己独占的构建输出**，
 * 否则多个 agent 同时 `npx vite build` 到同一个 `dist/` 会互相截断，
 * 探针读到半个产物、表现成"改了没生效"（和 §4-30 的 dist/exe 不同步是同一类坑）。
 *
 * ```bash
 * npx vite build --outDir _verify-out/dist-<owner> --emptyOutDir
 * BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-<owner>" node scripts/xxx.mjs
 * ```
 */
export const DIST = process.env.BROWSER_PROBE_DIST
  ? path.resolve(process.env.BROWSER_PROBE_DIST)
  : path.join(ROOT, "dist");
export const OUT_DIR = path.join(ROOT, "_verify-out");
export const SHOT_DIR = path.join(OUT_DIR, "shots");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

async function portFree(port) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(false); });
    s.on("error", () => res(true));
    s.setTimeout(500, () => { s.destroy(); res(true); });
  });
}

async function pickPort() {
  for (let i = 0; i < 80; i++) {
    const p = 9810 + Math.floor(Math.random() * 160);
    if (await portFree(p)) return p;
  }
  throw new Error("找不到空闲端口");
}

function serveStatic(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        let file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
        if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404); res.end("not found"); return;
        }
        res.writeHead(200, {
          "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "cache-control": "no-store",
        });
        fs.createReadStream(file).pipe(res);
      } catch {
        res.writeHead(500); res.end("err");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

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

export async function runBrowserProbe(opts, body) {
  const { name, doc, docTitle = (doc.match(/[^\n#*\s][^\n]*/) || ["文档"])[0].slice(0, 12) } = opts;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const lines = [];
  const log = (t = "") => { lines.push(t); console.log(t); };
  const results = [];
  const add = (id, n, status, detail) => {
    results.push({ id, name: n, status, detail });
    const tag = status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL ";
    log(`${tag} [${id}] ${n}${detail ? ` — ${detail}` : ""}`);
  };

  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  log(`[browser] dist 入口 ${hm ? hm[1] : "?"}（注意：这测的是 dist，不是 exe）`);

  const { server, port: httpPort } = await serveStatic(DIST);
  const cdpPort = await pickPort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-bprobe-"));
  let child = null;
  let cdp = null;
  let ui = null;

  try {
    child = spawn(CHROME, [
      `--remote-debugging-port=${cdpPort}`,
      `--remote-allow-origins=*`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1600,1000",
      "--force-device-scale-factor=1",
      `http://127.0.0.1:${httpPort}/index.html`,
    ], { stdio: "ignore" });

    const t0 = Date.now();
    for (let i = 0; i < 200 && !cdp; i++) {
      if (Date.now() - t0 > 45000) throw new Error("Chrome 启动超时");
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          if (!String(t.url || "").includes("127.0.0.1")) continue;
          const c = await wsConnect(t.webSocketDebuggerUrl).catch(() => null);
          if (c) { cdp = c; break; }
        }
      } catch { /* not ready */ }
      if (!cdp) await sleep(250);
    }
    if (!cdp) throw new Error("找不到 CDP target");
    log(`[browser] CDP 已连接（${Date.now() - t0}ms，http ${httpPort} / cdp ${cdpPort}）`);

    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("Runtime.enable").catch(() => {});

    const ev = async (bodyRaw) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${bodyRaw} })()`,
        returnByValue: true, awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error("页面内异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      }
      return r.result?.result?.value;
    };

    // 等 React 挂载
    const mounted = await (async () => {
      for (let i = 0; i < 100; i++) {
        const ok = await ev(`return !!document.querySelector(".app, #root > *");`).catch(() => false);
        if (ok) return true;
        await sleep(200);
      }
      return false;
    })();
    log(`[browser] React 挂载 = ${mounted}`);
    await sleep(800);

    // 装文档（纯前端路径：App 的 lightmd:openFile handler 只用 detail.content）
    const docFile = path.join(os.tmpdir(), `${name}.md`);
    fs.writeFileSync(docFile, doc, "utf8");
    let loaded = false;
    for (let i = 0; i < 12 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(doc)} },
        }));
        return true;
      `).catch(() => {});
      await sleep(500);
      loaded = await ev(`
        (() => {
          const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
          return !!pm && (pm.textContent || "").indexOf(${JSON.stringify(docTitle)}) >= 0;
        })()
      `).catch(() => false);
    }
    log(`[browser] 文档装入 = ${loaded}`);

    // 进编辑模式（带分屏）
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`).catch(() => {});
    await sleep(2200);
    const hasCm = await ev(`return !!document.querySelector(".cm-editor")`).catch(() => false);
    if (!hasCm) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`).catch(() => {});
      await sleep(1500);
    }
    const impl = await ev(`
      return document.querySelector(".cm-editor") ? "cm6" : (document.querySelector("textarea.source-editor") ? "textarea" : "none");
    `).catch(() => "none");
    log(`[browser] 源码面 = ${impl}`);

    await ev(`
      window.__ERRS = [];
      window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
      window.onunhandledrejection = (e) => window.__ERRS.push("rejection:" + String(e.reason && e.reason.message || e.reason));
      return true;
    `).catch(() => {});

    ui = {
      name, doc, docFile, impl, mode: "browser",
      ev, cdp, log, add, results, lines, sleep, fs, path,
      /**
       * 当前源码面全文。
       *
       * ⚠️⚠️ CM6 是**虚拟化渲染**：`.cm-line` 只有**视口内**的行在 DOM 里。
       * 用 `querySelectorAll(".cm-line").join("\n")` 只能读到可见的几百字符。
       *
       * 这个坑造成了本轮一次**假警报**：撤销探针用旧读法得到
       * `8641 → 1880`，被误判成"一次 Ctrl+Z 撤掉了整篇"（数据级缺陷），
       * 改用 `state.doc` 后实际是 `8641 → 8641`（撤销粒度完全正确）。
       *
       * 所以：**任何基于长度的断言都必须走 `state.doc`**，不能拼 DOM。
       * 拿 `state.doc` 的路径：CM6 把 view 挂在 `contentDOM` 的 `cmTile` 上
       * （`document.querySelector(".cm-content").cmTile.view.state.doc`）。
       * 该内部字段不是公开 API，所以**保留 DOM 兜底**：取不到时退回拼 `.cm-line`
       * 并**明确标记** `truncated: true`，让调用方能识别"这是不完整文本"。
       */
      async readSourceText() {
        const r = await ev(`
          const c = document.querySelector(".cm-content");
          const cm = document.querySelector(".cm-editor");
          // 首选：CM6 内部 view → state.doc（全文，不受虚拟化影响）
          try {
            const v = c && c.cmTile && c.cmTile.view;
            if (v && v.state && v.state.doc) return { text: v.state.doc.toString(), full: true };
          } catch { /* 内部字段不可用，走兜底 */ }
          if (cm) {
            const lines = Array.from(cm.querySelectorAll(".cm-line")).map(l => l.textContent || "");
            return { text: lines.join("\\n"), full: false };
          }
          const ta = document.querySelector("textarea.source-editor");
          return ta ? { text: ta.value, full: true } : null;
        `);
        if (!r) return null;
        if (!r.full) {
          // 不静默：让用的人知道这是"只有可见行"
          console.warn("[probe] readSourceText 退回 DOM 拼行（CM6 虚拟化 → 文本不完整）");
        }
        return r.text;
      },

      /** 读全文 + 是否完整（给需要判「长度断言是否可信」的探针用） */
      async readSourceTextEx() {
        return await ev(`
          const c = document.querySelector(".cm-content");
          try {
            const v = c && c.cmTile && c.cmTile.view;
            if (v && v.state && v.state.doc) return { text: v.state.doc.toString(), full: true, len: v.state.doc.length };
          } catch { /* ignore */ }
          const cm = document.querySelector(".cm-editor");
          if (cm) {
            const lines = Array.from(cm.querySelectorAll(".cm-line")).map(l => l.textContent || "");
            const text = lines.join("\\n");
            return { text, full: false, len: text.length };
          }
          const ta = document.querySelector("textarea.source-editor");
          return ta ? { text: ta.value, full: true, len: ta.value.length } : null;
        `);
      },
      async command(id) {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: ${JSON.stringify(id)} } })); return true;`);
      },
      async focusSource() {
        await ev(`
          const cm = document.querySelector(".cm-content");
          if (cm) { cm.focus(); return true; }
          const ta = document.querySelector("textarea.source-editor");
          if (ta) { ta.focus(); return true; }
          return false;
        `);
        await sleep(250);
      },
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
      async click(x, y) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        }
        await sleep(120);
      },
      /**
       * 真实滚轮滚动（负 deltaY = 向上，正 = 向下）。
       *
       * ⚠️ 为什么探针必须用真实滚轮而不是直接写 `scrollTop`（本轮实测教训）：
       * CM6 的 `scrollHeight` 来自 heightMap —— **没渲染/测量过的区块用估算高度**。
       * 直接 `scroller.scrollTop = x` 是瞬移，视口上方的内容从未被测量；
       * 之后任何一次 dispatch 触发重新测量，估算被修正 → 总高度变化上千像素 →
       * 视口中央的**内容**自己就变了（实测 PI30 → PI37），会被误判成"滚动跳动缺陷"。
       * 滚轮事件走浏览器原生滚动路径，CM6 按滚动过程逐段测量，无此伪影。
       */
      async wheel(x, y, deltaY) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel", x, y, deltaX: 0, deltaY,
          pointerType: "mouse",
        });
        await sleep(16);
      },
      async shot(label) {
        try {
          const r = await cdp.send("Page.captureScreenshot", { format: "png" });
          const b64 = r.result?.data;
          if (!b64) return null;
          const p = path.join(SHOT_DIR, `${name}-${label}.png`);
          fs.writeFileSync(p, Buffer.from(b64, "base64"));
          log(`[browser] 截图 → ${p}`);
          return p;
        } catch (e) { log(`截图失败 ${e.message}`); return null; }
      },
      async errors() { return await ev(`return window.__ERRS || []`); },
    };

    await body(ui);

    const errs = await ui.errors();
    add("Z9", "全程无未捕获异常", errs.length === 0 ? "PASS" : "FAIL",
      errs.length ? JSON.stringify(errs.slice(0, 3)) : "无");
  } catch (err) {
    log(`[browser] 异常：${err?.message || String(err)}`);
    results.push({ id: "E", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    await sleep(400);

    const pass = results.filter((r) => r.status === "PASS").length;
    const known = results.filter((r) => r.status === "KNOWN").length;
    const fail = results.filter((r) => r.status === "FAIL").length;
    log("");
    log(`[browser] PASS=${pass} KNOWN=${known} FAIL=${fail}`);
    fs.writeFileSync(path.join(OUT_DIR, `${name}.txt`), lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify({
      generatedAt: new Date().toISOString(), probe: name, mode: "browser",
      doc: { chars: doc.length, lines: doc.split("\n").length }, results,
    }, null, 1), "utf8");
    if (fail > 0) process.exitCode = 1;
  }
}

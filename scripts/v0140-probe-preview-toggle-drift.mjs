/**
 * LightMD v0.14.0 —— 实机探针：**反复开/关预览时滚动位置逐步上漂**的取证。
 *
 * 用户原话：「文档拉到底，我在编辑模式不断重复关闭预览和打开预览，即不断双击 Shift，
 * 结果发现文档进度每一次会细微的往上滚动，这样文档不断在滚动就造成了阅读焦点的不断变化。」
 *
 * 本脚本**只测不改**：启动打包产物 → 打开一份长文档 → 进入编辑模式 → 把左屏滚到**最底部**
 * → 连续 N 轮「关预览 → 开预览」（与双击 Shift 同一条 store 路径），每轮记录：
 *   · 左屏 textarea 的 scrollTop / maxScroll / 底部百分比
 *   · 右屏 iframe 滚动元素的 scrollTop / maxScroll / 底部百分比
 *   · 视口顶对应的源码行（mirror 实测，作为"阅读焦点是否漂走"的 ground truth）
 *
 * 判定：
 *   A. 漂移量：第 N 轮相对第 0 轮的 scrollTop 变化（期望 ≈ 0，允许 ±1px 亚像素）
 *   B. 单调性：若每轮同向递减 → 累积型漂移（本轮要修的目标）
 *   C. 底部是否失守：期望每轮都保持 100%
 *
 * 用法：node scripts/v0140-probe-preview-toggle-drift.mjs
 * 环境变量：
 *   V0140_DRIFT_PORT    CDP 端口（默认 9287）
 *   V0140_DRIFT_ROUNDS  开合轮数（默认 12）
 *   V0140_DRIFT_SERVE   设 1 时探针自托管 dist/（dev 二进制需要）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_DRIFT_PORT || 9287);
const ROUNDS = Number(process.env.V0140_DRIFT_ROUNDS || 12);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0140-probe-preview-toggle-drift.txt");
const OUT_JSON = path.join(OUT_DIR, "v0140-probe-preview-toggle-drift.json");

const SERVE_DIST = process.env.V0140_DRIFT_SERVE === "1";
const DIST_DIR = "D:\\AI\\markdown view\\lightmd\\dist";
const DIST_PORT = 1420;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function startDistServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let file = path.join(DIST_DIR, (urlPath === "/" ? "/index.html" : urlPath).replace(/^\/+/, ""));
      if (!file.startsWith(DIST_DIR)) return res.writeHead(403).end("forbidden");
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST_DIR, "index.html");
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(DIST_PORT, "127.0.0.1", () => resolve(server));
  });
}

const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id).resolve(m);
        pending.delete(m.id);
      }
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params, timeoutMs = 60000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(i);
              rej(new Error(`CDP ${method} 超时`));
            }, timeoutMs);
            pending.set(i, {
              resolve: (v) => {
                clearTimeout(t);
                res(v);
              },
            });
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
  });
}

/** 长文档：足够长，保证两屏都有可观的可滚动空间；含标题/段落/分割线/代码块 */
function makeDoc() {
  const p = ["# 滚动漂移取证文档", ""];
  for (let i = 1; i <= 120; i++) {
    p.push(`第 ${i} 段：这是一段用于把文档撑长的正文，长度适中，重复若干次以让左右两屏都真的可以滚动。`);
    p.push("");
    if (i % 20 === 0) {
      p.push("---");
      p.push("");
    }
    if (i % 30 === 0) {
      p.push("```js");
      p.push(`const block${i} = ${i};`);
      p.push("```");
      p.push("");
    }
  }
  p.push("## 文档末尾");
  p.push("");
  p.push("最后一段：用于确认滚到底部时视口顶落在哪里。");
  return p.join("\n");
}

/** 页面内工具：mirror 实测每逻辑行的内容坐标顶部（与产品同法，独立实现） */
const PAGE_TOOLS = String.raw`
function __mirrorFor(ta) {
  const cs = getComputedStyle(ta);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const br = parseFloat(cs.borderRightWidth) || 0;
  const mirror = document.createElement("div");
  mirror.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;" +
    "box-sizing:border-box;width:" + (ta.clientWidth + bl + br) + "px;" +
    "padding:" + cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft + ";" +
    "border-style:solid;border-width:" + cs.borderTopWidth + " " + cs.borderRightWidth + " " +
      cs.borderBottomWidth + " " + cs.borderLeftWidth + ";" +
    "white-space:pre-wrap;word-break:" + cs.wordBreak + ";" +
    "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";font-weight:" + cs.fontWeight + ";" +
    "font-style:" + cs.fontStyle + ";line-height:" + cs.lineHeight + ";letter-spacing:" + cs.letterSpacing + ";" +
    "tab-size:" + cs.tabSize + ";margin:0;overflow:hidden;";
  document.body.appendChild(mirror);
  return mirror;
}

/** 每个逻辑行顶部的"内容坐标"(含 padding-top) */
function __lineTops(ta) {
  const text = ta.value;
  const mirror = __mirrorFor(ta);
  try {
    const lines = text.split("\n");
    const markers = [];
    for (let k = 0; k < lines.length; k++) {
      const m = document.createElement("span");
      m.textContent = "\u200b";
      mirror.appendChild(m);
      markers.push(m);
      mirror.appendChild(document.createTextNode(lines[k] + (k < lines.length - 1 ? "\n" : "")));
    }
    const boxTop = mirror.getBoundingClientRect().top;
    return markers.map((m) => m.getBoundingClientRect().top - boxTop);
  } finally {
    mirror.remove();
  }
}

/** 当前视口顶所在的源码行（浮点，0-based）= 阅读焦点的 ground truth */
function __topLine(tops, scrollTop) {
  if (!tops || tops.length < 2) return 0;
  let lo = 0, hi = tops.length - 1;
  if (scrollTop <= tops[0]) return 0;
  if (scrollTop >= tops[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= scrollTop) lo = mid; else hi = mid - 1;
  }
  const span = tops[lo + 1] - tops[lo];
  if (!(span > 0)) return lo;
  return lo + Math.min(1, Math.max(0, (scrollTop - tops[lo]) / span));
}
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-drift-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "drift-long.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(1200);

  let distServer = null;
  if (SERVE_DIST) {
    distServer = await startDistServer();
    console.log(`[probe] 已托管 dist/ 于 127.0.0.1:${DIST_PORT}`);
  }

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
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
      expression: `(() => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    }
    return r.result?.result?.value;
  };

  const results = [];
  let failed = 0;
  const check = (name, ok, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed++;
  };

  try {
    // ── 1. 打开文档并进入编辑模式 ──
    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
        path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
      return true;
    `);
    await sleep(1500);
    // 进编辑模式（双击 Shift 在阅读模式下的语义 = 进编辑并开预览）
    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } }));
      return true;
    `);
    await sleep(1200);

    const setup = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      const shell = document.querySelector(".split-preview-shell");
      return {
        hasTa: !!ta,
        hasShell: !!shell,
        previewOpen: !!shell && shell.classList.contains("split-preview-open"),
        docLen: ta ? ta.value.length : 0,
        scrollHeight: ta ? ta.scrollHeight : 0,
        clientHeight: ta ? ta.clientHeight : 0,
      };
    `);
    log("会话就绪：" + JSON.stringify(setup));
    if (!setup?.hasTa) throw new Error("找不到 textarea.source-editor（编辑模式未进入）");
    check("进入编辑模式且有右侧预览", setup.previewOpen === true, JSON.stringify(setup));

    // ── 2. 滚到左屏最底部 ──
    await ev(`
      const ta = document.querySelector("textarea.source-editor");
      ta.scrollTop = ta.scrollHeight - ta.clientHeight;
      ta.dispatchEvent(new Event("scroll", { bubbles: false }));
      return ta.scrollTop;
    `);
    await sleep(700);

    /** 采一次样 */
    const snap = (round) =>
      ev(`
        const ta = document.querySelector("textarea.source-editor");
        const shell = document.querySelector(".split-preview-shell");
        const ifr = document.querySelector(".split-preview-shell iframe");
        const d = ifr && ifr.contentDocument;
        const sc = d ? (d.scrollingElement || d.documentElement) : null;
        required = null;
        const tops = __lineTops(ta);
        const maxS = Math.max(0, ta.scrollHeight - ta.clientHeight);
        return {
          round: ${round},
          previewOpen: !!shell && shell.classList.contains("split-preview-open"),
          left: {
            scrollTop: ta.scrollTop, scrollHeight: ta.scrollHeight,
            clientHeight: ta.clientHeight, max: maxS,
            bottomPct: maxS > 0 ? ta.scrollTop / maxS : 1,
            topLine: __topLine(tops, ta.scrollTop),
            totalLines: tops.length,
          },
          right: sc ? {
            scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight,
            clientHeight: sc.clientHeight, max: Math.max(0, sc.scrollHeight - sc.clientHeight),
            bottomPct: (sc.scrollHeight - sc.clientHeight) > 0
              ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 1,
          } : null,
        };
      `);

    const baseline = await snap(0);
    log("");
    log("════════ 第 0 轮（已滚到底，开合前的基线）════════");
    log(`  左屏 scrollTop=${baseline.left.scrollTop.toFixed(2)} / max=${baseline.left.max} → 底部 ${(baseline.left.bottomPct * 100).toFixed(2)}%`);
    log(`  左屏视口顶行=${baseline.left.topLine.toFixed(2)}（0-based / 共 ${baseline.left.totalLines} 行）`);
    if (baseline.right) {
      log(`  右屏 scrollTop=${baseline.right.scrollTop.toFixed(2)} / max=${baseline.right.max} → 底部 ${(baseline.right.bottomPct * 100).toFixed(2)}%`);
    }

    check("基线：左屏确实在最底部", baseline.left.bottomPct >= 0.995, `${(baseline.left.bottomPct * 100).toFixed(2)}%`);
    check("基线：右屏确实在最底部", !baseline.right || baseline.right.bottomPct >= 0.995,
      baseline.right ? `${(baseline.right.bottomPct * 100).toFixed(2)}%` : "no-iframe");

    // ── 3. 反复「关预览 → 开预览」 ──
    const track = [baseline];
    for (let r = 1; r <= ROUNDS; r++) {
      // 关预览
      await ev(`
        const s = window.__lightmdStore || null;
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } }));
        return true;
      `);
      await sleep(700);
      const closed = await snap(r);
      // 开预览
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } }));
        return true;
      `);
      await sleep(900);
      const opened = await snap(r);
      track.push(opened);
      log(`  R${String(r).padStart(2)} 关→ open=${closed.previewOpen} 左=${closed.left.scrollTop.toFixed(1)}` +
          `  | 开→ open=${opened.previewOpen} 左=${opened.left.scrollTop.toFixed(1)}` +
          ` (底部 ${(opened.left.bottomPct * 100).toFixed(2)}%, 顶行 ${opened.left.topLine.toFixed(2)})` +
          (opened.right ? ` 右=${opened.right.scrollTop.toFixed(1)} (${(opened.right.bottomPct * 100).toFixed(2)}%)` : ""));
    }

    // ── 4. 判定 ──
    log("");
    log("════════ 漂移判定 ════════");
    const baseTop = baseline.left.scrollTop;
    const finals = track.map((t) => t.left.scrollTop);
    const drift = finals.map((v) => v - baseTop);
    log(`  左屏 scrollTop 序列（每轮"开预览"后的稳态）：`);
    log(`    ${finals.map((v) => v.toFixed(1)).join(" → ")}`);
    log(`  相对基线漂移：${drift.map((d) => (d >= 0 ? "+" : "") + d.toFixed(1)).join(", ")}`);

    const maxAbsDrift = Math.max(...drift.map(Math.abs));
    const netDrift = drift[drift.length - 1];
    log(`  最大绝对漂移 = ${maxAbsDrift.toFixed(2)}px；净漂移 = ${netDrift.toFixed(2)}px`);

    // 单调同向累积？
    let monotone = 0;
    for (let i = 1; i < finals.length; i++) {
      const step = finals[i] - finals[i - 1];
      if (Math.abs(step) > 0.5 && Math.sign(step) === Math.sign(finals[1] - finals[0])) monotone++;
    }
    log(`  同向累积步数 = ${monotone}/${finals.length - 1}`);

    check("反复开合 12 轮后左屏 scrollTop 漂移 ≤ 2px", maxAbsDrift <= 2,
      `最大 ${maxAbsDrift.toFixed(2)}px，净 ${netDrift.toFixed(2)}px`);
    check("反复开合后仍保持在底部（≥99.5%）", track.every((t) => t.left.bottomPct >= 0.995),
      `末轮 ${(track[track.length - 1].left.bottomPct * 100).toFixed(2)}%`);
    check("阅读焦点（视口顶行）不漂移（≤1 行）",
      track.every((t) => Math.abs(t.left.topLine - baseline.left.topLine) <= 1),
      `末轮 ${track[track.length - 1].left.topLine.toFixed(2)} vs 基线 ${baseline.left.topLine.toFixed(2)}`);

    fs.writeFileSync(OUT_JSON, JSON.stringify({ baseline, scrollArea: track }, null, 2));

    log("");
    log(`════════ 汇总 ${results.filter((r) => r.startsWith("PASS")).length}/${results.length} PASS ════════`);
    results.forEach((r) => log(r));
    log(`\n退出码：${failed === 0 ? 0 : 1}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    console.log(`\n报告：${OUT_TXT}`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    distServer?.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
};

main().catch((e) => {
  console.error("探针失败:", e);
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  process.exit(2);
});

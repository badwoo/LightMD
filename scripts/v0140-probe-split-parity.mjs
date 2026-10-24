/**
 * LightMD v0.14.0 需求4 —— 实机探针：分屏「左右篇幅差异 / 块对齐 / 底部对齐」取证。
 *
 * 用户症状：分屏时左屏（源码）比右屏（渲染）长很多（块之间的空行不产生块元素）；
 * 往下滚时「右屏已经到底了，左屏还要滚很长才到底」。
 *
 * 本脚本**只读**：启动打包产物、打开三份构造文档、在若干滚动位置采样
 *   左屏 textarea / 右屏 iframe 滚动元素的 scrollHeight / clientHeight / scrollTop，
 * 并用**独立的 mirror 测量**（与产品代码同法，但由探针自己实现）算出"左屏视口顶的真实源码行"
 * 作为 ground truth，从而量化两件事：
 *   A. 块对齐误差：右屏视口顶落在的块 vs 左屏视口顶真实所在块（Δ块 / Δ行）
 *   B. 底部对齐：左屏滚到 max 时右屏的滚动百分比（期望 1.0）
 *
 * 采样结果同时落盘为 JSON（`_verify-out/v0140-probe-split-parity.json`），
 * 供 `v0140-probe-split-parity-sim.mjs` 用真实锚点数据回放「改前 vs 改后」纯函数映射。
 *
 * 用法：node scripts/v0140-probe-split-parity.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_PARITY_PORT || 9283);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0140-probe-split-parity.txt");
const OUT_JSON = path.join(OUT_DIR, "v0140-probe-split-parity.json");

/**
 * `PARITY_SERVE_DIST=1`：探针自己起一个静态服务器托管 `dist/`（端口 1420）。
 *
 * 为什么需要：`cargo build --release` 单独跑出来的 exe 是 **dev 模式**二进制
 * （`devUrl` = http://localhost:1420），不会把 `dist/` 内联进二进制 ——
 * 直接启动会显示 "localhost 拒绝连接"，什么都测不了。
 * 这种情况下由探针补上那个前端服务，exe 就能加载**当前最新 dist**，
 * 于是仍能对最新代码做端到端取证（无需等重新 `tauri build`）。
 */
const SERVE_DIST = process.env.PARITY_SERVE_DIST === "1";
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
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

/** 起一个只读静态服务器托管 dist/（SPA 回退到 index.html） */
function startDistServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let rel = urlPath === "/" ? "/index.html" : urlPath;
      let file = path.join(DIST_DIR, rel.replace(/^\/+/, ""));
      // 目录穿越防护
      if (!file.startsWith(DIST_DIR)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // SPA 回退（tauri 的 base 是 "./"，只有根路径需要）
        file = path.join(DIST_DIR, "index.html");
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
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

// ─── 三份构造文档 ────────────────────────────────────────────────────────────

function docHrBlanks() {
  const p = [];
  p.push("# ① 分割线 + 大量空行");
  p.push("");
  // 每个段落之间必须有空行，否则 markdown 会把连续行并成**一个**段落（块数就少了）
  for (let i = 1; i <= 30; i++) {
    p.push(`开篇段落 ${i}：这里是一段用于撑高右屏渲染内容的中文正文，长度适中，重复若干次以便两屏都真的可以滚动。`);
    p.push("");
  }
  p.push("---");
  p.push("");
  // 用户场景：分割线与下一段之间塞入大量空行（左屏有行，右屏无块）
  for (let i = 0; i < 120; i++) p.push("");
  p.push("空行之后的段落：右屏里它紧挨着分割线，左屏里它隔了 120 行。");
  p.push("");
  for (let i = 1; i <= 40; i++) {
    p.push(`尾部段落 ${i}：用于让两屏都能继续滚动，验证底部是否一起到底。`);
    p.push("");
  }
  return p.join("\n");
}

function docLongLines() {
  const p = [];
  p.push("# ② 长行软换行");
  p.push("");
  const longText = (tag) =>
    `【${tag}】` +
    "这是一条很长的段落行，用来触发 textarea 的 white-space: pre-wrap 软换行。" +
    "它在一个逻辑行里会被折成很多视觉行，因此「按逻辑行线性估算滚动位置」必然产生偏差。" +
    "下面继续堆字：LightMD 的分屏联动需要在这种情况下仍然把左右两屏的同一个块对齐。" +
    "再补一些字确保在 1200px 宽的窗口里至少折成四到六行，便于观察误差。";
  for (let i = 1; i <= 90; i++) {
    if (i % 3 === 0) p.push(longText(`长行 ${i}`));
    else p.push(`短段落 ${i}：一行就结束。`);
    p.push("");
  }
  return p.join("\n");
}

function docTableMermaid() {
  const p = [];
  p.push("# ③ 表格 / mermaid");
  p.push("");
  for (let i = 1; i <= 20; i++) {
    p.push(`前置段落 ${i}：用于把图表推到视口下方。`);
    p.push("");
  }
  p.push("| 列 A | 列 B | 列 C |");
  p.push("| --- | --- | --- |");
  for (let i = 1; i <= 14; i++) p.push(`| 行 ${i} | 值 ${i} | 说明 ${i} |`);
  p.push("");
  p.push("```mermaid");
  p.push("flowchart TD");
  p.push("  A[开始] --> B{判断}");
  p.push("  B -->|是| C[处理]");
  p.push("  B -->|否| D[结束]");
  p.push("```");
  p.push("");
  for (let i = 1; i <= 40; i++) {
    p.push(`后置段落 ${i}：图表之后的内容，用于验证块高差异极大时的对齐。`);
    p.push("");
  }
  return p.join("\n");
}

// ─── 页面内注入的工具（独立实现，不依赖产品代码） ──────────────────────────

/**
 * 用 mirror div + 逐行起始标记 span 测出"每个逻辑行的视觉顶部偏移"。
 *
 * 为什么不按字符区间取 rect：空行的 Range 是**空区间**，`getBoundingClientRect()`
 * 返回全 0 —— 用户这份文档里恰好有 60 个连续空行，用空区间会把它们全测成 0。
 * 改成在每行起点插一个零宽标记（U+200B）span：空行也会因为该 span 而拥有真实的
 * 行盒，`rect.top` 就是该行顶部。宽度为 0，不改变换行行为。
 *
 * 与 textarea 使用同一套字体/行高/pre-wrap/word-break/宽度（与产品里
 * `utils/focus-paragraph.ts` 的 mirror 同法），因此逐行顶部可与真实布局对齐。
 */
const PAGE_MEASURE_TOPS = String.raw`
function __mirrorFor(ta) {
  const cs = getComputedStyle(ta);
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderRight = parseFloat(cs.borderRightWidth) || 0;
  const mirror = document.createElement("div");
  mirror.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;" +
    "box-sizing:border-box;width:" + (ta.clientWidth + borderLeft + borderRight) + "px;" +
    "padding:" + cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft + ";" +
    "border-style:solid;border-width:" + cs.borderTopWidth + " " + cs.borderRightWidth + " " +
      cs.borderBottomWidth + " " + cs.borderLeftWidth + ";" +
    "white-space:pre-wrap;word-break:" + cs.wordBreak + ";" +
    "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";font-weight:" + cs.fontWeight + ";" +
    "font-style:" + cs.fontStyle + ";line-height:" + cs.lineHeight + ";letter-spacing:" + cs.letterSpacing + ";" +
    "tab-size:" + cs.tabSize + ";margin:0;overflow:hidden;";
  document.body.appendChild(mirror);
  return { mirror, cs };
}

/** 返回 { tops: 每个逻辑行顶部的"内容坐标"(含 padding-top), mirrorHeight, lineHeight, padTop } */
function __measureLineTops(ta, text) {
  const { mirror, cs } = __mirrorFor(ta);
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
    const tops = markers.map((m) => m.getBoundingClientRect().top - boxTop);
    const mirrorHeight = mirror.getBoundingClientRect().height;
    const lh = parseFloat(cs.lineHeight);
    return {
      tops, mirrorHeight, padTop: parseFloat(cs.paddingTop) || 0,
      lineHeight: Number.isFinite(lh) ? lh : (parseFloat(cs.fontSize) || 16) * 1.8,
      lines: lines.length,
    };
  } finally {
    mirror.remove();
  }
}

/** 只测若干"块起始行"的顶部（产品补丁里 EditorContainer 要做的同一步） */
function __measureBlockTops(ta, text, blockLines) {
  const { mirror } = __mirrorFor(ta);
  try {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const lines = text.split("\n");
    // 逐行渲染，只在需要的行首插标记
    const want = new Map();
    for (const L of blockLines) want.set(L, []);
    for (let k = 0; k < lines.length; k++) {
      let marker = null;
      if (want.has(k)) {
        marker = document.createElement("span");
        marker.textContent = "\u200b";
        mirror.appendChild(marker);
      }
      mirror.appendChild(document.createTextNode(lines[k] + (k < lines.length - 1 ? "\n" : "")));
      if (marker) want.get(k).push(marker);
    }
    const boxTop = mirror.getBoundingClientRect().top;
    return blockLines.map((L) => {
      const arr = want.get(L) || [];
      return arr.length ? arr[0].getBoundingClientRect().top - boxTop : null;
    });
  } finally {
    mirror.remove();
  }
}
`;

const main = async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-parity-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docs = {
    hrBlanks: { name: "① 分割线+大量空行", file: path.join(tmpDir, "parity-1-hr-blanks.md"), text: docHrBlanks() },
    longLines: { name: "② 长行软换行", file: path.join(tmpDir, "parity-2-longlines.md"), text: docLongLines() },
    tableMermaid: { name: "③ 表格/mermaid", file: path.join(tmpDir, "parity-3-table-mermaid.md"), text: docTableMermaid() },
  };
  for (const d of Object.values(docs)) fs.writeFileSync(d.file, d.text, "utf-8");

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(1200);

  let distServer = null;
  if (SERVE_DIST) {
    if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
      throw new Error(`PARITY_SERVE_DIST=1 但 ${DIST_DIR}/index.html 不存在，请先 vite build`);
    }
    distServer = await startDistServer();
    console.log(`[probe] 已托管 dist/ 于 http://127.0.0.1:${DIST_PORT}（dev 模式 exe 需要）`);
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
      expression: `(() => { ${PAGE_MEASURE_TOPS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    }
    return r.result?.result?.value;
  };

  /** 采样一次：左右度量 + 锚点 + 真实行偏移表 */
  const snapshot = () =>
    ev(`
      const ta = document.querySelector("textarea.source-editor");
      const ifr = document.querySelector(".split-preview-shell iframe");
      const d = ifr && ifr.contentDocument;
      const sc = d ? (d.scrollingElement || d.documentElement) : null;
      if (!ta || !sc) return null;
      const anchors = [];
      for (const el of sc.querySelectorAll("[data-src-line]")) {
        const line = Number(el.dataset.srcLine);
        const r = el.getBoundingClientRect();
        anchors.push({ line, top: r.top + sc.scrollTop, height: r.height, tag: el.tagName.toLowerCase() });
      }
      const bodyKids = d.body ? Array.from(d.body.children).map((e) => e.tagName.toLowerCase()) : [];
      // v0.14.0 需求4：**全部内容元素**的几何（不只是已贴标的）——
      // 这样即使改前一个锚点都没贴上（mermaid 文档），也能在回放里算出"改后贴好标"的效果。
      const allKids = Array.from(sc.querySelectorAll("body > *"))
        .filter((el) => !/^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT)$/.test(el.tagName))
        .filter((el) => !(typeof el.className === "string" && el.className.split(/\s+/).includes("mermaidTooltip")))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName.toLowerCase(), top: r.top + sc.scrollTop, height: r.height };
        });
      const m = __measureLineTops(ta, ta.value);
      const cs = getComputedStyle(ta);
      const taContentH = ta.scrollHeight - (parseFloat(cs.paddingTop)||0) - (parseFloat(cs.paddingBottom)||0);
      return {
        source: {
          scrollTop: ta.scrollTop, scrollHeight: ta.scrollHeight,
          clientHeight: ta.clientHeight, maxScroll: Math.max(0, ta.scrollHeight - ta.clientHeight),
          paddingTop: m.padTop, totalLines: m.lines, contentHeight: taContentH,
          mirrorHeight: m.mirrorHeight, lineHeight: m.lineHeight,
        },
        sourceTops: m.tops,
        preview: {
          scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight,
          clientHeight: sc.clientHeight, maxScroll: Math.max(0, sc.scrollHeight - sc.clientHeight),
        },
        anchors,
        allKids,
        bodyKids,
        taggedCount: anchors.length,
      };
    `);

  const setLeft = (fraction) =>
    ev(`
      const ta = document.querySelector("textarea.source-editor");
      const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
      ta.scrollTop = Math.round(max * ${fraction});
      ta.dispatchEvent(new Event("scroll"));
      return ta.scrollTop;
    `);

  const setRight = (fraction) =>
    ev(`
      const ifr = document.querySelector(".split-preview-shell iframe");
      const d = ifr && ifr.contentDocument;
      const sc = d ? (d.scrollingElement || d.documentElement) : null;
      if (!sc) return null;
      const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
      sc.scrollTop = Math.round(max * ${fraction});
      sc.dispatchEvent(new Event("scroll"));
      return sc.scrollTop;
    `);

  /** ground truth：某 scrollTop 下"左屏视口顶的真实源码行"（浮点） */
  const trueTopLine = (snap) => {
    const { sourceTops, source } = snap;
    // `sourceTops[i]` = "把第 i 行顶对齐到视口顶所需的 scrollTop"（含 padding-top），
    // 与 textarea.scrollTop 同一坐标系，可直接二分。
    const tops = sourceTops;
    const y = source.scrollTop;
    if (y <= 0) return 0;
    let lo = 0;
    let hi = tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    const start = tops[lo];
    const end = lo + 1 < tops.length ? tops[lo + 1] : source.contentHeight;
    const span = Math.max(1e-6, end - start);
    return lo + Math.min(1, Math.max(0, (y - start) / span));
  };

  const blockIndexOfLine = (anchors, line) => {
    if (!anchors.length) return -1;
    let best = 0;
    for (let i = 0; i < anchors.length; i++) if (anchors[i].line <= line) best = i;
    return best;
  };

  /**
   * 等文档真的加载进来。
   *
   * ⚠️ 不能只看 textarea：**阅读模式下 textarea 的 value 是空的**（源码只在
   * 编辑/分屏模式同步）。所以这里先看阅读区 `.ProseMirror` 的文本长度是否与目标
   * 文档"量级一致"，再切到编辑模式后由 `waitForTextarea` 精确校验。
   */
  const waitForLoaded = async (text, timeoutMs = 15000) => {
    const t0 = Date.now();
    const want = text.length;
    while (Date.now() - t0 < timeoutMs) {
      const got = await ev(`
        const pm = document.querySelector(".ProseMirror");
        const ta = document.querySelector("textarea.source-editor");
        return {
          pmLen: pm ? pm.innerText.length : -1,
          taLen: ta ? ta.value.length : -1,
          empty: !!document.querySelector(".editor-empty-state"),
        };
      `);
      if (got && !got.empty && (got.pmLen > 0 || got.taLen > 0)) {
        // 阅读区文本比源文本短（markdown 标记被渲染掉了），所以用宽松判据：
        // 非空即认为加载完成；随后 textarea 的**精确**长度由 waitForTextarea 校验。
        void want;
        return got;
      }
      await sleep(300);
    }
    return null;
  };

  /** 切到编辑模式后，等 textarea 里出现**精确**的目标文本 */
  const waitForTextarea = async (text, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const got = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        if (!ta) return null;
        return { len: ta.value.length, head: ta.value.slice(0, 40), lines: ta.value.split("\\n").length };
      `);
      if (got && got.len === text.length) return got;
      await sleep(300);
    }
    return null;
  };

  const results = { docs: [], port: PORT, exe: EXE, mode: SERVE_DIST ? "dev(dist served)" : "bundled" };

  try {
    for (const key of Object.keys(docs)) {
      const d = docs[key];
      log("");
      log(`════════ ${d.name} ════════`);
      // 用 `lightmd:openFile`（带内联 content）而不是 `lightmd:open-path`：
      // 后者要经 Rust 命令读盘，dev 模式 exe 在 `PARITY_SERVE_DIST=1` 下的
      // 事件链路与打包版不同（实测 open-path 不生效、textarea 恒空）。
      // openFile 是 App.tsx 的统一打开入口，两种模式下都走同一条渲染链路。
      await ev(
        `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(
          d.file,
        )},name:${JSON.stringify(path.basename(d.file))},content:${JSON.stringify(
          d.text,
        )}}})); return 1;`,
      );
      const loaded = await waitForLoaded(d.text);
      if (!loaded) {
        log("  ⚠ 文档未在超时内加载完成，跳过");
        continue;
      }
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}})); return 1;`);
      await sleep(1800);
      const ready = await waitForTextarea(d.text);
      if (!ready) {
        log("  ⚠ 切到编辑模式后 textarea 文本不符，跳过");
        continue;
      }
      log(`  已加载：${ready.lines} 行 / ${ready.len} 字符`);
      // mermaid / 高亮异步渲染：多等一会再开始采样
      await sleep(1800);
      // 确认右屏 iframe 已贴标（改前 mermaid 文档贴不上，这里只提示不阻断）
      const tagProbe = await ev(`
        const ifr = document.querySelector(".split-preview-shell iframe");
        const d = ifr && ifr.contentDocument;
        if (!d) return null;
        return { tagged: d.querySelectorAll("[data-src-line]").length, kids: d.body ? d.body.children.length : -1 };
      `);
      if (tagProbe) log(`  右屏贴标：${tagProbe.tagged} 个锚点 / body.children ${tagProbe.kids}`);

      const base = await snapshot();
      if (!base) {
        log("  ⚠ 无法采样（textarea 或 iframe 未就绪）");
        continue;
      }
      log(
        `  左屏: scrollHeight=${base.source.scrollHeight} clientHeight=${base.source.clientHeight} ` +
          `max=${base.source.maxScroll} 行数=${base.source.totalLines}`,
      );
      log(
        `  右屏: scrollHeight=${base.preview.scrollHeight} clientHeight=${base.preview.clientHeight} ` +
          `max=${base.preview.maxScroll} 块数=${base.anchors.length}`,
      );
      const ratio =
        base.source.maxScroll > 0 ? (base.preview.maxScroll / base.source.maxScroll).toFixed(3) : "n/a";
      log(`  篇幅比（右 max / 左 max）= ${ratio}`);

      const samples = [];
      log("");
      log("  ── 左屏驱动：滚动位置 → 右屏落点 / 块对齐误差 ──");
      log("   frac | 左scrollTop | 真实顶行 | 真实顶块 | 右scrollTop | 右顶块 | Δ块 | 右pct");
      for (const frac of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        await setLeft(frac);
        await sleep(220);
        const snap = await snapshot();
        if (!snap) continue;
        const gtLine = trueTopLine(snap);
        const gtBlock = blockIndexOfLine(snap.anchors, gtLine);
        const rightTopBlock = blockIndexOfLine(snap.anchors, gtLine);
        // 右屏视口顶落在哪个块：top <= scrollTop 的最后一个
        let rBlock = -1;
        for (let i = 0; i < snap.anchors.length; i++) if (snap.anchors[i].top <= snap.preview.scrollTop) rBlock = i;
        const delta = rBlock >= 0 ? rBlock - gtBlock : NaN;
        const rightPct = snap.preview.maxScroll > 0 ? snap.preview.scrollTop / snap.preview.maxScroll : 0;
        samples.push({
          frac,
          leftScrollTop: snap.source.scrollTop,
          trueTopLine: +gtLine.toFixed(2),
          trueBlock: gtBlock,
          previewScrollTop: snap.preview.scrollTop,
          previewTopBlock: rBlock,
          deltaBlock: delta,
          rightPct: +rightPct.toFixed(4),
        });
        log(
          `   ${String(frac).padEnd(4)} | ${String(snap.source.scrollTop).padEnd(11)} | ` +
            `${String(+gtLine.toFixed(2)).padEnd(8)} | ${String(gtBlock).padEnd(8)} | ` +
            `${String(snap.preview.scrollTop).padEnd(11)} | ${String(rBlock).padEnd(6)} | ` +
            `${String(delta).padEnd(4)} | ${rightPct.toFixed(3)}`,
        );
      }

      // 底部对齐专测：左屏到底 → 右屏百分比
      await setLeft(1);
      await sleep(300);
      const atBottom = await snapshot();
      const bottomRightPct =
        atBottom && atBottom.preview.maxScroll > 0
          ? atBottom.preview.scrollTop / atBottom.preview.maxScroll
          : 0;
      log("");
      log(
        `  ▶ 底部对齐：左屏 scrollTop=${atBottom?.source.scrollTop} / max=${atBottom?.source.maxScroll}` +
          ` → 右屏 scrollTop=${atBottom?.preview.scrollTop} / max=${atBottom?.preview.maxScroll}` +
          ` → 右屏百分比=${bottomRightPct.toFixed(3)}（期望 1.000）`,
      );

      // 反向专测：右屏到底 → 左屏百分比
      await setRight(1);
      await sleep(300);
      const rb = await snapshot();
      const leftPctAtRightBottom =
        rb && rb.source.maxScroll > 0 ? rb.source.scrollTop / rb.source.maxScroll : 0;
      log(
        `  ▶ 反向底部：右屏到底 → 左屏百分比=${leftPctAtRightBottom.toFixed(3)}（期望 1.000）`,
      );

      // 反向块对齐：右屏 50% → 左屏真实顶行 vs 右屏顶块起始行
      await setRight(0.5);
      await sleep(300);
      const r50 = await snapshot();
      let r50block = -1;
      if (r50) {
        for (let i = 0; i < r50.anchors.length; i++)
          if (r50.anchors[i].top <= r50.preview.scrollTop) r50block = i;
      }
      const r50line = r50 ? trueTopLine(r50) : NaN;
      log(
        `  ▶ 反向块对齐：右屏 50%（块 ${r50block}，源码行 ${
          r50 && r50block >= 0 ? r50.anchors[r50block].line : "?"
        }）→ 左屏真实顶行 ${Number.isFinite(r50line) ? r50line.toFixed(2) : "?"}`,
      );

      results.docs.push({
        key,
        name: d.name,
        base,
        samples,
        bottomRightPct: +bottomRightPct.toFixed(4),
        leftPctAtRightBottom: +leftPctAtRightBottom.toFixed(4),
        reverse50: { previewTopBlock: r50block, leftTrueTopLine: r50line },
      });
    }
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
    try {
      distServer?.close();
    } catch {
      /* ignore */
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n文本报告：${OUT_TXT}`);
  console.log(`原始采样：${OUT_JSON}`);
};

main().catch((e) => {
  console.error("探针异常：", e);
  process.exit(1);
});

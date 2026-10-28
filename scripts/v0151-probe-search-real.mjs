/**
 * LightMD v0.15.1 —— 搜索功能**真实 WebView2 探针**（打包产物实机验证）
 *
 * 背景：用户连续两轮反馈搜索相关缺陷（「点多处结果只跳第一个」「行号与右下角状态栏对不上」
 * 「一搜只高亮当前一处」「关掉搜索高亮还留着」）。jsdom 单测覆盖了纯逻辑，但**证明不了
 * 实机能用** —— 例如「目标文档已经是当前标签时点了没反应」这类缺陷，只有在真实的
 * Tauri + WebView2 + 打包产物里才会暴露。本脚本因此对**已打包的 lightmd.exe** 做真机验证。
 *
 * 手法完全复用 `scripts/v0151-probe-mode-toggle-drift.mjs`（启动 exe 带
 * `--remote-debugging-port` → 连 WebView2 CDP → `Runtime.evaluate` 注入 → 打开文档 →
 * 双击 Ctrl 切模式），这里只替换业务断言部分。
 *
 * ## 本脚本验证的 6 件事（每条都给出 PASS/FAIL + 实测数字）
 * 1. **工作区搜索多处跳转**：同一文档 4 处命中，依次点第 1/2/3/4 条结果 →
 *    scrollTop 必须不同且递增、当前项索引依次 1..4、当前高亮所在段落是对应那一处
 *    （`LOC-n` 上下文比对，不只看 scrollTop）、且第 2/3/4 次点击时目标文档**已经打开**
 *    （标签数/活动标签不变 = 用户报「点了没反应」的那个场景）。
 * 2. **查找所有打开文件**：同样 4 处、同样 4 次点击，同样判定。
 * 3. **行号一致性**：条幅显示的 `:行:列` vs 右下角状态栏「行 N 列 M」——
 *    · 阅读模式：条幅行号必须是**状态栏口径**（PM 逻辑块行号，≠源码行号），
 *      跳转后在该命中处落光标，状态栏行号必须与条幅一致；
 *    · 源码模式 + **CRLF 文档**：条幅 `:行:列` 必须与状态栏完全相等（\r 不计入列宽），
 *      且与「原文 1 基行列」这一独立口径一致、textarea 选区起点 == 命中偏移。
 * 4. **全命中高亮**：搜索一出结果 `.ProseMirror .search-match` 数 == 命中数
 *    （**无需**点 ↑/↓）；当前项 `.search-match-current` 唯一，点 ↓ 后移动到第 2 处。
 * 5. **源码模式高亮**：双击 Ctrl 切到编辑模式后，textarea 上的
 *    `.source-search-overlay` 必须存在，mark 总数 == 命中数、当前项唯一、且 overlay
 *    文本与 textarea 完全一致（排版对齐）。
 * 6. **关闭搜索清理**：清空关键词 / 关闭面板后，PM 两层装饰 + overlay 残留均为 0；
 *    之后切模式不复发。
 *
 * ## 硬约束（本脚本刻意遵守）
 * - **不重新 build**：只跑 `src-tauri/target/release/lightmd.exe`（脚本会校验 exe 内联的
 *   dist 入口 hash 在当前 dist 里，避免测到旧前端；并额外提示 src 是否有比 exe 新的文件）；
 * - **不改产品代码**：只写本脚本 + `_verify-out/` 报告；
 * - 端口 9297 独占：跑前杀 lightmd.exe / msedgewebview2.exe 并确认端口无监听，跑完再杀；
 * - 页面加载**重试 + 校验**（真的渲染出文档正文，不能是「开始输入 Markdown…」欢迎页）；
 * - 退出码真实：0 = 全 PASS，1 = 有 FAIL，2 = 探针自身失败（连不上/前置不成立）。
 *
 * 用法：node scripts/v0151-probe-search-real.mjs
 * 环境变量：
 *   V0151_PORT    CDP 端口（默认 9297）
 *   V0151_EXE     打包产物路径（默认 src-tauri/target/release/lightmd.exe）
 *   V0151_DUMP=1  额外 dump 面板/DOM 结构（排查选择器用）
 *
 * ⚠️ 同一时刻只能有一个探针占用 9297；脚本首尾都会杀进程。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "D:\\AI\\markdown view\\lightmd";
const EXE =
  process.env.V0151_EXE || path.join(REPO, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0151_PORT || 9297);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0151-probe-search-real.txt");
const OUT_JSON = path.join(OUT_DIR, "v0151-probe-search-real.json");
const DIST_INDEX = path.join(REPO, "dist", "index.html");
const SRC_DIR = path.join(REPO, "src");
const DUMP = process.env.V0151_DUMP === "1";

/** 主文档里的关键词（只出现在 4 处） */
const TOKEN = "ZQMAIN";
/** CRLF 文档里的关键词（只出现在 3 处；与主文档关键词刻意不同，避免工作区结果串档） */
const CRLF_TOKEN = "ZQCRLF";
/** 主文档命中处数（任务要求 ≥4） */
const HITS = 4;
/** CRLF 文档命中处数 */
const CRLF_HITS = 3;
/** 主文档里 4 处命中所在的小节序号 → 用于生成 `LOC-1..4` 定位标记 */
const MAIN_HIT_SECTIONS = [2, 8, 14, 20];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
const log = (s) => {
  console.log(s);
  logLines.push(s);
};

// ────────────────────────────────────────────────────────────────
// exe / dist 一致性校验（语义地图 §4-30 的坑：测到旧代码会白忙一场）
// ────────────────────────────────────────────────────────────────
function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) {
    throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  }
  if (!fs.existsSync(DIST_INDEX)) {
    throw new Error(`找不到 dist/index.html：${DIST_INDEX}\n请先执行：npx vite build（或 npx tauri build）`);
  }
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) {
    throw new Error("dist/index.html 里找不到 assets/index-<hash>.js 入口，dist 可能不完整");
  }
  const hashName = m[1];
  const exeBuf = fs.readFileSync(EXE);
  if (!exeBuf.includes(Buffer.from(hashName, "utf-8"))) {
    throw new Error(
      `exe 内联的 dist 与当前 dist/ 不一致（找不到 ${hashName}）。\n` +
        `你大概只跑了 npx vite build —— exe 里还是旧前端。\n` +
        `正确命令：npx tauri build --no-bundle`,
    );
  }
  log(`[probe] exe 内联 dist 校验通过：${hashName}`);
}

/** 报告用：exe 构建时间 vs src 最新修改时间（若 src 更新，说明 exe 可能落后一轮） */
function warnSrcNewerThanExe() {
  const exeStat = fs.statSync(EXE);
  log(`[probe] exe mtime = ${new Date(exeStat.mtimeMs).toISOString()}`);
  const newer = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > exeStat.mtimeMs + 1000) {
            newer.push({ file: path.relative(REPO, p), mtimeMs: st.mtimeMs });
          }
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(SRC_DIR);
  newer.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (newer.length > 0) {
    log(
      `[probe] ⚠️ 有 ${newer.length} 个 src 文件比 exe 新（exe 可能不含这些改动，结论需留余地）：`,
    );
    for (const n of newer.slice(0, 8)) {
      log(`  · ${n.file}  ${new Date(n.mtimeMs).toISOString()}`);
    }
  } else {
    log("[probe] src 中没有比 exe 更新的文件（打包产物代表当前源码）");
  }
  return newer;
}

// ────────────────────────────────────────────────────────────────
// CDP 客户端（照抄 v0151-probe-mode-toggle-drift.mjs）
// ────────────────────────────────────────────────────────────────
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
      // ⚠️ 必须 resolve 整条消息（调用方读 r.result.result.value）
      else p.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

// ────────────────────────────────────────────────────────────────
// 进程 / 端口清理
// ────────────────────────────────────────────────────────────────
function killImage(name) {
  try {
    execFileSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function portListenPids(port) {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
  } catch {
    return [];
  }
}

async function killAppAndFreePort(tag) {
  killImage("lightmd.exe");
  killImage("msedgewebview2.exe");
  await sleep(1200);
  let pids = portListenPids(PORT);
  if (pids.length > 0) {
    log(`[probe] (${tag}) 端口 ${PORT} 仍有监听（PID ${pids.join(",")}）→ 强制结束`);
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        /* ignore */
      }
    }
    await sleep(900);
    pids = portListenPids(PORT);
  }
  const free = pids.length === 0;
  log(`[probe] (${tag}) 端口 ${PORT} ${free ? "无监听 ✓" : `仍被占用（PID ${pids.join(",")}）✗`}`);
  return free;
}

// ────────────────────────────────────────────────────────────────
// 测试文档（同一个文档里 ≥4 处命中；另一份 CRLF 文档用于行号核对）
// ────────────────────────────────────────────────────────────────
function makeMainDoc() {
  const parts = ["# 搜索跳转取证文档", ""];
  for (let i = 1; i <= 24; i++) {
    parts.push(`## 小节 ${i}`);
    parts.push("");
    for (let j = 1; j <= 3; j++) {
      const hitIdx = MAIN_HIT_SECTIONS.indexOf(i);
      const isHit = hitIdx >= 0 && j === 2;
      const loc = isHit ? `定位标记 LOC-${hitIdx + 1} ` : "";
      parts.push(
        `第 ${i}.${j} 段：${loc}这是一段用于撑长文档的正文，故意写得比较长，` +
          (isHit ? `其中出现待搜索的关键词 ${TOKEN} 一处，` : "") +
          "让长行在阅读面与源码面都真的可以滚动。重复若干次以保证阅读面可滚动。",
      );
      parts.push("");
    }
  }
  parts.push("## 文档末尾");
  parts.push("");
  parts.push("最后一段，用于让文档底部仍可滚动。");
  return parts.join("\n");
}

function makeCrlfDoc() {
  const lines = [
    "# CRLF 行号取证文档",
    "",
    "这份文档使用 CRLF 换行，用来核对「\\r 是否被计入列宽」以及行号是否 1 基。",
    "",
  ];
  const hitLines = new Set([3, 8, 13]);
  for (let n = 1; n <= 18; n++) {
    if (hitLines.has(n)) {
      lines.push(
        `第 ${n} 个逻辑行：定位标记 C-LOC-${[...hitLines].indexOf(n) + 1} ` +
          `前缀${"文字".repeat([...hitLines].indexOf(n) + 1)} 出现关键词 ${CRLF_TOKEN} 一次。`,
      );
    } else {
      lines.push(`第 ${n} 个逻辑行：普通正文，用于撑开行距与滚动。`);
    }
    if (n % 3 === 0) lines.push("");
  }
  lines.push("末尾行。");
  return lines.join("\r\n") + "\r\n";
}

/** 独立口径：在**归一化文本**（\r\n → \n）里找关键词，算 1 基行列 + 全文偏移 */
function occurrences(text, token) {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out = [];
  let idx = 0;
  while ((idx = norm.indexOf(token, idx)) >= 0) {
    const before = norm.slice(0, idx);
    const nl = before.lastIndexOf("\n");
    out.push({
      offset: idx,
      line: before.split("\n").length,
      column: idx - (nl + 1) + 1,
    });
    idx += token.length;
  }
  return { norm, hits: out };
}

// ────────────────────────────────────────────────────────────────
// 页面内快照脚本（拆成多次小 eval，避免一次注入过多代码）
// ────────────────────────────────────────────────────────────────
const SNIP = {
  reader: String.raw`
    const sc = document.querySelector(".editor-container");
    const pm = sc ? sc.querySelector(".ProseMirror") : null;
    const all = pm ? Array.from(pm.querySelectorAll(".search-match")) : [];
    const cur = pm ? Array.from(pm.querySelectorAll(".search-match-current")) : [];
    const el = cur[0] || null;
    let curText = "", blockText = "", rect = null;
    if (el) {
      curText = el.textContent || "";
      const b = el.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th") || el.parentElement;
      blockText = b ? (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) : "";
      const r = el.getBoundingClientRect();
      rect = { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    }
    const sr = sc ? sc.getBoundingClientRect() : null;
    return {
      pmExists: !!pm,
      pmTextLen: pm ? (pm.textContent || "").length : 0,
      scrollTop: sc ? Math.round(sc.scrollTop) : null,
      max: sc ? Math.round(Math.max(0, sc.scrollHeight - sc.clientHeight)) : null,
      clientH: sc ? sc.clientHeight : null,
      allCount: all.length,
      curCount: cur.length,
      curText, blockText, rect,
      visible: !!(el && sc && sr && rect && rect.top >= sr.top - 2 && rect.bottom <= sr.top + sc.clientHeight + 2),
      centerOffset: (el && sc && sr && rect)
        ? Math.round((rect.top + rect.bottom) / 2 - (sr.top + sc.clientHeight / 2))
        : null,
    };
  `,
  panel: String.raw`
    const panel = document.querySelector(".search-replace");
    const countEl = document.querySelector('[data-testid="search-count"]');
    const openRows = Array.from(document.querySelectorAll('[data-testid="search-result-item"]'));
    const wsRows = Array.from(document.querySelectorAll('[data-testid="search-workspace-result-item"]'));
    const lineOf = (row) => (row.querySelector(".search-result-file-line") || {}).textContent || "";
    const textOf = (row) => (row.querySelector('[data-testid="search-result-line"]') || {}).textContent || "";
    const cls = (sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.className || "") : "";
    };
    return {
      panelOpen: !!panel,
      countLabel: countEl ? countEl.textContent || "" : "",
      summaryOpen: (document.querySelector('[data-testid="search-results-summary"]') || {}).textContent || "",
      summaryWs: (document.querySelector('[data-testid="search-workspace-summary"]') || {}).textContent || "",
      wsSearching: !!document.querySelector('[data-testid="search-workspace-progress"]'),
      scopeActive: cls('[data-testid="search-scope-workspace"]').includes("active"),
      findActive: cls('[data-testid="search-find-in-open-files"]').includes("active"),
      openRows: openRows.length,
      wsRows: wsRows.length,
      openLines: openRows.map(lineOf),
      openTexts: openRows.map(textOf),
      wsLines: wsRows.map(lineOf),
      wsTexts: wsRows.map(textOf),
    };
  `,
  chrome: String.raw`
    const cur = document.querySelector('[data-testid="statusbar-cursor"]');
    const tabs = Array.from(document.querySelectorAll(".tab-item"));
    return {
      statusCursor: cur ? cur.textContent || "" : "",
      tabCount: tabs.length,
      activeTab: (document.querySelector(".tab-item.tab-active .tab-name") || {}).textContent || "",
      statusProgress: (document.querySelector('[data-testid="statusbar-progress"]') || {}).textContent || "",
    };
  `,
  source: String.raw`
    const ta = document.querySelector("textarea.source-editor");
    const wrap = document.querySelector(".source-editor-wrapper");
    const overlay = wrap
      ? wrap.querySelector(".source-search-overlay")
      : document.querySelector(".source-search-overlay");
    const vis = (el) => !!el && el.offsetHeight > 0 && el.clientHeight > 0;
    const sc = document.querySelector(".editor-container");
    return {
      taExists: !!ta,
      taVisible: vis(ta),
      taLen: ta ? ta.value.length : 0,
      taScrollTop: ta ? Math.round(ta.scrollTop) : null,
      selStart: ta ? ta.selectionStart : null,
      selEnd: ta ? ta.selectionEnd : null,
      pmVisible: !!sc && sc.offsetHeight > 0,
      overlayExists: !!overlay,
      overlayMarks: overlay ? overlay.querySelectorAll("mark.search-match").length : 0,
      overlayCurrent: overlay ? overlay.querySelectorAll("mark.search-match-current").length : 0,
      overlayMarksTotal: overlay ? overlay.querySelectorAll("mark").length : 0,
      overlayTextLen: overlay ? (overlay.textContent || "").length : 0,
      overlayTextSame: !!(ta && overlay && (overlay.textContent || "") === ta.value),
    };
  `,
  dumpPanel: String.raw`
    const panel = document.querySelector(".search-replace");
    const ids = Array.from(document.querySelectorAll("[data-testid]"))
      .map((e) => e.getAttribute("data-testid"))
      .filter((v, i, a) => v && a.indexOf(v) === i);
    return {
      hasPanel: !!panel,
      panelHtml: panel ? panel.outerHTML.slice(0, 2600) : "",
      testIds: ids,
    };
  `,
};

// ────────────────────────────────────────────────────────────────
// 报告解析
// ────────────────────────────────────────────────────────────────
const parseCount = (s) => {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(s || "");
  return m ? { cur: Number(m[1]), total: Number(m[2]) } : null;
};
const parseCursor = (s) => {
  const m = /行\s*(\d+)\s*列\s*(\d+)/.exec(s || "");
  return m ? { line: Number(m[1]), column: Number(m[2]) } : null;
};
const parseBannerLine = (s) => {
  const m = /:(\d+)(?::(\d+))?/.exec(s || "");
  return m ? { line: Number(m[1]), column: m[2] ? Number(m[2]) : null, raw: s } : null;
};

// ────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────
const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();
  const newerSrc = warnSrcNewerThanExe();

  // ── 临时工作区：一个目录里放两份 md（主文档 + CRLF 文档）──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-searchreal-"));
  const wsDir = path.join(tmpDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });
  const mainPath = path.join(wsDir, "search-main.md");
  const crlfPath = path.join(wsDir, "search-crlf.md");
  const mainText = makeMainDoc();
  const crlfText = makeCrlfDoc();
  fs.writeFileSync(mainPath, mainText, "utf-8");
  fs.writeFileSync(crlfPath, crlfText, "utf-8");

  const mainOcc = occurrences(mainText, TOKEN);
  const crlfOcc = occurrences(crlfText, CRLF_TOKEN);
  if (mainOcc.hits.length !== HITS) {
    throw new Error(`主文档关键词出现 ${mainOcc.hits.length} 处（期望 ${HITS}）—— 探针前置不成立`);
  }
  if (crlfOcc.hits.length !== CRLF_HITS) {
    throw new Error(`CRLF 文档关键词出现 ${crlfOcc.hits.length} 处（期望 ${CRLF_HITS}）`);
  }
  log(
    `[probe] 主文档命中处：${mainOcc.hits
      .map((h) => `源码 ${h.line}:${h.column}`)
      .join(" / ")}`,
  );
  log(
    `[probe] CRLF 命中处（独立口径）：${crlfOcc.hits
      .map((h) => `${h.line}:${h.column}@${h.offset}`)
      .join(" / ")}`,
  );

  // ── 端口独占 ──
  const portFreeBefore = await killAppAndFreePort("pre");
  if (!portFreeBefore) throw new Error(`端口 ${PORT} 被占用且无法释放，探针中止`);

  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });

  let cdp = null;
  const checks = [];
  /** 不属于 PASS/FAIL 的观察（例如「面板在源码模式不显示列号」这类既有行为差异） */
  const notes = [];
  const note = (s) => {
    notes.push(s);
    log(`  [说明] ${s}`);
  };
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok: !!ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    // ── 等 CDP 端点 + 连上 WebView2 页面 ──
    log("[probe] 等待 CDP 端点就绪…");
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          log("[probe] CDP 端点已就绪");
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(500);
    }
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
            const ok = r.result?.result?.value === true;
            if (ok) {
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
        expression: `(() => { ${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
      }
      return r.result?.result?.value;
    };

    const snapReader = () => ev(SNIP.reader);
    const snapPanel = () => ev(SNIP.panel);
    const snapChrome = () => ev(SNIP.chrome);
    const snapSource = () => ev(SNIP.source);
    const dumpPanel = () => ev(SNIP.dumpPanel);

    async function waitFor(fn, timeout = 8000, interval = 200, label = "") {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          const v = await fn();
          if (v) return v;
        } catch {
          /* ignore */
        }
        await sleep(interval);
      }
      if (label) log(`  [wait] 超时：${label}（${timeout}ms）`);
      return null;
    }

    /**
     * 等阅读面**滚动真正收敛**。
     *
     * 为什么必须等：跳转用的是 `scrollTo({ behavior: "smooth" })`，跨越几千像素时
     * 动画可长达 1~2 秒。固定 sleep 1000ms 偶尔会在动画中途取快照 → 高亮词的
     * rect 是"飞行中"的位置 → 用它算出的点击坐标在动画结束后就落到别的行，
     * 表现为**状态栏行号对、列号是 1**（首版探针偶发 1 项假 FAIL，已复现）。
     * 判据：连续 3 次采样 scrollTop 相同视为收敛。
     */
    const waitScrollSettled = async () => {
      let last = null;
      let stable = 0;
      for (let i = 0; i < 80; i++) {
        const st = await ev(
          `const sc = document.querySelector(".editor-container"); return sc ? Math.round(sc.scrollTop) : null;`,
        );
        if (st !== null && st === last) {
          stable += 1;
          if (stable >= 3) return st;
        } else {
          stable = 0;
        }
        last = st;
        await sleep(100);
      }
      return last;
    };

    const clickSel = (sel, idx = 0) =>
      ev(String.raw`
        const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
        if (!els[${idx}]) return { clicked: false, count: els.length };
        els[${idx}].click();
        return { clicked: true, count: els.length };
      `);

    const setQuery = async (q) => {
      const ok = await ev(String.raw`
        const input = document.querySelector(".search-row input.search-input");
        if (!input) return false;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        desc.set.call(input, ${JSON.stringify(q)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      `);
      if (!ok) throw new Error("找不到搜索输入框（面板没打开？）");
      return ok;
    };

    const doubleCtrl = async () => {
      for (let k = 0; k < 2; k++) {
        await ev(String.raw`
          const fire = (type) => {
            const e = new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true });
            window.dispatchEvent(e);
          };
          fire("keydown"); fire("keyup");
          return true;
        `);
        await sleep(60);
      }
    };

    /**
     * 在「当前高亮词」左半格落一次**真实鼠标点击**（ProseMirror 按坐标定位光标），
     * 这样右下角状态栏显示的就是这个命中处的行/列 —— 与用户肉眼对照同一口径。
     *
     * ## 为什么必须用 CDP `Input.dispatchMouseEvent`（而不是页面内 dispatchEvent）
     * 页面内 `new MouseEvent(...)` 是**合成事件，没有浏览器默认行为**：不会真的移动
     * DOM 选区；而 ProseMirror 的鼠标路径只在 `mouseup` 里对少数特例直接
     * `updateSelection`，常规点击靠浏览器的原生选区 + `selectionchange` 同步进 PM。
     * 所以合成事件点下去，PM 状态不变 → `onSelectionChange` 不触发 → 状态栏恒停在
     * 「行 1 列 1」（**首版探针实测踩到**，4 项检查因此假 FAIL）。
     * CDP Input 走渲染进程真实输入管线，会产生原生选区，PM 能正常同步。
     *
     * ## 为什么要临时隐藏面板
     * 面板是浮动窗、正好盖在视口中央，跳转后的当前命中也在中央 ——
     * 不隐藏的话点击命中测试拿到的是面板（`visibility:hidden` 的元素不参与命中测试，
     * 且不改布局、不卸载面板）。点完立刻恢复。
     */
    const clickCurrentMarkAtTokenStart = async () => {
      const point = await ev(String.raw`
        const el = document.querySelector(".ProseMirror .search-match-current");
        if (!el) return { ok: false, reason: "no current mark" };
        const r = el.getBoundingClientRect();
        const text = el.textContent || "";
        const chW = text.length > 0 ? r.width / text.length : 8;
        // 落点取「首字符左半格」→ 光标落在该词起点（= 条幅行列描述的位置）
        const x = r.left + Math.max(0.6, Math.min(2.5, chW * 0.25));
        const y = (r.top + r.bottom) / 2;
        const shell = document.querySelector(".search-genie");
        if (shell) shell.style.visibility = "hidden";
        const hit = document.elementFromPoint(x, y);
        return {
          ok: true,
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          hitInfo: hit ? { tag: hit.tagName, cls: String(hit.className || "").slice(0, 60) } : null,
        };
      `);
      if (!point || !point.ok) return point;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        buttons: 0,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      const after = await ev(String.raw`
        const shell = document.querySelector(".search-genie");
        if (shell) shell.style.visibility = "";
        const se = window.getSelection();
        const ae = document.activeElement;
        return {
          active: ae ? { tag: ae.tagName, cls: String(ae.className || "").slice(0, 60) } : null,
          selText: se ? String(se.toString()).slice(0, 24) : "",
          selCollapsed: se ? !!se.isCollapsed : null,
        };
      `);
      await sleep(300);
      return Object.assign({}, point, after);
    };

    /** 打开文档并**校验真的装进去了**（重试直到渲染出正文；防止测到欢迎空文档的假绿） */    const openDoc = async (filePath, content, marker, sourceMode) => {
      const markerNorm = marker.replace(/\s+/g, "");
      for (let attempt = 0; attempt < 20; attempt++) {
        await ev(String.raw`
          window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
            path: ${JSON.stringify(filePath)}, content: ${JSON.stringify(content)} } }));
          return true;
        `);
        const ok = await waitFor(
          async () => {
            if (sourceMode) {
              return await ev(String.raw`
                const ta = document.querySelector("textarea.source-editor");
                if (!ta || !(ta.offsetHeight > 0)) return false;
                return (ta.value || "").replace(/\s+/g, "").includes(${JSON.stringify(markerNorm)});
              `);
            }
            return await ev(String.raw`
              const sc = document.querySelector(".editor-container");
              const pm = sc && sc.querySelector(".ProseMirror");
              if (!pm) return false;
              return (pm.textContent || "").replace(/\s+/g, "").includes(${JSON.stringify(markerNorm)});
            `);
          },
          1400,
          150,
        );
        if (ok) return true;
        log(`  [probe] 文档尚未装入（第 ${attempt + 1} 次重试）…`);
      }
      return false;
    };

    const ensureWorkspaceAvailable = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const ok = await ev(`return !!document.querySelector('[data-testid="search-scope-workspace"]');`);
        if (ok) return true;
        await ev(String.raw`
          window.dispatchEvent(new CustomEvent("lightmd:openFolder", { detail: { path: ${JSON.stringify(wsDir)} } }));
          return true;
        `);
        await sleep(1500);
      }
      return false;
    };

    // ════════════════════════════════════════════════════════════
    // 0. 前置：挂工作区 / 打开主文档 / 打开搜索面板
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 0. 前置准备 ════════");
    await ev(String.raw`
      window.dispatchEvent(new CustomEvent("lightmd:openFolder", { detail: { path: ${JSON.stringify(wsDir)} } }));
      return true;
    `);
    await sleep(2000);

    const loadedOk = await openDoc(mainPath, mainText, "第 5.1 段", false);
    check(
      "前置A：主文档真的装入阅读面（不是「开始输入 Markdown…」欢迎空文档）",
      loadedOk,
      loadedOk ? "渲染出正文「第 5.1 段」" : "20 次重试后仍未装入 → 其余判定会全部失真",
    );
    await sleep(1000);

    // 打开搜索面板（点底栏搜索按钮；若已经在就跳过，避免误关闭）
    const alreadyOpen = await ev(`return !!document.querySelector(".search-replace .search-row input.search-input");`);
    if (!alreadyOpen) {
      await clickSel('button[data-genie-anchor="search"]');
    }
    const panelOpen = await waitFor(
      () => ev(`return !!document.querySelector(".search-replace .search-row input.search-input");`),
      9000,
      200,
      "搜索面板出现",
    );
    check("前置B：搜索面板已打开", panelOpen);
    await sleep(500);

    const workspaceOk = await ensureWorkspaceAvailable();
    check(
      "前置C：工作区作用域可用（临时目录已挂载为文件夹 → 出现「搜索整个工作区」按钮）",
      workspaceOk,
      `wsDir=${wsDir}`,
    );

    const readerBase = await snapReader();
    check(
      "前置D：阅读面真的可滚动（max > 500px，防止「零漂移/零跳转」假绿）",
      (readerBase.max ?? 0) > 500,
      `scrollTop=${readerBase.scrollTop} max=${readerBase.max} clientH=${readerBase.clientH}`,
    );

    // ════════════════════════════════════════════════════════════
    // 4. 全命中高亮（必须在没点 ↑/↓ 之前测）
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 4. 全命中高亮（阅读模式）════════");
    await setQuery(TOKEN);
    const hl0 = await waitFor(
      async () => {
        const r = await snapReader();
        return r.allCount >= HITS ? r : null;
      },
      8000,
      250,
      "全部命中高亮出现",
    );
    const hlBase = hl0 || (await snapReader());
    const panelHl = await snapPanel();
    check(
      `4a 一搜出结果就整篇标出全部命中（未点 ↑/↓）：.search-match 数 == ${HITS}`,
      hlBase.allCount === HITS,
      `实测 .search-match=${hlBase.allCount}（期望 ${HITS}）`,
    );
    check(
      "4b 当前项醒目高亮唯一：.search-match-current 数 == 1",
      hlBase.curCount === 1,
      `实测 ${hlBase.curCount}`,
    );
    check(
      "4c 当前项指向第 1 处（所在段落含 LOC-1）",
      (hlBase.blockText || "").includes("LOC-1"),
      `curText=${JSON.stringify(hlBase.curText)} block=${JSON.stringify(hlBase.blockText.slice(0, 60))}`,
    );
    const cnt0 = parseCount(panelHl.countLabel);
    check("4d 面板计数为 1/4", !!cnt0 && cnt0.cur === 1 && cnt0.total === HITS, `count=${JSON.stringify(panelHl.countLabel)}`);

    // 点 ↓ → 当前项应移动到第 2 处，全部命中数不变
    await clickSel(".search-nav-btn", 1);
    await sleep(800);
    const hl1 = await snapReader();
    const panelHl1 = await snapPanel();
    const cnt1 = parseCount(panelHl1.countLabel);
    check(
      "4e 点 ↓ 后当前项移动到第 2 处（LOC-2）且仍唯一，全部命中数不变",
      hl1.curCount === 1 &&
        (hl1.blockText || "").includes("LOC-2") &&
        hl1.allCount === HITS &&
        !!cnt1 &&
        cnt1.cur === 2,
      `curCount=${hl1.curCount} all=${hl1.allCount} count=${JSON.stringify(panelHl1.countLabel)}`,
    );

    // ════════════════════════════════════════════════════════════
    // 1. 工作区搜索：同文档 4 处依次跳转
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 1. 工作区搜索 4 处依次跳转 ════════");
    await clickSel('[data-testid="search-scope-workspace"]');
    const wsPanel0 = await waitFor(
      async () => {
        const p = await snapPanel();
        return p.wsRows >= HITS && !p.wsSearching ? p : null;
      },
      20000,
      300,
      "工作区搜索结果",
    );
    const wsP = wsPanel0 || (await snapPanel());
    log(`  工作区汇总：${JSON.stringify(wsP.summaryWs)}`);
    log(`  工作区行（文件:行列 | 片段）：`);
    for (let i = 0; i < wsP.wsRows; i++) {
      log(`    [${i}] ${JSON.stringify(wsP.wsLines[i])} | ${JSON.stringify((wsP.wsTexts[i] || "").slice(0, 60))}`);
    }
    check(
      `1a 工作区结果条幅列出同一文档的 ${HITS} 条命中`,
      wsP.wsRows === HITS,
      `实测 ${wsP.wsRows} 条`,
    );
    const wsCountsOk = wsP.wsRows === HITS;
    if (!wsCountsOk && DUMP) log(JSON.stringify(await dumpPanel(), null, 2));

    const wsClicks = [];
    for (let i = 0; i < HITS; i++) {
      const before = await snapReader();
      const chromeBefore = await snapChrome();
      const clickRes = await clickSel('[data-testid="search-workspace-result-item"]', i);
      await sleep(300);
      await waitScrollSettled(); // 平滑滚动收敛后再取快照（否则 rect/scrollTop 都是飞行中的值）
      await sleep(200);
      const after = await snapReader();
      const p = await snapPanel();
      const chromeAfter = await snapChrome();
      wsClicks.push({
        i,
        clicked: clickRes.clicked,
        beforeScrollTop: before.scrollTop,
        afterScrollTop: after.scrollTop,
        countLabel: p.countLabel,
        curCount: after.curCount,
        allCount: after.allCount,
        blockText: after.blockText,
        visible: after.visible,
        centerOffset: after.centerOffset,
        tabCountBefore: chromeBefore.tabCount,
        tabCountAfter: chromeAfter.tabCount,
        activeTabBefore: chromeBefore.activeTab,
        activeTabAfter: chromeAfter.activeTab,
      });
      log(
        `  [点第 ${i + 1} 条] 点击前 scrollTop=${before.scrollTop} → 点击后=${after.scrollTop}` +
          ` 计数=${JSON.stringify(p.countLabel)} 当前项数=${after.curCount}` +
          ` 可见=${after.visible} centerOffset=${after.centerOffset}` +
          ` 标签数 ${chromeBefore.tabCount}→${chromeAfter.tabCount}` +
          ` 当前块=${JSON.stringify((after.blockText || "").slice(0, 50))}`,
      );
    }

    const wsTops = wsClicks.map((c) => c.afterScrollTop);
    const wsIncreasing = wsTops.every((v, i) => i === 0 || v > wsTops[i - 1] + 50);
    check(
      "1b 4 次点击后阅读面 scrollTop 依次递增（不是每次都跳到第一处）",
      wsIncreasing,
      `序列 = ${wsTops.join(" → ")}`,
    );
    check(
      "1c 4 次点击当前项索引依次为 1/4、2/4、3/4、4/4",
      wsClicks.every((c, i) => !!parseCount(c.countLabel) && parseCount(c.countLabel).cur === i + 1),
      `计数序列 = ${wsClicks.map((c) => c.countLabel).join(" → ")}`,
    );
    check(
      "1d 4 次点击后当前高亮所在段落依次是 LOC-1..LOC-4（内容比对，不只看 scrollTop）",
      wsClicks.every((c, i) => (c.blockText || "").includes(`LOC-${i + 1}`)),
      wsClicks.map((c) => `${i2loc(c.blockText)}`).join(" → "),
    );
    check(
      "1e 第 2/3/4 次点击时目标文档已经打开（标签数/活动标签不变 = 用户报「没反应」的场景）",
      wsClicks.every(
        (c) => c.tabCountBefore === c.tabCountAfter && c.activeTabBefore === c.activeTabAfter,
      ),
      wsClicks.map((c) => `${c.tabCountBefore}/${c.activeTabBefore}`).join(" | "),
    );
    check(
      "1f 每次跳转后当前命中都在阅读面视口内（真的滚到了）",
      wsClicks.every((c) => c.visible),
      wsClicks.map((c) => `visible=${c.visible},centerOffset=${c.centerOffset}`).join(" | "),
    );

    // ════════════════════════════════════════════════════════════
    // 2. 「查找所有打开文件」：同样 4 处、同样 4 次点击
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 2. 查找所有打开文件：4 处依次跳转 ════════");
    await clickSel('[data-testid="search-scope-workspace"]'); // 切回「当前文档」作用域
    await sleep(600);
    await clickSel('[data-testid="search-find-in-open-files"]');
    const ofPanel0 = await waitFor(
      async () => {
        const p = await snapPanel();
        return p.openRows >= HITS ? p : null;
      },
      9000,
      250,
      "打开文件条幅",
    );
    const ofP = ofPanel0 || (await snapPanel());
    log(`  条幅汇总：${JSON.stringify(ofP.summaryOpen)}`);
    for (let i = 0; i < ofP.openRows; i++) {
      log(`    [${i}] ${JSON.stringify(ofP.openLines[i])} | ${JSON.stringify((ofP.openTexts[i] || "").slice(0, 60))}`);
    }
    check(`2a 「查找所有打开文件」条幅列出 ${HITS} 条命中`, ofP.openRows === HITS, `实测 ${ofP.openRows} 条`);

    const ofClicks = [];
    for (let i = 0; i < HITS; i++) {
      const before = await snapReader();
      const chromeBefore = await snapChrome();
      const clickRes = await clickSel('[data-testid="search-result-item"]', i);
      await sleep(300);
      await waitScrollSettled();
      await sleep(200);
      const after = await snapReader();
      const p = await snapPanel();
      const chromeAfter = await snapChrome();
      ofClicks.push({
        i,
        clicked: clickRes.clicked,
        beforeScrollTop: before.scrollTop,
        afterScrollTop: after.scrollTop,
        countLabel: p.countLabel,
        curCount: after.curCount,
        allCount: after.allCount,
        blockText: after.blockText,
        visible: after.visible,
        centerOffset: after.centerOffset,
        tabCountBefore: chromeBefore.tabCount,
        tabCountAfter: chromeAfter.tabCount,
        activeTabBefore: chromeBefore.activeTab,
        activeTabAfter: chromeAfter.activeTab,
      });
      log(
        `  [点第 ${i + 1} 条] 点击前 scrollTop=${before.scrollTop} → 点击后=${after.scrollTop}` +
          ` 计数=${JSON.stringify(p.countLabel)} 当前项数=${after.curCount}` +
          ` 可见=${after.visible} centerOffset=${after.centerOffset}` +
          ` 标签数 ${chromeBefore.tabCount}→${chromeAfter.tabCount}` +
          ` 当前块=${JSON.stringify((after.blockText || "").slice(0, 50))}`,
      );
    }
    const ofTops = ofClicks.map((c) => c.afterScrollTop);
    check(
      "2b 4 次点击后阅读面 scrollTop 依次递增",
      ofTops.every((v, i) => i === 0 || v > ofTops[i - 1] + 50),
      `序列 = ${ofTops.join(" → ")}`,
    );
    check(
      "2c 4 次点击当前项索引依次为 1/4、2/4、3/4、4/4",
      ofClicks.every((c, i) => !!parseCount(c.countLabel) && parseCount(c.countLabel).cur === i + 1),
      `计数序列 = ${ofClicks.map((c) => c.countLabel).join(" → ")}`,
    );
    check(
      "2d 4 次点击后当前高亮所在段落依次是 LOC-1..LOC-4",
      ofClicks.every((c, i) => (c.blockText || "").includes(`LOC-${i + 1}`)),
      ofClicks.map((c) => `${i2loc(c.blockText)}`).join(" → "),
    );
    check(
      "2e 第 2/3/4 次点击时目标文档已经打开（标签数/活动标签不变）",
      ofClicks.every(
        (c) => c.tabCountBefore === c.tabCountAfter && c.activeTabBefore === c.activeTabAfter,
      ),
      ofClicks.map((c) => `${c.tabCountBefore}/${c.activeTabBefore}`).join(" | "),
    );
    check(
      "2f 每次跳转后当前命中都在阅读面视口内",
      ofClicks.every((c) => c.visible),
      ofClicks.map((c) => `visible=${c.visible},centerOffset=${c.centerOffset}`).join(" | "),
    );

    // ════════════════════════════════════════════════════════════
    // 3A. 行号一致性 —— 阅读模式（条幅「状态栏口径」行号 vs 真实状态栏）
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 3A. 条幅行号 vs 状态栏（阅读模式，PM 逻辑块口径）════════");
    const lnPreview = [];
    for (let i = 0; i < HITS; i++) {
      await clickSel('[data-testid="search-result-item"]', i);
      await sleep(300);
      await waitScrollSettled();
      await sleep(200);
      const p = await snapPanel();
      const banner = parseBannerLine(p.openLines[i]);
      // 落光标（CDP 真实鼠标输入）→ 读状态栏。行列与条幅不符时**重测一次**：
      // 若只是滚动/布局时序造成的落点偏移，第二次（等滚动收敛后重测坐标）会一致；
      // 若是真实口径错误，两次都会错，仍会 FAIL。attempts 记进报告便于复核。
      let clickInfo = null;
      let chrome = null;
      let status = null;
      let attempts = 0;
      for (let k = 0; k < 2; k++) {
        attempts = k + 1;
        clickInfo = await clickCurrentMarkAtTokenStart();
        await sleep(450);
        chrome = await snapChrome();
        status = parseCursor(chrome.statusCursor);
        const lineOk = !!banner && !!status && banner.line === status.line;
        const colOk = !!banner && !!status && banner.column === status.column;
        if (lineOk && colOk) break;
        log(
          `  [第 ${i + 1} 处] 状态栏 ${JSON.stringify(chrome.statusCursor)} 与条幅 ` +
            `${JSON.stringify(p.openLines[i])} 不一致 → 重测一次（attempt=${attempts}）`,
        );
        await waitScrollSettled();
        await sleep(200);
      }
      const reader = await snapReader();
      lnPreview.push({
        i: i + 1,
        banner,
        status,
        clickInfo,
        attempts,
        blockText: reader.blockText,
        sourceOracle: { line: mainOcc.hits[i].line, column: mainOcc.hits[i].column },
      });
      log(
        `  [第 ${i + 1} 处] 条幅 :行:列 = ${JSON.stringify(p.openLines[i])}` +
          ` | 状态栏 = ${JSON.stringify(chrome.statusCursor)}` +
          ` | 重测次数=${attempts}` +
          ` | 源码行号(独立口径) = ${mainOcc.hits[i].line}:${mainOcc.hits[i].column}` +
          ` | 点击命中元素=${JSON.stringify(clickInfo && clickInfo.hitInfo)}` +
          ` | 焦点=${JSON.stringify(clickInfo && clickInfo.active)}` +
          ` | 选区=${JSON.stringify(clickInfo && clickInfo.selText)}(collapsed=${clickInfo && clickInfo.selCollapsed})` +
          ` | 当前块含=${JSON.stringify((reader.blockText || "").slice(0, 46))}`,
      );
    }
    const lnPreviewLineOk = lnPreview.every((x) => x.banner && x.status && x.banner.line === x.status.line);
    const lnPreviewColOk = lnPreview.every(
      (x) => x.banner && x.status && x.banner.column === x.status.column,
    );
    check(
      "3a 阅读模式：条幅行号 == 状态栏行号（跳转后在同一命中处落光标）",
      lnPreviewLineOk,
      lnPreview
        .map((x) => `${x.i}: 条幅${x.banner ? x.banner.line : "?"}/状态栏${x.status ? x.status.line : "?"}`)
        .join("，"),
    );
    check(
      "3b 阅读模式：条幅列号 == 状态栏列号",
      lnPreviewColOk,
      lnPreview
        .map((x) => `${x.i}: 条幅${x.banner && x.banner.column}/状态栏${x.status && x.status.column}`)
        .join("，"),
    );
    const lnPreviewConverted = lnPreview.every(
      (x) => x.banner && x.banner.line !== x.sourceOracle.line,
    );
    check(
      "3c 阅读模式：条幅行号是「状态栏口径」（与源码行号不同，证明做过逻辑块换算）",
      lnPreviewConverted,
      lnPreview
        .map((x) => `${x.i}: 条幅${x.banner && x.banner.line} vs 源码${x.sourceOracle.line}`)
        .join("，"),
    );

    // ════════════════════════════════════════════════════════════
    // 3B2. 行号一致性 —— 阅读模式 + CRLF 文档
    //
    // 为什么把 CRLF 文档先放在**阅读模式**测：条幅只有在阅读模式才会同时显示
    // 「行:列」（源码模式的条幅只显示「:行」，见 3B 末尾说明），所以要核对
    // 「条幅 :行:列 vs 状态栏 行N列M」这一条，阅读模式是唯一能对照的场景。
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 3B2. 条幅行号 vs 状态栏（阅读模式 + CRLF 文档）════════");
    const crlfLoadedPreview = await openDoc(crlfPath, crlfText, "第 1 个逻辑行", false);
    check(
      "3d-前置：CRLF 文档真的装入阅读面（不是欢迎空文档）",
      crlfLoadedPreview,
      crlfLoadedPreview ? "PM 正文出现「第 1 个逻辑行」" : "20 次重试后仍未装入",
    );
    await sleep(700);
    await setQuery(CRLF_TOKEN);
    const ofCrlfPreview = await waitFor(
      async () => {
        const p = await snapPanel();
        return p.openRows >= CRLF_HITS ? p : null;
      },
      9000,
      250,
      "阅读模式 CRLF 条幅结果",
    );
    const ofCrlfPv = ofCrlfPreview || (await snapPanel());
    check(
      `3e-前置：阅读模式 CRLF 文档条幅列出 ${CRLF_HITS} 条结果`,
      ofCrlfPv.openRows === CRLF_HITS,
      `实测 ${ofCrlfPv.openRows} 条，行=${JSON.stringify(ofCrlfPv.openLines)}`,
    );
    const lnPvCrlf = [];
    for (let i = 0; i < Math.min(CRLF_HITS, ofCrlfPv.openRows); i++) {
      await clickSel('[data-testid="search-result-item"]', i);
      await sleep(300);
      await waitScrollSettled();
      await sleep(200);
      const p = await snapPanel();
      const banner = parseBannerLine(p.openLines[i]);
      let clickInfo2 = null;
      let chrome = null;
      let status = null;
      let attempts = 0;
      for (let k = 0; k < 2; k++) {
        attempts = k + 1;
        clickInfo2 = await clickCurrentMarkAtTokenStart();
        await sleep(450);
        chrome = await snapChrome();
        status = parseCursor(chrome.statusCursor);
        const lineOk = !!banner && !!status && banner.line === status.line;
        const colOk = !!banner && !!status && banner.column === status.column;
        if (lineOk && colOk) break;
        log(
          `  [第 ${i + 1} 处] 状态栏 ${JSON.stringify(chrome.statusCursor)} 与条幅 ` +
            `${JSON.stringify(p.openLines[i])} 不一致 → 重测一次（attempt=${attempts}）`,
        );
        await waitScrollSettled();
        await sleep(200);
      }
      lnPvCrlf.push({
        i: i + 1,
        banner,
        status,
        clickInfo: clickInfo2,
        attempts,
        sourceOracle: crlfOcc.hits[i],
      });
      log(
        `  [第 ${i + 1} 处] 条幅 = ${JSON.stringify(p.openLines[i])}` +
          ` | 状态栏 = ${JSON.stringify(chrome.statusCursor)}` +
          ` | 重测次数=${attempts}` +
          ` | 原文行号(独立口径) = ${crlfOcc.hits[i].line}` +
          ` | 点击命中元素=${JSON.stringify(clickInfo2 && clickInfo2.hitInfo)}` +
          ` | 焦点=${JSON.stringify(clickInfo2 && clickInfo2.active)}` +
          ` | 选区=${JSON.stringify(clickInfo2 && clickInfo2.selText)}(collapsed=${clickInfo2 && clickInfo2.selCollapsed})`,
      );
    }
    check(
      "3j 阅读模式(CRLF)：条幅行号 == 状态栏行号",
      lnPvCrlf.every((x) => x.banner && x.status && x.banner.line === x.status.line),
      lnPvCrlf
        .map((x) => `${x.i}: 条幅${x.banner ? x.banner.line : "?"}/状态栏${x.status ? x.status.line : "?"}`)
        .join("，"),
    );
    check(
      "3k 阅读模式(CRLF)：条幅列号 == 状态栏列号",
      lnPvCrlf.every((x) => x.banner && x.status && x.banner.column === x.status.column),
      lnPvCrlf
        .map(
          (x) =>
            `${x.i}: 条幅${x.banner ? x.banner.column : "?"}/状态栏${x.status ? x.status.column : "?"}`,
        )
        .join("，"),
    );
    check(
      "3l 阅读模式(CRLF)：条幅行号是「状态栏口径」（≠源码行号，证明做过逻辑块换算）",
      lnPvCrlf.every((x) => x.banner && x.banner.line !== x.sourceOracle.line),
      lnPvCrlf
        .map((x) => `${x.i}: 条幅${x.banner && x.banner.line} vs 源码${x.sourceOracle.line}`)
        .join("，"),
    );

    // ════════════════════════════════════════════════════════════
    // 5. 源码模式高亮（双击 Ctrl 切编辑模式）
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 5. 源码模式（编辑模式）搜索高亮 ════════");
    await doubleCtrl();
    await sleep(1600);
    const srcBase = await waitFor(
      async () => {
        const s = await snapSource();
        return s.taVisible && s.taLen > 0 ? s : null;
      },
      10000,
      300,
      "进入源码模式",
    );
    check(
      "前置E：双击 Ctrl 已切到源码（编辑）模式，textarea 可见且有内容",
      !!srcBase,
      srcBase ? `taLen=${srcBase.taLen}` : "未切到编辑模式",
    );
    const srcSearchOk = await waitFor(
      async () => {
        const p = await snapPanel();
        const c = parseCount(p.countLabel);
        return c && c.total >= CRLF_HITS ? p : null;
      },
      9000,
      300,
      "源码模式重搜",
    );
    // 期望命中数取**面板自报的总数**（此时当前文档是 CRLF 文档 = 3 处），
    // 不写死 HITS —— 写死会让「换个文档测源码高亮」变成恒 FAIL。
    const expectSrcHits = srcSearchOk ? parseCount(srcSearchOk.countLabel).total : CRLF_HITS;
    const srcHl = await waitFor(
      async () => {
        const s = await snapSource();
        return s.overlayMarksTotal >= expectSrcHits ? s : null;
      },
      9000,
      250,
      "源码 overlay 高亮",
    );
    const srcSnap = srcHl || (await snapSource());
    log(
      `  源码 overlay：存在=${srcSnap.overlayExists} mark总数=${srcSnap.overlayMarksTotal}` +
        ` .search-match=${srcSnap.overlayMarks} .search-match-current=${srcSnap.overlayCurrent}` +
        ` 文本一致=${srcSnap.overlayTextSame} 计数=${JSON.stringify(srcSearchOk && srcSearchOk.countLabel)}`,
    );
    check(
      "5a 源码模式存在搜索高亮 overlay（.source-search-overlay）",
      srcSnap.overlayExists,
      `overlayExists=${srcSnap.overlayExists}`,
    );
    check(
      `5b overlay 内 mark 总数 == 命中数（${expectSrcHits}）`,
      srcSnap.overlayMarksTotal === expectSrcHits,
      `实测 ${srcSnap.overlayMarksTotal}（其中 .search-match=${srcSnap.overlayMarks}，当前项=${srcSnap.overlayCurrent}）`,
    );
    check(
      "5c overlay 当前项唯一（.search-match-current == 1）",
      srcSnap.overlayCurrent === 1,
      `实测 ${srcSnap.overlayCurrent}`,
    );
    check(
      "5d overlay 文本与 textarea 完全一致（底色与文字不错行）",
      srcSnap.overlayTextSame,
      `overlayLen=${srcSnap.overlayTextLen} taLen=${srcSnap.taLen}`,
    );
    if (!srcSnap.overlayExists && DUMP) log(JSON.stringify(await dumpPanel(), null, 2));

    // ════════════════════════════════════════════════════════════
    // 3B. 行号一致性 —— 源码模式 + CRLF 文档
    //
    // 源码模式的条幅**只显示「:行」不显示列号**（模板是 `:${r.statusLine ?? r.line}`
    // 再按 `statusColumn !== undefined` 追加列号，而 statusColumn 只在阅读模式算），
    // 所以这里能对照的是「条幅行号 vs 状态栏行/列 vs 原文 1 基行列」；
    // 「条幅列号」由阅读模式的 3b / 3k 覆盖。
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 3B. 条幅行号 vs 状态栏（源码模式 + CRLF 文档）════════");
    const ofCrlf = await waitFor(
      async () => {
        const p = await snapPanel();
        return p.openRows >= CRLF_HITS && !p.wsSearching ? p : null;
      },
      9000,
      250,
      "源码模式 CRLF 条幅结果",
    );
    const ofCrlfP = ofCrlf || (await snapPanel());
    check(
      `3f-前置：源码模式 CRLF 文档条幅列出 ${CRLF_HITS} 条结果`,
      ofCrlfP.openRows === CRLF_HITS,
      `实测 ${ofCrlfP.openRows} 条，行=${JSON.stringify(ofCrlfP.openLines)}`,
    );

    const lnSource = [];
    for (let i = 0; i < Math.min(CRLF_HITS, ofCrlfP.openRows); i++) {
      await clickSel('[data-testid="search-result-item"]', i);
      await sleep(800);
      const p = await snapPanel();
      const s = await snapSource();
      const chrome = await snapChrome();
      const banner = parseBannerLine(p.openLines[i]);
      const status = parseCursor(chrome.statusCursor);
      const oracle = crlfOcc.hits[i];
      lnSource.push({ i: i + 1, banner, status, selStart: s.selStart, oracle, rawLine: p.openLines[i] });
      log(
        `  [第 ${i + 1} 处] 条幅 = ${JSON.stringify(p.openLines[i])}` +
          ` | 状态栏 = ${JSON.stringify(chrome.statusCursor)}` +
          ` | 独立口径(原文1基) = ${oracle.line}:${oracle.column}@${oracle.offset}` +
          ` | textarea 选区起点 = ${s.selStart}`,
      );
    }
    const lnSrcLineOk = lnSource.every((x) => x.banner && x.status && x.banner.line === x.status.line);
    const lnSrcLineOracleOk = lnSource.every((x) => x.banner && x.banner.line === x.oracle.line);
    const lnSrcStatusOracleOk = lnSource.every(
      (x) =>
        x.status &&
        x.status.line === x.oracle.line &&
        x.status.column === x.oracle.column,
    );
    const lnSrcSelOk = lnSource.every((x) => x.selStart === x.oracle.offset);
    check(
      "3g 源码模式(CRLF)：条幅行号 == 状态栏行号 == 原文 1 基行号（不差 1）",
      lnSrcLineOk && lnSrcLineOracleOk,
      lnSource
        .map(
          (x) =>
            `${x.i}: 条幅${x.banner ? x.banner.line : "?"}/状态栏${x.status ? x.status.line : "?"}/原文${x.oracle.line}`,
        )
        .join("，"),
    );
    check(
      "3h 源码模式(CRLF)：状态栏「行 列」== 原文 1 基行列（\\r 不计入列宽、列号不差 1）",
      lnSrcStatusOracleOk,
      lnSource
        .map(
          (x) =>
            `${x.i}: 状态栏${x.status ? `${x.status.line}:${x.status.column}` : "?"}/原文${x.oracle.line}:${x.oracle.column}`,
        )
        .join("，"),
    );
    check(
      "3i 源码模式(CRLF)：跳转后 textarea 选区起点 == 命中偏移（真的定位到那一处）",
      lnSrcSelOk,
      lnSource.map((x) => `${x.i}: 选区${x.selStart}/命中${x.oracle.offset}`).join("，"),
    );
    if (lnSource.every((x) => x.banner && x.banner.column === null)) {
      const nl = lnSource.map((x) => JSON.stringify(x.rawLine)).join("，");
      note(
        `编辑/源码模式下条幅只显示「:行」不显示列号（条幅文案实测 ${nl}）；` +
          `这是改造前既有行为（git HEAD 里就是 \`:{r.line}\`），本次未改动。` +
          `因此「列」的一致性在阅读模式（条幅显示 :行:列）用 3b / 3k 核对。`,
      );
    }

    // ════════════════════════════════════════════════════════════
    // 6. 关闭 / 清空搜索后的清理
    // ════════════════════════════════════════════════════════════
    log("");
    log("════════ 6. 清空关键词 / 关闭面板后的高亮清理 ════════");
    await setQuery("");
    await sleep(1000);
    const clear1Reader = await snapReader();
    const clear1Source = await snapSource();
    log(
      `  清空后：PM .search-match=${clear1Reader.allCount} .search-match-current=${clear1Reader.curCount}` +
        ` | overlay mark=${clear1Source.overlayMarksTotal} current=${clear1Source.overlayCurrent}`,
    );
    check(
      "6a 清空关键词后阅读面无残留高亮（.search-match / .search-match-current 均为 0）",
      clear1Reader.allCount === 0 && clear1Reader.curCount === 0,
      `实测 match=${clear1Reader.allCount} current=${clear1Reader.curCount}`,
    );
    check(
      "6b 清空关键词后源码 overlay 无残留 mark",
      clear1Source.overlayMarksTotal === 0 && clear1Source.overlayCurrent === 0,
      `实测 marks=${clear1Source.overlayMarksTotal} current=${clear1Source.overlayCurrent}`,
    );

    // 重新搜出高亮，再点关闭按钮 → 全部应清干净
    await setQuery(CRLF_TOKEN);
    const reHl = await waitFor(
      async () => {
        const s = await snapSource();
        return s.overlayMarksTotal >= CRLF_HITS ? s : null;
      },
      8000,
      250,
      "关闭前重新出现高亮",
    );
    log(`  关闭前 overlay mark=${(reHl || (await snapSource())).overlayMarksTotal}（期望 ≥${CRLF_HITS}）`);
    await clickSel(".search-close-btn");
    await sleep(1500);
    const closedPanel = await snapPanel();
    const clear2Source = await snapSource();
    const clear2Reader = await snapReader();
    log(
      `  关闭后：面板存在=${closedPanel.panelOpen} | PM match=${clear2Reader.allCount} current=${clear2Reader.curCount}` +
        ` | overlay 存在=${clear2Source.overlayExists} marks=${clear2Source.overlayMarksTotal}`,
    );
    check("6c 点 ✕ 后面板真的关闭了", closedPanel.panelOpen === false, `panelOpen=${closedPanel.panelOpen}`);
    check(
      "6d 关闭面板后源码 overlay 已移除（无残留 mark）",
      clear2Source.overlayMarksTotal === 0,
      `overlayExists=${clear2Source.overlayExists} marks=${clear2Source.overlayMarksTotal}`,
    );
    check(
      "6e 关闭面板后阅读面 PM 层无残留高亮",
      clear2Reader.allCount === 0 && clear2Reader.curCount === 0,
      `match=${clear2Reader.allCount} current=${clear2Reader.curCount}`,
    );

    // 关闭后切模式 → 不得复发
    await doubleCtrl();
    await sleep(1800);
    const afterMode = await snapReader();
    const afterModeSrc = await snapSource();
    log(
      `  关闭后切模式：PM match=${afterMode.allCount} current=${afterMode.curCount}` +
        ` | overlay marks=${afterModeSrc.overlayMarksTotal}`,
    );
    check(
      "6f 关闭搜索后切模式不复发（PM 层 + overlay 均为 0）",
      afterMode.allCount === 0 && afterMode.curCount === 0 && afterModeSrc.overlayMarksTotal === 0,
      `match=${afterMode.allCount} current=${afterMode.curCount} overlayMarks=${afterModeSrc.overlayMarksTotal}`,
    );

    // ════════════════════════════════════════════════════════════
    // 汇总
    // ════════════════════════════════════════════════════════════
    const failed = checks.filter((c) => !c.ok);
    log("");
    log("════════ 结论 ════════");
    log(`  ${checks.length - failed.length} PASS / ${failed.length} FAIL（共 ${checks.length} 项）`);
    if (failed.length > 0) {
      log("  失败项：");
      for (const f of failed) log(`    · ${f.name} — ${f.detail}`);
    }
    log("");
    log("════════ 实测数字（供复核）════════");
    log(`  工作区 4 次点击 scrollTop 序列：${wsTops.join(" → ")}`);
    log(`  打开文件 4 次点击 scrollTop 序列：${ofTops.join(" → ")}`);
    log(`  工作区计数序列：${wsClicks.map((c) => c.countLabel).join(" → ")}`);
    log(`  打开文件计数序列：${ofClicks.map((c) => c.countLabel).join(" → ")}`);
    log(
      `  阅读模式行号对照表（条幅 vs 状态栏 vs 源码行号）：\n` +
        lnPreview
          .map(
            (x) =>
              `    #${x.i} 条幅 ${x.banner ? `${x.banner.line}:${x.banner.column}` : "?"}` +
              ` | 状态栏 ${x.status ? `${x.status.line}:${x.status.column}` : "?"}` +
              ` | 源码 ${x.sourceOracle.line}:${x.sourceOracle.column}`,
          )
          .join("\n"),
    );
    log(
      `  源码模式(CRLF)行号对照表（条幅 vs 状态栏 vs 原文口径）：\n` +
        lnSource
          .map(
            (x) =>
              `    #${x.i} 条幅 ${x.banner ? `${x.banner.line}:${x.banner.column}` : "?"}` +
              ` | 状态栏 ${x.status ? `${x.status.line}:${x.status.column}` : "?"}` +
              ` | 原文 ${x.oracle.line}:${x.oracle.column}` +
              ` | 选区 ${x.selStart} / 命中偏移 ${x.oracle.offset}`,
          )
          .join("\n"),
    );
    log(
      `  阅读模式(CRLF)行号对照表（条幅 vs 状态栏 vs 源码行号）：\n` +
        lnPvCrlf
          .map(
            (x) =>
              `    #${x.i} 条幅 ${x.banner ? `${x.banner.line}:${x.banner.column}` : "?"}` +
              ` | 状态栏 ${x.status ? `${x.status.line}:${x.status.column}` : "?"}` +
              ` | 源码 ${x.sourceOracle.line}:${x.sourceOracle.column}`,
          )
          .join("\n"),
    );
    if (notes.length > 0) {
      log("");
      log("════════ 观察/说明（不计入 PASS/FAIL）════════");
      for (const n of notes) log(`  · ${n}`);
    }
    log(
      `  高亮计数：阅读 .search-match=${hlBase.allCount} current=${hlBase.curCount}` +
        ` 点↓后 current@LOC-2=${(hl1.blockText || "").includes("LOC-2")}` +
        ` | 源码 overlay marks=${srcSnap.overlayMarksTotal} current=${srcSnap.overlayCurrent}`,
    );
    if (newerSrc.length > 0) {
      log(
        `  ⚠️ 打包产物可能滞后：exe mtime 之后又有 ${newerSrc.length} 个 src 文件被修改（见上），` +
          `本次结论只对当前 exe 负责。`,
      );
    }
    log("");
    log(`主文档：${mainPath}`);
    log(`CRLF 文档：${crlfPath}`);

    fs.writeFileSync(OUT_TXT, logLines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify(
        {
          exe: EXE,
          port: PORT,
          docs: { mainPath, crlfPath, wsDir },
          newerSrc,
          checks,
          notes,
          ws: { panel: wsP, clicks: wsClicks },
          of: { panel: ofP, clicks: ofClicks },
          hl: { base: hlBase, afterNext: hl1 },
          lnPreview,
          lnPvCrlf,
          lnSource,
          sourceMode: { expectSrcHits, snap: srcSnap },
          clear: { clear1Reader, clear1Source, clear2Reader, clear2Source, closedPanel, afterMode },
        },
        null,
        2,
      ),
      "utf-8",
    );
    log(`报告已写入：${OUT_TXT}`);
    log(`明细 JSON：${OUT_JSON}`);
    process.exitCode = failed.length > 0 ? 1 : 0;
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
    await killAppAndFreePort("post");
  }
};

/** 把 `blockText` 里的 LOC-n 抽出来，报告里一眼可读 */
function i2loc(blockText) {
  const m = /LOC-(\d+)/.exec(blockText || "");
  return m ? `LOC-${m[1]}` : "(未找到LOC)";
}

main().catch(async (e) => {
  console.error("探针失败：", e);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // 失败也要落报告：否则"没输出"会被误当成"没跑"
    killImage("lightmd.exe");
    killImage("msedgewebview2.exe");
    logLines.push("");
    logLines.push(`探针失败（前置/环境问题，未得出 PASS/FAIL 结论）：${e && e.stack ? e.stack : e}`);
    fs.writeFileSync(OUT_TXT, logLines.join("\n") + "\n", "utf-8");
  } catch {
    /* ignore */
  }
  process.exitCode = 2;
});

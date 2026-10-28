/**
 * LightMD v0.15.1 需求3 —— 实机探针：**反复双击 Ctrl 切换阅读/编辑模式导致滚动位置持续偏移**。
 *
 * 用户原话：「通过不断双击ctrl键进行阅读模式和编辑模式切换时出现了之前修复编辑模式左右屏
 * 切换的类似问题，屏幕不断会滚动位置偏移。」
 *
 * 与 v0.14.0 的「双击 Shift 反复开合预览上漂」同类，但触发条件不同：
 *   · v0.14.0 是 **viewMode 不变、只翻 splitPreviewOpen**（有冻结窗口护栏）；
 *   · 本轮是 **viewMode 真的在 preview ↔ edit 之间翻转** —— 冻结窗口按 `modeChanged`
 *     提前 return（语义地图 §4-31 的正确行为），于是**没有任何护栏**，只剩模式切换的
 *     滚动恢复。而 v0.15.0 只给「阅读→编辑」方向采了内容锚点，反向「编辑→阅读」仍走
 *     百分比 → 两种排版几何不同 → 每轮累积偏移。
 *
 * 本脚本只测不改：启动打包产物 → 打开长文档 → 滚到 50% 附近 → 连续 N 轮
 * 「双击 Ctrl（preview→edit）→ 双击 Ctrl（edit→preview）」，每轮记录：
 *   · 阅读面 `.editor-container` 的 scrollTop / maxScroll / 视口中央块
 *   · 源码面 `textarea.source-editor` 的 scrollTop / maxScroll / 视口中央行
 *   · 「同一处内容是否仍在视口中央」（ground truth：内容锚点，而非像素）
 *
 * 判定（与用户诉求对齐：不是像素相等，而是"阅读焦点不变"）：
 *   A. 每轮回到阅读面后，视口中央的**内容**（块下标/标题）必须与基线一致；
 *   B. 累积偏移（首轮 vs 末轮的像素差）应当很小（排版差异允许，但不得单向累积）；
 *   C. 阅读面 scrollTop 不得贴底（=0 或 =max 都是失败信号）。
 *
 * 用法：node scripts/v0151-probe-mode-toggle-drift.mjs
 * 环境变量：
 *   V0151_PORT     CDP 端口（默认 9297）
 *   V0151_ROUNDS   切换轮数（默认 10，即 20 次双击 Ctrl）
 *   V0151_EXE      打包产物路径（默认 src-tauri/target/release/lightmd.exe）
 *
 * ⚠️ 探针必须跑**打包产物**（`npx tauri build --no-bundle`），只 `npx vite build` 时
 *    exe 内联的仍是旧 dist（语义地图 §4-30 的验证陷阱）。脚本会校验 dist/index.html 的
 *    入口 hash 是否出现在 exe 字节流里，不一致直接中止。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.env.V0151_EXE || "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0151_PORT || 9297);
const ROUNDS = Number(process.env.V0151_ROUNDS || 10);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0151-probe-mode-toggle-drift.txt");
const OUT_JSON = path.join(OUT_DIR, "v0151-probe-mode-toggle-drift.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
const log = (s) => {
  console.log(s);
  logLines.push(s);
};

// ─── exe 内联 dist 校验（语义地图 §4-30 的坑：测到旧代码会白忙一场）───
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
  const found = exeBuf.includes(Buffer.from(hashName, "utf-8"));
  if (!found) {
    throw new Error(
      `exe 内联的 dist 与当前 dist/ 不一致（找不到 ${hashName}）。\n` +
        `你大概只跑了 npx vite build —— exe 里还是旧前端。\n` +
        `正确命令：npx tauri build --no-bundle`,
    );
  }
  log(`[probe] exe 内联 dist 校验通过：${hashName}`);
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
      // ⚠️ 必须 resolve **整条消息**（不是 msg.result）：调用方读的是
      // `r.result.result.value`（CDP 的 Runtime.evaluate 返回
      // {result:{result:{type,value}}}）。只给 msg.result 会让所有取值都少一层，
      // 表现为"CDP 连上了但什么都读不到"（踩过一次）。
      else p.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

function makeDoc() {
  const parts = ["# 模式切换漂移取证", ""];
  for (let i = 1; i <= 60; i++) {
    parts.push(`## 小节 ${i}`);
    parts.push("");
    for (let j = 1; j <= 3; j++) {
      parts.push(
        `第 ${i}.${j} 段：这是一段用于撑长文档的正文，故意写得比较长，让长行在两种排版下产生不同的软换行数 —— ` +
          `这正是"同一百分比指向不同内容"的成因。重复若干次以让阅读面与源码面都真的可以滚动。`,
      );
      parts.push("");
    }
  }
  parts.push("## 文档末尾");
  parts.push("");
  parts.push("最后一段。");
  return parts.join("\n");
}

/**
 * 页面内工具：把「当前视口中央是哪个内容」量化出来（与产品同口径的独立实现）。
 *
 * 阅读面：`.ProseMirror > *` 的 rect 求视口中央命中块，取其标题文本/序号；
 * 源码面：mirror 实测按行轴，二分插值出视口中央行号。
 * 两者都能给出「中央内容」的可比较标识 —— 判定不看像素，只看内容是否同一处。
 */
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
function __lineAtY(tops, y) {
  if (!tops || tops.length < 2) return 0;
  let lo = 0, hi = tops.length - 1;
  if (y <= tops[0]) return 0;
  if (y >= tops[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  const span = tops[lo + 1] - tops[lo];
  if (!(span > 0)) return lo;
  return lo + Math.min(1, Math.max(0, (y - tops[lo]) / span));
}
/** 阅读面：视口中央命中的顶层块（返回块序号 + 文本前 24 字，作为"同一处内容"的标识） */
function __pmCenter(scroller) {
  const root = scroller.querySelector(".ProseMirror");
  if (!root || !(scroller.clientHeight > 0)) return null;
  const sr = scroller.getBoundingClientRect();
  const centerY = sr.top + scroller.clientHeight / 2;
  const kids = Array.from(root.children);
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (!(r.height > 0)) continue;
    if (centerY >= r.top && centerY <= r.bottom) {
      return { index: i, tag: kids[i].tagName, text: (kids[i].textContent || "").trim().slice(0, 24) };
    }
  }
  // 中央落在块间空隙/首尾时退回"离中央最近的块"
  let best = null, bestDist = Infinity;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (!(r.height > 0)) continue;
    const d = Math.abs((r.top + r.bottom) / 2 - centerY);
    if (d < bestDist) {
      bestDist = d;
      best = { index: i, tag: kids[i].tagName, text: (kids[i].textContent || "").trim().slice(0, 24) };
    }
  }
  return best;
}
/** 源码面：视口中央所在行 + 该行内容前 24 字 */
function __srcCenter(ta) {
  const tops = __lineTops(ta);
  const centerY = ta.scrollTop + ta.clientHeight / 2;
  const line = __lineAtY(tops, centerY);
  const lines = ta.value.split("\n");
  const li = Math.min(lines.length - 1, Math.round(line));
  return { line, text: (lines[li] || "").trim().slice(0, 24) };
}
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-modedrift-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "mode-drift.md");
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

  // CDP 端点要等应用创建 WebView2 后才出现（实测 12~20s；打包产物首启还要建
  // profile 目录）。先等端口就绪再开始连，避免在窗口还没出现时就判失败。
  log("[probe] 等待 CDP 端点就绪…");
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { log("[probe] CDP 端点已就绪"); break; }
    } catch { /* 还没起来 */ }
    await sleep(500);
  }

  let cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) {
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
          const rawVal = r.result?.result?.value;
          const tauriOk = rawVal === true;
          if (!tauriOk && i % 5 === 0) {
            log(`[probe] 第 ${i} 次尝试：tauri 检查返回 =${JSON.stringify(rawVal)}` +
              ` type=${r.result?.result?.type} url=${t.url} exc=${!!r.result?.exceptionDetails}`);
          }
          if (tauriOk) {
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

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  /** 采一次样：当前模式下视口中央的内容 + 滚动几何 */
  const snap = (tag) =>
    ev(`
      const scroller = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      // 可见性判据用尺寸（两个面在编辑区里用 display:none 互斥）
      const srcVisible = !!ta && ta.offsetHeight > 0 && ta.clientHeight > 0;
      const pmVisible = !!scroller && !!scroller.querySelector(".ProseMirror")
        && scroller.offsetHeight > 0 && scroller.clientHeight > 0;
      const out = { tag: ${JSON.stringify(tag)}, srcVisible, pmVisible };
      if (srcVisible && ta) {
        out.source = {
          scrollTop: ta.scrollTop,
          max: Math.max(0, ta.scrollHeight - ta.clientHeight),
          center: __srcCenter(ta),
        };
      }
      if (pmVisible && scroller) {
        out.reader = {
          scrollTop: scroller.scrollTop,
          max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          center: __pmCenter(scroller),
        };
      }
      return out;
    `);

  /** 双击 Ctrl（与用户操作同一条 keydown 路径） */
  const doubleCtrl = async () => {
    await ev(`
      const fire = (type) => {
        const e = new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true });
        window.dispatchEvent(e);
      };
      fire("keydown"); fire("keyup");
      return true;
    `);
    await sleep(60);
    await ev(`
      const fire = (type) => {
        const e = new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true });
        window.dispatchEvent(e);
      };
      fire("keydown"); fire("keyup");
      return true;
    `);
  };

  try {
    // ── 1. 打开文档（默认阅读模式）──
    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
        path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
      return true;
    `);
    await sleep(1600);

    const setup = await ev(`
      const scroller = document.querySelector(".editor-container");
      return {
        hasScroller: !!scroller,
        hasPm: !!document.querySelector(".ProseMirror"),
        scrollHeight: scroller ? scroller.scrollHeight : 0,
        clientHeight: scroller ? scroller.clientHeight : 0,
      };
    `);
    log("会话就绪：" + JSON.stringify(setup));
    if (!setup?.hasScroller || !setup?.hasPm) throw new Error("阅读面未就绪");

    // ── 2. 滚到 50%（阅读面），建立基线 ──
    await ev(`
      const sc = document.querySelector(".editor-container");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
      sc.dispatchEvent(new Event("scroll", { bubbles: false }));
      return sc.scrollTop;
    `);
    await sleep(900);

    const baseline = await snap("baseline");
    log("");
    log("════════ 基线（阅读面 50%）════════");
    log(`  阅读面 scrollTop=${baseline.reader?.scrollTop?.toFixed(1)} / max=${baseline.reader?.max}`);
    log(`  阅读面视口中央块：index=${baseline.reader?.center?.index} text=${JSON.stringify(baseline.reader?.center?.text)}`);
    check(
      "基线：阅读面中央内容可识别",
      !!baseline.reader?.center?.text,
      JSON.stringify(baseline.reader?.center ?? null),
    );
    const baseCenterText = baseline.reader?.center?.text ?? "";
    const baseCenterIndex = baseline.reader?.center?.index ?? -1;

    // ── 3. 连续 N 轮「双击 Ctrl 进编辑 → 双击 Ctrl 回阅读」──
    const track = [];
    for (let r = 1; r <= ROUNDS; r++) {
      await doubleCtrl();
      await sleep(950); // 进编辑模式（含右侧预览渲染）
      const editSnap = await snap(`R${r}-edit`);

      await doubleCtrl();
      await sleep(1100); // 回阅读模式（PM 布局 + 异步渲染）
      const readSnap = await snap(`R${r}-read`);
      track.push({ round: r, edit: editSnap, read: readSnap });

      log(
        `  R${String(r).padStart(2)}  编辑: 源码中央行=${editSnap.source?.center?.line?.toFixed(1) ?? "n/a"}` +
          ` ${JSON.stringify(editSnap.source?.center?.text ?? "")}` +
          `  →  阅读: scrollTop=${readSnap.reader?.scrollTop?.toFixed(1)}` +
          ` 中央块=${readSnap.reader?.center?.index}` +
          ` ${JSON.stringify(readSnap.reader?.center?.text ?? "")}`,
      );
    }

    // ── 4. 判定 ──
    log("");
    log("════════ 判定 ════════");
    const reads = track.map((t) => t.read);
    const tops = reads.map((r) => r.reader?.scrollTop ?? NaN);
    const centers = reads.map((r) => r.reader?.center?.text ?? "");
    const idxs = reads.map((r) => r.reader?.center?.index ?? -1);

    log(`  阅读面 scrollTop 序列：${tops.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
    const baseTop = baseline.reader?.scrollTop ?? 0;
    const drift = tops.map((v) => (Number.isFinite(v) ? v - baseTop : NaN));
    log(`  相对基线漂移：${drift.map((d) => (Number.isFinite(d) ? (d >= 0 ? "+" : "") + d.toFixed(1) : "n/a")).join(", ")}`);

    const finiteDrift = drift.filter((d) => Number.isFinite(d));
    const maxAbsDrift = finiteDrift.length ? Math.max(...finiteDrift.map(Math.abs)) : NaN;
    const netDrift = finiteDrift.length ? finiteDrift[finiteDrift.length - 1] : NaN;

    // 单调同向累积（真正的"越切越偏"）
    let monotone = 0;
    for (let i = 1; i < tops.length; i++) {
      const step = tops[i] - tops[i - 1];
      if (Number.isFinite(step) && Math.abs(step) > 0.5) {
        if (monotone === 0) monotone = Math.sign(step) > 0 ? 1 : -1;
        else if (Math.sign(step) !== monotone) monotone = 999; // 方向不一致 → 不算累积
      }
    }
    log(`  单调同向累积：${monotone === 999 ? "否（方向不一致）" : monotone === 0 ? "无显著步进" : "是（同向）"}`);

    // 内容稳定性：每轮回到阅读面后，中央内容应仍是基线那一处
    const sameAsBase = centers.filter((c) => c && c === baseCenterText).length;
    log(`  中央内容与基线一致的轮数：${sameAsBase}/${centers.length}`);
    log(`  中央块下标序列：${idxs.join(", ")}（基线 ${baseCenterIndex}）`);

    check(
      `反复切换 ${ROUNDS} 轮后阅读面中央内容仍是基线那一处（允许 ±1 块邻域）`,
      centers.every((c, i) => c === baseCenterText || Math.abs(idxs[i] - baseCenterIndex) <= 1),
      `${sameAsBase}/${centers.length} 完全一致`,
    );
    check(
      `反复切换 ${ROUNDS} 轮后阅读面 scrollTop 偏移 ≤ 24px（排版差异允许，禁止单向累积）`,
      Number.isFinite(maxAbsDrift) && maxAbsDrift <= 24,
      `最大绝对偏移=${Number.isFinite(maxAbsDrift) ? maxAbsDrift.toFixed(2) : "n/a"}px，净偏移=${Number.isFinite(netDrift) ? netDrift.toFixed(2) : "n/a"}px`,
    );
    check(
      "不得出现单调同向累积（>1px 且每轮同向 = 累积型漂移）",
      monotone !== 1 && monotone !== -1,
      monotone === 999 ? "方向不一致" : monotone === 0 ? "无显著步进" : "同向累积",
    );
    check(
      "阅读面不得被写到贴底/贴顶（钳位信号）",
      reads.every((r) => {
        const st = r.reader?.scrollTop;
        const max = r.reader?.max;
        if (!Number.isFinite(st) || !Number.isFinite(max) || max <= 0) return true;
        return st > 1 && st < max - 1;
      }),
      reads.map((r) => `${r.reader?.scrollTop?.toFixed(0)}/${r.reader?.max?.toFixed(0)}`).join(" "),
    );

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);

    fs.writeFileSync(OUT_TXT, logLines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify({ baseline, track, checks, maxAbsDrift, netDrift }, null, 2),
      "utf-8",
    );
    log(`报告已写入：${OUT_TXT}`);
    process.exitCode = failed > 0 ? 1 : 0;
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
  }
};

main().catch((e) => {
  console.error("探针失败：", e);
  process.exitCode = 2;
});

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
 *   V0151_ROUNDS   切换轮数（默认 20，即 40 次双击 Ctrl；用户实测"连续多次"要够长才能暴露累积）
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
const ROUNDS = Number(process.env.V0151_ROUNDS || 20);
/**
 * FAST=1：模拟用户**快速连按**双击 Ctrl（不等恢复链 0/60/160/400ms 跑完就切下一次）。
 * 这是合成探针最容易漏掉的真实条件 —— 恢复窗口未收敛时下一次切换会拿"中间态几何"
 * 当锚点，误差才会逐轮累积（慢速切换每轮都等稳态，自然测不出累积）。
 */
const FAST = process.env.V0151_FAST === "1";
const WAIT_SETTLE_EDIT = FAST ? 180 : 950;
const WAIT_SETTLE_READ = FAST ? 180 : 1100;
const SAMPLE_TIMES = FAST ? [0, 40] : [0, 60, 160, 400];
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
    //
    // ⚠️ 必须**重试直到文档真的装进编辑器**：应用刚启动时 App 的
    // `lightmd:openFile` 监听器可能还没挂上（React effect 未跑完），
    // 派发一次就没了 —— 探针随后测到的是"开始输入 Markdown…"欢迎空文档，
    // 于是所有 scrollTop 恒为 0、漂移恒为 0，**看起来全 PASS 其实什么也没测**。
    // （这个坑真实踩过：判定 8/8 PASS 但内容块是欢迎占位段落。）
    // ⚠️ 校验用**渲染后的可见文本**，不能用 Markdown 原文前缀：
    // PM 的 textContent 去掉了所有语法记号与空行（实测 "# T\n\n## 小节 0…" 在 DOM 里是
    // "T小节 0正文 0…"），拿 "# T" 去 indexOf 永远匹配不到 → 会误判"文档没装入"。
    // 这里取正文里稳定的一段中文（与语法无关），并去掉空白后比较。
    // 文档实际结构是 "# 模式切换漂移取证" + 每节 "## 小节 N" + "第 i.j 段：…"。
    // 取一个**必然出现在正文段落里**的稳定片段（与 Markdown 语法无关）。
    const docProbe = JSON.stringify("第 5.1 段");
    let loaded = false;
    for (let attempt = 0; attempt < 25 && !loaded; attempt++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
          path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`
        const sc = document.querySelector(".editor-container");
        const pm = sc && sc.querySelector(".ProseMirror");
        const want = ${docProbe};
        if (!pm) return false;
        const txt = (pm.textContent || "").replace(/\s+/g, "");
        return txt.indexOf(String(want).replace(/\s+/g, "")) >= 0;
      `);
      if (!loaded) log(`  [probe] 文档尚未装入（第 ${attempt + 1} 次重试）…`);
    }
    if (!loaded) {
      throw new Error(
        "文档没能装进编辑器（25 次重试后仍是欢迎空文档）—— 本探针的判定会全部失真，必须中止而非报 PASS",
      );
    }
    log("  [probe] 文档已装入编辑器");
    await sleep(800);

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

    // ── 诊断：编辑→阅读方向到底有没有采到「内容锚点」 ──
    // 若 captureSourceContentAnchor 在 useLayoutEffect 里跑时 textarea 已 display:none，
    // 则 clientWidth/clientHeight 为 0 → measureSourceLineAxis 返回 null → 锚点为 null
    // → 该方向永远退回百分比 → 这就是"编辑面先漂、再传染阅读面"的根源。
    const anchorDiag = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      const scroller = document.querySelector(".editor-container");
      return {
        taClientW: ta ? ta.clientWidth : null,
        taClientH: ta ? ta.clientHeight : null,
        taExists: !!ta,
        taDisplay: ta ? getComputedStyle(ta).display : null,
        scrollerClientH: scroller ? scroller.clientHeight : null,
        scrollerDisplay: scroller ? getComputedStyle(scroller).display : null,
      };
    `);
    log("  [诊断] 当前（阅读模式）textarea 状况：" + JSON.stringify(anchorDiag));

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
    // 探针前置条件：文档必须真的可滚动，否则"零漂移"是无意义的假绿灯
    check(
      "基线：文档已真正装入且可滚动（防止测到欢迎空文档导致假 PASS）",
      (baseline.reader?.max ?? 0) > 200,
      `scrollTop=${baseline.reader?.scrollTop} max=${baseline.reader?.max}`,
    );
    const baseCenterText = baseline.reader?.center?.text ?? "";
    const baseCenterIndex = baseline.reader?.center?.index ?? -1;

    // ── 2b. 任意滚动位置下的**往返幂等性**（用户是在任意位置切换的）──
    // 用户报的是"连续多次切换后开始偏"。这里在 3 个不同位置各做 4 轮往返，
    // 每轮都检查「回到同一位置时 scrollTop 是否与离开前一致」——这是真正的幂等判据，
    // 而不是"从固定基线出发不累积"。
    log("");
    log("════════ 2b. 任意位置往返幂等性 ════════");
    const idemChecks = [];
    const traces = [];
    for (const ratio of [0.2, 0.5, 0.8]) {
      await ev(`
        window.__LMD_SCROLL_TRACE = [];
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * ${ratio});
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        return sc.scrollTop;
      `);
      await sleep(500);
      const p0 = (await snap("pos-base")).reader?.scrollTop ?? NaN;
      const seq = [p0];
      const srcSeq = [];
      for (let k = 0; k < 4; k++) {
        await doubleCtrl(); await sleep(WAIT_SETTLE_EDIT);
        const eSnap = await snap("pos-" + k + "-edit");
        srcSeq.push(eSnap.source?.scrollTop ?? NaN);
        await doubleCtrl(); await sleep(Math.max(WAIT_SETTLE_READ, 700));
        seq.push((await snap("pos-" + k)).reader?.scrollTop ?? NaN);
      }
      const back = seq.slice(1);
      const drift = back.map((v) => (Number.isFinite(v) ? v - p0 : NaN));
      const maxAbs = Math.max(...drift.filter(Number.isFinite).map(Math.abs));
      log(`  ratio=${ratio}  基线=${p0.toFixed(1)}  4 轮后序列=${seq.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
      log(`            漂移=${drift.map((d) => (Number.isFinite(d) ? (d >= 0 ? "+" : "") + d.toFixed(1) : "n/a")).join(", ")}`);
      log(`            编辑面 scrollTop=${srcSeq.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
      const traceJson = await ev(`return JSON.stringify(window.__LMD_SCROLL_TRACE || []);`);
      let trace = [];
      try {
        trace = JSON.parse(traceJson || "[]");
      } catch {
        trace = [];
      }
      traces.push({ ratio, p0, seq, srcSeq, trace });
      // 精简打印：只打"锚点/恢复"的关键字段，便于直接看出哪一步在漂
      for (const e of trace) {
        log(
          `     · ${e.event}  ` +
            JSON.stringify(
              Object.fromEntries(Object.entries(e).filter(([k]) => k !== "event" && k !== "t")),
            ),
        );
      }
      idemChecks.push({ ratio, p0, seq, srcSeq, maxAbs });
    }
    fs.writeFileSync(
      path.join(OUT_DIR, "v0151-scroll-trace.json"),
      JSON.stringify(traces, null, 2),
      "utf-8",
    );
    const idemWorst = Math.max(...idemChecks.map((c) => (Number.isFinite(c.maxAbs) ? c.maxAbs : 0)));
    check(
      "任意滚动位置往返 4 次后 scrollTop 幂等（偏移 ≤ 2px，用户报的核心症状）",
      idemWorst <= 2,
      `三个位置的最大偏移 = ${idemWorst.toFixed(2)}px`,
    );

    // ── 3. 连续 N 轮「双击 Ctrl 进编辑 → 双击 Ctrl 回阅读」──
    await ev(`
      const sc = document.querySelector(".editor-container");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
      sc.dispatchEvent(new Event("scroll", { bubbles: false }));
      return sc.scrollTop;
    `);
    await sleep(500);
    const track = [];
    for (let r = 1; r <= ROUNDS; r++) {
      await doubleCtrl();
      // 时间序列采样：切换后的 0 / 60 / 160 / 400ms 各读一次（看"是谁在什么时候写的"）
      const sampleTimes = SAMPLE_TIMES;
      const editSeries = [];
      let last = 0;
      for (const t of sampleTimes) {
        if (t > last) await sleep(t - last);
        last = t;
        const sn = await snap(`R${r}-edit-t${t}`);
        editSeries.push({ t, scrollTop: sn.source?.scrollTop ?? null, center: sn.source?.center ?? null });
      }
      await sleep(FAST ? 60 : 400); // 让异步渲染彻底稳定后再取稳态
      const editSnap = await snap(`R${r}-edit`);

      await doubleCtrl();
      const readSeries = [];
      last = 0;
      for (const t of sampleTimes) {
        if (t > last) await sleep(t - last);
        last = t;
        const sn = await snap(`R${r}-read-t${t}`);
        readSeries.push({ t, scrollTop: sn.reader?.scrollTop ?? null, center: sn.reader?.center ?? null });
      }
      await sleep(FAST ? 60 : 400);
      const readSnap = await snap(`R${r}-read`);
      track.push({ round: r, edit: editSnap, read: readSnap, editSeries, readSeries });

      log(
        `  R${String(r).padStart(2)}  编辑: ta.scrollTop=${(editSnap.source?.scrollTop ?? NaN).toFixed(1)}` +
          ` 中央行=${editSnap.source?.center?.line?.toFixed(1) ?? "n/a"}` +
          ` ${JSON.stringify(editSnap.source?.center?.text ?? "")}` +
          `  →  阅读: scrollTop=${(readSnap.reader?.scrollTop ?? NaN).toFixed(1)}` +
          ` 中央块=${readSnap.reader?.center?.index}` +
          ` ${JSON.stringify(readSnap.reader?.center?.text ?? "")}`,
      );
    }

    // ── 4. 判定 ──
    log("");
    log("════════ 判定 ════════");
    log(`  模式：${FAST ? "FAST（快速连按，不等恢复收敛）" : "慢速（每轮等稳态）"}`);
    const reads = track.map((t) => t.read);
    const tops = reads.map((r) => r.reader?.scrollTop ?? NaN);
    const centers = reads.map((r) => r.reader?.center?.text ?? "");
    const idxs = reads.map((r) => r.reader?.center?.index ?? -1);

    log(`  阅读面 scrollTop 序列：${tops.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
    const baseTop = baseline.reader?.scrollTop ?? 0;
    const drift = tops.map((v) => (Number.isFinite(v) ? v - baseTop : NaN));

    // ── 编辑面（textarea）稳态漂移：用户报"先漂的是编辑模式" ──
    const editTops = track.map((t) => t.edit?.source?.scrollTop ?? NaN);
    const baseEditTop = track[0]?.edit?.source?.scrollTop ?? NaN;
    const editDrift = editTops.map((v) => (Number.isFinite(v) ? v - baseEditTop : NaN));
    log(`  编辑面 ta.scrollTop 序列：${editTops.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
    log(`  编辑面相对第 1 轮漂移：${editDrift.map((d) => (Number.isFinite(d) ? (d >= 0 ? "+" : "") + d.toFixed(1) : "n/a")).join(", ")}`);

    const finiteEditDrift = editDrift.filter((d) => Number.isFinite(d));
    const maxAbsEditDrift = finiteEditDrift.length ? Math.max(...finiteEditDrift.map(Math.abs)) : NaN;
    const netEditDrift = finiteEditDrift.length ? finiteEditDrift[finiteEditDrift.length - 1] : NaN;

    // 编辑面单调同向累积
    let editMonotone = 0;
    for (let i = 1; i < editTops.length; i++) {
      const step = editTops[i] - editTops[i - 1];
      if (Number.isFinite(step) && Math.abs(step) > 0.5) {
        if (editMonotone === 0) editMonotone = Math.sign(step) > 0 ? 1 : -1;
        else if (Math.sign(step) !== editMonotone) editMonotone = 999;
      }
    }

    // 时间序列：每轮切换后 4 个时刻的写入幅度（诊断"谁在什么时候写"）
    const seriesWidth = (arr, field) => {
      const vals = arr.map((x) => (x[field] == null ? NaN : Number(x[field]))).filter(Number.isFinite);
      if (vals.length < 2) return NaN;
      return Math.max(...vals) - Math.min(...vals);
    };
    const editWriteSpan = track.map((t) => seriesWidth(t.editSeries ?? [], "scrollTop"));
    const readWriteSpan = track.map((t) => seriesWidth(t.readSeries ?? [], "scrollTop"));
    log(`  编辑面切换窗口内写入幅度（max-min，4 时刻）：${editWriteSpan.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(", ")}`);
    log(`  阅读面切换窗口内写入幅度（max-min，4 时刻）：${readWriteSpan.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(", ")}`);
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

    check(
      `编辑面（textarea）反复切换 ${ROUNDS} 轮不得有单调同向累积`,
      editMonotone !== 1 && editMonotone !== -1,
      editMonotone === 999
        ? "方向不一致"
        : editMonotone === 0
          ? "无显著步进"
          : `同向累积，最大偏移=${Number.isFinite(maxAbsEditDrift) ? maxAbsEditDrift.toFixed(2) : "n/a"}px，净偏移=${Number.isFinite(netEditDrift) ? netEditDrift.toFixed(2) : "n/a"}px`,
    );
    check(
      `编辑面 scrollTop 净漂移 ≤ 2px（对照用户"编辑模式先开始细微偏移"）`,
      Number.isFinite(netEditDrift) && Math.abs(netEditDrift) <= 2,
      `净偏移=${Number.isFinite(netEditDrift) ? netEditDrift.toFixed(2) : "n/a"}px，最大=${Number.isFinite(maxAbsEditDrift) ? maxAbsEditDrift.toFixed(2) : "n/a"}px`,
    );
    check(
      `阅读面 scrollTop 净漂移 ≤ 2px（不允许被编辑面传导）`,
      Number.isFinite(netDrift) && Math.abs(netDrift) <= 2,
      `净偏移=${Number.isFinite(netDrift) ? netDrift.toFixed(2) : "n/a"}px，最大=${Number.isFinite(maxAbsDrift) ? maxAbsDrift.toFixed(2) : "n/a"}px`,
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

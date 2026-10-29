/**
 * LightMD v0.15.3 — 漂移**判别矩阵**探针（只测不改）。
 *
 * 目的：把「编辑后双击 Ctrl 漂移」的复现条件一次跑清，避免在第 5 次返修里继续猜。
 * 上一轮 `scripts/v0153-probe-edit-then-toggle.mjs` 只覆盖了「单一空行 + 编辑视口中央」，
 * 实测 −38.5px 后 20 轮幂等。两位只读分析给出的两个疑点必须**分离变量**验证：
 *
 * | 变体 | 文档 | 编辑位置 | 想判定的东西 |
 * |---|---|---|---|
 * | V1 | 单空行 | 视口中央 | 基线（≈ 上一轮 −38.5px 是否属"正确重对齐"） |
 * | V2 | 单空行 | **文档末尾（远离视口）** | 若也漂 → 真 bug；若 0.00 → V1 的 38.5px 是重对齐，不是 bug |
 * | V3 | **双空行 `\n\n\n`** | 不编辑 | C1：PM 顶层多出"空段落" → 源码面/PM 面 blockIndex 两把尺子错位 |
 * | V4 | **双空行** | 视口中央 | C1 + 编辑叠加 |
 *
 * ## 为什么双空行会触发 C1（纯代码事实，先看这里再读结果）
 * `core/markdown/parser.ts:325-331`：`gap = token.map[0] - prevEndLine`，
 * `for (k = 1; k < gap; k++)` 会为每个**多余空行**造一个**空段落节点**。
 *   · 段间 1 个空行 → gap=1 → 循环不执行 → 无空段落；
 *   · 段间 **2 个空行** → gap=2 → 造 1 个空段落 → PM 顶层块数 **+1**。
 * 而源码面块表（`contentScrollMap.blockGeometryFromLineAxis`）只按
 * `topLevelBlockStartLines`（真实顶层块）建表，**不含空段落**。
 * 于是 `captureContentAnchor` 采到的 `blockIndex` 与 `restoreContentAnchor` 里的
 * PM 块表 `index` 是**两把尺子**，`resolveAnchorBlock` 的 ② 分支按 index 命中，
 * 每多一个空段落就错开一块 → 这就是"文档对齐问题"的候选根因。
 *
 * ## 判定（每个变体各自跑 8 轮，慢速）
 *   A. 每轮回阅读面后中心块稳定性（内容是否还在同一处）
 *   B. 阅读面 scrollTop 幂等性（首轮 vs 后续；**是否单向累积**）
 *   C. 专门断言：变体文档里 PM 顶层空段落数（V1/V2 应为 0，V3/V4 应 > 0）
 *      —— 若 V3/V4 出现显著漂移而 V1/V2 为 0，C1 成立。
 *
 * 用法：node scripts/v0153-probe-drift-matrix.mjs
 * 环境变量：V0153M_PORT（默认 9300）、V0153M_EXE、V0153M_ROUNDS（默认 8）、
 *          V0153M_ONLY=V1,V3（只跑指定变体）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0153M_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0153M_PORT || 9300);
const ROUNDS = Number(process.env.V0153M_ROUNDS || 8);
const ONLY = (process.env.V0153M_ONLY || "").split(",").filter(Boolean);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0153-probe-drift-matrix.txt");
const OUT_JSON = path.join(OUT_DIR, "v0153-probe-drift-matrix.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";
const EDIT_MARK = "【矩阵取证标记】";

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

/** 造文档：blankLines = 段间空行数（1 = 常规，2 = 触发 C1 空段落） */
function makeDoc(blankLines) {
  const gap = "\n".repeat(blankLines + 1); // 1 空行 = "\n\n"
  const parts = ["# 漂移矩阵取证", ""];
  for (let i = 1; i <= 40; i++) {
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
  // 把段落间的单空行改成 N 个空行（只改"正文段"之间，不动标题后那一个空行）
  return parts.join("\n").split("\n\n第 ").join(gap + "第 ");
}

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
    const ls = text.split("\n");
    const markers = [];
    for (let k = 0; k < ls.length; k++) {
      const m = document.createElement("span");
      m.textContent = "\u200b";
      mirror.appendChild(m);
      markers.push(m);
      mirror.appendChild(document.createTextNode(ls[k] + (k < ls.length - 1 ? "\n" : "")));
    }
    const boxTop = mirror.getBoundingClientRect().top;
    return markers.map((m) => m.getBoundingClientRect().top - boxTop);
  } finally { mirror.remove(); }
}
function __lineAtY(tops, y) {
  if (!tops || tops.length < 2) return 0;
  let lo = 0, hi = tops.length - 1;
  if (y <= tops[0]) return 0;
  if (y >= tops[hi]) return hi;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
  const span = tops[lo + 1] - tops[lo];
  if (!(span > 0)) return lo;
  return lo + Math.min(1, Math.max(0, (y - tops[lo]) / span));
}
function __pmCenter(scroller) {
  const root = scroller.querySelector(".ProseMirror");
  if (!root || !(scroller.clientHeight > 0)) return null;
  const sr = scroller.getBoundingClientRect();
  const cy = sr.top + scroller.clientHeight / 2;
  const kids = Array.from(root.children);
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (!(r.height > 0)) continue;
    if (cy >= r.top && cy <= r.bottom) return { index: i, tag: kids[i].tagName, text: (kids[i].textContent || "").trim().slice(0, 24) };
  }
  let best = null, bd = Infinity;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (!(r.height > 0)) continue;
    const d = Math.abs((r.top + r.bottom) / 2 - cy);
    if (d < bd) { bd = d; best = { index: i, tag: kids[i].tagName, text: (kids[i].textContent || "").trim().slice(0, 24) }; }
  }
  return best;
}
/** PM 顶层"空段落"数量（= C1 的指纹：parser 由多余空行造出来的） */
function __pmEmptyCount() {
  const root = document.querySelector(".editor-container .ProseMirror");
  if (!root) return null;
  let n = 0;
  for (const el of Array.from(root.children)) {
    // 空段落特征：P 标签且 textContent 为空、无图片等子元素
    if (el.tagName === "P" && (el.textContent || "").trim() === "" && el.querySelectorAll("img").length === 0) n++;
  }
  return n;
}
`;

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

const VARIANTS = [
  { id: "V1", blankLines: 1, edit: "center", desc: "单空行 + 编辑视口中央（基线）" },
  { id: "V2", blankLines: 1, edit: "end", desc: "单空行 + 编辑文档末尾（远离视口）" },
  { id: "V3", blankLines: 2, edit: "none", desc: "双空行 + 不编辑（C1 空段落指纹）" },
  { id: "V4", blankLines: 2, edit: "center", desc: "双空行 + 编辑视口中央" },
];

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-matrix-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });

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

  const doubleCtrl = async () => {
    await ev(`
      await new Promise((r) => setTimeout(r, 320));
      for (const type of ["keydown", "keyup"]) {
        window.dispatchEvent(new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      }
      await new Promise((r) => setTimeout(r, 60));
      for (const type of ["keydown", "keyup"]) {
        window.dispatchEvent(new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      }
      return true;
    `);
  };

  const results = {};
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    for (const V of VARIANTS) {
      if (ONLY.length && !ONLY.includes(V.id)) continue;
      const docText = makeDoc(V.blankLines);
      const docFile = path.join(tmpDir, `${V.id}.md`);
      fs.writeFileSync(docFile, docText, "utf-8");

      log("");
      log(`════════ ${V.id}：${V.desc} ════════`);
      log(`  文档：段间空行=${V.blankLines}，长度=${docText.length}`);
      // 注意：同一进程内换文档走「打开文件」事件（forceUpdateKey 变化）
      const probeMark = JSON.stringify("第 5.1 段");
      let loaded = false;
      for (let a = 0; a < 20 && !loaded; a++) {
        await ev(`
          window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
          return true;
        `);
        await sleep(500);
        loaded = await ev(`
          const pm = document.querySelector(".editor-container .ProseMirror");
          if (!pm) return false;
          const txt = (pm.textContent || "").replace(/\s+/g, "");
          return txt.indexOf(String(${probeMark}).replace(/\s+/g, "")) >= 0;
        `);
      }
      if (!loaded) {
        log(`  ⚠ 文档未装入，跳过 ${V.id}`);
        continue;
      }
      await sleep(900);
      const pmEmpty = await ev(`return __pmEmptyCount();`);
      log(`  PM 顶层空段落数 = ${pmEmpty}（C1 指纹：${V.blankLines >= 2 ? "应 > 0" : "应为 0"}）`);

      // 滚到 50%
      await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        return sc.scrollTop;
      `);
      await sleep(800);
      const base = await ev(`
        const sc = document.querySelector(".editor-container");
        return {
          top: sc.scrollTop,
          max: sc.scrollHeight - sc.clientHeight,
          sh: sc.scrollHeight,
          ch: sc.clientHeight,
          center: __pmCenter(sc),
        };
      `);
      log(
        `  基线：scrollTop=${base.top?.toFixed(1)} max=${base.max} 中心块=${base.center?.index} ` +
          `${JSON.stringify(base.center?.text ?? "")}`,
      );

      // ── 可选编辑 ──
      let editInfo = null;
      if (V.edit !== "none") {
        // 先进编辑模式
        await doubleCtrl();
        await sleep(1100);
        editInfo = await ev(`
          const ta = document.querySelector("textarea.source-editor");
          if (!ta) return { ok: false, why: "no-textarea" };
          ta.focus();
          const ls = ta.value.split("\\n");
          const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
          let pick = 0;
          if ("${V.edit}" === "end") {
            // 裁剪尾部：取最后一个非空行
            for (let i = ls.length - 1; i >= 0; i--) { if ((ls[i] || "").trim()) { pick = i; break; } }
          } else {
            // 视口中央那一行（就近找非空、非标题、非表格行）
            const approx = Math.round((ta.scrollTop + ta.clientHeight / 2) / lh);
            pick = Math.max(0, Math.min(ls.length - 1, approx));
            for (let k = 0; k < 40; k++) {
              const cand = pick + (k % 2 === 0 ? k / 2 : -Math.ceil(k / 2));
              if (cand < 0 || cand >= ls.length) continue;
              const t = (ls[cand] || "").trim();
              if (t && t.charAt(0) !== "#" && t.charAt(0) !== "|" && t.charAt(0) !== ">" && t.charAt(0) !== "-" && t.charAt(0) !== ":") { pick = cand; break; }
            }
          }
          let pos = 0;
          for (let i = 0; i < pick; i++) pos += ls[i].length + 1;
          const indent = /^[#>*\\-\\s|:]+/.exec(ls[pick] || "");
          pos += indent ? indent[0].length : 0;
          ta.setSelectionRange(pos, pos);
          const before = ta.value;
          document.execCommand("insertText", false, ${JSON.stringify(EDIT_MARK)});
          return {
            ok: ta.value.length === before.length + ${EDIT_MARK.length},
            pick, pos, beforeLen: before.length, afterLen: ta.value.length,
            lineText: (ls[pick] || "").slice(0, 40),
          };
        `);
        log(`  编辑（${V.edit}）：行 ${editInfo?.pick} pos=${editInfo?.pos} len ${editInfo?.beforeLen}→${editInfo?.afterLen}`);
        await sleep(1200);
        // 回阅读面
        await doubleCtrl();
        await sleep(1300);
      }

      const first = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, center: __pmCenter(sc), pmEmpty: __pmEmptyCount() };
      `);
      log(
        `  首轮回阅读：scrollTop=${first.top?.toFixed(1)} 中心块=${first.center?.index} ` +
          `${JSON.stringify(first.center?.text ?? "")} 空段落=${first.pmEmpty}`,
      );

      // ── 8 轮往返 ──
      const track = [];
      for (let r = 1; r <= ROUNDS; r++) {
        await doubleCtrl();
        await sleep(900);
        const e = await ev(`
          const ta = document.querySelector("textarea.source-editor");
          const ta2 = ta && ta.clientHeight > 0 ? ta : null;
          return ta2 ? { top: ta2.scrollTop, max: ta2.scrollHeight - ta2.clientHeight } : null;
        `);
        await doubleCtrl();
        await sleep(1000);
        const rd = await ev(`
          const sc = document.querySelector(".editor-container");
          return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, center: __pmCenter(sc) };
        `);
        track.push({ r, edit: e, read: rd });
        log(
          `  R${String(r).padStart(2)} edit=${(e?.top ?? NaN).toFixed(1)}  →  read=${(rd?.top ?? NaN).toFixed(1)}` +
            ` 中心=${rd?.center?.index} ${JSON.stringify(rd?.center?.text ?? "")}`,
        );
      }

      const readTops = track.map((t) => t.read?.top ?? NaN);
      const baseTop = first.top ?? NaN;
      const drift = readTops.map((v) => (Number.isFinite(v) ? v - baseTop : NaN));
      const maxAbs = Math.max(...drift.filter(Number.isFinite).map(Math.abs));
      const net = drift.filter(Number.isFinite).slice(-1)[0];
      const idxs = track.map((t) => t.read?.center?.index ?? -1);
      const baseIdx = first.center?.index ?? -1;
      const idxDrift = idxs.map((i) => i - baseIdx);

      log(`  阅读面序列：${readTops.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
      log(`  漂移：${drift.map((d) => (Number.isFinite(d) ? (d >= 0 ? "+" : "") + d.toFixed(1) : "n/a")).join(", ")}`);
      log(`  中心块下标相对基线：${idxDrift.join(", ")}`);

      results[V.id] = {
        desc: V.desc,
        pmEmpty,
        editInfo,
        base,
        first,
        track,
        readTops,
        drift,
        maxAbs: Number.isFinite(maxAbs) ? +maxAbs.toFixed(2) : null,
        net: Number.isFinite(net) ? +net.toFixed(2) : null,
        idxDrift,
      };
            }
    // 汇总判定
    log("");
    log("════════ 汇总 ════════");
    for (const [id, r] of Object.entries(results)) {
      log(
        `${id}（${r.desc}）：PM空段落=${r.pmEmpty} 最大漂移=${r.maxAbs}px 净漂移=${r.net}px ` +
          `中心块偏移=[${r.idxDrift.join(",")}]`,
      );
    }
    // C1 判定：双空行文档确实多出空段落
    const v3 = results["V3"];
    const v1 = results["V1"];
    if (v3) {
      check(
        "C1 前提：双空行文档的 PM 顶层空段落数 > 单空行文档（两把尺子成立）",
        (v3.pmEmpty ?? 0) > (v1?.pmEmpty ?? 0) || (v3.pmEmpty ?? 0) > 0,
        `V3=${v3.pmEmpty}，V1=${v1?.pmEmpty ?? "n/a"}`,
      );
    }
    // A0 判定：远端编辑不应产生漂移（用来判定 V1 的 −38.5px 是否属"正确重对齐"）
    if (results["V2"]) {
      check(
        "A0：编辑**文档末尾（远离视口）**后往返 8 轮不得漂移（≤2px）",
        (results["V2"].maxAbs ?? 99) <= 2,
        `最大=${results["V2"].maxAbs}px`,
      );
    }
    if (v1) {
      check(
        "V1（编辑视口中央）漂移量记录（用于区分'正确重对齐'与真 bug）",
        v1.maxAbs !== null,
        `最大=${v1.maxAbs}px，净=${v1.net}px（首轮 −38.5px 属预期重对齐时此项应记为一次性、后续 0）`,
      );
    }
    if (v3) {
      check(
        "C1 结论：双空行 + 不编辑，往返不得出现块级错位（中心块偏移全 0）",
        v3.idxDrift.every((d) => d === 0),
        `中心块偏移=[${v3.idxDrift.join(",")}]`,
      );
    }
    if (results["V4"]) {
      check(
        "C1 结论：双空行 + 编辑，往返不得出现块级错位（中心块偏移全 0）",
        results["V4"].idxDrift.every((d) => d === 0),
        `中心块偏移=[${results["V4"].idxDrift.join(",")}]，最大漂移=${results["V4"].maxAbs}px`,
      );
    }

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ results, checks }, null, 2), "utf-8");
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

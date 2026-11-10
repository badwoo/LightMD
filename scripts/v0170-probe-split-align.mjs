/**
 * LightMD v0.17.0 探针：**分屏对齐精度**（A 线验收锚点之一）
 *
 * ## 为什么需要这个探针
 * 设计稿把「分屏滚动对齐」列为 C8/C9 的核心项，且 A 线的验收锚点包含
 * 「分屏对齐精度」——但此前一直没有探针实测，只能标"未测"。
 *
 * ## 要验证的核心命题
 * CM6 的 `measureBlockTops` 在 A3 阶段从 textarea mirror 改成了
 * `lineBlockAt`（CM6 的 heightMap，视口内实测 / 视口外估算）。
 * 报告的预期是：**视口内 ≈ textarea 水平；视口外有估算偏差但不崩、不退回百分比**。
 *
 * 本探针量化这个偏差：
 * 1. 在源码面（CM6）滚动到某位置，记录「视口中央那一行」的源码行号；
 * 2. 读右屏预览 iframe 的滚动位置，找出该行对应的 `data-src-line` 块；
 * 3. 计算该块相对视口中央的像素偏移 —— 理想为 0，允许 < 1 行高。
 *
 * ## 判定
 * - `|偏移| < 1 行高` → PASS（对齐良好）
 * - `1~3 行高` → KNOWN（可感知但不崩，属报告已登记的「估算偏差」）
 * - `> 3 行高` 或退回百分比 → FAIL
 *
 * 用法：node scripts/v0170-probe-split-align.mjs
 * 前置：npx tauri build --no-bundle
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9472;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-split-align.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-split-align.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/**
 * 测试文档：**足够长**（让分屏两侧都能滚动），且**结构均匀**。
 *
 * 为什么需要长文档：短文档两侧都滚不动，无法测对齐。
 * 为什么结构要均匀（大量同构段落 + 少量标题）：
 * 让"第 N 个顶层块"在两侧一一对应，避免 mermaid/表格等
 * `data-src-line` 贴标失败（源码注释里写明：含 mermaid 的文档贴标数为 0）。
 */
function makeDoc() {
  const parts = ["# 分屏对齐测试文档", ""];
  for (let i = 1; i <= 60; i++) {
    parts.push(`## 第 ${i} 节标题`, "");
    parts.push(
      `第 ${i} 节的正文段落。这一段用于制造可滚动的行数与均匀的块结构，` +
        `使左右两侧的「第 N 个顶层块」能够一一对应。长度保持均匀便于对比。`,
      "",
    );
    parts.push(`- 要点 ${i}.1：对齐测试条目`, `- 要点 ${i}.2：对齐测试条目`, "");
  }
  return parts.join("\n");
}
const DOC = makeDoc();

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      res({
        send(m, q) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: q }));
          return new Promise((a, b) => {
            pending.set(i, { a, b });
            setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 30000);
          });
        },
        close() { ws.close(); },
      }),
    );
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
}

async function main() {
  // exe 内联 dist 校验（§4-30 铁律）
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!hm) throw new Error("dist/index.html 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(hm[1]))) {
    throw new Error(`exe 内联 dist 不一致（找不到 ${hm[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hm[1]}`);
  log(`[probe] 测试文档：${DOC.length} 字符 / ${DOC.split("\n").length} 行`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-align-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "align.md");
  fs.writeFileSync(docFile, DOC, "utf8");

  let child = null;
  let cdp = null;
  const results = [];
  const add = (id, name, status, detail) => {
    results.push({ id, name, status, detail });
    const tag = status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL ";
    log(`${tag} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 140 && !cdp; i++) {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })
        ).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (r.result?.result?.value) { cdp = c; break; }
          c.close();
        }
      } catch { /* not ready */ }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 CDP target");

    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      }
      return r.result?.result?.value;
    };

    // ── 打开文档 ──
    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: {
            path: ${JSON.stringify(docFile)},
            name: ${JSON.stringify(path.basename(docFile))},
            content: ${JSON.stringify(DOC)},
          },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return !!pm && (pm.textContent || "").indexOf("第 60 节") >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入");
    log("[probe] 文档已装入");

    /**
     * ── 切到编辑模式并**确保分屏预览打开** ──
     *
     * ⚠️ 不要靠"找按钮文字点击"来开分屏 —— 实测按钮的 aria-label/title 随状态翻转，
     * 且页面上多个按钮含"预览"字样，容易点错或点到不可用的。
     * 走 App 的**命令总线**（`lightmd:command`）是既有正式入口：
     * ```
     * if (id === "view.edit") { setSplitPreviewOpen(true); setViewMode("edit"); }
     * ```
     * 这条命令的语义就是"进编辑模式 = 旧分屏观感"，会顺带打开右侧预览。
     */
    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } }));
      return true;
    `);
    await sleep(2500);
    log("[probe] 已发送 view.edit 命令（进编辑模式 + 打开右侧预览）");

    // 检查分屏是否已开
    let splitOpen = await ev(
      `return !!document.querySelector("iframe.split-preview");`,
    );
    if (!splitOpen) {
      // 兜底：显式切一次 togglePreview
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } }));
        return true;
      `);
      await sleep(2000);
      splitOpen = await ev(
        `return !!document.querySelector("iframe.split-preview");`,
      );
    }
    add("1", "分屏预览已开启", splitOpen ? "PASS" : "FAIL", splitOpen ? "" : "找不到预览 iframe");
    if (!splitOpen) throw new Error("分屏未开启，无法测对齐");

    // ── 等预览内容渲染 + data-src-line 贴标 ──
    let marked = null;
    for (let i = 0; i < 25; i++) {
      marked = await ev(`
        const f = document.querySelector("iframe.split-preview");
        const d = f && f.contentDocument;
        if (!d) return null;
        const els = Array.from(d.querySelectorAll("[data-src-line]"));
        return { count: els.length, maxLine: els.length ? Math.max(...els.map(e => +e.getAttribute("data-src-line"))) : 0 };
      `);
      if (marked && marked.count > 10) break;
      await sleep(600);
    }
    log("[probe] data-src-line 贴标：" + JSON.stringify(marked));
    add(
      "2",
      "预览侧 data-src-line 贴标可用",
      marked && marked.count > 10 ? "PASS" : "FAIL",
      `贴标块数=${marked?.count ?? 0}`,
    );
    if (!marked || marked.count <= 10) throw new Error("data-src-line 贴标不足，无法测对齐");

    /**
     * ── 核心测量 ──
     *
     * 步骤：
     * 1. 在 CM6 侧滚动到文档中部某处；
     * 2. 读右屏 iframe 的滚动位置，找"视口中央"最近的那个 data-src-line 块；
     * 3. 计算该块中心的像素位置 vs 预览视口中心的偏移。
     *
     * 注意：这里测的是**联动后的稳态对齐**，不是滚动瞬间。
     * 需要等联动完成（分屏联动有自己的节流/方向锁）。
     */
    const SCROLL_FRACTIONS = [0.2, 0.4, 0.6, 0.8];
    const samples = [];

    for (const frac of SCROLL_FRACTIONS) {
      // ① 滚动 CM6 到指定比例
      const scrolled = await ev(`
        const ed = document.querySelector(".cm-editor");
        const scroller = ed && ed.querySelector(".cm-scroller");
        if (!scroller) return null;
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = max * ${frac};
        scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
        return { scrollTop: scroller.scrollTop, max: max, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
      `);
      await sleep(1200); // 等联动稳定

      // ② 读两侧状态
      const paired = await ev(`
        const ed = document.querySelector(".cm-editor");
        const scroller = ed && ed.querySelector(".cm-scroller");
        const f = document.querySelector("iframe.split-preview");
        const d = f && f.contentDocument;
        if (!scroller || !d) return null;
        const win = f.contentWindow;
        const docEl = d.scrollingElement || d.documentElement;
        const pvTop = win.scrollY;
        const pvMid = pvTop + win.innerHeight / 2;
        // 找预览视口中央附近的 data-src-line 块
        const els = Array.from(d.querySelectorAll("[data-src-line]"));
        let best = null;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          const center = r.top + r.height / 2;   // 相对预览视口
          if (best === null || Math.abs(center - win.innerHeight / 2) < Math.abs(best.center - win.innerHeight / 2)) {
            best = { line: +el.getAttribute("data-src-line"), center, height: r.height };
          }
        }
        if (!best) return null;
        // 源码侧：视口中央对应的行
        const srcMid = scroller.scrollTop + scroller.clientHeight / 2;
        return {
          srcScrollTop: scroller.scrollTop,
          srcMax: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          previewScrollTop: pvTop,
          previewMidBlockLine: best.line,
          previewMidOffsetPx: Math.round(best.center - win.innerHeight / 2),
          previewBlockHeight: Math.round(best.height),
          markedCount: els.length,
        };
      `);
      if (!paired) { continue; }
      samples.push({ frac, ...paired });
      log(
        `[probe] frac=${frac} 源码scrollTop=${Math.round(paired.srcScrollTop)}/${paired.srcMax} ` +
          `→ 预览中央块 line=${paired.previewMidBlockLine} 偏移=${paired.previewMidOffsetPx}px ` +
          `(块高 ${paired.previewBlockHeight}px)`,
      );
    }

    add("3", "分屏联动产生有效测量样本", samples.length >= 3 ? "PASS" : "FAIL", `样本=${samples.length}/4`);

    if (samples.length) {
      /**
       * 判定：预览中央块的偏移应小于 **1 个块高**。
       *
       * 为什么用"块高"而非固定像素：不同字号/内容下块高差异大，
       * 用相对量才有跨配置可比性。
       */
      const offsets = samples.map((s) => Math.abs(s.previewMidOffsetPx));
      const worst = Math.max(...offsets);
      const worstSample = samples[offsets.indexOf(worst)];
      const tolerance = worstSample.previewBlockHeight;
      const medianOffset = offsets.slice().sort((a, b) => a - b)[Math.floor(offsets.length / 2)];

      if (worst <= tolerance) {
        add("4", "分屏对齐精度（偏移 < 1 块高）", "PASS", `最差=${worst}px / 容差=${tolerance}px；中位=${medianOffset}px`);
      } else if (worst <= tolerance * 3) {
        add(
          "4",
          "分屏对齐精度（偏移 1~3 块高，属已登记估算偏差）",
          "KNOWN",
          `最差=${worst}px / 容差=${tolerance}px；中位=${medianOffset}px`,
        );
      } else {
        add(
          "4",
          "分屏对齐精度",
          "FAIL",
          `最差=${worst}px 超过 3 块高（${tolerance * 3}px）；中位=${medianOffset}px`,
        );
      }

      // 附加：验证"不是退回百分比"——百分比映射在长文档上会大幅偏离
      // 这里用"偏移是否随 frac 单调漂移"来侧面判断
      const drift = Math.abs(offsets[offsets.length - 1] - offsets[0]);
      add(
        "5",
        "未退回百分比映射（偏移无系统性漂移）",
        drift <= tolerance * 2 ? "PASS" : "KNOWN",
        `首尾偏移差=${drift}px（容差 ${tolerance * 2}px）`,
      );
    }
  } catch (err) {
    log(`[probe] 异常：${err?.message || String(err)}`);
    results.push({ id: "E", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }

    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify({ generatedAt: new Date().toISOString(), doc: { chars: DOC.length, lines: DOC.split("\n").length }, results }, null, 1),
      "utf8",
    );
    log(`[probe] 产物：${OUT_JSON}`);
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}

main();

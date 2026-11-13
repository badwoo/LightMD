/**
 * #2 「第一次打开软件切换到编辑模式下，偶尔会出现页面崩溃（ErrorBoundary /
 *      Something went wrong / Your document is intact. Retry...）」—— 真机冷启动探针。
 *
 * ## 用户原话
 * 「第一次打开软件切换到编辑模式下，偶尔会出现页面崩溃情况，界面渲染出错 /
 *  Something went wrong / Your document is intact. Retry... 需要点击"重试"才能正常。」
 *
 * ## 为什么必须真机
 * - 涉及 Tauri 窗口会话 / WebView2 真实冷启动 / localStorage 落盘；
 * - 浏览器版（`v0170-r2-coldstart-browser`）覆盖不了 WebView2 的 iframe `doc.open/write`
 *   时序差异（§4-27d 记过：`doc.close()` 返回时 `doc.body` 可能仍是 null）。
 *
 * ## 前提（Lead 已处理）
 * `tauri-plugin-single-instance` 用 Win32 互斥量挡同 identifier 的第二实例。
 * 探针版 exe 已用 `-c _plan/probe-config.json` 构建（identifier `com.lightmd.probe`）。
 * ⚠️ 改了 TS/TSX 后必须**带 `-c` 重新构建**，否则 exe 内联的是旧 dist。
 *
 * ## 采集口径（三条独立证据，缺一条都不算复现）
 * 1. `window.__ERRS` —— 未捕获异常 / unhandledrejection（骨架内置）
 * 2. CDP `Runtime.exceptionThrown` —— React 错误边界**吞掉**的渲染错误也在这里
 * 3. `.error-boundary` DOM 是否出现（用户唯一能看到的症状）
 * 4. `console.error` 里的 `[ErrorBoundary] 渲染出错:`（错误边界自己打的堆栈）
 *
 * ## 重复次数
 * 每次都要**全新 profile**（冷启动 = 空 localStorage），所以每轮用独立的
 * `makeProfileDir`，顺序跑（实例锁已串行化）。
 */
import {
  runProbe,
  makeProfileDir,
  OUT_DIR,
} from "./_lib/probe-harness.mjs";
import fs from "node:fs";
import path from "node:path";

const ROUNDS = Number(process.env.COLD_ROUNDS || 5);

const parts = ["# 冷启动崩溃复现", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
    "",
  );
  // 混入易触发渲染路径的块（列表 / 代码块 / 表格 / 图片引用），提高覆盖面
  if (i === 5) parts.push("- 列表项 A", "- 列表项 B", "");
  if (i === 10) parts.push("```js", "const a = 1;", "```", "");
  if (i === 15) parts.push("| 列1 | 列2 |", "| --- | --- |", "| a | b |", "");
  if (i === 20) parts.push("### 三级标题", "");
  if (i === 25) parts.push("> 引用块内容", "");
}
const DOC = parts.join("\n");

/** 汇总表，最后统一输出 */
const summary = [];

for (let round = 1; round <= ROUNDS; round++) {
  const profile = makeProfileDir(`cold${round}`);
  const name = `v0170-r2-coldstart-exe-r${round}`;
  const rec = {
    round,
    profile,
    name,
    boundaryAppeared: null,
    uncaught: null,
    exceptionThrown: null,
    consoleErrors: null,
    stack: null,
  };

  await runProbe(
    { name, doc: DOC, docTitle: "PI01", viewMode: "raw", profileDir: profile },
    async (ui) => {
      /* ─── 冷启动后**立即**装三路采集（在切模式之前！） ─── */
      await ui.ev(`
        window.__ERRS = window.__ERRS || [];
        window.__CONSOLE_ERRS = [];
        window.__BOUNDARY_HITS = [];
        window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
        window.addEventListener("unhandledrejection", (e) =>
          window.__ERRS.push("rejection:" + String((e.reason && e.reason.message) || e.reason)));
        // 错误边界自己打的日志（带 componentStack）
        const origErr = console.error;
        console.error = function (...args) {
          try {
            const s = args.map((a) => (a && a.stack) ? a.stack : String(a)).join(" ");
            if (s.includes("[ErrorBoundary]") || s.includes("渲染出错")) {
              window.__CONSOLE_ERRS.push(s);
            }
          } catch { /* ignore */ }
          return origErr.apply(console, args);
        };
        // MutationObserver 盯 .error-boundary 出现（错误边界的 DOM 是唯一用户可见症状）
        const mo = new MutationObserver(() => {
          const el = document.querySelector(".error-boundary, [data-testid='error-boundary']");
          if (el && window.__BOUNDARY_HITS.length < 20) {
            window.__BOUNDARY_HITS.push({
              t: Math.round(performance.now()),
              text: (el.textContent || "").slice(0, 300),
            });
          }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        return true;
      `);

      /* ─── 装文档（模拟"打开上次文件"后的首屏） ─── */
      await ui.ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify("D:/tmp/v0170-coldstart.md")}, name: "v0170-coldstart.md", content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await ui.sleep(2500);

      /* ─── 用户报告的触发动作：**立即**切到编辑模式 ─── */
      await ui.command("view.edit");
      // 立刻检查（覆盖"切的那一帧就崩"）
      await ui.sleep(400);
      const early = await ui.ev(`
        return {
          boundary: !!document.querySelector(".error-boundary, [data-testid='error-boundary']"),
          errs: (window.__ERRS || []).slice(),
          hits: (window.__BOUNDARY_HITS || []).slice(),
        };
      `);
      await ui.sleep(3000);
      const late = await ui.ev(`
        return {
          boundary: !!document.querySelector(".error-boundary, [data-testid='error-boundary']"),
          boundaryText: (() => { const e = document.querySelector(".error-boundary, [data-testid='error-boundary']"); return e ? (e.textContent || "").slice(0, 400) : null; })(),
          errs: (window.__ERRS || []).slice(),
          hits: (window.__BOUNDARY_HITS || []).slice(),
          consoleErrs: (window.__CONSOLE_ERRS || []).slice(),
          hasCm: !!document.querySelector(".cm-editor"),
          cmLines: document.querySelectorAll(".cm-line").length,
          hasIframe: !!document.querySelector("iframe.split-preview"),
          iframeHasBody: (() => { const f = document.querySelector("iframe.split-preview"); const d = f && f.contentDocument; return d ? !!d.body : null; })(),
          splitW: (() => { const s = document.querySelector(".split-preview-shell"); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
        };
      `);

      rec.boundaryAppeared = early.boundary || late.boundary;
      rec.uncaught = late.errs;
      rec.consoleErrors = late.consoleErrs;
      rec.stack = late.consoleErrs.length ? late.consoleErrs[0] : null;

      ui.log(`[轮 ${round}] early.boundary=${early.boundary} late.boundary=${late.boundary}`);
      ui.log(`[轮 ${round}] errs=${JSON.stringify(late.errs).slice(0, 500)}`);
      ui.log(`[轮 ${round}] consoleErrs=${(late.consoleErrs || []).map((s) => String(s).slice(0, 400)).join(" ||| ")}`);
      ui.log(`[轮 ${round}] 布局 cm=${late.hasCm} lines=${late.cmLines} iframe=${late.hasIframe} iframeBody=${late.iframeHasBody} splitW=${late.splitW}`);

      ui.add(`R${round}-1`, `冷启动第 ${round} 轮：切编辑后错误边界是否出现`, rec.boundaryAppeared ? "FAIL" : "PASS",
        rec.boundaryAppeared ? (late.boundaryText || "").slice(0, 200) : "未出现");
      ui.add(`R${round}-2`, `冷启动第 ${round} 轮：未捕获异常`, (late.errs || []).length === 0 ? "PASS" : "FAIL",
        (late.errs || []).length ? JSON.stringify(late.errs).slice(0, 400) : "无");
      ui.add(`R${round}-3`, `冷启动第 ${round} 轮：ErrorBoundary 控制台堆栈`, (late.consoleErrs || []).length === 0 ? "PASS" : "FAIL",
        (late.consoleErrs || []).length ? String(late.consoleErrs[0]).slice(0, 700) : "无");
      ui.add(`R${round}-4`, `冷启动第 ${round} 轮：切编辑后渲染是否正常（CM6 + iframe）`,
        late.hasCm && late.cmLines > 0 ? "PASS" : "FAIL",
        `cm=${late.hasCm} lines=${late.cmLines} iframe=${late.hasIframe} iframeBody=${late.iframeHasBody} splitW=${late.splitW}`);
      await ui.shot(`round${round}`);
    },
  );

  /* ─── CDP 层的 exceptionThrown 在 body 跑完后单独取（骨架不暴露监听） ─── */
  rec.exceptionThrown = "见 Runtime 事件（骨架未暴露；以 consoleErrors + __ERRS 为准）";
  summary.push(rec);
}

/* ═══ 汇总 ═══ */
const failed = summary.filter((r) => r.boundaryAppeared || (r.uncaught || []).length > 0);
const lines = [
  `#2 冷启动切编辑·复现统计（${ROUNDS} 轮真机冷启动）`,
  `复现率：${failed.length}/${ROUNDS}`,
  "",
];
for (const r of summary) {
  lines.push(`轮 ${r.round}: boundary=${r.boundaryAppeared} uncaught=${(r.uncaught || []).length} consoleErrs=${(r.consoleErrors || []).length}`);
  if (r.stack) lines.push(`  堆栈：${String(r.stack).slice(0, 1200)}`);
}
const outPath = path.join(OUT_DIR, "v0170-r2-coldstart-summary.txt");
fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
console.log("\n" + lines.join("\n"));
console.log(`[summary] ${outPath}`);

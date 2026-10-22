/**
 * LightMD v0.14.0 需求3 —— 修复验证（真实 WebView2 + **真实的新 useResizable 代码**）
 *
 * 为什么需要这个脚本：
 *   jsdom 测不出根因（jsdom 里 iframe 不会抢占鼠标事件），仓库里的打包产物又是
 *   v0.13.2 旧代码，所以无法「直接跑新 exe」。做法：
 *     1. 用 esbuild 把 `src/hooks/useResizable.ts` + 独立一份 React 打成自包含 IIFE；
 *     2. 通过 CDP `Runtime.evaluate` 注入到真实应用页面（CSP 不约束 Runtime.evaluate），
 *        挂在一个 fixed 定位的覆盖层里：一个 .split-divider 相邻一个真实 <iframe>；
 *     3. 用 `Input.dispatchMouseEvent` 发**真实的** WebView2 鼠标手势：
 *        「分割条上按下 → 指针**进入右侧 iframe** → 继续移动 → 松手 → 再反向拖」；
 *     4. 读回 hook 输出的 ratio 序列，判断往右拖是否真的能改变比例（旧代码这里是 0 次事件）。
 *
 * 用法：node scripts/v0140-verify-split-divider-fix.mjs
 * 输出：控制台证据 + _verify-out/v0140-verify-split-divider-fix.txt
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.env.LIGHTMD_EXE || "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_VERIFY_PORT || 9253);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const ROOT = "D:\\AI\\markdown view\\lightmd";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

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
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send(method, params, timeoutMs = 120000) {
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

/**
 * 把指定 hook 源文件 + React 打成自包含 IIFE（React 打进来，避免依赖页面暴露 React）。
 *
 * @param hookPath 要打包的 useResizable 源文件（修复后 = src/hooks/useResizable.ts；
 *                 对照 = _verify-out/useResizable.old.ts，即 git HEAD 里的旧实现）
 * @param tag      挂到 window 上的命名空间（__hNew / __hOld）
 */
async function buildHarnessBundle(hookPath, tag) {
  const esbuildMain = path.join(ROOT, "node_modules/.pnpm/esbuild@0.21.3/node_modules/esbuild/lib/main.js");
  const mod = await import(`file://${esbuildMain.replace(/\\/g, "/")}`);
  const esbuild = mod.default ?? mod;
  const entry = path.join(ROOT, `_verify-out/harness-entry-${tag}.tsx`);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const hookSrc = hookPath.replace(/\\/g, "/");
  fs.writeFileSync(
    entry,
    `
import { createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useResizable } from ${JSON.stringify(hookSrc)};

const TAG = ${JSON.stringify(tag)};

/** 挂在真实应用页面上的最小验证台：分割条 + 紧邻的真实 iframe + 左右两栏 */
function Harness() {
  const [ratio, setRatio] = useState(0.5);
  const logRef = useRef<number[]>([]);
  const resizer = useResizable({
    direction: "split",
    initialRatio: ratio,
    onSplitChange: (r: number) => { logRef.current.push(r); setRatio(r); },
  });
  (window as any)[TAG] = {
    get ratio() { return resizer.ratio; },
    get isDragging() { return resizer.isDragging; },
    get changes() { return logRef.current.slice(); },
    reset() { logRef.current = []; },
  };
  const id = (n: string) => TAG + "-" + n;
  return createElement(
    "div",
    { id: id("root"), style: { position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", background: "#fff", fontFamily: "sans-serif" } },
    createElement("div", { id: id("left"), style: { width: "calc(" + ratio * 100 + "% - 3px)", background: "#eef", padding: "8px" } }, "left " + ratio.toFixed(3)),
    createElement("div", {
      id: id("divider"),
      className: "split-divider",
      style: { width: "6px", minWidth: "6px", flexShrink: 0, background: "#333", cursor: "col-resize", alignSelf: "stretch" },
      onMouseDown: resizer.onMouseDown,
    }),
    createElement("iframe", {
      id: id("iframe"),
      className: "split-preview",
      style: { flex: "none", width: "calc(" + (1 - ratio) * 100 + "% - 3px)", border: "none", background: "#ffe" },
      srcDoc: "<body style='margin:0;font:14px sans-serif'>right pane iframe</body>",
    }),
  );
}

const host = document.createElement("div");
host.id = TAG + "-host";
document.body.appendChild(host);
createRoot(host).render(createElement(Harness));
`,
  );
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2020",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`未找到打包产物：${EXE}`);
    process.exit(3);
  }

  // ── 取出 git HEAD 里的旧实现作为 A/B 对照 ──
  // 旧版 exe 无法直接跑新代码；把 HEAD 版本的 hook 源码抽出来打进同一个验证台，
  // 就能在**完全相同的环境、完全相同的坐标**下对比「修复前 vs 修复后」。
  const oldHookPath = path.join(ROOT, "_verify-out/useResizable.old.ts");
  fs.mkdirSync(path.dirname(oldHookPath), { recursive: true });
  fs.writeFileSync(
    oldHookPath,
    execFileSync("git", ["show", "HEAD:src/hooks/useResizable.ts"], { cwd: ROOT, encoding: "utf-8" }),
  );

  const newBundle = await buildHarnessBundle(path.join(ROOT, "src/hooks/useResizable.ts"), "__hNew");
  const oldBundle = await buildHarnessBundle(oldHookPath, "__hOld");
  log(`验证台打包完成：新实现 ${newBundle.length} bytes / 旧实现 ${oldBundle.length} bytes（各自含独立 React）`);
  log(`（旧实现取 git HEAD:src/hooks/useResizable.ts —— 即 v0.13.2 打包产物里的代码）`);

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    await sleep(1200);
  } catch {
    /* 无实例 */
  }

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });

  let cdp;
  try {
    let picked = null;
    for (let i = 0; i < 60 && !picked; i++) {
      try {
        const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
        for (const t of list) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          try {
            const c = await connect(t.webSocketDebuggerUrl);
            await c.send("Runtime.enable");
            const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true }, 20000);
            if (r.result?.result?.value === true) {
              picked = c;
              break;
            }
            c.close();
          } catch {
            /* next */
          }
        }
      } catch {
        /* 端口未就绪 */
      }
      if (!picked) await sleep(500);
    }
    if (!picked) throw new Error("未找到带 Tauri IPC 的 page target");
    cdp = picked;
    await cdp.send("Page.enable");

    const evalJs = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify((() => { ${expression} })())`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      const raw = r.result?.result?.value;
      return raw === undefined ? undefined : JSON.parse(raw);
    };

    const inject = async (tag, bundle) => {
      const r = await cdp.send("Runtime.evaluate", { expression: bundle, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(`注入 ${tag} 失败: ${JSON.stringify(r.result.exceptionDetails).slice(0, 600)}`);
      await sleep(1200);
      const ok = await evalJs(`return !!(document.getElementById("${tag}-divider") && document.getElementById("${tag}-iframe"));`);
      if (!ok) throw new Error(`${tag} 验证台未挂载成功`);
    };

    // ══════════════════════════════════════════════════════════════
    // 通用手势驱动器：对指定 tag 的验证台做完整手势序列
    // ══════════════════════════════════════════════════════════════
    const driveHarness = async (tag) => {
      const id = (n) => `${tag}-${n}`;

      /** 读当前几何 + hook 状态 */
      const snap = async () => {
        return evalJs(`
          const d = document.getElementById("${id("divider")}");
          const l = document.getElementById("${id("left")}");
          const f = document.getElementById("${id("iframe")}");
          const dr = d.getBoundingClientRect();
          const lw = l.getBoundingClientRect().width;
          const fr = f.getBoundingClientRect();
          return {
            dividerX: Math.round((dr.left + dr.width / 2) * 10) / 10,
            dividerLeft: Math.round(dr.left * 10) / 10,
            leftWidth: Math.round(lw * 10) / 10,
            iframeLeft: Math.round(fr.left * 10) / 10,
            ratio: Math.round(window["${tag}"].ratio * 10000) / 10000,
            isDragging: window["${tag}"].isDragging,
            changeCount: window["${tag}"].changes.length,
            iframePE: f.style.pointerEvents,
            resizingAttr: document.documentElement.getAttribute("data-split-resizing"),
            bodyCursor: document.body.style.cursor,
            bodyClass: document.body.className,
          };
        `);
      };

      /**
       * 一次手势：在「当前分割条位置」按下 → 按 offsets 分段移动 → 松手。
       * 返回每步的几何与指针下方元素，供判定「指针是否真的进入了 iframe」。
       */
      const gesture = async (label, offsets) => {
        const before = await snap();
        const x0 = Math.round(before.dividerX);
        const y = Math.round(
          (await evalJs(`const d=document.getElementById("${id("divider")}"); const r=d.getBoundingClientRect(); return r.top + Math.min(r.height/2, 400);`)),
        );

        await evalJs(`window["${tag}"].reset(); return true;`);

        // 按下（带重试：连续 mousedown 落在同一坐标时，浏览器可能把它当成双击序列的一部分）
        let pressed = false;
        for (let attempt = 1; attempt <= 3 && !pressed; attempt++) {
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1 });
          await sleep(160);
          pressed = await evalJs(`return window["${tag}"].isDragging === true;`);
          if (!pressed) {
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y, button: "none", buttons: 0 });
            await sleep(220);
          }
        }

        const steps = [];
        for (const off of offsets) {
          const nx = x0 + off;
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: nx, y, button: "left", buttons: 1 });
          await sleep(95);
          const s = await snap();
          const under = await evalJs(`
            const el = document.elementFromPoint(${nx}, ${y});
            return { tag: el ? el.tagName : null, id: el ? el.id : null };
          `);
          steps.push({ sentX: nx, under: `${under.tag}#${under.id}`, ...s });
        }

        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x0 + offsets[offsets.length - 1], y, button: "left", buttons: 1, clickCount: 1 });
        await sleep(320);
        const after = await snap();
        return { label, x0, pressed, steps, before, after };
      };

      // ── 手势 ① 往左拖（指针留在左栏内，旧代码本来就能用）──
      const g1 = await gesture("① 往左拖 200px", [-40, -80, -120, -160, -200]);
      // ── 手势 ② 往右拖（指针**进入右侧 iframe**，这就是缺陷发生的方向）──
      const g2 = await gesture("② 往右拖 180px（进入 iframe）", [30, 60, 90, 120, 150, 180]);
      // ── 手势 ③ 再往左拖回来（验证能连续来回）──
      const g3 = await gesture("③ 再往左拖 120px", [-30, -60, -90, -120]);
      // ── 手势 ④ 一路拖到 min 边界 ──
      const g4 = await gesture("④ 拖到 min 边界", [-150, -300, -500, -700]);
      // ── 手势 ⑤ 边界后反向只拖 10px（无死区判定）──
      const g5 = await gesture("⑤ 边界后反向 10px", [10]);

      return { g1, g2, g3, g4, g5 };
    };

    /** 打印一次手势的逐行证据 */
    const traceGesture = (r) => {
      log(
        `\n  ${r.label}  起点 x=${r.x0}  按下生效=${r.pressed}  ` +
          `ratio ${r.before.ratio} → ${r.after.ratio}  (左栏 ${r.before.leftWidth} → ${r.after.leftWidth}px, onSplitChange 触发 ${r.after.changeCount} 次)`,
      );
      for (const s of r.steps) {
        log(
          `    x=${String(s.sentX).padEnd(5)} 指针下方=${String(s.under).padEnd(22)} ratio=${String(s.ratio).padEnd(7)} 左栏=${String(s.leftWidth).padEnd(7)} iframePE="${s.iframePE}"`,
        );
      }
    };

    /** 汇总一个实现的判定 */
    const judge = (res) => {
      const { g1, g2, g3, g4, g5 } = res;
      const leftWorks = g1.pressed && g1.after.ratio < g1.before.ratio - 0.05;
      const rightWorks = g2.pressed && g2.after.ratio > g2.before.ratio + 0.05;
      const leftBackWorks = g3.pressed && g3.after.ratio < g3.before.ratio - 0.02;
      const boundaryHeld = g4.pressed && Math.abs(g4.after.ratio - 0.3) < 1e-6;
      const noDeadZone = g4.pressed && g5.pressed && g5.after.ratio > g4.after.ratio + 1e-4;
      const cleaned =
        g5.after.iframePE === "" &&
        g5.after.resizingAttr === null &&
        g5.after.bodyCursor === "" &&
        !g5.after.bodyClass.includes("split-resizing");
      const enterIframe = g2.steps.some((s) => String(s.under).startsWith("IFRAME"));
      return { leftWorks, rightWorks, leftBackWorks, boundaryHeld, noDeadZone, cleaned, enterIframe };
    };

    // ══════════════════════════════════════════════════════════════
    // A. 修复后的实现
    // ══════════════════════════════════════════════════════════════
    await inject("__hNew", newBundle);
    log("\n──────── A. 修复后的 useResizable（当前源码）────────");
    const newRes = await driveHarness("__hNew");
    for (const g of [newRes.g1, newRes.g2, newRes.g3, newRes.g4, newRes.g5]) traceGesture(g);
    const newJudge = judge(newRes);

    // 卸载 A 的验证台，避免遮挡 B
    await evalJs(`const h=document.getElementById("__hNew-host"); if(h) h.remove(); return true;`);
    await sleep(400);

    // ══════════════════════════════════════════════════════════════
    // B. 修复前的实现（git HEAD）—— 对照
    // ══════════════════════════════════════════════════════════════
    await inject("__hOld", oldBundle);
    log("\n──────── B. 修复前（git HEAD，v0.13.2 打包产物里的代码）—— 对照 ────────");
    const oldRes = await driveHarness("__hOld");
    for (const g of [oldRes.g1, oldRes.g2, oldRes.g3, oldRes.g4, oldRes.g5]) traceGesture(g);
    const oldJudge = judge(oldRes);

    // ══════════════════════════════════════════════════════════════
    // 判定
    // ══════════════════════════════════════════════════════════════
    const yn = (b) => (b ? "✔" : "✘");
    log("\n===== 判定（真实 WebView2，同一坐标序列，A/B 对照）=====");
    log(`                                   修复前(HEAD)   修复后(当前)`);
    const row = (name, a, b) => log(`  ${name.padEnd(30)} ${yn(a).padEnd(14)} ${yn(b)}`);
    row("① 往左拖能改变比例", oldJudge.leftWorks, newJudge.leftWorks);
    row("② 往右拖能改变比例（关键）", oldJudge.rightWorks, newJudge.rightWorks);
    row("③ 再往左能拖回来", oldJudge.leftBackWorks, newJudge.leftBackWorks);
    row("④ 拖到 min 边界被钳制", oldJudge.boundaryHeld, newJudge.boundaryHeld);
    row("⑤ 边界后反向无死区", oldJudge.noDeadZone, newJudge.noDeadZone);
    row("⑥ 拖拽收尾清理干净", oldJudge.cleaned, newJudge.cleaned);

    log(`\n  ② 往右拖时指针下方是否真的进入 iframe：修复前=${oldJudge.enterIframe} 修复后=${newJudge.enterIframe}`);
    log(
      `  ② 修复前往右拖：ratio ${oldRes.g2.before.ratio} → ${oldRes.g2.after.ratio}，` +
        `onSplitChange 触发 ${oldRes.g2.after.changeCount} 次（发出 6 次 mouseMoved）`,
    );
    log(
      `  ② 修复后往右拖：ratio ${newRes.g2.before.ratio} → ${newRes.g2.after.ratio}，` +
        `onSplitChange 触发 ${newRes.g2.after.changeCount} 次（发出 6 次 mouseMoved）`,
    );

    const bugReproduced = !oldJudge.rightWorks && oldJudge.leftWorks;
    const fixConfirmed =
      newJudge.leftWorks && newJudge.rightWorks && newJudge.leftBackWorks && newJudge.boundaryHeld && newJudge.noDeadZone && newJudge.cleaned;

    log(`\n  缺陷复现（旧实现：左拖能、右拖不能）：${bugReproduced ? "是 ✔" : "否 ✘"}`);
    log(`  修复生效（新实现：左右都能来回 + 边界无死区 + 收尾干净）：${fixConfirmed ? "是 ✔" : "否 ✘"}`);

    const pass = bugReproduced && fixConfirmed;
    log(`\n${pass ? "PASS" : "FAIL"} —— 根因与修复在真实 WebView2 下${pass ? "双向确认" : "未能双向确认"}`);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "v0140-verify-split-divider-fix.txt"), lines.join("\n") + "\n");
    fs.writeFileSync(
      path.join(OUT_DIR, "v0140-verify-split-divider-fix.json"),
      JSON.stringify({ newRes, oldRes, newJudge, oldJudge, bugReproduced, fixConfirmed, pass }, null, 2),
    );
    process.exitCode = pass ? 0 : 1;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    child.unref?.();
  }
}

main().catch((e) => {
  console.error("验证异常:", e);
  process.exit(2);
});

/**
v0.17.0 诊断：**相位模型的决定性验证**（p95 由按键节奏决定，非代码质量）

## 背景
`v0170-probe-latency-floor.mjs` 提出了一个模型：

```
门禁口径 A = T（处理耗时） + P（距下一帧的随机相位），  P ~ Uniform[0, 帧长)
  p95[A] = T + 0.95 × 帧长
```

该模型若成立，会推出一个**可证伪的预言**：

> **只改按键节奏（不改一行代码），p95 就会显著变化** —— 因为不同的按键间隔
> 会让按键落在不同的相位分布上。

本探针就做这个实验：同一份 5MB 文档、同一个 exe、同一段代码，
只改变按键间隔，观察 p95。

## 实验设计
| 组 | 按键间隔 | 相对帧长(16.67ms) | 预期相位分布 |
|---|---|---|---|
| A | 100ms | 恰好 6 帧 | CDP 往返抖动使相位扩散 |
| B | 16ms | ≈1 帧 | 每次落点相位几乎相同 |

## 实测结果（2026-11-10，本机，**各跑 3 次**）

| 组 | 按键间隔 | p95 三次实测 | p95 均值 | p50 |
|---|---|---|---|---|
| A | 100ms | 17.8 / 17.4 / 17.4ms | **17.5ms** | 9.5ms |
| B | 16ms | 16.7 / 16.9 / 16.9ms | **16.8ms** | 8.9ms |

**代码完全没改，p95 从 17.5 → 16.8ms（降 4%）。**

> ⚠️ **一次差点写错的经历**：我最初只跑了一次 16ms 组，得到 **15.9ms**，
> 当场想写成「16ms 节奏就能 PASS」。复跑三次得到 16.7/16.9/16.9 ——
> 说明 15.9 是**偶然偏低**，不是真实值。
> **这已经是同一个教训在本项目里第二次出现**：
> 单次测量只能给观测值，不能下结论（上次是 rAF 地板 18.2→16.5）。

## 结论
1. p95 的变化**由相位分布决定**，不是代码变快/变慢；
2. 5MB 输入真实处理成本 ≈ 0.1–1.2ms（见 floor 探针的 B/A 两项）；
3. ⇒ **在这条门禁口径上继续优化代码无效** —— 该改的是度量口径。
## 建议（v0.18）
把「每键到 paint 的 p95 < 16ms」改为：
- `处理成本 p95 < 4ms`（纯 JS，跨机器稳定，不受刷新率影响）；
- `跳帧率 < 5%`（用户可感知的卡顿比例；当前 4.1–6.3%）。

## 复现方式
本探针通过环境变量控制间隔，避免改动生产脚本：
```
INTERVAL_MS=100 node scripts/v0170-probe-phase-model.mjs   # 复现 A 组（默认）
INTERVAL_MS=16  node scripts/v0170-probe-phase-model.mjs   # 复现 B 组
```
前置：`npx tauri build --no-bundle`（本脚本会校验 exe 内联 dist）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9488;
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 100);
const TYPE_SECONDS = Number(process.env.TYPE_SECONDS || 20);
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-phase-model.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-phase-model.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/** 5MB 结构化文档（与 perf-bench 同形的精简版） */
function makeDoc(bytes) {
  const parts = ["# 相位模型测试", ""];
  let i = 0;
  while (Buffer.byteLength(parts.join("\n"), "utf8") < bytes) {
    i++;
    switch (i % 5) {
      case 1:
        parts.push(`## 第 ${i} 节`, "", `第 ${i} 节正文，用于制造可滚动行数与均匀块结构。`, "");
        break;
      case 2:
        parts.push(`- 要点 ${i}.1`, `- 要点 ${i}.2`, "");
        break;
      case 3:
        parts.push("| A | B |", "| --- | --- |", `| ${i} | x |`, "");
        break;
      case 4:
        parts.push("```ts", `const v${i} = ${i};`, "```", "");
        break;
      default:
        parts.push(`> 第 ${i} 节引用块。`, "");
        break;
    }
  }
  return parts.join("\n");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => res({
      send(m, q) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method: m, params: q }));
        return new Promise((a, b) => { pending.set(i, { a, b }); setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 60000); });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id); m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!hm) throw new Error("dist 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(hm[1]))) {
    throw new Error(`exe 内联 dist 不一致（找不到 ${hm[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[phase] exe 内联 dist 校验通过：${hm[1]}`);
  log(`[phase] 按键间隔 = ${INTERVAL_MS}ms（帧长 16.67ms → ${(INTERVAL_MS / (1000 / 60)).toFixed(2)} 帧）`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-phase-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const DOC_BYTES = Number(process.env.DOC_KB || 300) * 1024;
  const DOC = makeDoc(DOC_BYTES);
  const docFile = path.join(tmp, "phase.md");
  fs.writeFileSync(docFile, DOC, "utf8");
  log(`[phase] 文档：${(Buffer.byteLength(DOC, "utf8") / 1024 / 1024).toFixed(2)}MB / ${DOC.split("\n").length} 行`);

  let child = null, cdp = null;
  try {
    child = spawn(EXE, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
      stdio: "ignore",
    });
    for (let i = 0; i < 140 && !cdp; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true });
          if (r.result?.result?.value) { cdp = c; break; }
          c.close();
        }
      } catch { }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 CDP target");

    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
      return r.result?.result?.value;
    };

    // 装文档
    let loaded = false;
    for (let i = 0; i < 30 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(700);
      loaded = await ev(`const c = document.querySelector(".cm-content"); return !!c && (c.textContent || "").length > 100;`);
    }
    if (!loaded) throw new Error("文档未装入");

    // 编辑模式 + 关分屏（避免 iframe 干扰）
    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(2000);
    if (await ev(`return !!document.querySelector("iframe.split-preview");`)) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
      await sleep(1200);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    log(`[phase] impl = ${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    // 焦点
    const box = await ev(`
      const c = document.querySelector(".cm-content");
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(400);

    // 装采样器（与 perf-bench 同口径：keydown timeStamp → 第一个 rAF）
    await ev(`
      window.__ph = { active: false, samples: [] };
      if (!window.__phHooked) {
        window.__phHooked = true;
        window.addEventListener("keydown", function (ev) {
          if (!window.__ph.active) return;
          var t0 = ev.timeStamp;
          requestAnimationFrame(function () {
            window.__ph.samples.push(+(performance.now() - t0).toFixed(2));
          });
        }, true);
      }
      window.__ph.samples = [];
      window.__ph.active = true;
      return true;
    `);

    const chars = "abcdefghijklmnopqrstuvwxyz";
    const t0 = Date.now();
    let sent = 0;
    while (Date.now() - t0 < TYPE_SECONDS * 1000) {
      const ch = chars[sent % chars.length];
      const vk = ch.toUpperCase().charCodeAt(0);
      const code = "Key" + ch.toUpperCase();
      /**
       * ⚠️ 必须用 `keyDown`（带 `text`）+ `keyUp`，**不能**只发 `char`。
       *
       * 实测：只发 `char` 时 `keydown` 监听器**一次都不触发** → 采样为 0。
       * 这与 `perf-bench.mjs` 的做法一致（它也是 keyDown+keyUp 两段）。
       * 反过来说，若同时发 `keyDown(text)` **和** `char`，字符会**插入两次**
       * （此前在搜索探针上踩过 → 得到 `SAARRCCH...`）。
       */
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        code,
        key: ch,
        text: ch,
        unmodifiedText: ch,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        code,
        key: ch,
      });
      sent++;
      const elapsed = Date.now() - t0;
      const nextAt = sent * INTERVAL_MS;
      const wait = nextAt - elapsed;
      if (wait > 0) await sleep(wait);
    }
    await ev(`window.__ph.active = false; return true;`);
    await sleep(500);

    const samples = await ev(`return window.__ph.samples;`);
    const q = (arr, p) => {
      const s = arr.slice().sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length * p)] : null;
    };
    const n = samples.length;
    const p50 = q(samples, 0.5), p95 = q(samples, 0.95), p99 = q(samples, 0.99);
    const over16 = samples.filter((v) => v > 16.67).length;
    const FRAME = 1000 / 60;

    const result = {
      intervalMs: INTERVAL_MS,
      framesPerKey: +(INTERVAL_MS / FRAME).toFixed(2),
      typeSeconds: TYPE_SECONDS,
      keysSent: sent,
      n,
      p50, p95, p99,
      max: samples.length ? Math.max(...samples) : null,
      overFrameRatio: n ? +((over16 / n) * 100).toFixed(1) : null,
      phaseModel: {
        frameMs: +FRAME.toFixed(2),
        theoreticalP95FloorMs: +(0.95 * FRAME).toFixed(2),
        T_from_p50Ms: +(p50 - FRAME / 2).toFixed(2),
        T_from_p95Ms: +(p95 - 0.95 * FRAME).toFixed(2),
      },
    };
    log("");
    log("=== 结果 ===");
    log(`按键 ${sent} 次 / 采样 ${n} 个`);
    log(`p50=${p50}ms  p95=${p95}ms  p99=${p99}ms  max=${result.max}ms`);
    log(`跳帧率（>16.67ms）= ${result.overFrameRatio}%`);
    log(`相位模型反推 T(p50)=${result.phaseModel.T_from_p50Ms}ms  T(p95)=${result.phaseModel.T_from_p95Ms}ms`);
    log(`门禁判定：p95 ${p95}ms ${p95 < 16 ? "< 16ms → PASS" : ">= 16ms → FAIL（字面）"}`);

    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 1), "utf8");
    log(`[phase] 产物：${OUT_JSON}`);
  } finally {
    try { cdp?.close(); } catch { }
    try { child?.kill(); } catch { }
    await sleep(400);
    try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { }
  }
}

main();

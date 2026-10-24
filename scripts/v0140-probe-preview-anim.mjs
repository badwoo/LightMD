/**
 * LightMD v0.14.0 需求3 实机时序探针 —— 编辑模式「关闭/打开预览」滑出/滑回动画。
 *
 * 用户原话：「关闭预览 / 打开预览的动画太快，要放慢 50%；而且还不够顺滑。」
 *
 * 本探针**先取证再改**：在真机（打包产物 + WebView2 CDP）里对同一次点击做
 * rAF 逐帧采样，量化「抖动来源」，然后逐个注入候选 CSS 变体做 A/B，用数据挑方案。
 *
 * 每个变体都跑两趟：关闭（open→closed）+ 打开（closed→open），每趟采 ~1.4s。
 *
 * 逐帧采集（主文档 + iframe 内部文档）：
 *   shellW       `.split-preview-shell` 的 rect 宽度（被过渡的属性）
 *   leftW        `.editor-main-area > .source-editor-wrapper` 的 rect 宽度（另一栏）
 *   divX         `.split-divider` 的左边缘 x（分割条是否与两栏同步移动）
 *   ifrClientW   iframe 的 **布局** clientWidth（= 内部文档的布局视口宽）
 *   ifrDocW      内部 documentElement.clientWidth
 *   ifrScrollH   内部 documentElement.scrollHeight（高度会随宽度变化而重排 → 文字换行）
 *   markerTop    内部第 12 个块元素的 getBoundingClientRect().top（每帧变 = 文字在重排）
 *   markerLeft   同上元素的 left（横向抖动）
 *   taW          textarea 的 clientWidth（左栏文字是否每帧重排）
 *   dt           与上一帧的间隔（>33ms = 掉到 30fps 以下，>50ms = 明显卡顿）
 *
 * 另外用 PerformanceObserver 记 longtask，用 CDP Performance.getMetrics 记
 * LayoutCount / LayoutDuration / RecalcStyleCount / RecalcStyleDuration，
 * 用来区分「主线程被布局吃满」还是「只是合成器在跑」。
 *
 * 变体（CSS 注入，模拟"改 editor.css 之后"的等价效果；同一二进制，隔离变量）：
 *   A-baseline       现状 0.28s
 *   B-dur420         仅时长 +50%（0.42s，同曲线）
 *   C-contain        0.42s + contain: layout paint（裁剪/布局隔离）
 *   D-gpu            0.42s + contain + translateZ(0)/backface-visibility（独立合成层）
 *   E-ease           0.42s + contain + 更平缓的曲线
 *   F-fixediframe    0.42s + contain + 过渡期 iframe 保持**终态宽度**（外壳裁剪逐步显露）
 *   G-min            0.42s + contain + 去掉 will-change: width（will-change 对布局属性无益）
 *
 * 用法：node scripts/v0140-probe-preview-anim.mjs
 *       node scripts/v0140-probe-preview-anim.mjs  # 全变体 + 硬约束回归 + 验收判定
 *       V0140P_ONLY=FINAL-file 只跑"文件里真实规则"那一档（改完 CSS 后的验收）
 *
 * ⚠️ 关于「打包产物不随 dist 变」：`src-tauri/target/release/lightmd.exe` 在编译时
 *    把前端 dist **内联进二进制**，所以 `vite build` 之后直接跑这个 exe 仍然是**旧 CSS**
 *    （实测：V0-baseline 档 0.28s 依旧）。因此本探针的验证方式是**把
 *    `src/styles/editor.css` 里改动过的规则原样抽出来注入页面**（FINAL-file 档），
 *    等价于"改完 CSS 后重新打包"的效果，且能隔离变量做 A/B。
 *    若要真正端到端验证，需 Lead 统一重跑 `cargo build --release` 再跑 V0-baseline 档。
 *
 * 环境变量：V0140P_PORT（默认 9286）、V0140P_ONLY（逗号分隔变体 id）、V0140P_DEBUG=1
 * 输出：_verify-out/v0140-probe-preview-anim.txt
 * 互斥：与其它成员共用 _verify-out/probe.lock（都会 taskkill /IM lightmd.exe）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140P_PORT || 9286);
const CDP = `http://127.0.0.1:${PORT}`;
const VERIFY_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT = path.join(VERIFY_DIR, "v0140-probe-preview-anim.txt");
const LOCK = path.join(VERIFY_DIR, "probe.lock");
const SETTLE_MS = 1500; // 每趟采样窗口
const BETWEEN_MS = 900; // 两趟之间等动画彻底停下

const lines = [];
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 互斥锁（与其它实机探针共用，避免互相 taskkill）───────────
async function acquireLock(maxWaitMs = 8 * 60 * 1000) {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fh = await fs.promises.open(LOCK, "wx");
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), script: "v0140-probe-preview-anim" }),
        "utf-8",
      );
      await fh.close();
      log(`已抢到探针互斥锁：${LOCK}`);
      return true;
    } catch {
      let stale = false;
      try {
        const st = fs.statSync(LOCK);
        stale = Date.now() - st.mtimeMs > 10 * 60 * 1000;
      } catch {}
      if (stale) {
        log("探针锁已陈旧（>10 分钟），删除后重试");
        try { fs.unlinkSync(LOCK); } catch {}
        continue;
      }
      if (Date.now() - started > maxWaitMs) {
        log(`等待探针锁超时（${maxWaitMs / 1000}s），放弃`);
        return false;
      }
      log("探针锁被占用（别的成员在跑实机探针），5s 后重试…");
      await sleep(5000);
    }
  }
}
function releaseLock() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK, "utf-8"));
    if (info && info.pid !== undefined && info.pid !== process.pid) return;
  } catch {
    return;
  }
  try { fs.unlinkSync(LOCK); } catch {}
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"]) {
  process.on(sig, (e) => {
    if (e) log(`捕获 ${sig}：${e && e.stack ? e.stack : e}`);
    releaseLock();
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    process.exit(sig === "uncaughtException" || sig === "unhandledRejection" ? 2 : 130);
  });
}
process.on("exit", () => releaseLock());

// ─── CDP ──────────────────────────────────────────────────
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
        ws,
        send(method, params, timeoutMs = 30000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
            pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
          });
        },
        close() { try { ws.close(); } catch {} },
      });
  });
}

async function attach() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        let c = null;
        try {
          c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send(
            "Runtime.evaluate",
            { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true },
            15000,
          );
          if (r.result?.result?.value === true) {
            await c.send("Page.enable");
            try { await c.send("Performance.enable"); } catch {}
            return c;
          }
          c.close();
        } catch {
          try { c?.close(); } catch {}
        }
      }
    } catch {}
    await sleep(400);
  }
  throw new Error("连不上 CDP / 找不到 Tauri 页面");
}

// ─── 页面内采样器 ──────────────────────────────────────────
const installSampler = (durationMs) => `
  const S = window.__P = { startT: performance.now(), duration: ${durationMs}, samples: [], longtasks: [], clickT: null, last: 0 };
  try {
    S.po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) S.longtasks.push({ start: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1) });
    });
    S.po.observe({ entryTypes: ["longtask"] });
  } catch (e) { S.longtaskError = String(e); }

  const q = (sel) => document.querySelector(sel);
  const shell = q(".split-preview-shell");
  const left = q(".editor-main-area > .source-editor-wrapper");
  const div = q(".split-divider");
  const ifr = q(".split-preview-shell > iframe.split-preview");
  const ta = q("textarea.source-editor");
  if (!shell || !left || !div || !ifr) return { installed: false, reason: "缺元素", shell: !!shell, left: !!left, div: !!div, ifr: !!ifr };

  const idoc = () => { try { return ifr.contentDocument; } catch { return null; } };
  const de0 = idoc() ? idoc().documentElement : null;
  // 内部「重排探针」：取正文里第 12 个段落/标题（不足则取最后一个）。它的 top/left
  // 每帧变化说明 iframe 内部文档正在重排（文字重新换行），这是"文字抖动"的直接证据。
  // ⚠️ 不能取 body 的直接子元素：预览 body 里通常只有一个包裹容器（实测 body.children=2）。
  const marker = () => {
    const d = idoc();
    if (!d || !d.body) return null;
    const kids = [...d.body.querySelectorAll("p, h1, h2, h3, h4, li, pre, table")].filter(
      (el) => el.getBoundingClientRect().height > 0,
    );
    if (!kids.length) return null;
    return kids[Math.min(11, kids.length - 1)];
  };

  const snap = () => {
    const now = performance.now();
    const shR = shell.getBoundingClientRect();
    const lfR = left.getBoundingClientRect();
    const dvR = div.getBoundingClientRect();
    const d = idoc();
    const de = d ? d.documentElement : null;
    const m = marker();
    const mR = m ? m.getBoundingClientRect() : null;
    S.samples.push({
      t: +now.toFixed(2),
      dt: S.last ? +(now - S.last).toFixed(2) : 0,
      shellW: +shR.width.toFixed(2),
      leftW: +lfR.width.toFixed(2),
      divX: +dvR.left.toFixed(2),
      divW: +dvR.width.toFixed(2),
      ifrW: ifr.clientWidth,
      ifrDocW: de ? de.clientWidth : null,
      ifrScrollH: de ? de.scrollHeight : null,
      ifrScrollTop: de ? +de.scrollTop.toFixed(2) : null,
      ifrClientH: de ? de.clientHeight : null,
      markerTop: mR ? +mR.top.toFixed(2) : null,
      markerLeft: mR ? +mR.left.toFixed(2) : null,
      taW: ta ? ta.clientWidth : null,
      leftInline: left.style.width || "",
      leftFlex: left.style.flex || "",
      shellInline: shell.style.width || "",
      taScrollTop: ta ? +ta.scrollTop.toFixed(2) : null,
    });
    S.last = now;
    if (now - S.startT < S.duration) S.raf = requestAnimationFrame(snap);
  };
  S.raf = requestAnimationFrame(snap);
  return {
    installed: true,
    pre: {
      shellW: +shell.getBoundingClientRect().width.toFixed(2),
      leftW: +left.getBoundingClientRect().width.toFixed(2),
      taW: ta ? ta.clientWidth : null,
      ifrW: ifr.clientWidth,
      ifrScrollH: de0 ? de0.scrollHeight : null,
      leftInline: left.style.width || "",
      leftFlex: left.style.flex || "",
      leftComputedW: getComputedStyle(left).width,
      leftFlexBasis: getComputedStyle(left).flexBasis,
      leftFlexGrow: getComputedStyle(left).flexGrow,
      shellInline: shell.style.width || "",
      shellComputedW: getComputedStyle(shell).width,
      transitionShell: getComputedStyle(shell).transition,
      transitionLeft: getComputedStyle(left).transition,
    },
    markerTag: marker() ? marker().tagName + "." + (marker().className || "") : null,
    iframeBlocks: de0 ? de0.querySelectorAll("body > *").length : null,
  };
`;

const collectSampler = `
  const S = window.__P;
  if (!S) return { error: "采样器未安装" };
  if (S.raf) cancelAnimationFrame(S.raf);
  try { S.po && S.po.disconnect(); } catch {}
  return { clickT: S.clickT, startT: S.startT, samples: S.samples, longtasks: S.longtasks, longtaskError: S.longtaskError };
`;

// ─── 变体 ─────────────────────────────────────────────────
// 曲线候选（首帧速度 = 贝塞尔起点切线斜率，峰值速度决定「一顿一顿」的 jerk）：
//   cubic-bezier(0.22,0.61,0.36,1) 起点斜率 0.61/0.22 ≈ 2.77 → 起步瞬间弹出去；
//     实测 25% 时间走完 57% 位移，首帧位移 168px（0.28s）/111px（0.42s）。
//   对称 S 曲线（首尾斜率都 0）峰值速度最低：
//     smoothstep  cubic-bezier(0.33,0,0.67,1) 峰值斜率 ≈1.5（理论最优）
//     smoother    cubic-bezier(0.4,0,0.6,1)   峰值斜率 ≈1.7
//   Material standard cubic-bezier(0.4,0,0.2,1) 起点慢但中段很陡，峰值斜率 ≈2.6
const CURVE_OLD = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const CURVE_STEP = "cubic-bezier(0.33, 0, 0.67, 1)";
const CURVE_SMOOTH = "cubic-bezier(0.4, 0, 0.6, 1)";
const CURVE_MAT = "cubic-bezier(0.4, 0, 0.2, 1)";

const SEL_SHELL = ".split-preview-shell";
const SEL_LEFT = ".editor-main-area > .source-editor-wrapper";
const SEL_DIV = ".split-divider";

/**
 * 模拟「左栏改为始终 flex 派生宽度」的组件补丁。
 *
 * 现状（EditorContainer.tsx ~7246）：previewShown 时内联 `flex:none; width:calc(ratio*100% - 3px)`，
 * 关闭时内联 `flex:1`（width 无内联值 = auto）。
 *   · 关闭：width 从 calc() 变成 auto → flex 派生 → 随外壳逐帧跟随（实测同步、平滑）
 *   · 打开：width 从 auto 变成 calc() → **auto 与 calc() 不可插值 → 瞬间 snap**
 *     （实测打开时左栏/分割条第一帧就跳到终态，只有右屏在动 = "一栏先动"）
 * `flex:1` 派生宽度 = 容器 - 外壳 - 分割条，与 calc(ratio*100% - 3px) 数学完全等价
 * （ratio 就是外壳占比），所以两个方向都改成 flex 派生即可，几何不变。
 */
const PATCH_LEFT_FLEX = `width: auto !important; flex: 1 1 0% !important;`;

/** 拼一段注入 CSS */
function css({ dur, curve, shell = "", left = "", div = "", iframe = "" }) {
  return `
${SEL_SHELL} { transition: width ${dur} ${curve} !important; ${shell} }
${SEL_LEFT} { ${left} }
${div ? `${SEL_DIV} { ${div} }` : ""}
${iframe ? `.split-preview-shell > iframe.split-preview { ${iframe} }` : ""}
`;
}

/** 分割条 6↔18px 也要过渡，否则开/关瞬间跳 12px（min-width 必须一起过渡，否则被它钳住） */
const divTrans = (dur, curve) =>
  `transition: background var(--transition-fast), width ${dur} ${curve}, min-width ${dur} ${curve} !important;`;

const VARIANTS = [
  { id: "V0-baseline", label: "现状 0.28s / 老曲线（对照）", css: "" },
  {
    id: "V1-dur420",
    label: "仅时长 +50%：0.42s + 老曲线",
    css: css({ dur: "0.42s", curve: CURVE_OLD }),
  },
  {
    id: "V2-step",
    label: "0.42s + 对称 smoothstep 曲线(0.33,0,0.67,1) + 左栏 flex 补丁 + 分割条过渡",
    css:
      css({ dur: "0.42s", curve: CURVE_STEP, left: PATCH_LEFT_FLEX, div: divTrans("0.42s", CURVE_STEP) }),
  },
  {
    id: "V3-smooth",
    label: "同上但曲线 cubic-bezier(0.4,0,0.6,1)（峰值略高）",
    css:
      css({ dur: "0.42s", curve: CURVE_SMOOTH, left: PATCH_LEFT_FLEX, div: divTrans("0.42s", CURVE_SMOOTH) }),
  },
  {
    id: "V4-mat",
    label: "同上但 Material 曲线(0.4,0,0.2,1)（起点慢、中段陡）",
    css: css({ dur: "0.42s", curve: CURVE_MAT, left: PATCH_LEFT_FLEX, div: divTrans("0.42s", CURVE_MAT) }),
  },
  {
    id: "V5-step-contain",
    label: "V2 + contain: layout paint（验证是否真有收益）",
    css: css({
      dur: "0.42s",
      curve: CURVE_STEP,
      shell: "contain: layout paint;",
      left: PATCH_LEFT_FLEX,
      div: divTrans("0.42s", CURVE_STEP),
    }),
  },
  {
    id: "V6-step-nowc",
    label: "V2 + 去掉 will-change: width（布局属性上无收益）",
    css: css({
      dur: "0.42s",
      curve: CURVE_STEP,
      shell: "will-change: auto;",
      left: PATCH_LEFT_FLEX,
      div: divTrans("0.42s", CURVE_STEP),
    }),
  },
  {
    id: "FINAL-file",
    label: "★ 直接从 src/styles/editor.css 抽出真实规则注入（验收：这就是要发出去的东西）",
    css: null, // 运行时从文件抽取，见 finalCssFromFile()
  },
];

/**
 * 从 src/styles/editor.css 里抽出**本次需求3 真正改动的四条规则**，
 * 去掉注释后原样注入页面。这样验收的是「文件里实际写的内容」，
 * 而不是探针里手写的等价物（避免"探针绿了、真文件写错"）。
 */
function finalCssFromFile() {
  const cssPath = path.join("D:\\AI\\markdown view\\lightmd", "src", "styles", "editor.css");
  const src = fs.readFileSync(cssPath, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const pick = (re) => {
    const m = src.match(re);
    if (!m) throw new Error("抽不到规则：" + re);
    return m[0];
  };
  // ⚠️ 分割条**只能抽 transition 那几条声明**，不能整条规则注入：
  //    .split-divider 主规则里有 `width:6px; min-width:6px`，若连它一起注入到
  //    页面末尾，就会盖掉 `.split-divider-closed { width:18px }`（同特异性、后者靠
  //    源码顺序取胜），导致关闭态分割条仍是 6px —— 探针会误报"分割条没过渡"。
  const divRule = pick(/^\.split-divider\s*\{[^}]*\}/m);
  const divTransition = divRule.match(/transition:[\s\S]*?;/);
  if (!divTransition) throw new Error("抽不到 .split-divider 的 transition");
  return [
    // ① 外壳过渡（时长 + 曲线）
    pick(/^\.split-preview-shell\s*\{[^}]*\}/m),
    // ② 左栏过渡（同曲线同时长）
    pick(/^\.editor-main-area\s*>\s*\.source-editor-wrapper\s*\{[^}]*\}/m),
    // ③ 左栏 flex 派生（修打开方向 snap）
    pick(/^\.editor-main-area:has\(\.split-preview-shell\.split-preview-open\)\s*>\s*\.source-editor-wrapper\s*\{[^}]*\}/m),
    // ④ 分割条过渡（仅 transition 声明）
    `.split-divider { ${divTransition[0]} }`,
    // ⑤ 拖拽期间禁用过渡（三处都要，否则拖拽时分割条 6↔18px 还会动）
    pick(/^body\.split-resizing \.editor-main-area\s*>\s*\.source-editor-wrapper,[\s\S]*?\{[^}]*\}/m),
    // ⑥ prefers-reduced-motion 降级块（含三处选择器 + transition:none）
    (() => {
      // ⚠️ 不能用带 \n 的字面量定位：本仓库 editor.css 是 **CRLF** 换行，
      //    写死 "\n  .split-preview-shell" 永远匹配不到（踩过）。改用正则。
      const re = /@media \(prefers-reduced-motion: reduce\) \{\s*\.split-preview-shell\s*,/;
      const m = re.exec(src);
      if (!m) throw new Error("抽不到需求3 的 reduced-motion 块");
      const idx = m.index;
      const open = src.indexOf("{", idx);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return src.slice(idx, i + 1);
        }
      }
      throw new Error("reduced-motion 块花括号不配平");
    })(),
  ].join("\n");
}

// ─── 分析 ─────────────────────────────────────────────────
function analyze(raw) {
  const clickT = raw.clickT ?? raw.startT;
  const all = raw.samples || [];
  const after = all.filter((s) => s.t >= clickT);
  const rel = (t) => +(t - clickT).toFixed(1);

  // 过渡区间：shellW 第一次变化 → 最后一次变化
  const wSeq = [];
  for (const s of after) {
    const prev = wSeq[wSeq.length - 1];
    if (!prev || Math.abs(s.shellW - prev.w) >= 0.01) wSeq.push({ t: rel(s.t), w: s.shellW, leftW: s.leftW, divX: s.divX });
  }
  const moving = wSeq;
  const startT = moving.length ? moving[0].t : null;
  const endT = moving.length ? moving[moving.length - 1].t : null;
  const dur = startT !== null && endT !== null ? +(endT - startT).toFixed(1) : null;

  // 单调性：shellW 方向反转次数（回跳 = 抖动）
  let wReversals = 0;
  let prevSign = 0;
  for (let i = 1; i < moving.length; i++) {
    const d = moving[i].w - moving[i - 1].w;
    if (Math.abs(d) < 0.05) continue;
    const sign = Math.sign(d);
    if (prevSign !== 0 && sign !== prevSign) wReversals++;
    prevSign = sign;
  }

  // 左右两栏是否同帧开始 / 同帧结束
  const firstChange = (key) => {
    for (let i = 1; i < after.length; i++) {
      if (Math.abs(after[i][key] - after[i - 1][key]) >= 0.01) return rel(after[i].t);
    }
    return null;
  };
  const lastChange = (key) => {
    let last = null;
    for (let i = 1; i < after.length; i++) {
      if (Math.abs(after[i][key] - after[i - 1][key]) >= 0.01) last = rel(after[i].t);
    }
    return last;
  };
  // 首帧跳变：点击前一刻的宽度 → 点击后第一个采样帧的宽度。
  // 这是「一栏先动 / 瞬间 snap」的判定依据（宽度 auto↔length 不可插值时会一次跳完）。
  const jump = (key, preKey) => {
    if (!after.length || raw.pre == null || raw.pre[preKey] == null) return null;
    const first = after.find((s) => s[key] !== null && s[key] !== undefined);
    if (!first) return null;
    return +(first[key] - raw.pre[preKey]).toFixed(2);
  };
  const leftJump = jump("leftW", "leftW");
  const taJump = jump("taW", "taW");
  const syncStart = { shell: firstChange("shellW"), left: firstChange("leftW"), divider: firstChange("divX") };
  const syncEnd = { shell: lastChange("shellW"), left: lastChange("leftW"), divider: lastChange("divX") };

  // iframe 内部重排证据：ifrScrollH / markerTop / markerLeft 每帧是否在变
  const innerSeq = (key) => {
    const seq = [];
    for (const s of after) {
      if (s[key] === null || s[key] === undefined) continue;
      const prev = seq[seq.length - 1];
      if (!prev || Math.abs(s[key] - prev.v) >= 0.01) seq.push({ t: rel(s.t), v: s[key] });
    }
    return seq;
  };
  // 分割条自身宽度（6px 展开态 ↔ 18px 关闭态；无过渡时第一帧就跳 12px）
  const divWidthSeq = innerSeq("divW");
  const innerScrollH = innerSeq("ifrScrollH");
  const innerMarkerTop = innerSeq("markerTop");
  const innerMarkerLeft = innerSeq("markerLeft");
  const innerIfrW = innerSeq("ifrW");
  const taW = innerSeq("taW");

  // 帧间隔
  const frames = after.map((s) => s.dt).filter((d) => d > 0);
  const long33 = frames.filter((d) => d > 33).length;
  const long50 = frames.filter((d) => d > 50).length;
  const maxFrame = frames.length ? Math.max(...frames) : 0;
  const avgFrame = frames.length ? +(frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(2) : 0;
  const longtasks = raw.longtasks || [];

  // 「过渡窗口内」的帧质量（只看动画真正在跑的那段时间）
  const winFrames = after.filter((s) => startT !== null && rel(s.t) >= startT - 20 && rel(s.t) <= (endT ?? startT) + 40);
  const winDt = winFrames.map((s) => s.dt).filter((d) => d > 0);
  const winLong33 = winDt.filter((d) => d > 33).length;
  const winLong50 = winDt.filter((d) => d > 50).length;
  const winMax = winDt.length ? Math.max(...winDt) : 0;

  // ── 顺滑度量化：逐帧位移（速度）序列 ──
  // 「不够顺滑」的两种可测形态：
  //   ① 速度突变（jerk）：单帧位移远大于相邻帧 → 肉眼看到"一顿一顿"；
  //   ② 起止太陡：首帧/末帧位移占比过大 → 起步"弹出"、收尾"撞墙"。
  // 这里输出：最大单帧位移、位移标准差/均值（离散度）、首末帧位移占比、四段进度。
  const deltas = [];
  for (let i = 1; i < moving.length; i++) deltas.push(+(moving[i].w - moving[i - 1].w).toFixed(2));
  const absD = deltas.map(Math.abs);
  const total = Math.abs(moving.length ? moving[moving.length - 1].w - moving[0].w : 0);
  const meanAbs = absD.length ? absD.reduce((a, b) => a + b, 0) / absD.length : 0;
  const sd = absD.length
    ? Math.sqrt(absD.reduce((a, b) => a + (b - meanAbs) ** 2, 0) / absD.length)
    : 0;
  const maxAbs = absD.length ? Math.max(...absD) : 0;
  const jerk = meanAbs > 0 ? +(maxAbs / meanAbs).toFixed(2) : null;
  // 进度四段（过渡时长归一）：0-25% / 25-50% / 50-75% / 75-100% 各走了总位移的百分之多少
  const progressQuartiles = (() => {
    if (dur === null || !moving.length) return null;
    const w0 = moving[0].w;
    const w1 = moving[moving.length - 1].w;
    const span = w1 - w0;
    if (!span) return null;
    const at = (p) => {
      const tTarget = startT + (endT - startT) * p;
      let best = moving[0];
      for (const e of moving) if (e.t <= tTarget + 0.01) best = e;
      return +(((best.w - w0) / span) * 100).toFixed(1);
    };
    return { p25: at(0.25), p50: at(0.5), p75: at(0.75) };
  })();

  return {
    clickT: rel(clickT),
    durationMs: dur,
    startT,
    endT,
    pre: raw.pre ?? null,
    leftJump,
    taJump,
    frames: { n: frames.length, avgFrame, long33, long50, maxFrame: +maxFrame.toFixed(1), longtaskSum: +longtasks.reduce((s, e) => s + e.dur, 0).toFixed(1), longtaskN: longtasks.length },
    windowFrames: { n: winDt.length, long33: winLong33, long50: winLong50, maxFrame: +winMax.toFixed(1) },
    smoothness: {
      totalWidthPx: +total.toFixed(1),
      framesMoved: deltas.length,
      meanAbsPxPerFrame: +meanAbs.toFixed(2),
      sdPxPerFrame: +sd.toFixed(2),
      maxAbsPxPerFrame: +maxAbs.toFixed(2),
      jerkRatio: jerk,
      firstDeltaPx: deltas.length ? deltas[0] : null,
      lastDeltaPx: deltas.length ? deltas[deltas.length - 1] : null,
      quartiles: progressQuartiles,
      deltaSequence: deltas.join(","),
    },
    width: {
      reversals: wReversals,
      samples: moving.length,
      from: moving.length ? moving[0].w : null,
      to: moving.length ? moving[moving.length - 1].w : null,
      sequence: moving.map((e) => `${e.t}ms:${e.w}`).join(" → "),
    },
    sync: { start: syncStart, end: syncEnd },
    innerReflow: {
      dividerWidthChanges: divWidthSeq.length,
      dividerWidthSequence: divWidthSeq.map((e) => `${e.t}ms:${e.v}`).join(" → "),
      ifrWidthChanges: innerIfrW.length,
      ifrWidthSequence: innerIfrW.map((e) => `${e.t}ms:${e.v}`).join(" → "),
      scrollHeightChanges: innerScrollH.length,
      scrollHeightFromTo: innerScrollH.length ? [innerScrollH[0].v, innerScrollH[innerScrollH.length - 1].v] : null,
      scrollHeightSequence: innerScrollH.map((e) => `${e.t}ms:${e.v}`).join(" → "),
      markerTopChanges: innerMarkerTop.length,
      markerTopSequence: innerMarkerTop.map((e) => `${e.t}ms:${e.v}`).join(" → "),
      markerLeftChanges: innerMarkerLeft.length,
      markerLeftSequence: innerMarkerLeft.map((e) => `${e.t}ms:${e.v}`).join(" → "),
      taWidthChanges: taW.length,
    },
  };
}

// ─── 主流程 ────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(EXE)) {
    console.error("缺少打包产物：" + EXE);
    process.exit(3);
  }
  const got = await acquireLock();
  if (!got) process.exit(4);

  // 临时工作区 + 长文档（足够多的块，才能看出 iframe 内部逐帧重排）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140p-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docPath = path.join(tmp, "长文档.md");
  const parts = ["# 预览开关动画探针", ""];
  for (let i = 1; i <= 120; i++) {
    parts.push(`## 小节 ${i}`, "", `第 ${i} 段正文，用来把右侧预览撑到足够长，让 iframe 内部的重排在逐帧采样里可见。中文与 English mixed text 混排，宽度变化会触发换行重算。`, "");
  }
  fs.writeFileSync(docPath, parts.join("\n"), "utf-8");

  let cdp = null;
  let child = null;
  try {
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    await sleep(1200);
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
      stdio: "ignore",
    });
    cdp = await attach();

    const ev = async (body) => {
      const r = await cdp.send(
        "Runtime.evaluate",
        { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true },
        40000,
      );
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
      return r.result?.result?.value;
    };
    const metrics = async () => {
      try {
        const r = await cdp.send("Performance.getMetrics");
        const o = {};
        for (const m of r.result?.metrics || []) o[m.name] = m.value;
        return {
          LayoutCount: o.LayoutCount,
          LayoutDuration: +(o.LayoutDuration || 0).toFixed(4),
          RecalcStyleCount: o.RecalcStyleCount,
          RecalcStyleDuration: +(o.RecalcStyleDuration || 0).toFixed(4),
          ScriptDuration: +(o.ScriptDuration || 0).toFixed(4),
          TaskDuration: +(o.TaskDuration || 0).toFixed(4),
        };
      } catch {
        return null;
      }
    };

    log(`时间：${new Date().toISOString()}`);
    log(`打包产物：${EXE}`);
    log(`产物 mtime：${fs.statSync(EXE).mtime.toISOString()}`);
    log(`临时文档：${docPath}`);

    // 打开文档 → 进编辑模式（默认带预览）
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(docPath)}}})); return 1;`);
    await sleep(1800);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}})); return 1;`);
    await sleep(1600);

    const setup = await ev(`
      const shell = document.querySelector(".split-preview-shell");
      const ifr = document.querySelector(".split-preview-shell > iframe.split-preview");
      const de = ifr && ifr.contentDocument ? ifr.contentDocument.documentElement : null;
      return {
        shellW: shell ? +shell.getBoundingClientRect().width.toFixed(1) : null,
        ifrW: ifr ? ifr.clientWidth : null,
        ifrBlocks: de ? de.querySelectorAll("body > *").length : null,
        ifrScrollH: de ? de.scrollHeight : null,
        openClass: shell ? shell.className : null,
        btn: document.querySelector('[data-testid="split-preview-toggle"]')?.textContent?.trim() ?? null,
      };
    `);
    log(`初始布局：${JSON.stringify(setup)}`);
    if (!setup || setup.shellW === null) throw new Error("预览外壳不存在，无法继续");

    const only = process.env.V0140P_ONLY ? process.env.V0140P_ONLY.split(",").map((s) => s.trim()) : null;
    const variants = (only ? VARIANTS.filter((v) => only.includes(v.id)) : VARIANTS).map((v) =>
      v.css === null ? { ...v, css: finalCssFromFile() } : v,
    );
    const finalVariant = variants.find((v) => v.id === "FINAL-file");
    if (finalVariant) {
      log("");
      log("─── FINAL-file 注入内容（从 editor.css 原样抽出，去注释）───");
      for (const line of finalVariant.css.split("\n")) if (line.trim()) log("  " + line);
    }

    // ─── 前置校验：左栏改 flex 派生后，稳态几何必须与现状**逐像素一致** ───
    // （组件补丁的安全性前提。不等价就不能提补丁，否则拖拽分割条/多比例下布局会漂。）
    log("");
    log("─── 几何等价性校验（左栏 flex 派生 vs 现状内联 calc）───");
    // 直接改写外壳内联宽度来模拟不同分割比例（等价于拖拽分割条后 React 写入的值），
    // 比较「现状内联 width:calc」与「flex:1 派生」两种左栏宽度来源的最终像素。
    // ⚠️ splitRatio = **左栏**占比：left = ratio*100% - 3px，shell = (1-ratio)*100% - 3px。
    const geoCheck = [];
    for (const ratio of [0.3, 0.42, 0.5, 0.58, 0.7]) {
      await ev(`
        const st = document.getElementById("probe-geo-style") || (() => {
          const s = document.createElement("style"); s.id = "probe-geo-style"; document.head.appendChild(s); return s;
        })();
        st.textContent = "";
        const shell = document.querySelector(".split-preview-shell");
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        shell.style.transition = "none";
        left.style.transition = "none";
        shell.style.width = "calc(" + (${(1 - ratio).toFixed(6)} * 100) + "% - 3px)";
        left.style.width = "calc(" + (${ratio.toFixed(6)} * 100) + "% - 3px)";
        return true;
      `);
      await sleep(180);
      const before = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        const div = document.querySelector(".split-divider");
        const ta = document.querySelector("textarea.source-editor");
        return {
          shellW: +shell.getBoundingClientRect().width.toFixed(3),
          leftW: +left.getBoundingClientRect().width.toFixed(3),
          divW: +div.getBoundingClientRect().width.toFixed(3),
          taW: ta.clientWidth,
        };
      `);
      await ev(`
        document.getElementById("probe-geo-style").textContent =
          ".editor-main-area > .source-editor-wrapper { width: auto !important; flex: 1 1 0% !important; }";
        return true;
      `);
      await sleep(180);
      const after = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        const div = document.querySelector(".split-divider");
        const ta = document.querySelector("textarea.source-editor");
        return {
          shellW: +shell.getBoundingClientRect().width.toFixed(3),
          leftW: +left.getBoundingClientRect().width.toFixed(3),
          divW: +div.getBoundingClientRect().width.toFixed(3),
          taW: ta.clientWidth,
        };
      `);
      const diff = {
        shellW: +(after.shellW - before.shellW).toFixed(3),
        leftW: +(after.leftW - before.leftW).toFixed(3),
        taW: after.taW - before.taW,
      };
      geoCheck.push({ ratio, before, after, diff });
      log(`  比例 ${ratio}：现状 left=${before.leftW} ta=${before.taW} → flex 派生 left=${after.leftW} ta=${after.taW}  差 ${JSON.stringify(diff)}`);
    }
    // 清掉临时内联样式，并把状态交回 React（toggle 两次强制重渲染，重写内联 width）
    await ev(`
      document.getElementById("probe-geo-style").textContent = "";
      const shell = document.querySelector(".split-preview-shell");
      const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
      shell.style.transition = ""; shell.style.width = "";
      left.style.transition = ""; left.style.width = "";
      return true;
    `);
    const isOpenNow = await ev(`
      const shell = document.querySelector(".split-preview-shell");
      return shell.className.includes("split-preview-open");
    `);
    if (isOpenNow) {
      await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`);
      await sleep(800);
    }
    await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`);
    await sleep(1000);
    const restored = await ev(`
      const shell = document.querySelector(".split-preview-shell");
      const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
      return { shellW: +shell.getBoundingClientRect().width.toFixed(1), leftW: +left.getBoundingClientRect().width.toFixed(1), open: shell.className.includes("split-preview-open") };
    `);
    log(`  状态已恢复：${JSON.stringify(restored)}`);
    await sleep(600);
    const geoOk = geoCheck.every((g) => Math.abs(g.diff.leftW) < 0.6 && Math.abs(g.diff.taW) <= 1);
    log(`  几何等价结论：${geoOk ? "PASS（差 < 0.6px，calc 取整误差内）" : "FAIL（不等价，不能提该补丁）"}`);

    const results = [];

    /** 跑一趟：注入变体 CSS → 装采样器 → 点按钮 → 采集 */
    const runOnce = async (v, direction) => {
      // 1) 变体 CSS
      await ev(`
        let st = document.getElementById("probe-variant-style");
        if (!st) { st = document.createElement("style"); st.id = "probe-variant-style"; document.head.appendChild(st); }
        st.textContent = ${JSON.stringify(v.css || "")};
        return true;
      `);
      // 2) 确保处于正确的起点状态
      const cur = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        return { w: +shell.getBoundingClientRect().width.toFixed(1), open: shell.className.includes("split-preview-open") };
      `);
      const wantOpen = direction === "close";
      if (cur.open !== wantOpen) {
        await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`);
        await sleep(BETWEEN_MS + 600);
      }
      const pre = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        const ifr = document.querySelector(".split-preview-shell > iframe.split-preview");
        return { w: +shell.getBoundingClientRect().width.toFixed(1), ifrW: ifr.clientWidth, open: shell.className.includes("split-preview-open") };
      `);

      // 3) 采样器 + CDP 性能计数
      //    重试一次：偶发 `Runtime.evaluate` 超时（页面刚重排完、CDP 队列拥塞），
      //    重连后重装即可，不是被测行为的问题（已单独用 v0140-probe-has-perf.mjs
      //    排除 `:has()` 拖死主线程的可能：点击仅 6ms、Layout 47.7ms）。
      let inst = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          inst = await ev(installSampler(SETTLE_MS));
          break;
        } catch (e) {
          log(`    [warn] 装采样器超时（第 ${attempt + 1} 次），重连后重试`);
          try { cdp.close(); } catch {}
          try { cdp = await attach(); } catch {}
          await sleep(700);
        }
      }
      if (!inst?.installed) throw new Error("采样器安装失败：" + JSON.stringify(inst));
      const m0 = await metrics();

      // 4) 点击（同一帧内记 clickT，然后让 React 提交）
      const clickT = await ev(`
        window.__P.clickT = performance.now();
        document.querySelector('[data-testid="split-preview-toggle"]').click();
        return window.__P.clickT;
      `);
      await sleep(SETTLE_MS + 400);

      const raw = await ev(collectSampler);
      const m1 = await metrics();
      raw.clickT = clickT;
      raw.pre = inst.pre;
      const a = analyze(raw);
      if (process.env.V0140P_DEBUG) {
        log("    [debug] pre=" + JSON.stringify(inst.pre));
        log("    [debug] 前 6 帧=" + JSON.stringify((raw.samples || []).slice(0, 6)));
      }
      const perf = m0 && m1 ? {
        LayoutCount: +(m1.LayoutCount - m0.LayoutCount).toFixed(0),
        LayoutDurationMs: +((m1.LayoutDuration - m0.LayoutDuration) * 1000).toFixed(1),
        RecalcStyleCount: +(m1.RecalcStyleCount - m0.RecalcStyleCount).toFixed(0),
        RecalcStyleDurationMs: +((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000).toFixed(1),
        ScriptDurationMs: +((m1.ScriptDuration - m0.ScriptDuration) * 1000).toFixed(1),
        TaskDurationMs: +((m1.TaskDuration - m0.TaskDuration) * 1000).toFixed(1),
      } : null;

      const post = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        const ifr = document.querySelector(".split-preview-shell > iframe.split-preview");
        return { w: +shell.getBoundingClientRect().width.toFixed(1), ifrW: ifr.clientWidth, open: shell.className.includes("split-preview-open") };
      `);

      return { direction, pre, post, perf, ...a, markerTag: inst.markerTag, iframeBlocks: inst.iframeBlocks };
    };

    for (const v of variants) {
      log("");
      log(`═══ 变体 ${v.id}：${v.label} ═══`);
      const closeR = await runOnce(v, "close");
      await sleep(BETWEEN_MS);
      const openR = await runOnce(v, "open");
      await sleep(BETWEEN_MS);
      for (const r of [closeR, openR]) {
        const tag = r.direction === "close" ? "关闭" : "打开";
        log(`  ▸ ${tag}：${r.pre.w}px → ${r.post.w}px（open=${r.post.open}）`);
        log(`    起点 transition：shell="${r.pre?.transitionShell}" left="${r.pre?.transitionLeft}"`);
        log(`    起点内联：left.width="${r.pre?.leftInline}" left.flex="${r.pre?.leftFlex}" shell.width="${r.pre?.shellInline}"`);
        log(`    首帧跳变：左栏 ${r.leftJump}px / textarea 宽 ${r.taJump}px（非 0 且远小于总位移 = 该栏无过渡直接 snap）`);
        log(`    过渡时长 ${r.durationMs}ms（${r.startT} → ${r.endT}） / 宽度采样 ${r.width.samples} 点 / 回跳 ${r.width.reversals}`);
        log(`    宽度序列：${r.width.sequence}`);
        log(`    同步：开始 ${JSON.stringify(r.sync.start)} 结束 ${JSON.stringify(r.sync.end)}`);
        const sm = r.smoothness;
        log(`    顺滑度：总位移 ${sm.totalWidthPx}px / ${sm.framesMoved} 帧 → 每帧均值 ${sm.meanAbsPxPerFrame}px 标准差 ${sm.sdPxPerFrame} 最大 ${sm.maxAbsPxPerFrame}px（jerk=${sm.jerkRatio}）首帧 ${sm.firstDeltaPx}px 末帧 ${sm.lastDeltaPx}px`);
        log(`      进度 25%/50%/75% → ${sm.quartiles ? `${sm.quartiles.p25}% / ${sm.quartiles.p50}% / ${sm.quartiles.p75}%` : "-"}（线性=25/50/75；尾重=ease-out）`);
        log(`    帧：全程 n=${r.frames.n} avg=${r.frames.avgFrame}ms 长帧>33ms=${r.frames.long33} >50ms=${r.frames.long50} 最长=${r.frames.maxFrame}ms longtask=${r.frames.longtaskN}个/${r.frames.longtaskSum}ms`);
        log(`    过渡窗口帧：n=${r.windowFrames.n} 长帧>33ms=${r.windowFrames.long33} >50ms=${r.windowFrames.long50} 最长=${r.windowFrames.maxFrame}ms`);
        if (r.perf) log(`    布局开销：LayoutCount=${r.perf.LayoutCount} LayoutDuration=${r.perf.LayoutDurationMs}ms RecalcStyle=${r.perf.RecalcStyleCount}/${r.perf.RecalcStyleDurationMs}ms Task=${r.perf.TaskDurationMs}ms`);
        log(`    iframe 内部：布局宽变化 ${r.innerReflow.ifrWidthChanges} 次 / scrollHeight 变化 ${r.innerReflow.scrollHeightChanges} 次 ${JSON.stringify(r.innerReflow.scrollHeightFromTo)} / 块 top 变化 ${r.innerReflow.markerTopChanges} 次 / 块 left 变化 ${r.innerReflow.markerLeftChanges} 次 / textarea 宽变化 ${r.innerReflow.taWidthChanges} 次`);
        log(`      分割条宽 ${r.innerReflow.dividerWidthChanges} 次变化：${r.innerReflow.dividerWidthSequence}`);
        log(`      ifrW 序列：${r.innerReflow.ifrWidthSequence}`);
        log(`      scrollH 序列：${r.innerReflow.scrollHeightSequence}`);
        log(`      块 top 序列：${r.innerReflow.markerTopSequence}`);
      }
      results.push({ id: v.id, label: v.label, close: closeR, open: openR });
    }

    // ─── 汇总 ───
    log("");
    log("═══════════════ 汇总（关闭 / 打开）═══════════════");
    log("变体 | 时长ms | 窗口内长帧>33 | 最长帧ms | 每帧均值/最大px | jerk | 内部scrollH变化 | 块top变化 | Layout耗时ms");
    for (const r of results) {
      const f = (x) => (x === null ? "-" : x);
      log(
        `${r.id} | ${f(r.close.durationMs)}/${f(r.open.durationMs)} | ` +
        `${r.close.windowFrames.long33}/${r.open.windowFrames.long33} | ` +
        `${r.close.windowFrames.maxFrame}/${r.open.windowFrames.maxFrame} | ` +
        `${r.close.smoothness.meanAbsPxPerFrame}/${r.open.smoothness.meanAbsPxPerFrame} : ` +
        `${r.close.smoothness.maxAbsPxPerFrame}/${r.open.smoothness.maxAbsPxPerFrame} | ` +
        `${r.close.smoothness.jerkRatio}/${r.open.smoothness.jerkRatio} | ` +
        `${r.close.innerReflow.scrollHeightChanges}/${r.open.innerReflow.scrollHeightChanges} | ` +
        `${r.close.innerReflow.markerTopChanges}/${r.open.innerReflow.markerTopChanges} | ` +
        `${r.close.perf?.LayoutDurationMs ?? "-"}/${r.open.perf?.LayoutDurationMs ?? "-"}`,
      );
    }

    // ─── 硬约束回归验证（需求3 明确要求一条都不能破）───────────────
    // 用最终方案（FINAL-file 已注入页面）逐条实测，而不是只靠 CSS 文本断言。
    log("");
    log("═══════════ 硬约束回归实测（① 拖拽无过渡 ② 关闭后 0 宽不占位 ③ 重开内容现成 ④ reduced-motion ⑤ 阅读/无预览布局）═══════════");
    const regress = {};

    // ② 关闭后右屏宽度 0 且不占位
    //    ⚠️ 判据修正：不能拿"左栏宽 == 编辑区宽"比。关闭态分割条本身占 18px
    //    （「打开预览」竖排四字要放得下），所以 左栏 = 编辑区 - 18px 才是正确几何。
    //    真正的"不占位"含义是：右屏外壳宽为 0，且左栏把除分割条外的空间全吃掉。
    {
      const openNow = await ev(`return document.querySelector(".split-preview-shell")?.className.includes("split-preview-open");`);
      if (!openNow) { await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`); await sleep(900); }
      await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`);
      await sleep(1200);
      const r = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        const area = document.querySelector(".editor-main-area");
        const div = document.querySelector(".split-divider");
        const ifr = document.querySelector(".split-preview-shell > iframe.split-preview");
        const cs = getComputedStyle(shell);
        return {
          shellW: +shell.getBoundingClientRect().width.toFixed(2),
          leftW: +left.getBoundingClientRect().width.toFixed(2),
          areaW: +area.getBoundingClientRect().width.toFixed(2),
          divW: +div.getBoundingClientRect().width.toFixed(2),
          ifrW: ifr.clientWidth,
          overflow: cs.overflow,
          ariaHidden: shell.getAttribute("aria-hidden"),
        };
      `);
      const expectedLeft = r.areaW - r.divW;
      regress.closedZeroWidth = {
        ...r,
        expectedLeft: +expectedLeft.toFixed(2),
        // 外壳宽 0 + 左栏吃满「编辑区 - 分割条」+ iframe 被裁到 0 + aria-hidden
        pass:
          Math.abs(r.shellW) < 0.5 &&
          Math.abs(r.leftW - expectedLeft) < 2 &&
          r.ifrW === 0 &&
          r.ariaHidden === "true",
      };
      log(`  ② 关闭后：外壳宽 ${r.shellW}px / iframe 宽 ${r.ifrW}px / 左栏 ${r.leftW}px（应=编辑区 ${r.areaW} - 分割条 ${r.divW} = ${expectedLeft.toFixed(2)}px）/ overflow=${r.overflow} / aria-hidden=${r.ariaHidden} ⇒ ${regress.closedZeroWidth.pass ? "PASS" : "FAIL"}`);
    }

    // ③ 重开时内容现成（iframe 常驻，不等外壳展开就有内容；不先空白）
    {
      const beforeOpen = await ev(`
        const ifr = document.querySelector(".split-preview-shell > iframe.split-preview");
        const d = ifr.contentDocument;
        return {
          exists: !!ifr, blocks: d ? d.body.children.length : 0,
          textLen: d ? (d.body.textContent || "").length : 0,
          ifrW: ifr.clientWidth,
        };
      `);
      await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`);
      await sleep(80); // 极短：动画刚起步
      const early = await ev(`
        const ifr = document.querySelector(".split-preview-shell > iframe.split-preview");
        const d = ifr.contentDocument;
        const shell = document.querySelector(".split-preview-shell");
        return {
          shellW: +shell.getBoundingClientRect().width.toFixed(1),
          blocks: d ? d.body.children.length : 0,
          textLen: d ? (d.body.textContent || "").length : 0,
        };
      `);
      await sleep(1200);
      regress.contentReadyOnReopen = {
        beforeOpen, early,
        pass: beforeOpen.exists && beforeOpen.blocks > 0 && early.blocks === beforeOpen.blocks && early.textLen > 0,
      };
      log(`  ③ 重开：关闭态 iframe 已挂载=${beforeOpen.exists} 内容块=${beforeOpen.blocks} 文本 ${beforeOpen.textLen} 字；动画起步 80ms 时外壳仅 ${early.shellW}px 但内容块=${early.blocks} 文本 ${early.textLen} 字 ⇒ ${regress.contentReadyOnReopen.pass ? "PASS（内容现成，非先空白）" : "FAIL"}`);
    }

    // ① 拖拽分割条期间无过渡（body.split-resizing 生效时 computed transition 为 none）
    {
      const r = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        const div = document.querySelector(".split-divider");
        const snap = () => {
          const g = (el) => getComputedStyle(el);
          return {
            shellProp: g(shell).transitionProperty, shellDur: g(shell).transitionDuration,
            leftProp: g(left).transitionProperty, leftDur: g(left).transitionDuration,
            divProp: g(div).transitionProperty, divDur: g(div).transitionDuration,
          };
        };
        const before = snap();
        document.body.classList.add("split-resizing");
        const during = snap();
        document.body.classList.remove("split-resizing");
        return { before, during };
      `);
      // 分割条的 transition 是**三属性列表**（background + width + min-width），
      // 拖拽期间会被 body.split-resizing 整条覆盖成 none（三属性同时消失）。
      // 所以判据是「transitionProperty 变成 none」而不是「duration 全是 0」。
      const isNone = (prop) => /^none\b/.test(prop.trim());
      regress.resizingNoTransition = {
        ...r,
        pass: isNone(r.during.shellProp) && isNone(r.during.leftProp) && isNone(r.during.divProp),
      };
      log(`  ① 拖拽：平时 shell=${r.before.shellProp}/${r.before.shellDur} left=${r.before.leftProp}/${r.before.leftDur} div=${r.before.divProp}/${r.before.divDur}`);
      log(`           split-resizing 时 shell=${r.during.shellProp}/${r.during.shellDur} left=${r.during.leftProp}/${r.during.leftDur} div=${r.during.divProp}/${r.during.divDur} ⇒ ${regress.resizingNoTransition.pass ? "PASS" : "FAIL"}`);
    }

    // ④ prefers-reduced-motion 仍禁用动画（CDP 模拟媒体特性）
    {
      let r = null;
      try {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
        await sleep(400);
        r = await ev(`
          const shell = document.querySelector(".split-preview-shell");
          const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
          const div = document.querySelector(".split-divider");
          const g = (el) => ({
            prop: getComputedStyle(el).transitionProperty,
            dur: getComputedStyle(el).transitionDuration,
          });
          return { shell: g(shell), left: g(left), div: g(div) };
        `);
        await cdp.send("Emulation.setEmulatedMedia", { features: [] });
      } catch (e) {
        log(`    [warn] 模拟 reduced-motion 失败：${e.message}`);
      }
      // 判据同①：reduced-motion 块把整条 transition 置 none（三属性全消失）
      const isNone = (o) => !!o && /^none\b/.test(o.prop.trim());
      regress.reducedMotion = {
        ...r,
        pass: isNone(r?.shell) && isNone(r?.left) && isNone(r?.div),
      };
      log(`  ④ reduced-motion：shell=${r?.shell?.prop}/${r?.shell?.dur} left=${r?.left?.prop}/${r?.left?.dur} div=${r?.div?.prop}/${r?.div?.dur} ⇒ ${regress.reducedMotion.pass ? "PASS（transitionProperty=none）" : "FAIL"}`);
    }

    // ⑤ 阅读模式 / 无预览布局不变（左栏 flex 派生只在 preview-open 时生效）
    {
      // 先在"预览关闭"态量左栏（此时左栏应铺满、flex:1 由组件内联给出）
      const closedNow = await ev(`return !document.querySelector(".split-preview-shell")?.className.includes("split-preview-open");`);
      if (!closedNow) { await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`); await sleep(1200); }
      const closed = await ev(`
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        const cs = getComputedStyle(left);
        return { w: +left.getBoundingClientRect().width.toFixed(2), flexGrow: cs.flexGrow, flexBasis: cs.flexBasis, width: cs.width };
      `);
      // 再切到阅读模式（此时没有 .split-preview-shell，规则不可能命中）
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.preview"}})); return 1;`);
      await sleep(1400);
      const reading = await ev(`
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        const shell = document.querySelector(".split-preview-shell");
        const pm = document.querySelector(".ProseMirror");
        return {
          hasShell: !!shell,
          leftDisplay: left ? getComputedStyle(left).display : null,
          leftW: left ? +left.getBoundingClientRect().width.toFixed(1) : null,
          pmExists: !!pm,
          pmW: pm ? +pm.getBoundingClientRect().width.toFixed(1) : null,
        };
      `);
      // 回编辑模式，保证后续状态干净
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}})); return 1;`);
      await sleep(1500);
      regress.readingUnaffected = {
        closed, reading,
        pass: reading.hasShell === false && reading.pmExists && reading.leftDisplay === "none",
      };
      log(`  ⑤ 无预览态左栏 flex=${closed.flexGrow}/${closed.flexBasis} 宽 ${closed.w}px；阅读模式无外壳=${!reading.hasShell} 左栏 display=${reading.leftDisplay} PM 宽=${reading.pmW}px ⇒ ${regress.readingUnaffected.pass ? "PASS" : "FAIL"}`);
    }

    // ⑥ 真实鼠标拖拽分割条：几何必须正确、且全程无过渡（这是我改了左栏宽度来源后
    //    最需要实测的一条 —— flex 派生若算错，拖拽会把比例带偏）
    {
      const openNow = await ev(`return document.querySelector(".split-preview-shell")?.className.includes("split-preview-open");`);
      if (!openNow) { await ev(`document.querySelector('[data-testid="split-preview-toggle"]').click(); return 1;`); await sleep(1000); }
      // ⚠️ 按下点必须避开竖排小字按钮 `.split-divider-label`：
      //    EditorContainer 明确「凡落在开关按钮上的按下，一律不启动拖拽」
      //    （否则 setPointerCapture 会把 click 抢走、按钮点不动）。
      //    小字垂直居中、高约 73px，所以取分割条**上段**（top+40）作抓取点。
      //    首版探针用中心点抓，第二次按下正好落在已 hover 显形的小字上 → 拖不动，
      //    被误判成"右拖失效"（基线同样如此，与本次改动无关）。
      const grab = () => ev(`
        const d = document.querySelector(".split-divider");
        const r = d.getBoundingClientRect();
        const lb = document.querySelector(".split-divider-label");
        const lr = lb ? lb.getBoundingClientRect() : null;
        return {
          x: r.left + r.width / 2,
          y: r.top + 40,
          labelRect: lr ? { top: +lr.top.toFixed(1), bottom: +lr.bottom.toFixed(1) } : null,
          dividerRect: { top: +r.top.toFixed(1), height: +r.height.toFixed(1) },
          hitIsLabel: (() => {
            const el = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
            return !!(el && el.closest && el.closest(".split-divider-label"));
          })(),
        };
      `);
      const measure = () => ev(`
        const shell = document.querySelector(".split-preview-shell");
        const left = document.querySelector(".editor-main-area > .source-editor-wrapper");
        const area = document.querySelector(".editor-main-area");
        const div = document.querySelector(".split-divider");
        const areaW = area.getBoundingClientRect().width;
        const shW = shell.getBoundingClientRect().width;
        const lfW = left.getBoundingClientRect().width;
        const dvW = div.getBoundingClientRect().width;
        return {
          areaW: +areaW.toFixed(2), shellW: +shW.toFixed(2), leftW: +lfW.toFixed(2), divW: +dvW.toFixed(2),
          // 比例 = 左栏占比；三者之和必须等于编辑区宽（不重叠、不留缝）
          ratio: +((lfW + 3) / areaW).toFixed(4),
          sumW: +(lfW + shW + dvW).toFixed(2),
          resizing: document.body.classList.contains("split-resizing"),
          shellTransition: getComputedStyle(shell).transitionProperty,
          leftTransition: getComputedStyle(left).transitionProperty,
        };
      `);
      const g = await grab();
      const before = await measure();
      // 真实手势：按下分割条 → 分 6 步左移 200px → 松手
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: g.x, y: g.y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(60);
      const during = await measure();
      for (let i = 1; i <= 6; i++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: g.x - (200 * i) / 6, y: g.y, button: "left", buttons: 1 });
        await sleep(45);
      }
      const mid = await measure();
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g.x - 200, y: g.y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(500);
      const after = await measure();
      // 再拖回来 +200px，验证双向都灵（老缺陷"往右拖不回来"）
      const g2 = await grab();
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: g2.x, y: g2.y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(60);
      const during2 = await measure();
      for (let i = 1; i <= 6; i++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: g2.x + (200 * i) / 6, y: g2.y, button: "left", buttons: 1 });
        await sleep(45);
      }
      const mid2 = await measure();
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g2.x + 200, y: g2.y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(500);
      const back = await measure();

      const sumOk = (m) => Math.abs(m.sumW - m.areaW) < 1.5; // 三者铺满、不重叠
      const movedLeft = after.leftW < before.leftW - 150;   // 左拖 → 左栏变窄
      const movedBack = back.leftW > after.leftW + 150;      // 右拖 → 左栏变宽
      const noTransitionWhileDragging = during.resizing &&
        /^none\b/.test(during.shellTransition.trim()) && /^none\b/.test(during.leftTransition.trim());
      regress.dragResize = {
        before, during, mid, after, back,
        pass: sumOk(before) && sumOk(after) && sumOk(back) && movedLeft && movedBack && noTransitionWhileDragging,
      };
      log(`  ⑥ 真实拖拽：抓取点 y=${g.y.toFixed(1)}（分割条 top=${g.dividerRect.top} 高=${g.dividerRect.height}；竖排小字 ${JSON.stringify(g.labelRect)}，命中按钮=${g.hitIsLabel}）`);
      log(`           初始 左${before.leftW} 壳${before.shellW} 条${before.divW} 和${before.sumW}/编辑区${before.areaW}（ratio ${before.ratio}）`);
      log(`           按下后 body.split-resizing=${during.resizing} 过渡=${during.shellTransition}/${during.leftTransition}`);
      log(`           左拖 200px → 左${after.leftW} 壳${after.shellW} 和${after.sumW}（ratio ${after.ratio}）`);
      log(`           右拖回 200px → 左${back.leftW} 壳${back.shellW} 和${back.sumW}（ratio ${back.ratio}）`);
      log(`           第二次按下 resizing=${during2.resizing} 过渡=${during2.shellTransition}/${during2.leftTransition}，拖到中途 左${mid2.leftW} 壳${mid2.shellW}`);
      log(`           左栏确实变窄=${movedLeft} 又变宽=${movedBack} 拖拽期无过渡=${noTransitionWhileDragging} 三者和=编辑区=${sumOk(after) && sumOk(back)} ⇒ ${regress.dragResize.pass ? "PASS" : "FAIL"}`);
    }

    // ─── 验收指标判定（任务书第 4 条）─────────────────────────────
    log("");
    log("═══════════ 验收指标（任务书第 4 条）═══════════");
    const fin = results.find((r) => r.id === "FINAL-file") ?? results[results.length - 1];
    const durOk = [fin.close.durationMs, fin.open.durationMs].every((d) => d !== null && Math.abs(d - 420) <= 30);
    const monoOk = fin.close.width.reversals === 0 && fin.open.width.reversals === 0;
    const syncOk =
      fin.close.sync.start.shell === fin.close.sync.start.left &&
      fin.close.sync.start.left === fin.close.sync.start.divider &&
      fin.close.sync.end.shell === fin.close.sync.end.left &&
      fin.close.sync.end.left === fin.close.sync.end.divider &&
      fin.open.sync.start.shell === fin.open.sync.start.left &&
      fin.open.sync.start.left === fin.open.sync.start.divider &&
      fin.open.sync.end.shell === fin.open.sync.end.left &&
      fin.open.sync.end.left === fin.open.sync.end.divider;
    // 文字横向抖动：块 left 在过渡期间的变化次数。
    // ⚠️ 判据说明：iframe 宽度每帧在变，内部文字必然重新换行 → 块的 left/top 会跟着
    // 变几次，这是**预期的重排**，不是抖动。"横向抖动"指的是**来回反复**（方向反转），
    // 所以真正该判的是「块 left 序列的方向反转次数」，变化次数只作 INFO。
    const leftRev = (seqStr) => {
      // 从 "t:val → t:val → ..." 解析出 val 序列，数方向反转
      const vals = (seqStr || "").split("→").map((s) => Number(s.trim().split(":")[1])).filter((v) => !Number.isNaN(v));
      let rev = 0;
      let prevSign = 0;
      for (let i = 1; i < vals.length; i++) {
        const d = vals[i] - vals[i - 1];
        if (Math.abs(d) < 0.05) continue;
        const sign = Math.sign(d);
        if (prevSign !== 0 && sign !== prevSign) rev++;
        prevSign = sign;
      }
      return rev;
    };
    const closeLeftRev = leftRev(fin.close.innerReflow.markerLeftSequence);
    const openLeftRev = leftRev(fin.open.innerReflow.markerLeftSequence);
    const noHorizJitter = closeLeftRev === 0 && openLeftRev === 0;
    const noLongFrame = fin.close.windowFrames.long33 === 0 && fin.open.windowFrames.long33 === 0;
    const acceptMetrics = {
      "过渡总时长 420ms±30ms": { pass: durOk, detail: `关闭 ${fin.close.durationMs}ms / 打开 ${fin.open.durationMs}ms` },
      "宽度采样单调不回跳": { pass: monoOk, detail: `回跳 关闭 ${fin.close.width.reversals} / 打开 ${fin.open.width.reversals}` },
      "左右两栏同帧开始同帧结束": { pass: syncOk, detail: `开始 ${JSON.stringify(fin.close.sync.start)} 结束 ${JSON.stringify(fin.close.sync.end)}` },
      "iframe 内文字无横向抖动": { pass: noHorizJitter, detail: `块 left 方向反转 关闭 ${closeLeftRev} / 打开 ${openLeftRev} 次（变化次数 ${fin.close.innerReflow.markerLeftChanges}/${fin.open.innerReflow.markerLeftChanges}，属换行重排）` },
      "过渡窗口无掉帧（>33ms）": { pass: noLongFrame, detail: `最长帧 关闭 ${fin.close.windowFrames.maxFrame}ms / 打开 ${fin.open.windowFrames.maxFrame}ms` },
    };
    for (const [k, v] of Object.entries(acceptMetrics)) log(`  ${v.pass ? "✓" : "✗"} ${k} —— ${v.detail}`);
    const allMetrics = Object.values(acceptMetrics).every((v) => v.pass);

    log("");
    log("═══════════ 硬约束回归汇总 ═══════════");
    const labels = {
      closedZeroWidth: "② 关闭后右屏宽 0 不占位",
      contentReadyOnReopen: "③ 重开内容现成不先空白",
      resizingNoTransition: "① 拖拽分割条时无过渡",
      reducedMotion: "④ prefers-reduced-motion 禁用动画",
      readingUnaffected: "⑤ 阅读模式/无预览布局不变",
      dragResize: "⑥ 真实拖拽几何正确且双向可用（改左栏宽度来源后的关键回归）",
    };
    for (const [k, label] of Object.entries(labels)) log(`  ${regress[k]?.pass ? "✓" : "✗"} ${label}`);
    const allRegress = Object.values(regress).every((v) => v?.pass);
    log("");
    log(`总判定：验收指标 ${allMetrics ? "PASS" : "FAIL"} / 硬约束回归 ${allRegress ? "PASS" : "FAIL"} ⇒ ${allMetrics && allRegress ? "PASS" : "FAIL"}`);

    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(OUT, ["LightMD v0.14.0 需求3 预览开关动画时序探针", ...lines, ""].join("\n"), "utf-8");
    log("");
    log(`报告：${OUT}`);
    process.exitCode = allMetrics && allRegress ? 0 : 1;
  } finally {
    try { cdp?.close(); } catch {}
    try { child?.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    releaseLock();
  }
}

main().catch((e) => {
  console.error("探针异常：", e);
  try {
    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(OUT, ["LightMD v0.14.0 需求3 预览开关动画时序探针（异常中断）", ...lines, String(e && e.stack ? e.stack : e), ""].join("\n"), "utf-8");
  } catch {}
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  releaseLock();
  process.exit(2);
});

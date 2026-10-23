/**
 * LightMD v0.14.0 需求3 实机时序探针（打包产物 + WebView2 CDP）
 *
 * 用户原话：「左侧栏打开"收藏"或"最近打开"功能，动画会卡顿，而且左侧栏会抖动，
 * 请定位和修复。」
 *
 * 与 scripts/v0140-probe-recent.mjs 的区别：那个是**静态**测量（点完 2s 后量终态），
 * 看不到抖动。本探针点击**前**注入页面内采样器，按 rAF 连续采样 ~1.4s，量化：
 *   ① 帧间隔长帧数（>33ms / >50ms）与 longtask（主线程阻塞）总和；
 *   ② 每个 section 的高度序列 → 方向反转次数（先增后减再增 = 抖动）；
 *   ③ `.filetree-scroll` 的 scrollTop 实际变化次数 + 是否来回跳（回跳）；
 *   ④ `.section-slide` wrapper 的内联 height 写入序列（0→px 动画目标 vs 内部 section 真实高）；
 *   ⑤ 终态面板是否完整落在侧栏滚动视口内；末段 250ms 内高度是否已稳定。
 *
 * 会话（每个独立临时 profile，互不污染；每次会话前 taskkill 全部 lightmd.exe）：
 *   A cleanClock    开文件夹 + 3 个已打开文件（不溢出）→ 点时钟「最近打开」
 *   B overflowClock 开文件夹 + 15 个已打开文件（侧栏溢出）→ 点时钟
 *   C overflowStar  开文件夹 + 3 个文件 + 3 条收藏 → 点星标「收藏」（溢出态由收藏撑着）
 *
 * 用法：node scripts/v0140-probe-sidebar-anim.mjs
 * 环境变量：V0140A_PORT（默认 9297）
 * 输出：_verify-out/v0140-probe-sidebar-anim.txt（+ 截图 v0140a-*.png）
 * 互斥：跑之前先抢 _verify-out/probe.lock（别的成员可能同时在用同一个 exe 跑探针，
 * 两个探针都会 taskkill /IM lightmd.exe，同时跑会互杀 → 必须串行）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140A_PORT || 9297);
const CDP = `http://127.0.0.1:${PORT}`;
const VERIFY_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT = path.join(VERIFY_DIR, "v0140-probe-sidebar-anim.txt");
const LOCK = path.join(VERIFY_DIR, "probe.lock");
const SAMPLE_MS = 1400; // 采样窗口（覆盖 0.33s 滑入 + 0.3s 高度过渡 + 2 次后续改写）

const lines = [];
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const indent = (obj) => JSON.stringify(obj, null, 2).replace(/\n/g, "\n  ");

// ─── 探针互斥锁（别的成员同时在跑实机探针时串行化） ─────────
async function acquireLock(maxWaitMs = 6 * 60 * 1000) {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fh = await fs.promises.open(LOCK, "wx");
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), script: "v0140-probe-sidebar-anim" }),
        "utf-8",
      );
      await fh.close();
      log(`已抢到探针互斥锁：${LOCK}`);
      return true;
    } catch {
      let stale = false;
      try {
        const st = fs.statSync(LOCK);
        stale = Date.now() - st.mtimeMs > 6 * 60 * 1000;
      } catch {}
      if (stale) {
        log(`探针锁已陈旧（>6 分钟），删除后重试`);
        try { fs.unlinkSync(LOCK); } catch {}
        continue;
      }
      if (Date.now() - started > maxWaitMs) {
        log(`等待探针锁超时（${maxWaitMs / 1000}s），放弃本次运行`);
        return false;
      }
      log(`探针锁被占用，5s 后重试…`);
      await sleep(5000);
    }
  }
}
function releaseLock() {
  // 只删自己抢到的锁：锁文件可能已被别的成员（Lead 的构建 / 另一个探针）接管，
  // 无条件 unlink 会破坏互斥。任何退出路径（正常结束、异常、Ctrl+C、kill）都要调到这里。
  try {
    const raw = fs.readFileSync(LOCK, "utf-8");
    const info = JSON.parse(raw);
    if (info && info.pid !== undefined && info.pid !== process.pid) return;
  } catch {
    // 锁不存在 / 内容非法 → 视为已被清理，无需处理
    return;
  }
  try { fs.unlinkSync(LOCK); } catch {}
}
// 任何退出路径都放锁：Ctrl+C / SIGTERM / 未捕获异常 / 正常结束
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
            pending.set(i, {
              resolve: (v) => {
                clearTimeout(t);
                res(v);
              },
            });
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
  });
}

/** 找到 Tauri 页面目标并连上（重载后调用可重新拿一个新连接） */
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
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          }, 15000);
          if (r.result?.result?.value === true) {
            await c.send("Page.enable");
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

/** 一个会话：独立 profile、独立进程、可重载后重连 */
async function openSession(label, fileCount = 20) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140a-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const workDir = path.join(tmp, "工作区");
  fs.mkdirSync(workDir, { recursive: true });
  for (let i = 1; i <= fileCount; i++) {
    fs.writeFileSync(
      path.join(workDir, `笔记-${String(i).padStart(2, "0")}.md`),
      `# 笔记 ${i}\n\n第 ${i} 篇内容。\n`,
      "utf-8",
    );
  }
  log(`── 会话「${label}」 ──`);
  log(`   临时工作区：${workDir}（${fileCount} 个 md）`);
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  let cdp = await attach();
  const session = {
    child,
    get cdp() { return cdp; },
    async ev(body) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await cdp.send("Runtime.evaluate", {
            expression: `(() => { ${body} })()`,
            returnByValue: true,
            awaitPromise: true,
          }, 40000);
          if (r.result?.exceptionDetails) {
            throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
          }
          return r.result?.result?.value;
        } catch (e) {
          lastErr = e;
          try { cdp.close(); } catch {}
          try { cdp = await attach(); } catch {}
          await sleep(600);
        }
      }
      throw lastErr;
    },
    async clickXY(x, y) {
      // 不在这里等待：采样器已经在跑，点击后立刻由 rAF 采样记录
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    },
    async reload(wait = 7000) {
      try { await cdp.send("Page.reload", { ignoreCache: false }); } catch {}
      await sleep(wait);
      try { cdp.close(); } catch {}
      cdp = await attach();
      await sleep(800);
    },
    async shot(name) {
      try {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.mkdirSync(VERIFY_DIR, { recursive: true });
        fs.writeFileSync(path.join(VERIFY_DIR, `${name}.png`), Buffer.from(r.result.data, "base64"));
      } catch {}
    },
    async close() {
      try { cdp.close(); } catch {}
      try { child.kill(); } catch {}
      try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
      await sleep(900);
    },
    workDir,
  };
  await sleep(2600); // 等启动恢复流程走完
  return session;
}

// ─── 页面内采样器 ──────────────────────────────────────────
/**
 * 点击前注入：rAF 逐帧记录各 section 的 top/height/内联高度、wrapper 内联高度、
 * scrollTop；同时 patch scrollTo / scrollTop setter 记录**写入**，
 * 用 MutationObserver 记录 style.height 每次写入，用 PerformanceObserver 记 longtask。
 */
const installSamplerBody = (durationMs) => `
  const S = window.__V0140A = {
    startT: performance.now(), duration: ${durationMs}, samples: [], longtasks: [],
    scrollWrites: [], heightWrites: [], clickT: null, last: 0,
  };
  // ① longtask（主线程单任务 >50ms 才上报，直接对应"卡顿"）
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) S.longtasks.push({ start: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1) });
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) { S.longtaskError = String(e); }

  const sc = document.querySelector(".filetree-scroll");
  if (!sc) return { installed: false, reason: "no .filetree-scroll" };

  // ② scrollTop 写入（reveal 的多次校正）——同时在实例上装 setter 并包 scrollTo
  const protoDesc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (protoDesc && protoDesc.get && protoDesc.set) {
    Object.defineProperty(sc, "scrollTop", {
      configurable: true,
      get() { return protoDesc.get.call(this); },
      set(v) { S.scrollWrites.push({ t: +performance.now().toFixed(2), from: +protoDesc.get.call(this).toFixed(2), to: +Number(v).toFixed(2), src: "scrollTop" }); protoDesc.set.call(this, v); },
    });
  }
  const origScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    try {
      if (this === sc) {
        const a0 = args[0];
        let to = null;
        if (typeof a0 === "number") to = +Number(a0).toFixed(2);
        else if (a0 && typeof a0 === "object" && a0.top !== undefined) to = +Number(a0.top).toFixed(2);
        S.scrollWrites.push({ t: +performance.now().toFixed(2), from: +sc.scrollTop.toFixed(2), to, src: "scrollTo", behavior: a0 && a0.behavior ? a0.behavior : null });
      }
    } catch (e) {}
    return origScrollTo.apply(this, args);
  };

  // ③ 内联 height 每次写入（React 重渲染 / wrapper 动画的目标）
  const targets = new Set();
  const addTargets = () => {
    document.querySelectorAll(".filetree-scroll [data-section-key], .filetree-scroll > .section-slide, .filetree-scroll > .section-slide-out").forEach((el) => {
      if (targets.has(el)) return;
      targets.add(el);
      S.mo.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    });
  };
  S.mo = new MutationObserver((recs) => {
    for (const r of recs) {
      const el = r.target;
      S.heightWrites.push({
        t: +performance.now().toFixed(2),
        key: el.dataset.sectionKey || el.className.replace(/\\s+/g, "."),
        attr: r.attributeName,
        h: el.style.height || null,
        transition: el.style.transition || null,
      });
    }
  });
  addTargets();
  S.addTargets = addTargets;

  // ④ rAF 逐帧采样
  const snap = () => {
    const now = performance.now();
    const scrollEl = document.querySelector(".filetree-scroll");
    const secs = {};
    document.querySelectorAll(".filetree-scroll [data-section-key]").forEach((el) => {
      const r = el.getBoundingClientRect();
      secs[el.dataset.sectionKey] = [+r.top.toFixed(2), +r.height.toFixed(2), el.style.height || null];
    });
    const wraps = [...document.querySelectorAll(".filetree-scroll > .section-slide, .filetree-scroll > .section-slide-out")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        cls: el.classList.contains("section-slide-out") ? "out" : "in",
        id: [...el.querySelectorAll("[data-section-key]")].map((s) => s.dataset.sectionKey).join("+"),
        h: +r.height.toFixed(2),
        inline: el.style.height || null,
        tr: el.style.transition || null,
      };
    });
    S.addTargets();
    S.samples.push({
      t: +now.toFixed(2),
      dt: S.last ? +(now - S.last).toFixed(2) : 0,
      st: scrollEl ? +scrollEl.scrollTop.toFixed(2) : null,
      sh: scrollEl ? scrollEl.scrollHeight : null,
      ch: scrollEl ? scrollEl.clientHeight : null,
      cw: scrollEl ? scrollEl.clientWidth : null,
      ov: scrollEl ? scrollEl.scrollHeight > scrollEl.clientHeight + 0.5 : null,
      secs,
      wraps,
    });
    S.last = now;
    if (now - S.startT < S.duration) S.raf = requestAnimationFrame(snap);
  };
  S.raf = requestAnimationFrame(snap);
  return { installed: true, scrollTopWritable: !!protoDesc, sectionKeys: [...document.querySelectorAll(".filetree-scroll [data-section-key]")].map((e) => e.dataset.sectionKey) };
`;

/** 点击前页面状态：按钮坐标 + 命中检查 + 布局快照 */
const preClickState = (btnTitle) => `
  const b = document.querySelector('.filetree-btn[title="${btnTitle}"]');
  if (!b) return { error: "找不到按钮 title=${btnTitle}" };
  const r = b.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const sc = document.querySelector(".filetree-scroll");
  const secs = [...document.querySelectorAll(".filetree-scroll [data-section-key]")].map((el) => {
    const rr = el.getBoundingClientRect();
    return { key: el.dataset.sectionKey, top: +rr.top.toFixed(2), h: +rr.height.toFixed(2), inline: el.style.height || null };
  });
  return {
    x: cx, y: cy, active: b.className.includes("active"),
    hitIsBtn: hit === b || (b && hit ? b.contains(hit) : false),
    scrollTop: sc ? +sc.scrollTop.toFixed(2) : null, scrollH: sc ? sc.scrollHeight : null, clientH: sc ? sc.clientHeight : null,
    secs,
  };
`;

/** 采集结果 + 终态（panelKey = 本次点击应展开的面板，按 key 精确取，避免取错栏） */
const collectState = (panelKey) => `
  const S = window.__V0140A;
  if (!S) return { error: "采样器未安装" };
  if (S.raf) cancelAnimationFrame(S.raf);
  S.mo.disconnect();
  const sc = document.querySelector(".filetree-scroll");
  const scr = sc ? sc.getBoundingClientRect() : null;
  const secEls = [...document.querySelectorAll(".filetree-scroll [data-section-key]")];
  const finalSecs = secEls.map((el) => {
    const r = el.getBoundingClientRect();
    return { key: el.dataset.sectionKey, top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), h: +r.height.toFixed(2), inline: el.style.height || null };
  });
  const panel = secEls.find((el) => el.dataset.sectionKey === ${JSON.stringify(panelKey)});
  let panelInfo = null;
  if (panel && scr) {
    const pr = panel.getBoundingClientRect();
    panelInfo = {
      key: panel.dataset.sectionKey,
      top: +pr.top.toFixed(2), bottom: +pr.bottom.toFixed(2), h: +pr.height.toFixed(2),
      scrollTop: sc.scrollTop, scrollH: sc.scrollHeight, clientH: sc.clientHeight,
      viewportTop: +scr.top.toFixed(2), viewportBottom: +scr.bottom.toFixed(2),
      inViewport: pr.top < scr.bottom - 1 && pr.bottom > scr.top + 1,
      fullyVisible: pr.top >= scr.top - 1 && pr.bottom <= scr.bottom + 1,
      // 面板比视口还高时"完整可见"不可能，退化为"标题栏可见"
      headerVisible: pr.top >= scr.top - 1 && pr.top < scr.bottom - 1,
    };
  }
  return {
    clickT: S.clickT, startT: S.startT, duration: S.duration,
    samples: S.samples, longtasks: S.longtasks, scrollWrites: S.scrollWrites, heightWrites: S.heightWrites,
    finalSecs, panelInfo,
    finalScrollTop: sc ? +sc.scrollTop.toFixed(2) : null,
    clockActive: !!document.querySelector('.filetree-btn[title="最近打开"].active'),
    starActive: !!document.querySelector('.filetree-btn[title="收藏"].active'),
  };
`;

// ─── 分析 ─────────────────────────────────────────────────
function analyze(state) {
  const clickT = state.clickT ?? state.startT;
  const after = state.samples.filter((s) => s.t >= clickT);
  const rel = (t) => +(t - clickT).toFixed(1);

  // ① 帧间隔
  const frames = after.map((s) => s.dt).filter((d) => d > 0);
  const long33 = frames.filter((d) => d > 33).length;
  const long50 = frames.filter((d) => d > 50).length;
  const long100 = frames.filter((d) => d > 100).length;
  const maxFrame = frames.length ? Math.max(...frames) : 0;
  const longtasks = state.longtasks || [];
  const longtaskTotal = +longtasks.reduce((s, e) => s + e.dur, 0).toFixed(1);

  // ② 每个 section 的高度序列 → 方向反转
  const keys = new Set();
  after.forEach((s) => Object.keys(s.secs).forEach((k) => keys.add(k)));
  const perKey = {};
  for (const k of keys) {
    const seq = [];
    for (const s of after) {
      const v = s.secs[k];
      if (!v) continue;
      if (!seq.length || Math.abs(v[1] - seq[seq.length - 1].h) >= 0.5) {
        seq.push({ t: rel(s.t), h: v[1] });
      }
    }
    // 方向反转：Δ 符号交替（忽略 <0.5px 的抖动）
    let rev = 0;
    let prevSign = 0;
    for (let i = 1; i < seq.length; i++) {
      const d = seq[i].h - seq[i - 1].h;
      if (Math.abs(d) < 0.5) continue;
      const sign = Math.sign(d);
      if (prevSign !== 0 && sign !== prevSign) rev++;
      prevSign = sign;
    }
    const last = seq.length ? seq[seq.length - 1].h : null;
    // 末段稳定性：最后 250ms 内是否还在变
    const tailStart = (state.samples[state.samples.length - 1]?.t ?? 0) - 250;
    const tailChanges = seq.filter((e) => e.t + clickT > tailStart).length;
    perKey[k] = {
      changes: seq.length,
      reversals: rev,
      from: seq.length ? seq[0].h : null,
      to: last,
      sequence: seq.map((e) => `${e.t}ms:${e.h}`).join(" → "),
      tailChanges,
    };
  }

  // ③ scrollTop 实际变化 + 回跳
  const stSeq = [];
  for (const s of after) {
    if (s.st === null) continue;
    if (!stSeq.length || Math.abs(s.st - stSeq[stSeq.length - 1].st) >= 0.5) stSeq.push({ t: rel(s.t), st: s.st });
  }
  let stReversals = 0;
  let prevSign = 0;
  for (let i = 1; i < stSeq.length; i++) {
    const d = stSeq[i].st - stSeq[i - 1].st;
    if (Math.abs(d) < 0.5) continue;
    const sign = Math.sign(d);
    if (prevSign !== 0 && sign !== prevSign) stReversals++;
    prevSign = sign;
  }
  const writes = (state.scrollWrites || []).map((w) => `${rel(w.t)}ms:${w.from}→${w.to}(${w.src}${w.behavior ? "," + w.behavior : ""})`);

  // ④ wrapper 内联高度（0→px 动画）与内部 section 高度对照：wrapper 是否把 section 裁掉了
  // id = wrapper 内 section key 组合，避免把 folder/temp/panel 三个 wrapper 混成一条序列
  const wrapById = {};
  for (const s of after) {
    for (const w of s.wraps || []) {
      const arr = (wrapById[w.id] ||= []);
      const last = arr[arr.length - 1];
      if (!last || last.cls !== w.cls || Math.abs(last.h - w.h) >= 0.5 || last.inline !== w.inline) {
        arr.push({ t: rel(s.t), cls: w.cls, h: w.h, inline: w.inline });
      }
    }
  }
  const wrapEvents = [];
  for (const [id, arr] of Object.entries(wrapById)) {
    wrapEvents.push(`${id || "(空)"}: ` + arr.map((e) => `${e.t}ms:${e.cls} h=${e.h} inline=${e.inline}`).join(" → "));
  }
  // 面板 wrapper 在动画期间是否裁剪内部 section（按构造必然裁剪，仅用于确认动画确实在跑）
  const clipFrames = after.filter((s) => {
    const inW = (s.wraps || []).find((w) => w.cls === "in" && (w.id === "recent" || w.id === "favorites"));
    if (!inW) return false;
    const panel = s.secs.recent || s.secs.favorites;
    return panel && panel[1] - inW.h > 1;
  }).length;

  // ⑤ 布局总量时序（Lead 口径）：Σ(section 高) + 4px×分隔条 数。
  //    只靠 scrollHeight 看不出"总量凹下去"（内容比容器矮时 scrollHeight 被容器高托住），
  //    而两栏高度动画不同步时，**两栏之和**会先少 ~33px 再补回 → 面板底边先上浮再掉回来，
  //    且越过容器的一瞬会闪竖直滚动条（内容宽度 2px 抖动）。
  const sumSeries = [];
  const cwSet = new Set();
  let overflowFrames = 0;
  for (const s of after) {
    const ks = Object.keys(s.secs);
    if (ks.length > 0) {
      const sum = ks.reduce((acc, k) => acc + s.secs[k][1], 0) + 4 * (ks.length - 1);
      if (!sumSeries.length || Math.abs(sum - sumSeries[sumSeries.length - 1].sum) >= 0.5) {
        sumSeries.push({ t: rel(s.t), sum: +sum.toFixed(2) });
      }
    }
    if (s.ov) overflowFrames++;
    if (s.cw !== null && s.cw !== undefined) cwSet.add(s.cw);
  }
  let sumReversals = 0;
  // 「回弹」= 总量已经减过之后又变大（>=2px）→ 面板底边先掉下去再回来
  let sumBounceBacks = 0;
  let prevSumSign = 0;
  let seenDecrease = false;
  for (let i = 1; i < sumSeries.length; i++) {
    const d = sumSeries[i].sum - sumSeries[i - 1].sum;
    if (Math.abs(d) < 0.5) continue;
    if (d < 0) seenDecrease = true;
    else if (seenDecrease && d > 2) sumBounceBacks++;
    const sign = Math.sign(d);
    if (prevSumSign !== 0 && sign !== prevSumSign) sumReversals++;
    prevSumSign = sign;
  }
  const finalSum = sumSeries.length ? sumSeries[sumSeries.length - 1].sum : null;
  const sumMin = sumSeries.length ? Math.min(...sumSeries.map((e) => e.sum)) : null;
  const sumMax = sumSeries.length ? Math.max(...sumSeries.map((e) => e.sum)) : null;
  const finalSh = state.samples[state.samples.length - 1]?.sh ?? null;
  const finalCh = state.samples[state.samples.length - 1]?.ch ?? null;
  const finalOverflow = finalSh !== null && finalCh !== null ? finalSh > finalCh + 0.5 : null;
  // 凹 = 终态能装下时，动画中段比终态矮多少（= 面板底边上浮量）
  const sumDipMax = finalOverflow ? 0 : Math.max(0, +((finalSum ?? 0) - (sumMin ?? 0)).toFixed(1));
  // 超 = 动画中段比终态高多少（终态能装下时，越过就会闪滚动条）
  const sumExcessMax = finalOverflow ? 0 : Math.max(0, +((sumMax ?? 0) - (finalSum ?? 0)).toFixed(1));

  return {
    clickT: rel(clickT),
    frames: { total: frames.length, long33, long50, long100, maxFrame: +maxFrame.toFixed(1), sumLongtask: longtaskTotal },
    perKey,
    scroll: { changes: stSeq.length, reversals: stReversals, sequence: stSeq.map((e) => `${e.t}ms:${e.st}`).join(" → "), writes: writes.slice(0, 20), writeCount: writes.length },
    wraps: { events: wrapEvents, clipFrames },
    layoutTotal: {
      sumReversals,
      sumBounceBacks,
      sumDipMax,
      sumExcessMax,
      overflowFrames,
      clientWidths: [...cwSet],
      sequence: sumSeries.map((e) => `${e.t}ms:${e.sum}`).join(" → "),
      finalSum,
      finalSh,
      finalCh,
      finalOverflow,
    },
    final: {
      secs: state.finalSecs,
      scrollTop: state.finalScrollTop,
      panel: state.panelInfo,
      buttonActive: state.clockActive || state.starActive,
    },
  };
}

// ─── 会话流程 ─────────────────────────────────────────────
const btnPos = async (S, title) => S.ev(preClickState(title));

const openFolder = async (S, dir) => {
  await S.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFolder",{detail:{path:${JSON.stringify(dir)}}})); return 1;`);
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (await S.ev(`return !!document.querySelector(".filetree-folder-section .filetree-node");`)) return true;
  }
  return false;
};

const openPaths = async (S, paths, gap = 700) => {
  for (const p of paths) {
    await S.ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
    await sleep(gap);
  }
};

/** 记录一次「点按钮 → 采样 1.4s → 分析」的完整过程（panelKey = 本次应展开的面板） */
async function sampleClick(S, label, title, panelKey, enforce = true) {
  log("");
  log(`  ▸ 场景：${label}（点击按钮「${title}」，目标面板 ${panelKey}）`);
  const pre = await btnPos(S, title);
  if (!pre || pre.error) {
    log(`    ✗ 按钮状态异常：${JSON.stringify(pre)}`);
    return null;
  }
  log(`    点前布局：${JSON.stringify(pre.secs)}`);
  log(`    scrollTop=${pre.scrollTop} scrollH=${pre.scrollH} clientH=${pre.clientH} 按钮 active=${pre.active} 命中=${pre.hitIsBtn}`);

  const inst = await S.ev(installSamplerBody(SAMPLE_MS));
  if (!inst?.installed) {
    log(`    ✗ 采样器安装失败：${JSON.stringify(inst)}`);
    return null;
  }
  log(`    采样器已安装（section keys=${JSON.stringify(inst.sectionKeys)}，scrollTop 可 patch=${inst.scrollTopWritable}）`);

  await S.clickXY(pre.x, pre.y);
  const clickT = await S.ev(`window.__V0140A.clickT = performance.now(); return window.__V0140A.clickT;`);
  await sleep(SAMPLE_MS + 500);

  const raw = await S.ev(collectState(panelKey));
  if (raw?.error) {
    log(`    ✗ 采集失败：${raw.error}`);
    return null;
  }
  raw.clickT = clickT ?? raw.clickT;
  const a = analyze(raw);

  log("    帧：" + JSON.stringify(a.frames));
  log("    scrollTop：" + JSON.stringify({ changes: a.scroll.changes, reversals: a.scroll.reversals, writeCount: a.scroll.writeCount }));
  log("      scrollTop 实测序列：" + (a.scroll.sequence || "(无变化)"));
  log("      scroll 写入调用：" + JSON.stringify(a.scroll.writes));
  for (const [k, v] of Object.entries(a.perKey)) {
    log(`    高度 ${k}：变化 ${v.changes} 次 / 方向反转 ${v.reversals} 次 / ${v.from} → ${v.to}px / 末段250ms 变化 ${v.tailChanges}`);
    log(`      序列：${v.sequence}`);
  }
  log(`    wrapper 高度事件：${JSON.stringify(a.wraps.events)}`);
  log(`    wrapper 裁剪帧数（wrapper 高 < 面板高）：${a.wraps.clipFrames}`);
  log(`    布局总量（Σ section 高 + 分隔条）：${JSON.stringify({ ...a.layoutTotal, sequence: undefined })}`);
  log(`      序列：${a.layoutTotal.sequence}`);
  log("    终态：" + indent(a.final));
  if (a.final.panel) {
    log(
      `    终态面板：${a.final.panel.key} top=${a.final.panel.top} bottom=${a.final.panel.bottom} / 视口 ${a.final.panel.viewportTop}..${a.final.panel.viewportBottom} → 在视口内=${a.final.panel.inViewport} 完整可见=${a.final.panel.fullyVisible} 标题栏可见=${a.final.panel.headerVisible}`,
    );
  } else {
    log(`    终态面板：${panelKey} 已卸载（收起场景，不做可见性判定）`);
  }
  const safe = label.replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
  await S.shot(`v0140a-${safe}-after`);

  // 判定（需求3 修复目标：一次平滑展开、无抖动、无长帧、面板最终可见）
  const panelHeights = a.perKey[panelKey] ?? null;
  const verdict = {
    longFrames50: a.frames.long50 === 0,
    heightReversals: !panelHeights || panelHeights.reversals === 0,
    // changes 统计「不同 scrollTop 取值个数」：1 = 全程没滚；2 = reveal 单次校正；>2 = 多拍乱滚
    scrollJitter: a.scroll.changes <= 2 && a.scroll.reversals === 0,
    // 布局总量单调 = 没有"面板底边先上浮再掉回来"的抖动（凹/超都会让人肉眼看到回弹）
    // 单调（反转 0）+ 不回凹 = 无回弹；sumExcessMax 只作 INFO：面板初值 200 会让总量
    // 在动画起点天然高于终态，只要单调收敛就不是「底边先掉下去再回来」的抖动
    smoothLayout: a.layoutTotal.sumBounceBacks === 0 && a.layoutTotal.sumDipMax <= 2,
    // 滚动条出没不该改变内容宽度（scrollbar-gutter: stable）
    noScrollbarFlash: a.layoutTotal.clientWidths.length <= 1,
    // 收起场景面板已卸载 → 不做可见性判定
    panelVisible: !a.final.panel || a.final.panel.fullyVisible || a.final.panel.headerVisible,
    noLongtask: a.frames.sumLongtask === 0,
  };
  const pass = Object.values(verdict).every(Boolean);
  log(`    判定：${Object.entries(verdict).map(([k, v]) => `${k}=${v ? "✓" : "✗"}`).join(" ")} ⇒ ${pass ? "PASS" : "FAIL"}`);
  return { ...a, verdict, pass, label, enforce };
}

async function sessionCleanClock() {
  log("");
  log("═══ 会话 A：干净态（开文件夹 + 3 个已打开文件）→ 点时钟「最近打开」═══");
  const S = await openSession("cleanClock");
  try {
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await openPaths(S, ["01", "02", "03"].map((n) => path.join(S.workDir, `笔记-${n}.md`)));
    await sleep(1200);
    log(`  标签数=${await S.ev(`return document.querySelectorAll(".tab-item").length;`)}`);
    return await sampleClick(S, "A-clean-clock", "最近打开", "recent");
  } finally {
    await S.close();
  }
}

async function sessionOverflowClock() {
  log("");
  log("═══ 会话 B：侧栏溢出态（开文件夹 + 15 个已打开文件）→ 点时钟「最近打开」═══");
  const S = await openSession("overflowClock");
  try {
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await openPaths(S, Array.from({ length: 15 }, (_, i) => path.join(S.workDir, `笔记-${String(i + 1).padStart(2, "0")}.md`)), 550);
    await sleep(1600);
    log(`  标签数=${await S.ev(`return document.querySelectorAll(".tab-item").length;`)}`);
    const layout = await S.ev(`
      const sc = document.querySelector(".filetree-scroll");
      const secs = [...document.querySelectorAll(".filetree-scroll [data-section-key]")].map(el => { const r = el.getBoundingClientRect(); return { key: el.dataset.sectionKey, h: +r.height.toFixed(1), inline: el.style.height || null }; });
      return { secs, scrollTop: sc.scrollTop, scrollH: sc.scrollHeight, clientH: sc.clientHeight };
    `);
    log(`  点前布局：${JSON.stringify(layout)}`);
    return await sampleClick(S, "B-overflow-clock", "最近打开", "recent");
  } finally {
    await S.close();
  }
}

async function sessionOverflowStar() {
  log("");
  log("═══ 会话 C：溢出态 + 3 条收藏 → 点星标「收藏」═══");
  const S = await openSession("overflowStar");
  try {
    // 收藏数据没有可靠 UI 入口（要在标签页右键），直接种 localStorage 后重载
    const seeded = await S.ev(`
      const raw = localStorage.getItem("lightmd-file-store");
      const store = raw ? JSON.parse(raw) : { state: {}, version: 0 };
      store.state = store.state || {};
      const wd = ${JSON.stringify(S.workDir)};
      store.state.favorites = [1, 2, 3].map(i => ({ path: wd + "\\\\笔记-0" + i + ".md", name: "笔记-0" + i + ".md", addedAt: Date.now() - i * 1000 }));
      store.state.recentFiles = [];
      store.state.recentFolders = [];
      store.state.sessionFolders = [];
      localStorage.setItem("lightmd-file-store", JSON.stringify(store));
      const sraw = localStorage.getItem("lightmd-settings");
      const st = sraw ? JSON.parse(sraw) : { state: {}, version: 0 };
      st.state = st.state || {};
      st.state.loadLastFileOnStartup = false;
      st.state.loadLastFolderOnStartup = false;
      delete st.state.sidebarSectionSizes;
      localStorage.setItem("lightmd-settings", JSON.stringify(st));
      localStorage.removeItem("lightmd-open-file-tabs");
      return { favorites: store.state.favorites.length };
    `);
    log(`  种收藏数据：${JSON.stringify(seeded)}`);
    await S.reload(7500);
    log(`  重载后标签数=${await S.ev(`return document.querySelectorAll(".tab-item").length;`)}`);
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await openPaths(S, ["01", "02", "03"].map((n) => path.join(S.workDir, `笔记-${n}.md`)));
    await sleep(1400);
    const favCount = await S.ev(`return { favs: document.querySelectorAll(".favorites-section .favorite-item, .favorites-section .filetree-node").length, tabs: document.querySelectorAll(".tab-item").length };`);
    log(`  收藏条目=${favCount.favs} 标签=${favCount.tabs}`);
    return await sampleClick(S, "C-overflow-star", "收藏", "favorites");
  } finally {
    await S.close();
  }
}

/**
 * 会话 D/E/F：**侧栏溢出态**（用户把分栏拖大过 → 持久化高度之和 > 可视高）。
 *
 * 为什么单独造这个态：干净态下 auto-fill 会让新面板恰好填满到底部（scrollH == clientH），
 * v0.14.0 需求3 的 reveal（把面板滚进可视区）根本不会触发；而用户真实工作区里各栏都被
 * 拖高过、侧栏本来就是溢出的，点开收藏/最近打开时面板落在视口下方 → reveal 连续 5 拍
 * scrollTo，才是"抖动"最可能的来源。这里用种持久化的方式精确造出该态。
 */
async function sessionOverflowReveal() {
  log("");
  log("═══ 会话 D/E/F：溢出态（folder 392 + temp 800 + favorites 700）→ 点收藏 → 点时钟 → 再点时钟 ═══");
  const S = await openSession("overflowReveal");
  try {
    const seed = await S.ev(`
      const wd = ${JSON.stringify(S.workDir)};
      const sraw = localStorage.getItem("lightmd-settings");
      const st = sraw ? JSON.parse(sraw) : { state: {}, version: 0 };
      st.state = st.state || {};
      st.state.sidebarSectionSizes = { ["folder:" + wd]: 392, temp: 800, favorites: 700 };
      st.state.loadLastFileOnStartup = false;
      st.state.loadLastFolderOnStartup = false;
      localStorage.setItem("lightmd-settings", JSON.stringify(st));
      const fraw = localStorage.getItem("lightmd-file-store");
      const fs2 = fraw ? JSON.parse(fraw) : { state: {}, version: 0 };
      fs2.state = fs2.state || {};
      fs2.state.favorites = [1, 2, 3].map(i => ({ path: wd + "\\\\笔记-0" + i + ".md", name: "笔记-0" + i + ".md", addedAt: Date.now() - i * 1000 }));
      fs2.state.recentFiles = [];
      fs2.state.recentFolders = [];
      fs2.state.sessionFolders = [];
      localStorage.setItem("lightmd-file-store", JSON.stringify(fs2));
      localStorage.removeItem("lightmd-open-file-tabs");
      return { sizes: st.state.sidebarSectionSizes };
    `);
    log(`  种持久化分栏高度：${JSON.stringify(seed)}`);
    await S.reload(7500);
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await openPaths(S, ["01", "02", "03"].map((n) => path.join(S.workDir, `笔记-${n}.md`)));
    await sleep(1500);
    const before = await S.ev(`
      const sc = document.querySelector(".filetree-scroll");
      const secs = [...document.querySelectorAll(".filetree-scroll [data-section-key]")].map(el => { const r = el.getBoundingClientRect(); return { key: el.dataset.sectionKey, top: +r.top.toFixed(1), h: +r.height.toFixed(1), inline: el.style.height || null }; });
      return { secs, scrollTop: sc.scrollTop, scrollH: sc.scrollHeight, clientH: sc.clientHeight };
    `);
    log(`  点前布局：${JSON.stringify(before)}`);

    const star = await sampleClick(S, "D-overflow-star-first", "收藏", "favorites");
    const clockOpen = await sampleClick(S, "E-overflow-clock-reveal", "最近打开", "recent");
    // 收起场景只记录时序（INFO，不计入 PASS/FAIL）：收起必然让内容变矮、浏览器 clamp
    // scrollTop（实测 29 次），那是滚动位置跟随内容收缩，不是"打开时抖动"的口径。
    const clockClose = await sampleClick(S, "F-overflow-clock-close", "最近打开", "recent", false);
    return [star, clockOpen, clockClose];
  } finally {
    await S.close();
  }
}

// ─── 主流程 ────────────────────────────────────────────────
const main = async () => {
  if (!fs.existsSync(EXE)) {
    console.error("缺少打包产物：" + EXE);
    process.exit(3);
  }
  const got = await acquireLock();
  if (!got) process.exit(4);
  let allPass = true;
  try {
    log(`时间：${new Date().toISOString()}`);
    log(`打包产物：${EXE}`);
    log(`产物 mtime：${fs.statSync(EXE).mtime.toISOString()}`);
    log(`采样窗口：${SAMPLE_MS}ms（rAF 逐帧）`);

    const results = [];
    results.push(await sessionCleanClock());
    results.push(await sessionOverflowClock());
    results.push(await sessionOverflowStar());
    results.push(...(await sessionOverflowReveal()));

    log("");
    log("═══════════════ 汇总判定（需求3：一次平滑展开 / 无抖动 / 无长帧 / 面板可见）═══════════════");
    for (const r of results) {
      if (!r) { allPass = false; log("  某会话无数据（FAIL）"); continue; }
      const v = r.verdict;
      const ok = Object.values(v).every(Boolean);
      if (r.enforce !== false) allPass = allPass && ok;
      log(
        `  ${r.label}: 长帧>50ms=${r.frames.long50}（最长 ${r.frames.maxFrame}ms）/ longtask 合计 ${r.frames.sumLongtask}ms / ` +
        `面板高方向反转=${JSON.stringify(Object.values(r.perKey).map((v) => v.reversals))} / ` +
        `scrollTop 变化=${r.scroll.changes} 回跳=${r.scroll.reversals} / 总量回弹=${r.layoutTotal.sumBounceBacks} 反转=${r.layoutTotal.sumReversals} 凹=${r.layoutTotal.sumDipMax}px 超=${r.layoutTotal.sumExcessMax}px 滚动条出现帧=${r.layoutTotal.overflowFrames} clientWidth=${JSON.stringify(r.layoutTotal.clientWidths)} / ` +
        `面板完整可见=${r.final.panel?.fullyVisible} 标题栏可见=${r.final.panel?.headerVisible} ⇒ ${r.enforce === false ? "INFO" : ok ? "PASS" : "FAIL"}`,
      );
    }
    log("");
    log(`总判定：${allPass ? "PASS（需求3 修复达标）" : "FAIL（仍有卡顿/抖动/不可见）"}`);

    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(OUT, ["LightMD v0.14.0 需求3 动画时序探针", ...lines, ""].join("\n"), "utf-8");
    console.log(`\n报告：${OUT}`);
    process.exit(allPass ? 0 : 1);
  } finally {
    releaseLock();
  }
};

main().catch((e) => {
  console.error("探针异常：", e);
  try {
    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(OUT, ["LightMD v0.14.0 需求3 动画时序探针（异常中断）", ...lines, String(e && e.stack ? e.stack : e), ""].join("\n"), "utf-8");
  } catch {}
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  releaseLock();
  process.exit(2);
});

/**
 * LightMD v0.15.2 需求2 —— 实机探针：**标题折叠「折起比展开快」的按帧计时取证**（只测不改）。
 *
 * 用户原话：「标题折叠还有点小瑕疵，这个和之前左侧栏子文件夹展开和折起有同样的问题，
 *   就是折起来的动画太快，而展开的动画时间是符合我要求的。」
 *
 * 当前实现（v0.15.1 二次，220ms → 440ms）：
 *   `src/styles/readingFold.css`
 *     ① `.ProseMirror > *`                             —— 展开方向的几何过渡（440ms）
 *     ② `.ProseMirror > :not(.code-block-wrapper):not(.mermaid-block-wrapper):not(.math-block-wrapper):not(.table-wrapper)`
 *                                                      —— 展开方向 + `overflow 0s 440ms` / `visibility 0s 0s`
 *     ③ `.ProseMirror .lmd-fold-hidden`                —— 折叠方向（440ms）+ `overflow 0s 0s` / `visibility 0s 440ms`
 *   另外折叠态还写了 `max-height: 0 !important`（**不在 transition 列表里**）。
 *
 * Lead 的静态分析怀疑：② 的 `:not(类)` 计入参数特异性 → 真实特异性 (0,5,0)，
 * 而 ③ 只有 (0,2,0) → **折起时 ② 赢**，用的是 ② 的 `visibility 0s 0s`（立刻隐藏）。
 *
 * 本脚本要回答三个互斥假设（用实测数据区分，不靠读代码）：
 *   H1「visibility 立刻翻转」：折起时 visibility 在 0~1 帧变 hidden，但 height 仍在 440ms 内平滑下降。
 *   H2「max-height 立刻钳位」：折起时 height 计算值在 0~1 帧就掉到 0（`max-height:0` 未参与过渡，
 *      把 height 动画整体钳死）—— 若如此，则无论 visibility 如何，视觉上都是瞬间收起。
 *   H3「height 过渡本身时长不同」：折起与展开的 height 曲线斜率明显不同（例如折起 200ms 走完）。
 *
 * 采样手法：**页面内一次 eval 跑完整个窗口**（`requestAnimationFrame` 收集，约 16ms 一帧、900ms），
 * 跑完一次性取回数组 —— 避免每帧 CDP 往返抖动污染时间轴。
 *
 * 用法：
 *   node scripts/v0152-probe-fold-timing.mjs
 * 环境变量：
 *   V0152_PORT   CDP 端口（默认 9297）
 *   V0152_EXE    打包产物路径（默认 src-tauri/target/release/lightmd.exe）
 *   V0152_WINDOW 采样窗口 ms（默认 900）
 *
 * 退出码：0 = 全部取证项通过（数据有效）／1 = 有 FAIL（数据无效或曲线不可用）／2 = 探针异常。
 *
 * ⚠️ 必须跑**打包产物**：只 `npx vite build` 时 exe 内联的仍是旧 dist（语义地图 §4-30）。
 *    脚本会校验 dist/index.html 的入口 hash 是否出现在 exe 字节流里，不一致直接中止。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0152_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0152_PORT || 9297);
const WINDOW_MS = Number(process.env.V0152_WINDOW || 900);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0152-probe-fold-timing.txt");
const OUT_JSON = path.join(OUT_DIR, "v0152-probe-fold-timing.json");
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
  if (!m) throw new Error("dist/index.html 里找不到 assets/index-<hash>.js 入口，dist 可能不完整");
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
  log(`[probe] exe mtime=${fs.statSync(EXE).mtime.toISOString()}`);
  log(`[probe] dist mtime=${fs.statSync(DIST_INDEX).mtime.toISOString()}`);
}

// ─── 端口独占：跑前必须确认 9297 没有被旧进程占用 ───────────────
function killStale() {
  for (const name of ["lightmd.exe", "msedgewebview2.exe"]) {
    try {
      execFileSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" });
    } catch {
      /* 进程本来就不在 */
    }
  }
}

function portListeners(port) {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess) -join ','`,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return String(out || "").trim();
  } catch {
    return "";
  }
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
            }, 60000);
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
      // `r.result.result.value`。只给 msg.result 会让所有取值都少一层，
      // 表现为"CDP 连上了但什么都读不到"（v0.15.1 探针踩过一次）。
      else p.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

/**
 * 造一篇够长的取证文档：每个 H2 下 3 段长正文（总高足够量出曲线）。
 * 目标节选「小节 5」，其下内容高度 ≈ 500px+，收缩曲线才有足够分辨率。
 */
function makeDoc() {
  const parts = ["# 折叠计时取证", ""];
  for (let i = 1; i <= 30; i++) {
    parts.push(`## 小节 ${i}`);
    parts.push("");
    // 每节 6 段长正文 → 折叠区间总高 > 350px，高度曲线才有足够分辨率，
    // "内容是否还看得见"在视觉上也才真正可区分。
    for (let j = 1; j <= 6; j++) {
      parts.push(
        `第 ${i}.${j} 段：这是一段用于撑出可测量高度的正文，故意写得比较长，` +
          `让折叠区间内每个块都有稳定高度 —— 折起与展开的高度曲线才有足够的分辨率，` +
          `也能让"内容是否还看得见"这件事在视觉上真正可区分。`,
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
 * 页面内取证工具。全部在页面上下文里跑，避免 CDP 往返。
 *
 * `__pickTarget()`：在阅读面找「子内容最厚」的可折叠 H2（用与产品同口径的块几何：
 *   `.ProseMirror > *`，折叠区间 = 其后直到下一个 level ≤ 2 的标题之前的全部块）。
 *   返回它的块下标、按钮、以及**被折叠块的顶层下标列表**（用于逐帧按 index 重取元素，
 *   不依赖元素引用 —— PM 的装饰更新只 patch 属性，但重建时引用会失效，按 index 最稳）。
 */
const PAGE_TOOLS = String.raw`
function __pmRoot() { return document.querySelector(".ProseMirror"); }
function __kids() { const r = __pmRoot(); return r ? Array.from(r.children) : []; }
function __level(el) {
  const m = /^H([1-6])$/.exec(el.tagName || "");
  return m ? Number(m[1]) : 0;
}
/** 顶层块下标 → 折叠该标题时会隐藏的块下标列表（与 headingFold.hiddenBlockIndexes 同口径） */
function __hiddenIdxsFor(kids, headingIdx) {
  const lv = __level(kids[headingIdx]);
  const out = [];
  for (let i = headingIdx + 1; i < kids.length; i++) {
    const l = __level(kids[i]);
    if (l > 0 && l <= lv) break;
    out.push(i);
  }
  return out;
}
/** 找一个「子内容最厚」的可折叠标题（优先 H2），返回下标与几何信息 */
function __pickTarget() {
  const kids = __kids();
  let best = null;
  for (let i = 0; i < kids.length; i++) {
    const lv = __level(kids[i]);
    if (lv < 2 || lv > 3) continue;           // 只在 H2/H3 里挑（用户场景是二级标题）
    if (!kids[i].classList.contains("lmd-fold-heading")) continue; // 只挑真带折叠按钮的
    const btn = kids[i].querySelector(".lmd-fold-toggle");
    if (!btn) continue;
    const hiddenIdxs = __hiddenIdxsFor(kids, i);
    if (!hiddenIdxs.length) continue;
    let h = 0;
    for (const k of hiddenIdxs) h += kids[k].getBoundingClientRect().height;
    if (!best || h > best.contentHeight) {
      best = {
        headingIdx: i,
        level: lv,
        headingText: (kids[i].textContent || "").trim().slice(0, 30),
        hiddenIdxs,
        contentHeight: h,
        hasBtn: true,
      };
    }
  }
  return best;
}
/** 当前被折叠块（按顶层下标）高度之和 + 首个隐藏块的样式快照 */
function __frame(target) {
  const kids = __kids();
  let total = 0, connected = 0;
  for (const k of target.hiddenIdxs) {
    const el = kids[k];
    if (!el) continue;
    connected++;
    total += el.getBoundingClientRect().height;
  }
  const first = kids[target.hiddenIdxs[0]] || null;
  const cs = first ? getComputedStyle(first) : null;
  const anims = [];
  if (first && first.getAnimations) {
    for (const a of first.getAnimations()) {
      const eff = a.effect;
      const tgt = eff && eff.target === first ? eff : null;
      anims.push({
        prop: a.transitionProperty || (tgt && tgt.getKeyframes && null) || "?",
        dur: eff && eff.getTiming ? eff.getTiming().duration : null,
        t: a.currentTime,
        state: a.playState,
      });
    }
  }
  return {
    total,
    connected,
    cls: first ? first.classList.contains("lmd-fold-hidden") : null,
    vis: cs ? cs.visibility : null,
    op: cs ? cs.opacity : null,
    h: cs ? cs.height : null,
    maxH: cs ? cs.maxHeight : null,
    ov: cs ? cs.overflowY : null,
    animCount: anims.length,
    anims,
  };
}
/** 三个 transition 长串（property / duration / delay），按逗号对齐读 */
function __transitionOf(el) {
  if (!el) return null;
  const cs = getComputedStyle(el);
  const split = (s) => String(s || "").split(",").map((x) => x.trim());
  const props = split(cs.transitionProperty);
  const durs = split(cs.transitionDuration);
  const delays = split(cs.transitionDelay);
  const rows = props.map((p, i) => ({
    prop: p,
    dur: durs[i] ?? durs[durs.length - 1] ?? "",
    delay: delays[i] ?? delays[delays.length - 1] ?? "",
  }));
  return { property: cs.transitionProperty, duration: cs.transitionDuration, delay: cs.transitionDelay, rows };
}
/**
 * 特异性审计：列出**所有匹配该元素的 CSS 规则**及其特异性，按 (特异性, 源码顺序) 排序，
 * 最后一条带 transition 声明的就是"实际生效"的那条。
 *
 * 目的：把 Lead 的静态分析（② 是 (0,5,0)、③ 是 (0,2,0)）变成**运行时证据**，
 * 而不是继续靠读 CSS 推断。specificity() 是近似实现：:not()/:is() 取参数最大值
 * （现代规范行为）、伪元素记元素级、:where() 记 0 —— 对本文件足够。
 */
function __specificity(sel) {
  let s = String(sel || "");
  // :where() 的参数特异性为 0（规范行为），先整体抹掉
  s = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, " ");
  let a = 0;
  let b = 0;
  let c = 0;
  // :not()/:is()/:has() 取参数列表里的**最大**特异性并入（现代规范）
  const groupRe = /:(?:not|is|has)\(((?:[^()]|\([^()]*\))*)\)/g;
  let guard = 0;
  let m;
  while ((m = groupRe.exec(s)) && guard++ < 20) {
    let best = { a: 0, b: 0, c: 0 };
    for (const part of String(m[1]).split(",")) {
      const v = __specificity(part);
      if (v.a > best.a || (v.a === best.a && v.b > best.b) ||
          (v.a === best.a && v.b === best.b && v.c > best.c)) best = v;
    }
    a += best.a; b += best.b; c += best.c;
  }
  s = s.replace(groupRe, " ");
  a += (s.match(/#[\w-]+/g) || []).length;
  b += (s.match(/\.[\w-]+/g) || []).length;
  b += (s.match(/\[[^\]]+\]/g) || []).length;
  b += (s.match(/:(?!:)[\w-]+(?:\([^()]*\))?/g) || []).length;
  const pseudoEls = (s.match(/::[\w-]+/g) || []).length;
  const rest = s
    .replace(/::[\w-]+/g, " ")
    .replace(/#[\w-]+/g, " ")
    .replace(/\.[\w-]+/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/:(?!:)[\w-]+(?:\([^()]*\))?/g, " ")
    .replace(/[*>+~]/g, " ");
  c += pseudoEls + (rest.match(/(?:^|[\s,])([a-zA-Z][\w-]*)/g) || []).length;
  return { a, b, c };
}
/** 列出匹配 el 的、声明了 transition 的规则（按级联优先级升序，末条 = 实际生效） */
function __ruleAudit(el) {
  if (!el) return null;
  const hits = [];
  const diag = { sheets: 0, readable: 0, blocked: 0, blockedHrefs: [] };
  let order = 0;
  const walk = (rules, sheetHref) => {
    for (const r of rules) {
      order++;
      if (r.cssRules) { walk(r.cssRules, sheetHref); continue; }
      if (!r.selectorText || !r.style) continue;
      let matches = false;
      try { matches = el.matches(r.selectorText); } catch { matches = false; }
      if (!matches) continue;
      const spec = __specificity(r.selectorText);
      hits.push({
        selector: r.selectorText,
        spec: "(" + spec.a + "," + spec.b + "," + spec.c + ")",
        specScore: spec.a * 10000 + spec.b * 100 + spec.c,
        order,
        transition: r.style.transition || r.style.transitionProperty || "",
        transitionDelay: r.style.transitionDelay || "",
        transitionDuration: r.style.transitionDuration || "",
        maxHeight: r.style.maxHeight || "",
        visibility: r.style.visibility || "",
        sheet: sheetHref,
      });
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    diag.sheets++;
    let rules = null;
    try { rules = sheet.cssRules; } catch { rules = null; }
    if (rules) { diag.readable++; walk(rules, sheet.href || "(inline)"); }
    else { diag.blocked++; diag.blockedHrefs.push(sheet.href || "(inline)"); }
  }
  // 级联：特异性优先，同特异性按源码顺序
  hits.sort((x, y) => x.specScore - y.specScore || x.order - y.order);
  return {
    diag,
    totalMatching: hits.length,
    withTransition: hits.filter((h) => h.transition).map((h) => ({
      selector: h.selector, spec: h.spec, transition: h.transition,
      transitionDelay: h.transitionDelay, transitionDuration: h.transitionDuration,
      maxHeight: h.maxHeight, visibility: h.visibility,
    })),
    // 实际生效的 transition = 级联最末的那条
    winner: (() => {
      const list = hits.filter((h) => h.transition);
      return list.length ? list[list.length - 1] : null;
    })(),
    /** 声明了 max-height 且值为 0 的规则（H2 的静态证据） */
    maxHeightZeroRules: hits
      .filter((h) => String(h.maxHeight).replace(/\s|!important/g, "") === "0")
      .map((h) => ({ selector: h.selector, spec: h.spec, maxHeight: h.maxHeight })),
  };
}
/**
 * 若 CSSOM 读不到（Tauri 自定义协议下 link 样式表的 cssRules 会抛 SecurityError），
 * 退化为**抓取 CSS 文本 + 极简解析**：只取选择器与 transition/max-height/visibility 声明。
 * 这不是通用 CSS 解析器，只为取证服务（本文件规则都是单层、无 @media 嵌套依赖）。
 */
function __ruleAuditFromText(el, cssText) {
  if (!el) return null;
  const hits = [];
  let noComment = String(cssText || "").replace(/\/\*[\s\S]*?\*\//g, "");
  // ⚠️ 必须**剔除非活动的 @media 块**，否则 prefers-reduced-motion 那条
  // "transition: none !important" 会被当成「同特异性但源码更靠后」→ 误判为胜者
  // （v0.15.2 复验踩到：audit winner 变成了 reduced-motion 那条规则）。
  // 本探针只在 reduce=off 的常规环境跑静态审计，故整块删除即可。
  noComment = noComment.replace(
    /@media[^{]*prefers-reduced-motion[^{]*\{((?:[^{}]|\{[^{}]*\})*)\}/gi,
    " ",
  );
  // 拆块：selector { decls }（@media / @supports 包装层被上面的替换或本正则展平）
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let order = 0;
  while ((m = re.exec(noComment))) {
    order++;
    const selGroup = m[1].trim();
    if (!selGroup || selGroup.startsWith("@")) continue;
    const decls = m[2];
    const readDecl = (prop) => {
      const mm = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(decls);
      return mm ? mm[1].trim() : "";
    };
    const trans = readDecl("transition") || readDecl("transition-property");
    const maxH = readDecl("max-height");
    const vis = readDecl("visibility");
    if (!trans && !maxH && !vis) continue;
    // ⚠️ 选择器组必须按**括号深度为 0** 的逗号切分：
    // 修复后规则② 形如  .ProseMirror > *:not(:where(.a, .b, .c, .d))
    // —— 里面的逗号属于 :where() 参数列表，朴素 split(",") 会把它切成 4 段，
    // el.matches() 全部抛错 → 该规则被当成"不匹配"丢掉 → winner 判错
    // （v0.15.2 复验时踩到，误报 FAIL）。
    const splitSelectorGroup = (group) => {
      const out = [];
      let depth = 0;
      let buf = "";
      for (const ch of String(group)) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        if (ch === "," && depth === 0) {
          out.push(buf);
          buf = "";
        } else {
          buf += ch;
        }
      }
      if (buf.trim()) out.push(buf);
      return out.map((s) => s.trim()).filter(Boolean);
    };
    for (const one of splitSelectorGroup(selGroup)) {
      let matches = false;
      try { matches = el.matches(one); } catch { matches = false; }
      if (!matches) continue;
      const spec = __specificity(one);
      hits.push({
        selector: one,
        spec: "(" + spec.a + "," + spec.b + "," + spec.c + ")",
        specScore: spec.a * 10000 + spec.b * 100 + spec.c,
        order,
        transition: trans,
        transitionDelay: readDecl("transition-delay"),
        transitionDuration: readDecl("transition-duration"),
        maxHeight: maxH,
        visibility: vis,
      });
    }
  }
  hits.sort((x, y) => x.specScore - y.specScore || x.order - y.order);
  return {
    diag: { source: "css-text-fallback", totalMatching: hits.length },
    totalMatching: hits.length,
    withTransition: hits.filter((h) => h.transition).map((h) => ({
      selector: h.selector, spec: h.spec, transition: h.transition,
      transitionDelay: h.transitionDelay, transitionDuration: h.transitionDuration,
      maxHeight: h.maxHeight, visibility: h.visibility,
    })),
    winner: (() => {
      const list = hits.filter((h) => h.transition);
      return list.length ? list[list.length - 1] : null;
    })(),
    maxHeightZeroRules: hits
      .filter((h) => String(h.maxHeight).replace(/\s|!important/g, "") === "0")
      .map((h) => ({ selector: h.selector, spec: h.spec, maxHeight: h.maxHeight })),
  };
}
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-foldtiming-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "fold-timing.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  log("");
  log("[probe] 端口独占检查（跑前）…");
  killStale();
  await sleep(1500);
  const pre = portListeners(PORT);
  if (pre) {
    throw new Error(`端口 ${PORT} 仍被占用（PID=${pre}）—— 先手动清理再跑，否则会连到旧实例测到旧代码`);
  }
  log(`[probe] 端口 ${PORT} 干净`);

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });

  log("[probe] 等待 CDP 端点就绪…");
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        log("[probe] CDP 端点已就绪");
        break;
      }
    } catch {
      /* 还没起来 */
    }
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
          if (rawVal === true) {
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

  const ev = async (body, { awaitPromise = true } = {}) => {
    const r = await cdp.send("Runtime.evaluate", {
      // ⚠️ 用 **async** IIFE 包体：部分取证代码需要 `await`（如 fetch 样式表文本），
      // 同步 IIFE 里出现 await 会变成 SyntaxError: missing ) after argument list
      // —— 报错位置会指向整个表达式，非常难猜（这里踩过一次）。
      expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true,
      awaitPromise,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    }
    return r.result?.result?.value;
  };

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    // ── 1. 打开文档（必须重试直到真的装进编辑器，否则会测到欢迎空文档）──
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
        const pm = document.querySelector(".ProseMirror");
        if (!pm) return false;
        const txt = (pm.textContent || "").replace(/\s+/g, "");
        return txt.indexOf(String(${docProbe}).replace(/\s+/g, "")) >= 0;
      `);
      if (!loaded) log(`  [probe] 文档尚未装入（第 ${attempt + 1} 次重试）…`);
    }
    if (!loaded) {
      throw new Error("文档没能装进编辑器（25 次重试后仍是欢迎空文档）—— 判定会全部失真，中止");
    }
    log("  [probe] 文档已装入编辑器");
    await sleep(900);

    // ── 2. 环境与前置条件 ──
    const env = await ev(`
      const root = __pmRoot();
      const kids = __kids();
      return {
        hasPm: !!root,
        blockCount: kids.length,
        headingCount: kids.filter((k) => __level(k) > 0).length,
        btnCount: document.querySelectorAll(".ProseMirror .lmd-fold-toggle").length,
        hiddenNow: document.querySelectorAll(".ProseMirror .lmd-fold-hidden").length,
        interpolateSize: (typeof CSS !== "undefined" && CSS.supports)
          ? CSS.supports("interpolate-size", "allow-keywords") : null,
        transitionBehavior: (typeof CSS !== "undefined" && CSS.supports)
          ? CSS.supports("transition-behavior", "allow-discrete") : null,
        ua: navigator.userAgent,
      };
    `);
    log("");
    log("════════ 环境 ════════");
    log("  " + JSON.stringify(env, null, 2).replace(/\n/g, "\n  "));
    check("阅读面 .ProseMirror 已就绪且有多个块", !!env?.hasPm && (env?.blockCount ?? 0) > 10,
      `blocks=${env?.blockCount}`);
    check("阅读面存在折叠按钮", (env?.btnCount ?? 0) > 0, `btnCount=${env?.btnCount}`);
    check("初始为全展开（无 .lmd-fold-hidden）", (env?.hiddenNow ?? -1) === 0, `hidden=${env?.hiddenNow}`);
    check("Chromium 支持 interpolate-size: allow-keywords（决定是否走动画分支）",
      env?.interpolateSize === true, `supports=${env?.interpolateSize}`);

    // ── 3. 选目标标题（子内容最厚的 H2）──
    const target = await ev(`return __pickTarget();`);
    log("");
    log("════════ 取证目标 ════════");
    log("  " + JSON.stringify(target));
    check(
      "找到带足量子内容的可折叠标题（隐藏块数 ≥ 2 且总高 ≥ 150px）",
      !!target && (target.hiddenIdxs?.length ?? 0) >= 2 && (target.contentHeight ?? 0) >= 150,
      target
        ? `heading=${JSON.stringify(target.headingText)} hiddenBlocks=${target.hiddenIdxs.length} contentH=${Math.round(target.contentHeight)}px`
        : "未找到",
    );

    // 把目标标题滚进视口（视觉上真实，且让 rect 采样在真实视口里发生）
    await ev(`
      const kids = __kids();
      const el = kids[${target.headingIdx}];
      if (el) el.scrollIntoView({ block: "start" });
      return true;
    `);
    await sleep(400);

    /**
     * 一次 eval 跑完整个采样窗口：点击 → rAF 逐帧记录 → 窗口结束 resolve。
     * 返回 { before, frames, transBefore, transAfter, animsAll }。
     */
    const sample = (direction) =>
      ev(
        `
      const target = ${JSON.stringify({
        headingIdx: target.headingIdx,
        hiddenIdxs: target.hiddenIdxs,
      })};
      const WINDOW = ${WINDOW_MS};
      const kids0 = __kids();
      const headingEl = kids0[target.headingIdx];
      const btn = headingEl ? headingEl.querySelector(".lmd-fold-toggle") : null;
      if (!btn) return Promise.resolve(JSON.stringify({ error: "折叠按钮不存在" }));
      const firstEl = kids0[target.hiddenIdxs[0]] || null;
      const transBefore = __transitionOf(firstEl);
      const before = __frame(target);

      return new Promise((resolve) => {
        const frames = [];
        const t0 = performance.now();
        // 同一帧内点击：状态变更同步生效（controller.toggle → dispatch 空事务）
        btn.click();
        const afterClick = __frame(target);
        const transAfter = __transitionOf(kids0[target.hiddenIdxs[0]] || null);

        const tick = () => {
          const t = performance.now() - t0;
          const f = __frame(target);
          frames.push({ t: Math.round(t * 10) / 10, ...f });
          if (t < WINDOW) requestAnimationFrame(tick);
          else {
            const animsAll = (document.getAnimations ? document.getAnimations() : []).map((a) => {
              const eff = a.effect;
              return {
                prop: a.transitionProperty || null,
                dur: eff && eff.getTiming ? eff.getTiming().duration : null,
                delay: eff && eff.getTiming ? eff.getTiming().delay : null,
                t: a.currentTime,
                state: a.playState,
                targetTag: eff && eff.target ? eff.target.tagName : null,
              };
            });
            resolve(JSON.stringify({
              direction: ${JSON.stringify(direction)},
              before, afterClick, frames, transBefore, transAfter,
              animsAllCount: animsAll.length,
              animsAll: animsAll.slice(0, 40),
            }));
          }
        };
        requestAnimationFrame(tick);
      });
    `,
      );

    const analyze = (raw, label) => {
      const d = JSON.parse(raw);
      if (d.error) throw new Error(`${label}：${d.error}`);
      const frames = d.frames || [];
      if (!frames.length) throw new Error(`${label}：没有任何采样帧`);

      const total0 = d.before.total;
      const totalEnd = frames[frames.length - 1].total;
      const delta = totalEnd - total0;
      const denom = Math.abs(delta);

      /** 走到 |变化量| 的 ratio 所需时间（线性插值） */
      const atRatio = (ratio) => {
        if (!(denom > 0.5)) return null;
        for (let i = 0; i < frames.length; i++) {
          const prog = (frames[i].total - total0) / delta; // 0 → 1
          if (prog >= ratio) {
            if (i === 0) return frames[0].t;
            const prevProg = (frames[i - 1].total - total0) / delta;
            const span = prog - prevProg;
            const frac = span > 1e-9 ? (ratio - prevProg) / span : 0;
            return frames[i - 1].t + frac * (frames[i].t - frames[i - 1].t);
          }
        }
        return null;
      };

      /** visibility 第一次翻转（相对 before）的帧号与时间 */
      const flipFrame = frames.findIndex((f) => f.vis !== d.before.vis);
      /** height 计算值第一次达到终值（±0.5px）的帧 */
      const hEnd = frames[frames.length - 1].h;
      const heightSettledFrame = frames.findIndex(
        (f) => Math.abs(parseFloat(f.h) - parseFloat(hEnd)) <= 0.5,
      );

      return {
        label: d.direction,
        totalBefore: total0,
        totalEnd,
        delta,
        visibilityBefore: d.before.vis,
        visibilityAfter: frames[frames.length - 1].vis,
        visibilityFlipFrame: flipFrame,
        visibilityFlipTime: flipFrame >= 0 ? frames[flipFrame].t : null,
        t50: atRatio(0.5),
        t90: atRatio(0.9),
        heightSettledFrame,
        heightSettledTime: heightSettledFrame >= 0 ? frames[heightSettledFrame].t : null,
        frameCount: frames.length,
        frameSpan: frames[frames.length - 1].t - frames[0].t,
        firstFrames: frames.slice(0, 8).map((f) => ({
          t: f.t,
          total: Math.round(f.total * 10) / 10,
          vis: f.vis,
          h: f.h,
          maxH: f.maxH,
          ov: f.ov,
          animCount: f.animCount,
          anims: f.anims,
        })),
        lastFrames: frames.slice(-3).map((f) => ({
          t: f.t,
          total: Math.round(f.total * 10) / 10,
          vis: f.vis,
          h: f.h,
          maxH: f.maxH,
          ov: f.ov,
        })),
        transBefore: d.transBefore,
        transAfter: d.transAfter,
        animsAllCount: d.animsAllCount,
        animsAll: d.animsAll,
      };
    };

    // ── 4. 折起 ──
    log("");
    log("════════ A. 折起（点击折叠按钮）════════");
    const foldRaw = await sample("fold");
    const fold = analyze(foldRaw, "折起");
    log(`  块总高：${fold.totalBefore.toFixed(1)}px → ${fold.totalEnd.toFixed(1)}px（Δ=${fold.delta.toFixed(1)}px）`);
    log(`  visibility：${fold.visibilityBefore} → ${fold.visibilityAfter}，翻转于第 ${fold.visibilityFlipFrame} 帧 / ${fold.visibilityFlipTime}ms`);
    log(`  50% 时间点 = ${fold.t50 === null ? "n/a" : fold.t50.toFixed(1)}ms   90% 时间点 = ${fold.t90 === null ? "n/a" : fold.t90.toFixed(1)}ms`);
    log(`  height 计算值稳定于第 ${fold.heightSettledFrame} 帧 / ${fold.heightSettledTime}ms`);
    log(`  采样帧数=${fold.frameCount}，时间跨度=${fold.frameSpan.toFixed(1)}ms`);
    log("  前 8 帧：");
    for (const f of fold.firstFrames) {
      log(
        `    t=${String(f.t).padStart(7)}ms  total=${String(f.total).padStart(8)}  vis=${String(f.vis).padEnd(7)}` +
          ` h=${String(f.h).padStart(9)} maxH=${String(f.maxH).padStart(9)} ov=${String(f.ov).padEnd(7)} anims=${f.animCount}` +
          (f.anims && f.anims.length
            ? ` [${f.anims.map((a) => `${a.prop}:${a.dur}ms`).join(", ")}]`
            : ""),
      );
    }
    log("  ★ 折起时**实际生效**的 transition（首个隐藏块）：");
    for (const r of fold.transAfter?.rows ?? []) {
      log(`      ${String(r.prop).padEnd(22)} dur=${String(r.dur).padEnd(8)} delay=${r.delay}`);
    }
    log("  ★ 折起**前**（普通块，用于对照展开方向）的 transition：");
    for (const r of fold.transBefore?.rows ?? []) {
      log(`      ${String(r.prop).padEnd(22)} dur=${String(r.dur).padEnd(8)} delay=${r.delay}`);
    }
    log(`  页面内 getAnimations() 总数（采样结束时）= ${fold.animsAllCount}`);

    // ── A2. 规则审计：把「谁赢」变成运行时证据（不靠读 CSS 推断）──
    log("");
    log("════════ A2. 特异性审计（折起态，首个隐藏块）════════");
    const audit = await ev(`
      const kids = __kids();
      const el = kids[${JSON.stringify(target.hiddenIdxs[0])}] || null;
      const a = __ruleAudit(el);
      if (a && a.totalMatching > 0) return { ...a, mode: "cssom" };
      // CSSOM 读不到（Tauri 自定义协议下 <link> 的 cssRules 抛 SecurityError）→
      // 退化为抓取样式表文本 + 极简解析。fetch 同源的自定义协议资源可用。
      const hrefs = Array.from(document.styleSheets).map((s) => s.href).filter(Boolean);
      let text = "";
      for (const h of hrefs) {
        try { text += "\\n" + await (await fetch(h)).text(); } catch { /* skip */ }
      }
      // 内联 <style> 也并进来（本项目的折叠样式是 bundle 里的 CSS，通常走 <link>）
      for (const st of Array.from(document.querySelectorAll("style"))) text += "\\n" + st.textContent;
      const b = __ruleAuditFromText(el, text);
      return { ...b, mode: "text-fallback", hrefs, cssLen: text.length, cssomDiag: a ? a.diag : null };
    `);
    log(`  审计模式 = ${audit?.mode}（CSSOM 诊断=${JSON.stringify(audit?.cssomDiag ?? audit?.diag ?? null)}）`);
    if (audit?.cssLen) log(`  抓取到的 CSS 文本长度 = ${audit.cssLen} 字节，样式表 href=${JSON.stringify(audit.hrefs)}`);
    log(`  匹配到 ${audit?.totalMatching ?? 0} 条规则，其中 ${audit?.withTransition?.length ?? 0} 条声明了 transition：`);
    for (const r of audit?.withTransition ?? []) {
      log(`    ${r.spec.padEnd(10)} ${r.selector}`);
      log(`      transition = ${r.transition}`);
      if (r.transitionDelay) log(`      transitionDelay = ${r.transitionDelay}`);
      if (r.transitionDuration) log(`      transitionDuration = ${r.transitionDuration}`);
    }
    log("  ★ 级联胜者（实际生效的 transition 声明）：");
    if (audit?.winner) {
      log(`      selector = ${audit.winner.selector}`);
      log(`      spec     = ${audit.winner.spec}`);
      log(`      transition = ${audit.winner.transition}`);
      log(`      delay    = ${audit.winner.transitionDelay}`);
    } else {
      log("      （无）");
    }
    log(`  声明 max-height: 0 的规则：${JSON.stringify(audit?.maxHeightZeroRules ?? [])}`);

    // ★ v0.15.2 行为变更（这条断言原来锁的是「旧行为 = 规则② 赢」）：
    // 修复目标就是让折叠态改由 `.lmd-fold-hidden` 那条规则（③）生效。
    // 所以判据从「winner 命中 :not(.code-block-wrapper)」改成「winner 命中 .lmd-fold-hidden」。
    // 这是**预期内的行为变更**，不是把断言改松求绿 —— 见报告说明。
    const winnerSel = String(audit?.winner?.selector ?? "");
    check(
      "折起态实际生效的 transition 来自 .lmd-fold-hidden 规则③（v0.15.2 修复目标）",
      !!audit?.winner && /\.lmd-fold-hidden/.test(winnerSel),
      audit?.winner ? `winner=${winnerSel} spec=${audit?.winner.spec}` : "无胜者",
    );
    // ★ 同样是行为变更：修复后 ③ 生效，visibility 的 delay 应为 440ms（收完才隐藏），
    // 不再是旧行为的 0s（立刻隐藏）。
    check(
      "胜者规则的 visibility delay = 0.44s（收完才隐藏；旧行为是 0s 立刻隐藏）",
      !!audit?.winner && /visibility\s+0s\s+linear\s+\.?44s|visibility\s+0s\s+linear\s+440ms/.test(
        String(audit?.winner.transition),
      ),
      audit?.winner ? String(audit.winner.transition) : "无",
    );
    // ★ v0.15.2 行为变更：这条原来断言「折起态**有** max-height:0 声明」（那是 H2 的
    // 静态证据，锁的是**旧 bug 行为**）。修复目标恰恰是**删掉**它，所以判据反转成
    // 「折起态**不得**声明 max-height / min-height」—— 与单测 `★ 折叠态不得声明 max-height` 同口径。
    check(
      "折起态**不得**声明 max-height / min-height（v0.15.2 修复目标；不可插值会钳死 height）",
      (audit?.maxHeightZeroRules?.length ?? 0) === 0,
      `声明 max-height:0 的规则数=${audit?.maxHeightZeroRules?.length ?? 0} ${JSON.stringify(audit?.maxHeightZeroRules ?? [])}`,
    );

    // 等待完全稳定，再测展开
    await sleep(1200);

    // ── 5. 展开 ──
    log("");
    log("════════ B. 展开（再点一次同一按钮）════════");
    const expandRaw = await sample("expand");
    const expand = analyze(expandRaw, "展开");
    log(`  块总高：${expand.totalBefore.toFixed(1)}px → ${expand.totalEnd.toFixed(1)}px（Δ=${expand.delta.toFixed(1)}px）`);
    log(`  visibility：${expand.visibilityBefore} → ${expand.visibilityAfter}，翻转于第 ${expand.visibilityFlipFrame} 帧 / ${expand.visibilityFlipTime}ms`);
    log(`  50% 时间点 = ${expand.t50 === null ? "n/a" : expand.t50.toFixed(1)}ms   90% 时间点 = ${expand.t90 === null ? "n/a" : expand.t90.toFixed(1)}ms`);
    log(`  height 计算值稳定于第 ${expand.heightSettledFrame} 帧 / ${expand.heightSettledTime}ms`);
    log(`  采样帧数=${expand.frameCount}，时间跨度=${expand.frameSpan.toFixed(1)}ms`);
    log("  前 8 帧：");
    for (const f of expand.firstFrames) {
      log(
        `    t=${String(f.t).padStart(7)}ms  total=${String(f.total).padStart(8)}  vis=${String(f.vis).padEnd(7)}` +
          ` h=${String(f.h).padStart(9)} maxH=${String(f.maxH).padStart(9)} ov=${String(f.ov).padEnd(7)} anims=${f.animCount}` +
          (f.anims && f.anims.length
            ? ` [${f.anims.map((a) => `${a.prop}:${a.dur}ms`).join(", ")}]`
            : ""),
      );
    }
    log("  ★ 展开时**实际生效**的 transition（同一批块，已无隐藏 class）：");
    for (const r of expand.transAfter?.rows ?? []) {
      log(`      ${String(r.prop).padEnd(22)} dur=${String(r.dur).padEnd(8)} delay=${r.delay}`);
    }

    // ── C. 反事实 A/B：运行时只覆盖折叠态的两条可疑声明（不动源码）──
    //
    // 这是**因果证明**：逐个覆盖，看折起曲线恢复成什么样。
    //   C1：只解除 `max-height: 0 !important`（不在 transition 列表里 → 钳死 height）
    //   C2：只把 `visibility` 的延迟改回 440ms（规则②的 `visibility 0s 0s` 压过规则③）
    //   C3：两条都改（= 修复后的预期形态）
    log("");
    log("════════ C. 反事实 A/B（运行时覆盖，不动源码）════════");

    const installOverride = async (css) => {
      await ev(`
        const old = document.getElementById("__probe_cf");
        if (old) old.remove();
        const st = document.createElement("style");
        st.id = "__probe_cf";
        st.textContent = ${JSON.stringify(css)};
        document.head.appendChild(st);
        return true;
      `);
      await sleep(250);
    };
    const removeOverride = async () => {
      await ev(`
        const old = document.getElementById("__probe_cf");
        if (old) old.remove();
        return true;
      `);
      await sleep(250);
    };
    /** 保证当前是全展开（反事实每次都从展开态起测） */
    const ensureExpanded = async () => {
      await ev(`
        const kids = __kids();
        const el = kids[${JSON.stringify(target.headingIdx)}];
        const btn = el ? el.querySelector(".lmd-fold-toggle") : null;
        if (btn && btn.getAttribute("aria-expanded") === "false") btn.click();
        return btn ? btn.getAttribute("aria-expanded") : null;
      `);
      await sleep(1400);
    };

    // ⚠️ 覆盖选择器的特异性必须**真的**压过规则② (0,5,0)：
    // `.ProseMirror .lmd-fold-hidden.lmd-fold-hidden` 只有 (0,3,0)，仍然输 ——
    // 第一版就踩了这个坑（C2 没生效、曲线与基线一模一样，差点误判"visibility 不是原因"）。
    // 这里用 `.ProseMirror > .lmd-fold-hidden` ×5 个类 = (0,1,0)+(0,5,0) = **(0,6,0)**。
    const CF_SEL =
      ".ProseMirror > .lmd-fold-hidden.lmd-fold-hidden.lmd-fold-hidden.lmd-fold-hidden.lmd-fold-hidden";
    const CF_TRANSITION_OK =
      "transition: height 440ms cubic-bezier(0.2,0,0.2,1), opacity 440ms ease, " +
      "margin-top 440ms cubic-bezier(0.2,0,0.2,1), margin-bottom 440ms cubic-bezier(0.2,0,0.2,1), " +
      "padding-top 440ms cubic-bezier(0.2,0,0.2,1), padding-bottom 440ms cubic-bezier(0.2,0,0.2,1), " +
      "border-top-width 440ms ease, border-bottom-width 440ms ease, " +
      "overflow 0s linear 0s, visibility 0s linear 440ms;";
    /** 旧 bug 的 transition（visibility 立刻翻转） */
    const CF_TRANSITION_BUG =
      "transition: height 440ms cubic-bezier(0.2,0,0.2,1), opacity 440ms ease, " +
      "margin-top 440ms cubic-bezier(0.2,0,0.2,1), margin-bottom 440ms cubic-bezier(0.2,0,0.2,1), " +
      "padding-top 440ms cubic-bezier(0.2,0,0.2,1), padding-bottom 440ms cubic-bezier(0.2,0,0.2,1), " +
      "border-top-width 440ms ease, border-bottom-width 440ms ease, " +
      "overflow 0s linear 0s, visibility 0s linear 0s;";

    // ⚠️ 每条反事实都**自带完整场景**（自己注入 max-height:0 / 自己的 transition），
    // 不依赖产品 CSS 的当前状态。原因：v0.15.2 修好后产品里已经没有 max-height，
    // 若反事实还按"从现网 CSS 出发做增量覆盖"，C1/C2 就没有 bug 可复现、判据失效
    // （复验第二轮踩到：C2 因为产品已无 max-height，反而"高度平滑"，断言误报 FAIL）。
    const CF = [
      {
        key: "C1",
        label: "复现旧 bug：max-height:0 + visibility 立刻翻转（修复前基线）",
        css: `${CF_SEL} { max-height: 0 !important; ${CF_TRANSITION_BUG} }`,
      },
      {
        key: "C2",
        label: "bug 上只修次因：max-height:0 + visibility 延迟 440ms",
        css: `${CF_SEL} { max-height: 0 !important; ${CF_TRANSITION_OK} }`,
      },
      {
        key: "C3",
        label: "bug 上只修主因：不写 max-height + visibility 仍立刻翻转",
        css: `${CF_SEL} { ${CF_TRANSITION_BUG} }`,
      },
      {
        key: "C4",
        label: "错误修法：max-height:0 但**写进 transition**（预期仍被钳死）",
        css: `${CF_SEL} { max-height: 0 !important; ${CF_TRANSITION_OK.replace(
          "transition:",
          "transition: max-height 440ms cubic-bezier(0.2,0,0.2,1),",
        )} }`,
      },
      {
        key: "C5",
        label: "正确修法：不写 max-height + visibility 延迟 440ms（= 现网实现）",
        css: `${CF_SEL} { ${CF_TRANSITION_OK} }`,
      },
    ];

    const cfResults = [];
    for (const c of CF) {
      await ensureExpanded();
      await installOverride(c.css);
      log("");
      log(`  ── ${c.key}：${c.label} ──`);
      // 先证明覆盖**真的生效了**（否则整段反事实都是假阴性 —— C2 第一版就踩过）
      const applied = await ev(`
        const kids = __kids();
        const el = kids[${JSON.stringify(target.hiddenIdxs[0])}] || null;
        const audit = __ruleAudit(el);
        let winner = audit && audit.winner ? audit.winner.selector : null;
        // CSSOM 读不到时退回 computedStyle 判据
        const cs = el ? getComputedStyle(el) : null;
        return {
          winnerSelector: winner,
          maxHeight: cs ? cs.maxHeight : null,
          visDelay: cs ? cs.transitionDelay : null,
          visDuration: cs ? cs.transitionDuration : null,
          visProperty: cs ? cs.transitionProperty : null,
        };
      `);
      log(`    覆盖生效校验：maxHeight=${applied?.maxHeight}  transitionDelay=${applied?.visDelay}`);
      const raw = await sample(`fold-${c.key}`);
      const res = analyze(raw, `折起（${c.key}）`);
      log(`    块总高：${res.totalBefore.toFixed(1)} → ${res.totalEnd.toFixed(1)}px（Δ=${res.delta.toFixed(1)}px）`);
      log(`    visibility：${res.visibilityBefore} → ${res.visibilityAfter}，翻转于第 ${res.visibilityFlipFrame} 帧 / ${res.visibilityFlipTime}ms`);
      log(`    50% = ${res.t50 === null ? "n/a" : res.t50.toFixed(1)}ms   90% = ${res.t90 === null ? "n/a" : res.t90.toFixed(1)}ms` +
        `   height 稳定帧=${res.heightSettledFrame} / ${res.heightSettledTime}ms`);
      log(`    前 6 帧：`);
      for (const f of res.firstFrames.slice(0, 6)) {
        log(`      t=${String(f.t).padStart(7)}ms total=${String(f.total).padStart(8)} vis=${String(f.vis).padEnd(7)}` +
          ` h=${String(f.h).padStart(10)} maxH=${String(f.maxH).padStart(8)}`);
      }
      cfResults.push({ key: c.key, label: c.label, css: c.css, applied, ...res });
      await sleep(300);
    }
    await removeOverride();
    await ensureExpanded();

    const cfFold = cfResults.find((r) => r.key === "C1");
    const cfBoth = cfResults.find((r) => r.key === "C3");
    const cfVis = cfResults.find((r) => r.key === "C2");
    const cfAsIs = cfResults.find((r) => r.key === "C4");
    const cfNoMaxH = cfResults.find((r) => r.key === "C5");

    // ── 反事实判据（每条自带完整场景，互不依赖产品 CSS 当前状态）──
    // C1 = 旧 bug 基线：应当**复现**「height 被钳死」
    check(
      "C1 基线复现：max-height:0 + visibility 立刻翻转 → height 被钳死（第 0 帧到 0）",
      !!cfFold && cfFold.heightSettledFrame <= 1 && (cfFold.t90 ?? 999) < 50,
      cfFold
        ? `height 稳定帧=${cfFold.heightSettledFrame}、t90=${cfFold.t90?.toFixed(1)}ms（bug 复现）`
        : "n/a",
    );
    // C2 = bug 上只修次因：visibility 应推迟，但 height 仍被钳死（证明次因不是主因）
    check(
      "C2 bug 上只修次因：visibility 推迟到 ~440ms，但 height 仍被钳死（次因非主因）",
      !!cfVis && (cfVis.visibilityFlipFrame > 3 || (cfVis.visibilityFlipTime ?? 0) > 300) &&
        (cfVis.heightSettledFrame <= 1 || (cfVis.t90 ?? 999) < 50),
      cfVis
        ? `visibility 翻转=${cfVis.visibilityFlipTime}ms，height 稳定帧=${cfVis.heightSettledFrame}、t90=${cfVis.t90?.toFixed(1)}ms`
        : "n/a",
    );
    // C3 = bug 上只修主因：height 恢复平滑，但 visibility 仍立刻翻转
    check(
      "C3 bug 上只修主因：height 恢复平滑，但 visibility 仍立刻翻转（主因=height 钳死）",
      !!cfBoth && cfBoth.heightSettledFrame > 3 && (cfBoth.t90 ?? 0) > 50 &&
        cfBoth.visibilityFlipFrame >= 0 && cfBoth.visibilityFlipFrame <= 1,
      cfBoth
        ? `height 稳定帧=${cfBoth.heightSettledFrame}、t90=${cfBoth.t90?.toFixed(1)}ms；visibility 翻转=${cfBoth.visibilityFlipTime}ms`
        : "n/a",
    );
    // C4 = 错误修法（把 max-height 写进 transition）：仍被钳死
    check(
      "C4 错误修法（max-height:0 且**写进 transition**）仍被钳死 —— 证明写进 transition 不够",
      !!cfAsIs && cfAsIs.heightSettledFrame <= 1 && (cfAsIs.t90 ?? 999) < 50,
      cfAsIs
        ? `height 稳定帧=${cfAsIs.heightSettledFrame}、t90=${cfAsIs.t90?.toFixed(1)}ms（该修法无效）`
        : "n/a",
    );
    // C5 = 正确修法（不写 max-height + visibility 延迟）：两条都正常
    check(
      "C5 正确修法（不写 max-height + visibility 延迟 440ms）→ height 平滑 + visibility 推迟",
      !!cfNoMaxH && cfNoMaxH.heightSettledFrame > 3 && (cfNoMaxH.t90 ?? 0) > 50 &&
        (cfNoMaxH.visibilityFlipTime ?? 0) > 300,
      cfNoMaxH
        ? `height 稳定帧=${cfNoMaxH.heightSettledFrame}、t90=${cfNoMaxH.t90?.toFixed(1)}ms；visibility 翻转=${cfNoMaxH.visibilityFlipTime}ms`
        : "n/a",
    );

    // ── D. iframe 预览面（编辑模式右侧）──
    //
    // 为什么必须单独测：iframe 面的 CSS 是 `FOLD_IFRAME_CSS` 字符串常量，
    // 它的选择器结构与 PM 面**不同**：
    //   `body > *`          = (0,0,1)   ← 展开方向
    //   `.lmd-fold-hidden`  = (0,1,0)   ← 折叠方向
    // 折叠规则反而**赢**，所以 iframe 面可能本来就是对的（440ms + visibility 延迟 440ms）。
    // 若真是如此，那"折起太快"只在 PM 阅读面复现 —— 这是 Lead 修 CSS 时必须知道的
    // （PM 面改特异性即可，iframe 面不能跟着改，否则反而破坏）。
    log("");
    log("════════ D. iframe 预览面（编辑模式右侧）════════");
    const toEdit = await ev(`
      const fire = (type) => window.dispatchEvent(new KeyboardEvent(type, {
        key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      fire("keydown"); fire("keyup");
      return true;
    `);
    void toEdit;
    await sleep(70);
    await ev(`
      const fire = (type) => window.dispatchEvent(new KeyboardEvent(type, {
        key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      fire("keydown"); fire("keyup");
      return true;
    `);
    await sleep(1600);

    const iframeEnv = await ev(`
      const f = document.querySelector("iframe.split-preview");
      const doc = f ? f.contentDocument : null;
      const body = doc ? doc.body : null;
      const kids = body ? Array.from(body.children) : [];
      const styleEl = doc ? doc.head.querySelector("style[data-lmd-fold-style]") : null;
      return {
        hasIframe: !!f,
        iframeVisible: f ? f.offsetHeight > 0 : false,
        hasBody: !!body,
        childCount: kids.length,
        btnCount: body ? body.querySelectorAll(".lmd-fold-toggle").length : 0,
        hiddenNow: body ? body.querySelectorAll(".lmd-fold-hidden").length : 0,
        styleLen: styleEl ? (styleEl.textContent || "").length : 0,
      };
    `);
    log("  " + JSON.stringify(iframeEnv));
    check(
      "iframe 预览面已就绪（可见 + body 有子元素 + 有折叠按钮）",
      !!iframeEnv?.hasIframe && !!iframeEnv?.iframeVisible && (iframeEnv?.btnCount ?? 0) > 0,
      `visible=${iframeEnv?.iframeVisible} children=${iframeEnv?.childCount} btns=${iframeEnv?.btnCount}`,
    );

    if (iframeEnv?.btnCount > 0) {
      // iframe 面的一次性采样（同一 eval 内跑完，逻辑与 PM 面一致）
      //
      // ⚠️ `fixedHeadingIdx`：**必须由调用方指定目标标题**。
      // 若每次重新按「子内容最厚」挑目标，折叠后所有块高度都变 0 → 挑选退化为
      // "第一个合格标题"，展开那次就可能点到**别的**标题上（第一版实测把展开采成了
      // 又一次折叠，输出 345.5 → 0，数字自相矛盾）。折叠/展开必须钉死同一个标题。
      const iframeSample = (label, fixedHeadingIdx) =>
        ev(`
        const f = document.querySelector("iframe.split-preview");
        const doc = f ? f.contentDocument : null;
        const body = doc ? doc.body : null;
        if (!body) return Promise.resolve(JSON.stringify({ error: "iframe body 不可用" }));
        const kids = Array.from(body.children);
        const lvl = (el) => { const m = /^H([1-6])$/i.exec(el.tagName || ""); return m ? Number(m[1]) : 0; };
        const hiddenIdxsFor = (i) => {
          const l = lvl(kids[i]);
          const out = [];
          for (let k = i + 1; k < kids.length; k++) {
            const l2 = lvl(kids[k]);
            if (l2 > 0 && l2 <= l) break;
            out.push(k);
          }
          return out;
        };
        const FIXED = ${fixedHeadingIdx === undefined ? "null" : JSON.stringify(fixedHeadingIdx)};
        let headingIdx = FIXED;
        if (headingIdx === null) {
          let best = null;
          for (let i = 0; i < kids.length; i++) {
            const l = lvl(kids[i]);
            if (l < 2 || l > 3) continue;
            if (!kids[i].classList.contains("lmd-fold-heading")) continue;
            if (!kids[i].querySelector(".lmd-fold-toggle")) continue;
            const idxs = hiddenIdxsFor(i);
            if (!idxs.length) continue;
            let h = 0;
            for (const k of idxs) h += kids[k].getBoundingClientRect().height;
            if (!best || h > best.h) best = { headingIdx: i, h };
          }
          if (!best) return Promise.resolve(JSON.stringify({ error: "iframe 面找不到可折叠标题" }));
          headingIdx = best.headingIdx;
        }
        const hiddenIdxs = hiddenIdxsFor(headingIdx);
        const headingEl = kids[headingIdx];
        const btn = headingEl ? headingEl.querySelector(".lmd-fold-toggle") : null;
        if (!btn) return Promise.resolve(JSON.stringify({ error: "iframe 目标标题没有折叠按钮" }));
        const cur = () => Array.from(body.children);
        const sum = () => {
          let t = 0;
          for (const k of hiddenIdxs) {
            const el = cur()[k];
            if (el) t += el.getBoundingClientRect().height;
          }
          return t;
        };
        const frame = () => {
          const el = cur()[hiddenIdxs[0]] || null;
          const cs = el ? doc.defaultView.getComputedStyle(el) : null;
          return { total: sum(), vis: cs ? cs.visibility : null, h: cs ? cs.height : null, maxH: cs ? cs.maxHeight : null };
        };
        const transOf = (el) => {
          if (!el) return null;
          const cs = doc.defaultView.getComputedStyle(el);
          const split = (s) => String(s || "").split(",").map((x) => x.trim());
          const props = split(cs.transitionProperty);
          const durs = split(cs.transitionDuration);
          const delays = split(cs.transitionDelay);
          return props.map((p, i) => ({ prop: p, dur: durs[i] ?? "", delay: delays[i] ?? "" }));
        };
        const transBefore = transOf(cur()[hiddenIdxs[0]] || null);
        const before = frame();
        const ariaBefore = btn.getAttribute("aria-expanded");
        return new Promise((resolve) => {
          const frames = [];
          const t0 = performance.now();
          btn.click();
          const transAfter = transOf(cur()[hiddenIdxs[0]] || null);
          const tick = () => {
            const t = performance.now() - t0;
            frames.push({ t: Math.round(t * 10) / 10, ...frame() });
            if (t < ${WINDOW_MS}) requestAnimationFrame(tick);
            else resolve(JSON.stringify({
              direction: ${JSON.stringify(label)}, headingIdx, hiddenIdxs, before, frames,
              transBefore, transAfter, ariaBefore,
              headingText: (headingEl.textContent || "").trim().slice(0, 30),
            }));
          };
          requestAnimationFrame(tick);
        });
      `);

      const iframeFoldRawStr = await iframeSample("iframe-fold");
      const iframeFoldParsed = JSON.parse(iframeFoldRawStr);
      if (iframeFoldParsed.error) throw new Error(`iframe 折起采样失败：${iframeFoldParsed.error}`);
      const iframeHeadingIdx = iframeFoldParsed.headingIdx;
      log(`  目标标题 = ${JSON.stringify(iframeFoldParsed.headingText)}（body 子元素下标 ${iframeHeadingIdx}，隐藏块 ${iframeFoldParsed.hiddenIdxs.length} 个）`);
      const iframeFold = analyze(iframeFoldRawStr, "iframe 折起");
      log(`  块总高：${iframeFold.totalBefore.toFixed(1)} → ${iframeFold.totalEnd.toFixed(1)}px（Δ=${iframeFold.delta.toFixed(1)}px）`);
      log(`  visibility：${iframeFold.visibilityBefore} → ${iframeFold.visibilityAfter}，翻转于第 ${iframeFold.visibilityFlipFrame} 帧 / ${iframeFold.visibilityFlipTime}ms`);
      log(`  50% = ${iframeFold.t50 === null ? "n/a" : iframeFold.t50.toFixed(1)}ms   90% = ${iframeFold.t90 === null ? "n/a" : iframeFold.t90.toFixed(1)}ms` +
        `   height 稳定帧=${iframeFold.heightSettledFrame} / ${iframeFold.heightSettledTime}ms`);
      log("  ★ iframe 面折起时实际生效的 transition：");
      for (const r of iframeFold.transAfter ?? []) {
        log(`      ${String(r.prop).padEnd(22)} dur=${String(r.dur).padEnd(8)} delay=${r.delay}`);
      }
      log("  前 6 帧：");
      for (const f of iframeFold.firstFrames.slice(0, 6)) {
        log(`      t=${String(f.t).padStart(7)}ms total=${String(f.total).padStart(8)} vis=${String(f.vis).padEnd(7)}` +
          ` h=${String(f.h).padStart(10)} maxH=${String(f.maxH).padStart(8)}`);
      }

      await sleep(1200);
      // 展开：钉死同一个标题（否则会点到别的标题上）
      const iframeExpandRaw = await iframeSample("iframe-expand", iframeHeadingIdx);
      const iframeExpand = analyze(iframeExpandRaw, "iframe 展开");
      log(`  展开：块总高 ${iframeExpand.totalBefore.toFixed(1)} → ${iframeExpand.totalEnd.toFixed(1)}px（Δ=${iframeExpand.delta.toFixed(1)}px）`);
      log(`  展开 50% = ${iframeExpand.t50 === null ? "n/a" : iframeExpand.t50.toFixed(1)}ms   90% = ${iframeExpand.t90 === null ? "n/a" : iframeExpand.t90.toFixed(1)}ms`);

      const iframeBroken = iframeFold.heightSettledFrame <= 1 || (iframeFold.t90 ?? 999) < 50;

      // iframe 面的反事实：只解除 max-height:0（iframe 面的 visibility 延迟本来就是对的）
      let iframeCF = null;
      if (iframeBroken) {
        log("");
        log("  ── iframe 反事实：只解除 max-height:0 ──");
        // 先把目标标题展开回初始态
        await ev(`
          const f = document.querySelector("iframe.split-preview");
          const doc = f ? f.contentDocument : null;
          const body = doc ? doc.body : null;
          if (!body) return true;
          const kids = Array.from(body.children);
          const el = kids[${JSON.stringify(iframeFoldParsed.headingIdx)}];
          const btn = el ? el.querySelector(".lmd-fold-toggle") : null;
          if (btn && btn.getAttribute("aria-expanded") === "false") btn.click();
          return true;
        `);
        await sleep(1300);
        // 注入覆盖：iframe 是独立文档，覆盖样式必须注入**它自己的** head。
        // `.lmd-fold-hidden` = (0,1,0)，这里用同名类重复 3 次 → (0,3,0) 稳稳压过。
        await ev(`
          const f = document.querySelector("iframe.split-preview");
          const doc = f ? f.contentDocument : null;
          if (!doc || !doc.head) return false;
          const old = doc.getElementById("__probe_cf_iframe");
          if (old) old.remove();
          const st = doc.createElement("style");
          st.id = "__probe_cf_iframe";
          st.textContent = ".lmd-fold-hidden.lmd-fold-hidden.lmd-fold-hidden { max-height: none !important; }";
          doc.head.appendChild(st);
          return true;
        `);
        await sleep(300);
        const iframeCFRaw = await iframeSample("iframe-fold-cf", iframeHeadingIdx);
        iframeCF = analyze(iframeCFRaw, "iframe 折起（反事实）");
        log(`    块总高：${iframeCF.totalBefore.toFixed(1)} → ${iframeCF.totalEnd.toFixed(1)}px（Δ=${iframeCF.delta.toFixed(1)}px）`);
        log(`    50% = ${iframeCF.t50 === null ? "n/a" : iframeCF.t50.toFixed(1)}ms   90% = ${iframeCF.t90 === null ? "n/a" : iframeCF.t90.toFixed(1)}ms` +
          `   height 稳定帧=${iframeCF.heightSettledFrame} / ${iframeCF.heightSettledTime}ms`);
        log("    前 6 帧：");
        for (const f of iframeCF.firstFrames.slice(0, 6)) {
          log(`      t=${String(f.t).padStart(7)}ms total=${String(f.total).padStart(8)} vis=${String(f.vis).padEnd(7)}` +
            ` h=${String(f.h).padStart(10)} maxH=${String(f.maxH).padStart(8)}`);
        }
        check(
          "iframe 反事实：仅解除 max-height:0 → 折起恢复多帧平滑下降（证明两个面同因）",
          iframeCF.heightSettledFrame > 3 && (iframeCF.t90 ?? 0) > 50,
          `height 稳定帧=${iframeCF.heightSettledFrame}（原 ${iframeFold.heightSettledFrame}），t90=${iframeCF.t90?.toFixed(1)}ms（原 ${iframeFold.t90?.toFixed(1)}ms）`,
        );
        // 清掉覆盖 + 恢复展开
        await ev(`
          const f = document.querySelector("iframe.split-preview");
          const doc = f ? f.contentDocument : null;
          if (doc && doc.head) {
            const old = doc.getElementById("__probe_cf_iframe");
            if (old) old.remove();
          }
          const body = doc ? doc.body : null;
          if (body) {
            const kids = Array.from(body.children);
            const el = kids[${JSON.stringify(iframeFoldParsed.headingIdx)}];
            const btn = el ? el.querySelector(".lmd-fold-toggle") : null;
            if (btn && btn.getAttribute("aria-expanded") === "false") btn.click();
          }
          return true;
        `);
        await sleep(1300);
      }

      log("");
      log(
        `★ iframe 面判定：${iframeBroken
          ? "同样被 max-height 钳死（height 立即到 0）—— 两个面都坏；但 iframe 的 visibility 延迟是对的（0.44s），所以 PM 面还要额外修特异性"
          : `折起走满 ${iframeFold.t90?.toFixed(0)}ms（与展开 ${iframeExpand.t90?.toFixed(0)}ms 同量级）→ iframe 面本来就是对的，问题只在 PM 阅读面`}`,
      );
      check(
        "iframe 面折起曲线取证有效（真的测到了高度下降）",
        iframeFold.delta < -150,
        `Δ=${iframeFold.delta.toFixed(1)}px`,
      );
      // 这条不是"必须 PASS"的验收项，而是**事实记录**：无论好坏都要写进报告，
      // 让 Lead 知道该改哪个面。用 check 记录以便报告里一眼看到。
      check(
        `iframe 面折起时长 ${iframeBroken ? "异常（被钳死）" : "正常"}（供 Lead 判断是否要一起改）`,
        true,
        iframeBroken
          ? `height 稳定帧=${iframeFold.heightSettledFrame}、t90=${iframeFold.t90?.toFixed(1)}ms`
          : `t90=${iframeFold.t90?.toFixed(1)}ms vs 展开 ${iframeExpand.t90?.toFixed(1)}ms`,
      );
      cfResults.push({ key: "iframe", iframeFold, iframeExpand, iframeBroken, iframeCounterfactual: iframeCF });

      // 切回阅读模式（不影响后续，只是让收尾状态干净）
      await ev(`
        const fire = (type) => window.dispatchEvent(new KeyboardEvent(type, {
          key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
        fire("keydown"); fire("keyup");
        return true;
      `);
      await sleep(70);
      await ev(`
        const fire = (type) => window.dispatchEvent(new KeyboardEvent(type, {
          key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
        fire("keydown"); fire("keyup");
        return true;
      `);
      await sleep(1200);
    }

    // ── 6. 判定 ──
    log("");
    log("════════ 判定 ════════");
    check(
      "折起曲线有效（块总高真的下降了 ≥ 150px，不是空数据）",
      fold.delta < -150,
      `Δ=${fold.delta.toFixed(1)}px（${fold.totalBefore.toFixed(0)} → ${fold.totalEnd.toFixed(0)}）`,
    );
    check(
      "展开曲线有效（块总高真的回升 ≥ 150px）",
      expand.delta > 150,
      `Δ=${expand.delta.toFixed(1)}px（${expand.totalBefore.toFixed(0)} → ${expand.totalEnd.toFixed(0)}）`,
    );
    check(
      "折起与展开的终态互逆（折叠后 ≈ 0，展开后 ≈ 起始）",
      Math.abs(fold.totalEnd) <= 2 && Math.abs(expand.totalEnd - fold.totalBefore) <= 8,
      `foldEnd=${fold.totalEnd.toFixed(1)} expandEnd=${expand.totalEnd.toFixed(1)} 起始=${fold.totalBefore.toFixed(1)}`,
    );

    // 假设 H1：visibility 在折起时是否立刻翻转
    const visFlipFast = fold.visibilityFlipFrame >= 0 && fold.visibilityFlipFrame <= 1;
    // 假设 H2：height 是否在 0~1 帧就掉到终值（max-height 钳位）
    const heightClampedFast =
      fold.heightSettledFrame >= 0 && fold.heightSettledFrame <= 1;
    // 假设 H3：折起与展开的 height 曲线时长是否明显不同
    const curveRatio =
      fold.t90 != null && expand.t90 != null && expand.t90 > 0 ? fold.t90 / expand.t90 : null;

    log(`  visibility 折起翻转帧=${fold.visibilityFlipFrame}（≤1 帧 = 立刻隐藏）`);
    log(`  height 折起稳定帧=${fold.heightSettledFrame}（≤1 帧 = 被 max-height 钳死）`);
    log(`  t90 折起=${fold.t90?.toFixed(1)}ms / 展开=${expand.t90?.toFixed(1)}ms` +
      `（比值=${curveRatio === null ? "n/a" : curveRatio.toFixed(2)}）`);

    // ★ 这两条原来是「H1/H2 被证实」的断言（锁旧 bug 行为）。
    // v0.15.2 修复后它们**应该不再成立**（visibility 推迟到 440ms、height 不再第 0 帧钳死）。
    // 所以改成「记录当前事实」而不是断言旧行为 —— 判定目标见下方「修复目标」两条。
    log("");
    log("  ── 假设复核（修复前这两条成立；修复后应不再成立）──");
    log(`    H1（折起 visibility 立刻翻转）：${visFlipFast ? "仍成立（未修好）" : "已不成立（visibility 推迟）"}` +
      `，实测翻转于 ${fold.visibilityFlipTime}ms`);
    log(`    H2（折起 height 被 max-height 钳死）：${heightClampedFast ? "仍成立（未修好）" : "已不成立（height 有过渡）"}` +
      `，实测稳定于 ${fold.heightSettledTime}ms`);

    // ★ 修复目标的断言（v0.15.2 的验收口径）：
    check(
      "修复目标①：折起 visibility 推迟到 ≥300ms 才隐藏（不再第 0 帧瞬间消失）",
      fold.visibilityFlipFrame > 3 || (fold.visibilityFlipTime ?? 0) >= 300,
      `翻转于第 ${fold.visibilityFlipFrame} 帧 / ${fold.visibilityFlipTime}ms`,
    );
    check(
      "修复目标②：折起 height 走满过渡（稳定帧 > 3 且 t90 > 50ms）",
      fold.heightSettledFrame > 3 && (fold.t90 ?? 0) > 50,
      `稳定帧=${fold.heightSettledFrame} / ${fold.heightSettledTime}ms，t90=${fold.t90?.toFixed(1)}ms`,
    );
    check(
      "修复目标③：折起 t90 与展开 t90 同量级（比值在 0.5~2 之间，不再 0.01）",
      curveRatio !== null && curveRatio >= 0.5 && curveRatio <= 2,
      `折起 t90=${fold.t90?.toFixed(1)}ms / 展开 t90=${expand.t90?.toFixed(1)}ms = ${curveRatio?.toFixed(2)}`,
    );

    // 根因一句话（三选一，按实测优先级）
    const cfEvidence = cfFold && cfBoth
      ? ` 反事实 A/B 已证实因果：C1 只解除 \`max-height:0\` → 折起 height 稳定帧 ${fold.heightSettledFrame}→${cfFold.heightSettledFrame}、` +
        `t90 ${fold.t90?.toFixed(0)}ms→${cfFold.t90?.toFixed(0)}ms；C3 两条都改 → 折起 t90=${cfBoth.t90?.toFixed(0)}ms、` +
        `展开 t90=${expand.t90?.toFixed(0)}ms（同量级）。`
      : "";
    // v0.15.2 追加：C4（现网做法：max-height:0 且写进 transition）与 C5（不写 max-height）
    const cfEvidence2 = cfAsIs && cfNoMaxH
      ? ` ★ v0.15.2 追加：C4 复现「max-height:0 且写进 transition」→ 折起 height 稳定帧 ${cfAsIs.heightSettledFrame}、` +
        `t90=${cfAsIs.t90?.toFixed(1)}ms（仍被钳死，证明**光写进 transition 不够**：` +
        `\`none → 0\` 不可插值，浏览器把 max-height 当离散属性第一帧就生效，而它是 height 的上限）；` +
        `C5「折叠态完全不写 max-height」→ 稳定帧 ${cfNoMaxH.heightSettledFrame}、t90=${cfNoMaxH.t90?.toFixed(1)}ms（恢复平滑）。`
      : "";
    let rootCause;
    const allGood =
      !heightClampedFast && !visFlipFast &&
      curveRatio !== null && curveRatio >= 0.5 && curveRatio <= 2;
    if (allGood) {
      // 修复后的正常态：两面都平滑、visibility 推迟、折起/展开同量级。
      // ⚠️ 这里**不能**再落到下面的 H3 分支：H3 的文案是"曲线时长本身不同（异常）"，
      // 在比值 ≈1 时会把正常态描述成故障（复验第二轮踩到，报告文案误导）。
      rootCause =
        `已修复（无异常）：折起 t90=${fold.t90?.toFixed(0)}ms ≈ 展开 t90=${expand.t90?.toFixed(0)}ms` +
        `（比值 ${curveRatio?.toFixed(2)}），折起 height 走满 ${fold.heightSettledTime?.toFixed(0)}ms；` +
        `visibility 推迟到 ${fold.visibilityFlipTime}ms 才隐藏（收完才消失）；` +
        `折起态由 \`.lmd-fold-hidden\` 规则生效，且**未声明 max-height / min-height**。` +
        `历史根因（已修）：折叠态的 \`max-height: 0\` 不可插值 → 把 height 过渡第一帧钳死；` +
        `把 max-height 写进 transition 也无效（C4），必须彻底不写（C5）。`;
    } else if (heightClampedFast) {
      rootCause =
        `H2 仍成立：折起时 height 在 ${fold.heightSettledTime}ms 内就掉到 0（第 ${fold.heightSettledFrame} 帧）—— ` +
        `折叠态的 \`max-height: 0\` 仍然把 height 过渡钳死。` +
        `**即使它已被写进 transition 列表也不管用**（C4 已复现）：\`none → 0\` 不可插值 → 离散属性第一帧生效。` +
        `正确修法是折叠态**不要写 max-height**（C5 已验证恢复 440ms 曲线）。` +
        cfEvidence +
        cfEvidence2 +
        (visFlipFast
          ? ` visibility 也仍在 ${fold.visibilityFlipTime}ms 立刻隐藏（次因未修好）。`
          : ` visibility 已推迟到 ${fold.visibilityFlipTime}ms（次因已修好）。`);
    } else if (visFlipFast) {
      rootCause =
        `H1 成立：折起时 visibility 在第 ${fold.visibilityFlipFrame} 帧（${fold.visibilityFlipTime}ms）立刻变 hidden，` +
        `内容瞬间消失、只剩空白在收；而 height 曲线本身走到 90% 用了 ${fold.t90?.toFixed(0)}ms。` +
        `这正是规则②（特异性更高）的 \`visibility 0s linear 0s\` 压过规则③的 \`visibility 0s linear 440ms\`。`;
    } else {
      rootCause =
        `H3 成立（异常）：折起与展开的 height 曲线时长明显不同（t90 ${fold.t90?.toFixed(0)}ms vs ${expand.t90?.toFixed(0)}ms，` +
        `比值 ${curveRatio?.toFixed(2)}，不在 0.5~2 区间），不是 visibility/max-height 的瞬时翻转问题。`;
    }
    log("");
    log("★ 根因结论：" + rootCause);

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);

    fs.writeFileSync(OUT_TXT, logLines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify(
        {
          env,
          target,
          fold,
          expand,
          counterfactuals: cfResults,
          ruleAudit: audit,
          hypotheses: { visFlipFast, heightClampedFast, curveRatio },
          rootCause,
          checks,
        },
        null,
        2,
      ),
      "utf-8",
    );
    log(`报告已写入：${OUT_TXT}`);
    log(`原始曲线：${OUT_JSON}`);
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
    await sleep(600);
    killStale();
    await sleep(600);
    const post = portListeners(PORT);
    log("");
    log(`[probe] 端口 ${PORT} 收尾检查：${post ? `仍被占用 PID=${post}` : "已释放"}`);
  }
};

main().catch((e) => {
  console.error("探针失败：", e);
  process.exitCode = 2;
});

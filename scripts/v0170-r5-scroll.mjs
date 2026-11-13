/**
 * v0.17.0 第五轮 · V1 `fix-scroll-r4` · **实机验证**：滚动 / 模式切换 / 进度 11 项
 *
 * 用户要求：「重新进行一遍实机验证，验证 0.17.0 版本迁移 CM6 以来所解决的问题是否都真实修复。」
 *
 * ## 这一轮和第四轮的根本区别
 *
 * R4 我在**浏览器 Chromium** 里测，判"通过"；用户在**真机 WebView2** 里复现。
 * 所以本轮全部在 **Tauri exe + WebView2** 上跑（`scripts/_lib/probe-harness.mjs`）。
 *
 * ## 为什么把 R4 的测量逻辑搬进来，而不是重用浏览器探针
 *
 * 1. 本轮**禁止改源码**（验证轮）→ 无法为浏览器重新构建 dist；而 exe 内联的是
 *    `dist/index.html` 的入口 hash，骨架会校验一致性。直接跑 exe 才是被测对象本体。
 * 2. 更要紧的是：**要能回答"浏览器 vs 真机差在哪"**。
 *    所以每一项我都同时记录**同一个量**在真机上的数字，并与 R4 浏览器记录的数字并列写进报告。
 * 3. R4 的 `v0170-r4-scroll-lib.mjs` 是**浏览器侧**的（用 `ui.cdp` 的
 *    `Input.dispatchMouseEvent` 等）；本骨架的 `ui` 是**真机 CDP**（能力几乎同构，
 *    但 `ui.wheel` 不存在）。所以这里是**移植核心测量逻辑**，而不是 import。
 *
 * ## 判据为什么这么定（每项都写理由，这是用户要的"是否真实修复"）
 *
 * 通用口径（与 R4 一致，这样两项可直接横向比较）：
 * | 量 | 阈值 | 为什么代表用户感受 |
 * |---|---|---|
 * | `不可解释跳变` = `\|ΔscrollTop\| - \|ΔscrollHeight\|` | ≤3px | 排除"内容变高→视口跟着补偿"的**正确**行为；剩下的才是真的跳 |
 * | `反拉`（方向反转，分段算） | 0 | 单调移动叫"滚动"，来回摆才叫"抖" |
 * | `scrollTop` 写入次数 | 关键项要 0 | **写一次就产生一次可见位移**，哪怕随后拉回 |
 * | `scrollHeight` 塌陷 | 不能出现 | **整篇替换的指纹**（R4 实证：塌 1595px ⇒ 必然硬跳） |
 *
 * ## 11 项清单（与任务卡一一对应）
 * V1-1  R2#3  撤销/恢复位置跳动
 * V1-2  R2#6  点格式栏/语法栏跳底部（**R4 又修了语法栏，重点**）
 * V1-3  R2#8  反复切模式进度变化
 * V1-4  R2#9  阅读/编辑文档未对齐
 * V1-5  R2#10 关软件重开不保持模式+进度
 * V1-6  R2#11 切模式过渡效果（380ms 滑入/滑回）
 * V1-7  R2#12 预览开合宽度抖动
 * V1-8  R3#4  插入格式后退格抖动
 * V1-9  R3#12 预览开合抖动（逐帧）
 * V1-10 R4#1  语法栏插入瞬间下跳（**核心：scrollHeight 不塌**）
 * V1-11 R4#3  阅读面 Ctrl+T → Ctrl+Z（**核心：撤销期写入 0 次**）
 *
 * ⚠️ V1-5（关软件重开）需要**两个 runProbe 共用同一 profile**，无法在单个 `body` 内完成。
 *    本文件用 `phase` 参数分两次跑（见文件末尾的调度逻辑）。
 */

import { runProbe, makeProfileDir, grade } from "./_lib/probe-harness.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 一、测试文档
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 60 段正文 + 每 10 段一组有序列表。
 * 为什么需要有序列表：V1-11（R4#3）的场景是「在有序列表上加待办」，
 * 必须有 `ol > li` 可点，否则该场景只能标 INVALID。
 */
function makeDoc(paras = 60) {
  const parts = ["# 实机滚动验证", ""];
  for (let i = 1; i <= paras; i++) {
    parts.push(
      `PI${String(i).padStart(2, "0")} 第 ${i} 段。Lorem ipsum dolor sit amet ` +
        `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`,
      "",
    );
    if (i % 10 === 0) {
      parts.push(
        `1. 甲项 PI${String(i).padStart(2, "0")}A`,
        `2. 乙项 PI${String(i).padStart(2, "0")}B`,
        `3. 丙项 PI${String(i).padStart(2, "0")}C`,
        "",
      );
    }
  }
  return parts.join("\n");
}

const DOC = makeDoc(60);
const DOC_TITLE = "第 1 段";

/* ══════════════════════════════════════════════════════════════════════════
 * 二、页面内仪器（字符串注入，全部来自 R4 的实证版本）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 滚动写入打桩：记录**谁**写了 scrollTop。
 *
 * ⚠️ R4 T3 的血泪：**hook `scrollTo` 会制造伪影**（它内部会再走一次 setter → 双记）。
 * 所以本版本：
 * - 只 hook **裸 `scrollTop` setter**（唯一真实写入点）；
 * - `scrollTo`/`scrollBy` 单独标记为 `how`，但**不再转发记录**（避免双记）——
 *   改为只记"调用发生"这一事实，值与 setter 那条对齐。
 *
 * 另外 `scrollIntoView` 单独记录（CM6 的 `tr.scrollIntoView()` 走这条，
 * 不经 scrollTop setter，漏了它就会得出"零写入"的错误结论 —— R3 踩过）。
 */
export const INSTALL_SPY = `
  if (!window.__R5_SPY) {
    window.__R5_SPY = true;
    window.__R5_W = [];
    const interesting = (el) => {
      const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
      return String(cls).includes("cm-scroller")
        || String(cls).includes("editor-container")
        || String(cls).includes("split-preview")
        || String(cls).includes("ProseMirror");
    };
    const nameOf = (el) => {
      const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
      return String(cls).slice(0, 44);
    };
    const push = (o) => { try { window.__R5_W.push(Object.assign({ t: Math.round(performance.now()) }, o)); } catch (e) {} };
    const stackOf = (n) => (new Error().stack || "").split("\\n").slice(2, 2 + (n || 5))
      .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 110));

    // ① 裸 scrollTop setter —— 唯一真实写入通道
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true, enumerable: proto.enumerable,
      get() { return proto.get.call(this); },
      set(v) {
        try {
          if (interesting(this)) push({ how: "scrollTop=", v: Math.round(v), from: Math.round(proto.get.call(this)), cls: nameOf(this), s: stackOf(6) });
        } catch (e) {}
        return proto.set.call(this, v);
      },
    });

    // ② scrollIntoView —— CM6 的 tr.scrollIntoView() 走这条（不经 setter）
    const siv = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg) {
      try {
        if (interesting(this)) push({ how: "scrollIntoView", v: -1, from: -1, cls: nameOf(this), arg: JSON.stringify(arg || null), s: stackOf(6) });
      } catch (e) {}
      return siv.apply(this, arguments);
    };

    // ③ scrollTo/scrollBy —— **只记调用事实**，值由 ① 的 setter 记（避免双记伪影）
    for (const m of ["scrollTo", "scrollBy"]) {
      const orig = Element.prototype[m];
      if (!orig) continue;
      Element.prototype[m] = function () {
        try {
          if (interesting(this)) push({ how: m + "()", v: -2, from: -2, cls: nameOf(this), s: stackOf(5) });
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    }
  }
  return true;
`;

/**
 * 逐帧采样：滚动位置 + 视口中心锚（编辑面用 `.cm-line`，阅读面用 PM 块）+ 光标 Y。
 *
 * `kind`：
 * - `"cm"`：源码面（`.cm-scroller`）
 * - `"pm"`：阅读面（`.editor-container`，滚动在容器上，`.ProseMirror` 本身 overflow:visible）
 *
 * ⚠️ 采样**不读 `scrollHeight` 以外的布局属性**（除了锚块 rect），
 * 因为每帧读多个 rect 会让 WebView2 的采样本身产生抖动（R3 教训）。
 */
export const startTrace = (opts) => {
  const ms = opts.ms ?? 2600;
  const kind = JSON.stringify(opts.kind ?? "cm");
  const anchorPi = JSON.stringify(opts.anchorPi ?? null);
  const scrollerSel = kind === JSON.stringify("pm") ? ".editor-container" : ".cm-scroller";
  return `
  window.__R5_TR = [];
  window.__R5_T0 = performance.now();
  (function () {
    const T0 = performance.now();
    const KIND = ${kind};
    const AP = ${anchorPi};
    const SEL = ${JSON.stringify(scrollerSel)};
    const BLOCK = KIND === "cm" ? ".cm-line" : "p, h1, h2, h3, h4, h5, h6, li, pre, blockquote";
    const tick = () => {
      const rec = { t: Math.round(performance.now() - T0) };
      const sc = document.querySelector(SEL);
      if (sc) {
        const scR = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        rec.ch = Math.round(sc.clientHeight);
        const midY = scR.top + sc.clientHeight / 2;
        let best = null, bestD = Infinity;
        for (const el of sc.querySelectorAll(BLOCK)) {
          const txt = el.textContent || "";
          if (!/PI\\d{2}/.test(txt)) continue;
          if (AP && txt.indexOf(AP) < 0) continue;
          const r = el.getBoundingClientRect();
          const d = Math.abs((r.top + r.bottom) / 2 - midY);
          if (d < bestD) { bestD = d; best = el; }
        }
        if (best) {
          const m = /PI(\\d{2})/.exec(best.textContent || "");
          rec.pi = m ? Number(m[1]) : null;
          rec.piTop = Math.round((best.getBoundingClientRect().top - scR.top) * 100) / 100;
        }
        if (KIND === "cm") {
          const cur = sc.querySelector(".cm-cursor");
          if (cur) rec.caretY = Math.round((cur.getBoundingClientRect().top - scR.top) * 100) / 100;
        } else {
          try {
            const s = window.getSelection();
            if (s && s.rangeCount) rec.caretY = Math.round((s.getRangeAt(0).getBoundingClientRect().top - scR.top) * 100) / 100;
          } catch (e) {}
        }
      }
      window.__R5_TR.push(rec);
      if (performance.now() - T0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;
};

/**
 * 读稳态量（含**权威文本来源**）。
 *
 * ⚠️ CM6 虚拟化：`.cm-line` 只有视口内的在 DOM 里 —— 必须走内部 view 读全文。
 *    这个坑在 R2 造成过"一次 Ctrl+Z 撤掉整篇"的假警报（8641→1880 实际 8641→8641）。
 */
export const readState = (opts) => {
  const kind = JSON.stringify(opts.kind ?? "cm");
  const scrollerSel = kind === JSON.stringify("pm") ? ".editor-container" : ".cm-scroller";
  return `
  const round = (n) => Math.round(n * 100) / 100;
  const sc = document.querySelector(${JSON.stringify(scrollerSel)});
  if (!sc) return { ok: false, why: "no-scroller" };
  const scR = sc.getBoundingClientRect();
  const midY = scR.top + sc.clientHeight / 2;
  const BLOCK = ${kind} === "cm" ? ".cm-line" : "p, h1, h2, h3, h4, h5, h6, li, pre, blockquote";
  let best = null, bestD = Infinity;
  for (const el of sc.querySelectorAll(BLOCK)) {
    const txt = el.textContent || "";
    if (!/PI\\d{2}/.test(txt)) continue;
    const r = el.getBoundingClientRect();
    const d = Math.abs((r.top + r.bottom) / 2 - midY);
    if (d < bestD) { bestD = d; best = el; }
  }
  const out = {
    ok: true,
    st: round(sc.scrollTop),
    sh: Math.round(sc.scrollHeight),
    ch: Math.round(sc.clientHeight),
    max: Math.round(sc.scrollHeight - sc.clientHeight),
    pi: best ? Number((( /PI(\\d{2})/.exec(best.textContent || "") ) || [])[1]) : null,
    piTop: best ? round(best.getBoundingClientRect().top - scR.top) : null,
  };
  if (${kind} === "cm") {
    const cur = sc.querySelector(".cm-cursor");
    out.caretY = cur ? round(cur.getBoundingClientRect().top - scR.top) : null;
    out.focused = !!document.querySelector(".cm-focused");
    try {
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      if (v && v.state && v.state.doc) { out.text = v.state.doc.toString(); out.len = v.state.doc.length; out.lines = v.state.doc.lines; }
    } catch (e) {}
  } else {
    out.focused = !!document.querySelector(".ProseMirror-focused");
    try {
      const s = window.getSelection();
      if (s && s.rangeCount) out.caretY = round(s.getRangeAt(0).getBoundingClientRect().top - scR.top);
    } catch (e) {}
    // 阅读面结构签名（判"编辑是否生效" / "撤销是否回到原样"）
    try {
      const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
      const desc = pm && pm.pmViewDesc;
      const doc = desc && desc.node;
      if (doc && typeof doc.descendants === "function") {
        const parts = [];
        doc.descendants((node) => {
          if (node.isText) { parts.push("t" + node.text.length + "[" + node.marks.map((m) => m.type.name).join(",") + "]"); return false; }
          parts.push(node.type.name);
          return true;
        });
        out.sig = parts.join("|");
        out.text = pm.textContent || "";
      }
    } catch (e) {}
  }
  return out;
`;
};

/* ══════════════════════════════════════════════════════════════════════════
 * 三、曲线分析（Node 侧纯函数，口径与 R4 完全一致 → 可横向比较）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一维序列 → 观感指标。
 *
 * ⚠️ **断开空洞**：不能 `filter(v=>typeof v==="number")` 后算相邻差 ——
 * 那会把"某量中途缺失几帧"压缩成"相邻两帧"，产出假跳变。
 * （R4 实测：`caretY` 因点按钮时 `.cm-cursor` 被销毁，压缩后读出 547px 假跳变）
 */
export function analyze(seqRaw, tArr) {
  const pts = [];
  const deltas = [];
  const gaps = [];
  let maxJump = 0;
  const jumps = [];
  let segStart = null;
  for (let i = 0; i < seqRaw.length; i++) {
    const v = seqRaw[i];
    const valid = typeof v === "number" && Number.isFinite(v);
    if (!valid) {
      if (segStart !== null) gaps.push({ from: segStart, to: i });
      segStart = null;
      continue;
    }
    if (segStart === null) segStart = i;
    pts.push({ v, t: tArr ? tArr[i] : null });
    const prev = i > 0 ? seqRaw[i - 1] : undefined;
    if (typeof prev === "number" && Number.isFinite(prev)) {
      const d = Math.round((v - prev) * 100) / 100;
      deltas.push(d);
      if (Math.abs(d) > maxJump) maxJump = Math.abs(d);
      if (Math.abs(d) > 3) jumps.push({ at: i, t: tArr ? tArr[i] : null, d, from: prev, to: v });
    }
  }
  if (pts.length < 2) {
    return { n: pts.length, maxJump: 0, reversals: 0, net: 0, deltas, gaps, gapCount: gaps.length, jumps: [] };
  }
  const runs = [];
  for (const d of deltas) {
    if (Math.abs(d) < 0.05) continue;
    const sign = d > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== sign) runs.push(sign);
  }
  return {
    n: pts.length,
    first: pts[0].v,
    last: pts[pts.length - 1].v,
    net: Math.round((pts[pts.length - 1].v - pts[0].v) * 100) / 100,
    frames: deltas.filter((d) => Math.abs(d) >= 0.05).length,
    maxJump: Math.round(maxJump * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    jumps: jumps.slice(0, 12),
    jumpsCount: jumps.length,
    gaps,
    gapCount: gaps.length,
    deltas,
  };
}

/**
 * 逐帧联动分析：把「不可解释的跳变」与「正常重排」分开。
 *
 * ## 为什么必须做联动（R4 实证，R2 教训的延伸）
 * R2 教训：「整篇替换后 `scrollTop` 本来就该变，判据必须是**内容**不变」。
 * 反过来也成立 —— 只看"st 有没有动"会把**正常重排**判成缺陷：
 * ```
 * 插入多行模板：scrollTop 3656→3742（Δ+86）
 *               scrollHeight 8883→8969（Δ+86）   ← 完全同步
 *               视口中心 PI 28→28（内容没跑）
 * ```
 * 这是"内容变高 → 视口按内容锚补偿"的**正确**行为。
 *
 * ⇒ 判"跳"必须问：**这一帧的位移，能不能被同一帧的高度变化解释？**
 * - `|Δst| ≤ |Δsh| + 3` → 可解释，不算跳；
 * - `|Δst| > |Δsh| + 3` → **不可解释的跳变**。
 *
 * 反拉（方向反转且幅度 >3px）= 两个写者在打架，是"抖"的字面定义。
 */
export function analyzeLinkage(trace) {
  const jumps = [];
  let maxUnexplained = 0;
  const sts = trace.map((s) => s.st);
  const shs = trace.map((s) => s.sh);
  for (let i = 1; i < trace.length; i++) {
    const dst = sts[i] - sts[i - 1];
    const dsh = shs[i] - shs[i - 1];
    if (!Number.isFinite(dst) || !Number.isFinite(dsh)) continue;
    const unexplained = Math.abs(dst) - Math.abs(dsh);
    if (Math.abs(dst) > 3 && unexplained > 3) {
      if (unexplained > maxUnexplained) maxUnexplained = unexplained;
      jumps.push({ t: trace[i].t, dst: Math.round(dst * 100) / 100, dsh: Math.round(dsh * 100) / 100, unexplained: Math.round(unexplained * 100) / 100 });
    }
  }
  const runs = [];
  for (let i = 1; i < trace.length; i++) {
    const d = sts[i] - sts[i - 1];
    if (!Number.isFinite(d) || Math.abs(d) < 0.5) continue;
    const sign = d > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1].sign !== sign) runs.push({ sign, sum: 0, startFrame: i });
    runs[runs.length - 1].sum += d;
  }
  const counterMoves = [];
  for (let k = 1; k < runs.length; k++) {
    if (Math.abs(runs[k].sum) > 3) counterMoves.push({ prev: Math.round(runs[k - 1].sum * 100) / 100, cur: Math.round(runs[k].sum * 100) / 100 });
  }
  return { jumps: jumps.slice(0, 8), counterMoves, maxUnexplained: Math.round(maxUnexplained * 100) / 100 };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、交互工具（真机 CDP 版）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 真实滚轮滚动到目标比例。
 *
 * ⚠️ **绝对不能用 `scroller.scrollTop = x` 瞬移**（R2 教训）：
 * CM6 的 `scrollHeight` 来自 heightMap，视口上方没测量过的区块是**估算高度**；
 * 瞬移之后任何一次 dispatch 触发重测 → 估算被修正 → 总高度变上千像素 →
 * 视口里的**内容**自己就变了（实测 PI30→PI37），会被误判成滚动缺陷。
 * 滚轮走原生滚动路径，CM6 按滚动过程逐段测量，无此伪影。
 */
async function wheelTo(ui, pct, scrollerSel, opts = {}) {
  const step = opts.step ?? 150;
  const box = await ui.ev(`
    const el = document.querySelector(${JSON.stringify(scrollerSel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + Math.min(r.height - 24, r.height / 2)),
      st: Math.round(el.scrollTop),
      max: Math.round(el.scrollHeight - el.clientHeight),
    };
  `);
  if (!box) return null;
  const target = Math.round(box.max * pct);
  let cur = box.st;
  let guard = 0;
  while (cur > 6 && guard++ < 500) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -Math.min(step * 4, cur), pointerType: "mouse" });
    await ui.sleep(16);
    cur = await ui.ev(`return Math.round(document.querySelector(${JSON.stringify(scrollerSel)}).scrollTop)`);
  }
  guard = 0;
  while (cur < target - 6 && guard++ < 900) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: Math.min(step, target - cur), pointerType: "mouse" });
    await ui.sleep(16);
    const next = await ui.ev(`return Math.round(document.querySelector(${JSON.stringify(scrollerSel)}).scrollTop)`);
    if (next === cur) break;
    cur = next;
  }
  await ui.sleep(opts.settle ?? 600);
  return await ui.ev(`
    const el = document.querySelector(${JSON.stringify(scrollerSel)});
    return el ? { st: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) } : null;
  `);
}

/** 等滚动**真正稳定**（连续 N 次读数不变）—— 前置断言 A3 的实现 */
async function waitStableScroll(ui, scrollerSel, opts = {}) {
  const need = opts.need ?? 4;
  const gap = opts.gap ?? 110;
  let prev = null, stable = 0;
  for (let i = 0; i < 40; i++) {
    const st = await ui.ev(`return Math.round(document.querySelector(${JSON.stringify(scrollerSel)}).scrollTop)`);
    if (st === prev) stable++;
    else { stable = 0; prev = st; }
    if (stable >= need) return { ok: true, st, rounds: i + 1 };
    await ui.sleep(gap);
  }
  return { ok: false, st: prev, rounds: 40 };
}

/**
 * 点视口中央附近含 PIxx 的块（放光标）。
 *
 * ⚠️ R3 教训：**必须断言点到了**。R3 探针 1.0 因为"点击目标 = null"让光标留在文档开头，
 * 打字机把文档顶部居中，产出 1442px 的**假数据**。
 * 所以返回 null 时调用方标 INVALID，**不许继续跑**。
 */
async function placeCaretMid(ui, opts) {
  const kind = opts.kind ?? "cm";
  const scrollerSel = kind === "pm" ? ".editor-container" : ".cm-scroller";
  const pt = await ui.ev(`
    const sc = document.querySelector(${JSON.stringify(scrollerSel)});
    if (!sc) return null;
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    const sel = ${kind === "cm"} ? ".cm-line" : "p, h1, h2, h3, h4, h5, h6, li, pre, blockquote";
    let best = null, bestD = Infinity;
    for (const el of sc.querySelectorAll(sel)) {
      const txt = el.textContent || "";
      if (!/PI\\d{2}/.test(txt)) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestD) { bestD = d; best = el; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return {
      x: Math.round(r.left + Math.min(40, Math.max(8, r.width - 8))),
      y: Math.round(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2))),
      text: (best.textContent || "").trim().slice(0, 40),
      inView: r.top >= scR.top && r.bottom <= scR.bottom,
    };
  `);
  if (!pt) return null;
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  await ui.sleep(420);
  return pt;
}

/** 元素矩形中心（找不到 → null，调用方必须据此 FAIL，不许静默） */
async function centerOf(ui, selector, textContains) {
  return await ui.ev(`
    const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const want = ${JSON.stringify(textContains ?? null)};
    const el = want
      ? all.find(e => ((e.textContent || "") + " " + (e.getAttribute("title") || "") + " " + (e.getAttribute("aria-label") || "")).indexOf(want) >= 0)
      : all[0];
    if (!el) return { ok: false, n: all.length, cands: all.map(e => (e.textContent || "").trim().slice(0, 22)).slice(0, 30) };
    el.scrollIntoView({ block: "center" });
    return { ok: true };
  `).then(async (r) => {
    if (!r || !r.ok) return null;
    await ui.sleep(260);
    return await ui.ev(`
      const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const want = ${JSON.stringify(textContains ?? null)};
      const el = want
        ? all.find(e => ((e.textContent || "") + " " + (e.getAttribute("title") || "") + " " + (e.getAttribute("aria-label") || "")).indexOf(want) >= 0)
        : all[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return {
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        text: (el.textContent || "").trim().slice(0, 26),
        inView: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      };
    `);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 五、通用「编辑 → 采样」执行器
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 跑一次「动作 + 逐帧采样」，带**前置断言门**。
 *
 * 五个前置条件任一不成立，测出的数字**不代表产品**：
 * - A1 不可滚动 → 任何 st 变化被钳死，恒 0，**判据恒真**；
 * - A2 光标不在视口 → 用户没在"看着中间"操作，跳一下也无感，**判据失效**；
 * - A3 采样前滚动不稳 → 上文滚动尾巴被算进轨迹，**假 maxJump**；
 * - A4 动作没生效 → 什么都没动，**恒 PASS**（最危险的假绿）；
 * - A5 视口中心读不到锚 → 内容判据不可用。
 */
async function runAction(ui, cfg) {
  const kind = cfg.kind ?? "cm";
  const scrollerSel = kind === "pm" ? ".editor-container" : ".cm-scroller";
  const tag = cfg.tag;

  if (cfg.pct !== undefined) await wheelTo(ui, cfg.pct, scrollerSel, { settle: cfg.settle ?? 700 });
  const placed = cfg.prepare ? await cfg.prepare(ui) : await placeCaretMid(ui, { kind });
  if (!placed) return { invalid: true, tag, why: "A2 光标没能放到预期位置（点击目标 = null）" };

  await ui.sleep(300);
  const stable = await waitStableScroll(ui, scrollerSel, { need: 4, gap: 110 });
  const before = await ui.ev(readState({ kind }));
  const a1 = before.ok && before.max > 200;
  const a2 = before.caretY !== null && before.caretY !== undefined && before.caretY >= -2 && before.caretY <= before.ch + 2;
  const a5 = before.pi !== null && before.pi !== undefined;
  if (!a1 || !a2 || !a5 || !stable.ok) {
    return {
      invalid: true, tag, before,
      why: [
        !a1 && `A1 文档不可滚动(max=${before?.max})`,
        !a2 && `A2 光标不在视口内(caretY=${before?.caretY})`,
        !a5 && "A5 视口中心读不到 PI 段号",
        !stable.ok && "A3 采样前滚动不稳定",
      ].filter(Boolean).join("；"),
    };
  }

  await ui.ev(INSTALL_SPY);
  await ui.ev(`window.__R5_W = []; return true;`);
  const anchorPi = "PI" + String(before.pi).padStart(2, "0");
  await ui.ev(startTrace({ ms: cfg.ms ?? 2600, kind, anchorPi }));
  await ui.sleep(90);

  cfg.beforeLen = before.len;
  const trig = await cfg.action(ui, cfg);
  await ui.sleep(cfg.after ?? 2200);

  const traceRaw = await ui.ev(`return window.__R5_TR || []`);
  /**
   * ## ⚠️ 禁止在 action 内部重启 `startTrace`（本轮踩到的探针坑）
   *
   * 第一版 V1-1/V1-8 想在"打字之后、Ctrl+Z 之前"清空轨迹，于是在 action 里又调了一次
   * `startTrace` —— 但 `startTrace` 会**再起一个 rAF 循环**，而外层的循环仍在跑，
   * 两个循环同时往 `window.__R5_TR` 里 push ⇒ 轨迹**交错重复**，Δ 序列全乱。
   *
   * 正确做法：**只起一次采样**，由 action 返回 `segFromMs`（相对轨迹起点的毫秒数），
   * 分析时按时间切片。这样只有一条循环，且切片点是确定的。
   */
  const trace = (trig && typeof trig.segFromMs === "number")
    ? traceRaw.filter((f) => f.t >= trig.segFromMs)
    : traceRaw;
  const writes = await ui.ev(`return (window.__R5_W || []).map(w => ({ t: w.t, v: w.v, from: w.from, how: w.how, cls: w.cls, arg: w.arg, s: (w.s || []).slice(0, 4) }))`);
  const after = await ui.ev(readState({ kind }));

  /**
   * ## A4「动作真的生效」—— 判据必须**按场景**配，不能用"与动作前不同"
   *
   * 第一版我统一用 `len 或 sh 发生变化`，结果 4 项误判成"动作未生效"：
   * ```
   * V1-1 打字后 Ctrl+Z：len 6942→6942、sh 6019→6019   ← **撤销本来就该回到原状**！
   * V1-8 插粗体后 Backspace：len 6961→6961            ← 退格把格式符删掉了，也该回原状
   * V1-7/V1-9 开合预览：sh 5973→5973                  ← 预览是**右屏**，左屏内容高度本来就不该变
   * ```
   * 这不是产品问题，是**判据把"正确回到原状"当成了"没生效"**（与 R2/R3 反复踩的那类错误同源）。
   *
   * 所以：默认用 `len/sh 变化`；**每次动作由 action 自己声明证据**：
   * - `trig.applied === true` → 明确声明已生效（同时仍记录 len/sh 供人工核对）
   * - `trig.a4` → 自定义的布尔证据（如 V1-7 用右屏 shell 宽度变化）
   */
  const lenChanged = (after.len ?? 0) !== (before.len ?? 0) || (after.sig ?? "") !== (before.sig ?? "");
  const geomChanged = (after.sh ?? 0) !== (before.sh ?? 0);
  const declaredApplied = trig && (trig.applied === true || trig.a4 === true);
  const a4 = (trig && trig.ok !== false) && (declaredApplied || lenChanged || geomChanged);

  const st = analyze(trace.map((s) => s.st), trace.map((s) => s.t));
  const piTop = analyze(trace.map((s) => s.piTop), trace.map((s) => s.t));
  const caret = analyze(trace.map((s) => s.caretY), trace.map((s) => s.t));
  const linkage = analyzeLinkage(trace);
  const piSet = [...new Set(trace.map((s) => s.pi).filter((v) => v !== null && v !== undefined))];

  return {
    tag, before, after, trace, writes, trig, st, piTop, caret, linkage, piSet,
    lenChanged, geomChanged, a4, invalid: false,
    // 统计"我们自己的写入"（非 CM6 内部）
    ourWrites: writes.filter((w) => {
      const s = (w.s || []).join(" ") ;
      return /setScrollTop|restoreAfterDiscreteEdit|restorePreviewScrollFromAnchor|applyScroll|scrollToCenter|syncToPreview|realign/.test(s);
    }),
    stWrites: writes.filter((w) => w.how === "scrollTop="),
  };
}

/** 把一次 runAction 结果写成一行判定 */
function report(ui, id, name, rec, opts = {}) {
  if (!rec) { ui.add(id, name, "FAIL", "场景未执行"); return; }
  if (rec.invalid) { ui.add(id, name + "（前置断言不通过 → INVALID，不产出结论）", "KNOWN", rec.why); return; }
  if (!rec.a4) {
    ui.add(id, name + "（动作未生效 → 判据不适用）", "FAIL", `len ${rec.before?.len}→${rec.after?.len}；sh ${rec.before?.sh}→${rec.after?.sh}；action=${JSON.stringify(rec.trig)}`);
    return;
  }
  const lk = rec.linkage;
  const shCollapsed = (rec.after.sh ?? 0) < (rec.before.sh ?? 0) - 50;
  const pass = opts.passFn ? opts.passFn(rec) : (lk.maxUnexplained <= 3 && lk.counterMoves.length === 0);
  rec.pass = pass;
  ui.add(id, name, opts.knownOnly ? "KNOWN" : (pass ? "PASS" : "FAIL"),
    `不可解释跳变=${lk.maxUnexplained}px（≤3：${lk.maxUnexplained <= 3}）反拉=${lk.counterMoves.length}；` +
    `scrollTop ${rec.before.st}→${rec.after.st}；scrollHeight ${rec.before.sh}→${rec.after.sh}` +
    (shCollapsed ? "（**塌陷 = 整篇替换指纹**）" : "") + "；" +
    `PI 轨迹=${JSON.stringify(rec.piSet)}；` +
    `滚动写入 ${rec.writes.length} 次（裸 scrollTop ${rec.stWrites.length} 次，我们的 ${rec.ourWrites.length} 次）；` +
    `【诊断】caretY 净=${rec.caret.net}px maxJump=${rec.caret.maxJump}px 空洞=${rec.caret.gapCount}` +
    (opts.extra ? "；" + opts.extra(rec) : ""));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 六、主流程
 * ══════════════════════════════════════════════════════════════════════════ */

const CM = ".cm-scroller";
const PM_SC = ".editor-container";

/**
 * `phase` 参数（V1-5 关软件重开需要两个进程共用 profile）：
 * - `"main"`（默认）：跑 V1-1 ~ V1-4、V1-6 ~ V1-11
 * - `"coldstart-write"`：只写（进编辑模式 + 滚到中部），给下一次读用
 * - `"coldstart-read"`：只读（校验模式与进度是否恢复）
 */
const PHASE = process.env.R5_PHASE || "main";
const PROFILE = process.env.R5_PROFILE || null;

await runProbe(
  {
    /**
     * ## ⚠️ coldstart 两个 phase 必须用**同一个 name**
     *
     * 骨架里 `const docFile = path.join(tmp, `${name}.md`)` —— **name 决定文档文件名**，
     * 而进度是按**文件路径**做 key 的（`lightmd-scroll-progress` 是个 path→percent 的 Map）。
     *
     * 第一版我让 write/read 用不同 name（`...-coldstart-write` / `...-coldstart-read`），
     * 结果第二个进程打开的是**另一个文件**（`coldstart-read.md`），
     * 进度表里根本没有它的记录 → `scrollTop=0` 是**必然**，与产品行为无关。
     *
     * 证据（第一版 read 阶段的 localStorage）：
     * ```
     * lightmd-last-active-tab → ...\v0170-r5-scroll-coldstart-read.md   ← 文件名变了！
     * lightmd-scroll-progress → { "...coldstart-write.md": 0.5009 }      ← key 是 write 的文件
     * ```
     * 两个 key 对不上 ⇒ 不是"读回失效"，是**探针让两个进程开了不同文件**。
     *
     * 现在两个 phase 共用 name → 共用 docFile → 进度 key 一致。
     * 代价：两个 phase 的产物 json 会互相覆盖（write 的结果已单独备份为 `.BAK.json`）。
     */
    name: PHASE === "main" ? "v0170-r5-scroll" : "v0170-r5-scroll-coldstart",
    doc: DOC,
    docTitle: DOC_TITLE,
    viewMode: "edit",
    profileDir: PROFILE,
  },
  async (ui) => {
    ui.log(`[setup] phase=${PHASE} impl=${ui.impl}`);

    /* ════════════════════════════════════════════════════════════
     * 阶段 A：coldstart-write / coldstart-read（V1-5 专用）
     * ════════════════════════════════════════════════════════════ */
    if (PHASE === "coldstart-write") {
      /**
       * V1-5 第一步：进编辑模式 → 滚到中部 → 记下位置 → 直接退出。
       * 退出后由调度器复用同一 profile 起第二个进程读。
       *
       * ⚠️ 必须等 localStorage 的防抖落盘（viewMode 持久化 + 进度持久化都是异步的）。
       */
      await ui.command("view.edit");
      await ui.sleep(2400);
      const r = await wheelTo(ui, 0.5, CM, { settle: 900 });
      await waitStableScroll(ui, CM, { need: 4, gap: 120 });
      const st = await ui.ev(readState({ kind: "cm" }));
      ui.log("[coldstart-write] 滚到位： " + JSON.stringify({ st: st.st, sh: st.sh, pi: st.pi }));

      const readLs = `
        const out = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (/view-mode|scroll|progress|last-active/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 400);
          }
        } catch (e) {}
        return out;
      `;

      /**
       * ## 判据 ①：进度必须**真的落盘**（这是 Lead 要求加的第二判据）
       *
       * 源码依据（`src/App.tsx`）：
       * ```
       * const timer = setInterval(snapshot, 5000);      // 5s 心跳
       * window.addEventListener("beforeunload", snapshot);  // 退出时冲刷
       * ```
       * `fileScrollProgress` 注释也写明：「**写路径**只在 5s 心跳 + 窗口关闭时落盘一次」。
       *
       * 所以：只等 1500ms（上一版）必然没落盘 → 读到 0 是**方法问题**；
       * 这里等 **7s**（>5s 心跳 + 余量）让心跳跑过，并**显式确认** `lightmd-scroll-progress`
       * 里出现了本文件的进度值，再进入关闭。
       */
      let lsMid = null;
      for (let i = 0; i < 12; i++) {
        await ui.sleep(700);
        lsMid = await ui.ev(readLs);
        const raw = lsMid["lightmd-scroll-progress"];
        if (raw && /\d/.test(raw)) {
          ui.log(`[coldstart-write] 第 ${i + 1} 次轮询（~${(i + 1) * 700}ms）已看到 scroll-progress 落盘`);
          break;
        }
        ui.log(`[coldstart-write] 第 ${i + 1} 次轮询（~${(i + 1) * 700}ms）尚未落盘`);
      }
      const progressRaw = lsMid ? lsMid["lightmd-scroll-progress"] : null;
      const landedBeforeClose = !!progressRaw && /\d/.test(progressRaw);
      ui.log("[coldstart-write] localStorage(before close) = " + JSON.stringify(lsMid, null, 1));

      /**
       * ## 判据 ②：用**正常关闭**而不是 `taskkill /F`
       *
       * 上一版用骨架的 finally `taskkill /F /T` 强杀 → `beforeunload` 不触发。
       * 这里主动经 Tauri 关闭窗口（等价用户点 ×），让应用的退出冲刷链路跑完：
       * `beforeunload → fileScrollProgress.saveSnapshot() → flushWindowState() → quitApp()`。
       * 关闭后本进程会退出，后续由调度器复用同 profile 起第二个进程读。
       */
      const closed = await ui.ev(`
        try {
          const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
          if (!inv) return { ok: false, why: "no __TAURI_INTERNALS__.invoke" };
          // 主动触发应用的退出冲刷（与点 × 同一条链路）
          window.dispatchEvent(new Event("beforeunload"));
          await inv("plugin:window|close", { label: "main" });
          return { ok: true };
        } catch (e) {
          return { ok: false, why: String(e).slice(0, 200) };
        }
      `).catch((e) => ({ ok: false, why: String(e.message).slice(0, 200) }));
      ui.log("[coldstart-write] 正常关闭请求 = " + JSON.stringify(closed));
      // 给冲刷 + 写盘一点时间（这一步之后进程会被 finally 的 killSelf 兜底，但已经 flush 过）
      await ui.sleep(2500);

      ui.add("V1-5a", "① 写入阶段：进度真的落盘到 localStorage（不是只改了内存）",
        landedBeforeClose ? "PASS" : "FAIL",
        `滚动位置 scrollTop=${st.st} max=${st.max} 视口中心 PI${st.pi}；` +
        `lightmd-scroll-progress=${progressRaw ? progressRaw.slice(0, 200) : "**缺失**"}；` +
        `全部相关 key=${JSON.stringify(Object.keys(lsMid || {}))}；正常关闭=${JSON.stringify(closed)}`);
      ui.add("V1-5b", "② 写入阶段：用**正常关闭**（beforeunload + Tauri close）而非 taskkill 强杀",
        closed.ok ? "PASS" : "KNOWN",
        `关闭结果=${JSON.stringify(closed)}；` +
        `（上一版用 taskkill /F 强杀 → beforeunload 不触发 → 进度必然没落盘，这正是当时读到 0 的原因）`);
      await ui.shot("coldstart-write");
      return;
    }

    if (PHASE === "coldstart-read") {
      /**
       * V1-5 第二步：新进程（同 profile）启动后，直接读模式与位置。
       *
       * 判据：
       * - 模式仍是编辑模式（`.cm-editor` 存在且可见）
       * - `scrollTop` 与写入阶段接近（同一文件、同一内容，像素应可比 —— 允许 120px 容差，
       *   因为 WebView2 重启后字体/缩放可能有亚像素差、heightMap 首次测量也是估算值）
       */
      /**
       * ## 读取阶段：**两个独立判据**（Lead 要求，别只测一个）
       *
       * 判别矩阵（这是"没落盘"与"落盘了但读不回"的唯一区分方式）：
       * | ① localStorage 有值 | ② 界面恢复 | 结论 |
       * |---|---|---|
       * | 无 | 否 | 写入阶段就没落盘（写侧问题） |
       * | **有** | **否** | **落盘正常，但读取/恢复链路失效（读侧问题）** |
       * | 有 | 是 | 整条链路 PASS |
       */
      /**
       * ## ⚠️ 冷启动恢复有**两条路径**，必须取证是哪一条
       *
       * `App.tsx` 里：
       * - `mode === "session"`：按 `session.json` 精确恢复标签/文件夹，并 `fileScrollProgress.loadSnapshot()`
       * - `mode === "legacy"`：走"最近文件 + 临时标签"恢复
       * 且**两条路径都可能在之后调用 `clearAll()`**（例如 `!isUntitledRestoreEnabled()` 分支、
       * 或 `startupUntitledRestore` 判定不满足时）→ 内存 Map 被清空 → 恢复 effect 读到 null。
       *
       * 所以这里要**同时取证三件事**，否则"scrollTop=0"无法归因：
       * ① localStorage 里进度**仍在**吗（持久化层有没有被清）
       * ② 内存 Map 里**有没有**本文件的 percent（恢复 effect 能不能读到）
       * ③ 恢复 effect 跑了没有（看 scrollTop 是否曾被设过非 0）
       */
      await ui.sleep(1800); // 等启动恢复链跑完
      const bootDiag = await ui.ev(`
        const ls = {};
        try {
          const raw = localStorage.getItem("lightmd-scroll-progress");
          ls.progressRaw = raw;
          ls.keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (/session|scroll|progress|untitled|restore/i.test(k)) ls.keys.push(k);
          }
        } catch (e) {}
        // ② 内存 Map：fileScrollProgress 是模块级 Map，不挂在 window 上；
        // 但恢复 effect 会「get(key) → 写 scrollTop」，所以用 ③ 的观测替代：
        const sc = document.querySelector(".cm-scroller");
        return {
          ls,
          st: sc ? Math.round(sc.scrollTop) : null,
          sh: sc ? Math.round(sc.scrollHeight) : null,
          ch: sc ? Math.round(sc.clientHeight) : null,
          // 当前 tab 的 path（决定 progress key）
          tabPath: (() => { try { const t = JSON.parse(localStorage.getItem("lightmd-last-active-tab") || "{}"); return t.path || null; } catch (e) { return null; } })(),
        };
      `);
      ui.log("[coldstart-read] 启动取证 = " + JSON.stringify(bootDiag, null, 1));

      // ③ 恢复 effect 是否曾把 scrollTop 设过非 0：连续采样 12 次 × 250ms
      const stSamples = [];
      for (let i = 0; i < 12; i++) {
        await ui.sleep(250);
        const v = await ui.ev(`
          const sc = document.querySelector(".cm-scroller");
          return sc ? Math.round(sc.scrollTop) : null;
        `);
        stSamples.push(v);
        if (v && v > 50) break; // 一旦恢复成功就不用再等
      }
      ui.log("[coldstart-read] scrollTop 时间序列 = " + JSON.stringify(stSamples));
      const stRecovered = stSamples.some((v) => typeof v === "number" && v > 200);
      const progressStillThere = !!(bootDiag.ls.progressRaw && /\d/.test(bootDiag.ls.progressRaw));
      const key = bootDiag.tabPath;
      const progressHasThisFile = !!(progressStillThere && key && bootDiag.ls.progressRaw.indexOf(key) >= 0);
      ui.add("V1-5-diag", "冷启动归因：持久化仍在？key 对得上？恢复 effect 跑过？",
        "PASS",
        `① localStorage 进度仍在=${progressStillThere}；② 进度表含当前文件(${key})=${progressHasThisFile}；` +
        `③ scrollTop 时序=${JSON.stringify(stSamples)}（是否恢复到 >200：${stRecovered}）；` +
        `相关 key=${JSON.stringify(bootDiag.ls.keys)}`);

      const st = await ui.ev(readState({ kind: "cm" }));
      const mode = await ui.ev(`
        const cm = document.querySelector(".cm-editor");
        const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none"; };
        let m = null; try { m = JSON.parse(localStorage.getItem("lightmd-view-mode") || "{}"); } catch (e) {}
        return { cmVisible: vis(cm), store: m, hasCm: !!cm };
      `);
      const ls = await ui.ev(`
        const out = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/view-mode|scroll|progress|last-active/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 400); } } catch (e) {}
        return out;
      `);
      ui.log("[coldstart-read] 恢复后 = " + JSON.stringify({ st: st.st, sh: st.sh, pi: st.pi }));
      ui.log("[coldstart-read] 模式 = " + JSON.stringify(mode));
      ui.log("[coldstart-read] localStorage = " + JSON.stringify(ls, null, 1));

      // 判据 ①：写盘侧
      const persisted = ls["lightmd-scroll-progress"];
      const hasProgress = !!persisted && /\d/.test(persisted);
      // 判据 ②：读回侧（界面）
      const modeOk = mode.cmVisible === true;
      const posOk = (st.st ?? 0) > 200;

      ui.add("V1-5①", "写盘侧：localStorage 里存在 lightmd-scroll-progress（进度真的持久化了）",
        hasProgress ? "PASS" : "FAIL",
        `lightmd-scroll-progress=${persisted ? persisted.slice(0, 260) : "**缺失（从未落盘）**"}；` +
        `相关 key=${JSON.stringify(Object.keys(ls))}`);
      ui.add("V1-5②", "读回侧：重开后仍是编辑模式（模式持久化生效）",
        modeOk ? "PASS" : "FAIL",
        `cmVisible=${mode.cmVisible}；lightmd-view-mode=${JSON.stringify(mode.store)}`);
      ui.add("V1-5③", "读回侧：重开后滚动位置恢复（不是回到顶部）",
        posOk ? "PASS" : "FAIL",
        `重开后 scrollTop=${st.st}（判据 >200）；视口中心 PI${st.pi}；scrollHeight=${st.sh}`);
      ui.add("V1-5", "★ R2#10 关软件重开：模式 + 进度都恢复（①写盘 + ③读回 双判据）",
        hasProgress && modeOk && posOk ? "PASS"
          : (!hasProgress ? "FAIL" : "FAIL"),
        hasProgress
          ? (modeOk && posOk ? "整条链路 PASS" : `**落盘正常但读回失败** → 读侧（startupRestore/恢复链）问题`)
          : "写入阶段未落盘 → 写侧问题");
      await ui.shot("coldstart-read");
      return;
    }


    /* ════════════════════════════════════════════════════════════
     * 阶段 C：diag（V1-3 首轮异常 + V1-9 的 6px 溯源）
     * ════════════════════════════════════════════════════════════ */
    if (PHASE === "diag") {
      await ui.command("view.edit");
      await ui.sleep(2400);
      await ui.focusSource();
      await ui.sleep(400);

      /* ── D1：V1-3 首轮 PI24 是"恢复还没完成"还是"真漂"？ ──
       * 手法：切到阅读后，**按时间多次采样** PI，看它是否稳定在某个值、什么时候稳定。
       * 若最终稳定在 29 而中途短暂读到 24 → 是**测量过早**（修复流程本身在跑），
       * 若一直停在 24 → 是真漂。 */
      await wheelTo(ui, 0.45, CM, { settle: 900 });
      await waitStableScroll(ui, CM, { need: 4 });
      const d1base = await ui.ev(readState({ kind: "cm" }));
      ui.log("[D1] 编辑面基线 = " + JSON.stringify({ st: d1base.st, pi: d1base.pi, sh: d1base.sh }));

      await ui.command("view.preview");
      const d1samples = [];
      for (let i = 0; i < 14; i++) {
        await ui.sleep(200);
        const r = await ui.ev(readState({ kind: "pm" }));
        d1samples.push({ ms: (i + 1) * 200, pi: r.pi, st: r.st, sh: r.sh });
      }
      ui.log("[D1] 切阅读后按时间采样 = " + JSON.stringify(d1samples));
      const d1last = d1samples[d1samples.length - 1];
      const d1first = d1samples[0];
      ui.add("D1", "V1-3 诊断：切阅读后 PI 的时间演化（首轮 PI24 是测量过早还是真漂）",
        d1last.pi === d1base.pi ? "PASS" : "KNOWN",
        `编辑面 PI${d1base.pi} → 切阅读后 200ms 时 PI${d1first.pi}（st=${d1first.st}）→ ` +
        `2800ms 时 PI${d1last.pi}（st=${d1last.st}）；完整轨迹=${JSON.stringify(d1samples.map((x) => x.pi))}；` +
        `解读：若最终等于 ${d1base.pi} 而中途偏 → 是**切换后恢复流程尚未完成**（测量过早），不是漂移`);

      /* ── D2：V1-9 打开预览的 6px 是谁写的 ── */
      await ui.command("view.edit");
      await ui.sleep(2400);
      await wheelTo(ui, 0.45, CM, { settle: 900 });
      await placeCaretMid(ui, { kind: "cm" });
      await ui.sleep(400);
      await waitStableScroll(ui, CM, { need: 4 });
      const d2before = await ui.ev(readState({ kind: "cm" }));

      await ui.ev(INSTALL_SPY);
      await ui.ev(`window.__R5_W = []; return true;`);
      await ui.ev(startTrace({ ms: 3400, kind: "cm", anchorPi: null }));
      await ui.sleep(100);
      const d2t0 = await ui.ev(`return Math.round(performance.now())`);
      await ui.command("view.togglePreview");
      await ui.sleep(3000);

      const d2trace = await ui.ev(`return window.__R5_TR || []`);
      const d2writes = await ui.ev(`return (window.__R5_W || []).map(w => ({ t: w.t, v: w.v, from: w.from, how: w.how, cls: w.cls, s: (w.s || []).slice(0, 8) }))`);
      const d2after = await ui.ev(readState({ kind: "cm" }));
      const d2st = analyze(d2trace.map((f) => f.st), d2trace.map((f) => f.t));
      const d2lk = analyzeLinkage(d2trace);

      ui.log("[D2] before=" + JSON.stringify({ st: d2before.st, sh: d2before.sh }) + " after=" + JSON.stringify({ st: d2after.st, sh: d2after.sh }));
      ui.log("[D2] linkage=" + JSON.stringify(d2lk));
      ui.log("[D2] 不可解释帧明细（st 序列中 |Δst|>3 且 |Δst|>|Δsh|+3 的帧）=" + JSON.stringify(d2lk.jumps));
      ui.log("[D2] 全部写入 " + d2writes.length + " 次：");
      for (const w of d2writes) {
        ui.log(`    +${w.t - d2t0}ms ${w.how} ${w.from}->${w.v} @${w.cls}`);
        for (const st of (w.s || []).slice(1, 5)) ui.log(`        ${st}`);
      }
      // 逐帧 st 序列（前 70）
      ui.log("[D2] st Δ序列(前70)=" + JSON.stringify(d2st.deltas.slice(0, 70)));
      ui.log("[D2] sh Δ序列(前70)=" + JSON.stringify(analyze(d2trace.map((f) => f.sh), d2trace.map((f) => f.t)).deltas.slice(0, 70)));

      ui.add("D2", "V1-9 诊断：打开预览时 6px 位移的写入溯源",
        d2lk.maxUnexplained <= 3 ? "PASS" : "KNOWN",
        `不可解释跳变=${d2lk.maxUnexplained}px 反拉=${d2lk.counterMoves.length}；` +
        `scrollTop ${d2before.st}→${d2after.st}；scrollHeight ${d2before.sh}→${d2after.sh}；` +
        `写入 ${d2writes.length} 次：${JSON.stringify(d2writes.slice(0, 8).map((w) => `${w.from}->${w.v}@${w.how}`))}；` +
        `不可解释帧=${JSON.stringify(d2lk.jumps)}`);
      /* ── D3：完整复刻主流程的 V1-7 → V1-9 序列，看 6px 是否只在"连续开合"时出现 ── */
      await ui.command("view.edit");
      await ui.sleep(2200);
      await wheelTo(ui, 0.45, CM, { settle: 900 });
      await placeCaretMid(ui, { kind: "cm" });
      await ui.sleep(400);
      await waitStableScroll(ui, CM, { need: 4 });

      // 第一步：先关一次（模拟 V1-7）
      await ui.ev(`window.__R5_W = []; return true;`);
      await ui.command("view.togglePreview");
      await ui.sleep(2600);
      const d3closeWrites = await ui.ev(`return (window.__R5_W || []).map(w => ({ from: w.from, v: w.v, how: w.how, cls: w.cls, s: (w.s || []).slice(0, 5) }))`);
      ui.log("[D3] 关闭阶段写入 " + d3closeWrites.length + " 次：");
      for (const w of d3closeWrites) { ui.log(`   ${w.from}->${w.v}@${w.how} @${w.cls}`); for (const x of w.s.slice(1, 4)) ui.log(`      ${x}`); }

      // 等稳定
      await ui.sleep(2200);
      await waitStableScroll(ui, CM, { need: 5, gap: 140 });

      // 第二步：再开一次（模拟 V1-9）
      const d3before = await ui.ev(readState({ kind: "cm" }));
      await ui.ev(INSTALL_SPY);
      await ui.ev(`window.__R5_W = []; return true;`);
      await ui.ev(startTrace({ ms: 3600, kind: "cm", anchorPi: null }));
      await ui.sleep(120);
      const d3t0 = await ui.ev(`return Math.round(performance.now())`);
      await ui.command("view.togglePreview");
      await ui.sleep(3200);
      const d3trace = await ui.ev(`return window.__R5_TR || []`);
      const d3writes = await ui.ev(`return (window.__R5_W || []).map(w => ({ t: w.t, from: w.from, v: w.v, how: w.how, cls: w.cls, s: (w.s || []).slice(0, 8) }))`);
      const d3after = await ui.ev(readState({ kind: "cm" }));
      const d3lk = analyzeLinkage(d3trace);
      const d3st = analyze(d3trace.map((f) => f.st), d3trace.map((f) => f.t));
      ui.log("[D3] 打开阶段 before=" + JSON.stringify({ st: d3before.st, sh: d3before.sh }) + " after=" + JSON.stringify({ st: d3after.st, sh: d3after.sh }));
      ui.log("[D3] linkage=" + JSON.stringify(d3lk));
      ui.log("[D3] st Δ序列=" + JSON.stringify(d3st.deltas.slice(0, 80)));
      ui.log("[D3] 写入 " + d3writes.length + " 次：");
      for (const w of d3writes) { ui.log(`   +${w.t - d3t0}ms ${w.from}->${w.v}@${w.how} @${w.cls}`); for (const x of w.s.slice(1, 5)) ui.log(`      ${x}`); }
      ui.add("D3", "V1-9 诊断②：复刻「先关再开」序列，抓 6 次写入的来源",
        d3lk.maxUnexplained <= 3 ? "PASS" : "KNOWN",
        `不可解释=${d3lk.maxUnexplained}px 反拉=${d3lk.counterMoves.length}；写入=${d3writes.length} 次 ` +
        `${JSON.stringify(d3writes.map((w) => `${w.from}->${w.v}@${w.how}`))}`);
      await ui.shot("diag");
      return;
    }

    /* ════════════════════════════════════════════════════════════
     * 阶段 B：主流程 V1-1 ~ V1-4、V1-6 ~ V1-11
     * ════════════════════════════════════════════════════════════ */

    await ui.command("view.edit");
    await ui.sleep(2400);
    await ui.focusSource();
    await ui.sleep(400);

    // 环境自检（前置：入口存在才谈得上测）
    const env = await ui.ev(`
      return {
        cm: !!document.querySelector(".cm-editor"),
        scroller: !!document.querySelector(".cm-scroller"),
        toolbar: document.querySelectorAll(".source-format-toolbar .format-btn").length,
        syntax: document.querySelectorAll(".syntax-helper-item").length,
        splitIframe: !!document.querySelector("iframe.split-preview"),
        mainArea: !!document.querySelector(".editor-main-area"),
        impl: document.querySelector(".cm-editor") ? "cm6" : "textarea",
      };
    `);
    ui.log("[env] " + JSON.stringify(env));
    ui.add("V1-0", "环境自检：CM6 源码面 + 格式栏 + 语法栏 + 分屏 iframe 都存在",
      env.cm && env.scroller && env.toolbar > 0 && env.syntax > 0 && env.mainArea ? "PASS" : "FAIL",
      JSON.stringify(env));
    if (!env.cm) return; // 没有 CM6 就不必往下测

    /* ───────────────────────── V1-1：R2#3 撤销/恢复位置跳动 ─────────────────────────
     * 场景：滚到中部 → 在光标处打字（内容变化）→ Ctrl+Z → 视口应稳定。
     * 判据：撤销期不可解释跳变 ≤3px 且无回摆。
     * 为什么：用户看到的是"撤销一下页面乱跳"，而这个量直接代表"视口有没有被猛地挪走"。 */
    const v1 = await runAction(ui, {
      tag: "V1-1",
      kind: "cm", scroller: CM, pct: 0.45, ms: 3000, after: 2400,
      async action(u, cfg) {
        // 先打字（制造一条可撤销的编辑）→ 记下此刻的轨迹时刻 → 再 Ctrl+Z
        await u.typeText("XYZ");
        await u.sleep(900);
        // segFromMs：只分析"撤销阶段"的轨迹（打字阶段的正常重排不参与判据）
        const segFromMs = await u.ev(`
          // 用轨迹里最后一个采样点的相对时间当分界（比 performance.now 更稳，
          // 因为轨迹的 t 是相对它自己的 T0 的）
          const tr = window.__R5_TR || [];
          return tr.length ? tr[tr.length - 1].t : 0;
        `);
        /**
         * A4 证据：撤销后长度会**回到原状**，所以不能拿"与前后不同"当证据。
         * 正确证据是「**打字阶段确实把文档改长了**」——
         * 若打字没落地（长度不变），那 Ctrl+Z 什么都不会撤销，整场测不到东西。
         */
        const typedLen = await u.ev(`
          const c = document.querySelector(".cm-content");
          const v = c && c.cmTile && c.cmTile.view;
          return v && v.state ? v.state.doc.length : null;
        `);
        await u.ev(`window.__R5_W = []; return true;`); // 写入只看撤销阶段
        await u.key("z", "KeyZ", 90, 2);
        return {
          ok: true, how: "type XYZ + Ctrl+Z", segFromMs,
          a4: typeof typedLen === "number" && typeof cfg.beforeLen === "number" ? typedLen > cfg.beforeLen : true,
          typedLen, beforeLen: cfg.beforeLen,
        };
      },
    });
    report(ui, "V1-1", "R2#3 撤销：视口不跳（不可解释跳变≤3px、无回拉）", v1);

    /* ───────────────────── V1-2：R2#6 点格式栏/语法栏跳底部 ─────────────────────
     * 两条路径分开测（R4 发现语法栏走的是另一条链）：
     * - 格式栏「粗体」→ 上一轮已修，验没回归
     * - 语法栏「代码块」→ **R4 重点**，必须 scrollHeight 不塌 */
    const v2a = await runAction(ui, {
      tag: "V1-2a",
      kind: "cm", scroller: CM, pct: 0.45, ms: 2600, after: 2000,
      async action(u, cfg) {
        const btn = await u.ev(`
          const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
          const b = btns.find(x => (x.getAttribute("title") || "") .indexOf("粗体") >= 0);
          if (!b) return { ok: false, n: btns.length };
          const r = b.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), title: b.getAttribute("title") };
        `);
        if (!btn || !btn.ok) return { ok: false, why: "找不到粗体按钮", btn };
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
        return { ok: true, how: "toolbar-bold", btn };
      },
    });
    report(ui, "V1-2a", "R2#6 格式栏「粗体」：不跳到底部（R3/R4 已修，验无回归）", v2a);

    const v2b = await runAction(ui, {
      tag: "V1-2b",
      kind: "cm", scroller: CM, pct: 0.45, ms: 2600, after: 2000,
      async action(u, cfg) {
        const it = await centerOf(u, ".syntax-helper-item", "代码块");
        if (!it) return { ok: false, why: "找不到语法栏「代码块」" };
        if (!it.inView) return { ok: false, why: "目标不在视口内", box: it };
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: it.x, y: it.y, button: "left", clickCount: 1 });
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: it.x, y: it.y, button: "left", clickCount: 1 });
        return { ok: true, how: "syntax-codeblock", it };
      },
    });
    report(ui, "V1-2b", "R2#6 语法栏「代码块」：不跳（**R4 修的第二条链路**）", v2b);

    /* ─────────────────── V1-3：R2#8 反复切模式进度变化 ───────────────────
     * 场景：同一位置切 6 次（阅读↔编辑），最后一次的位置应与第一次接近。
     * 判据：每次切换后视口中心 PI 与初始的**段号差 ≤1**（一行以内的换算误差）。
     * 为什么用段号而不是像素：两种排版的行高/软换行不同，像素不可比（R2 实证）。 */
    await wheelTo(ui, 0.45, CM, { settle: 800 });
    await waitStableScroll(ui, CM, { need: 4 });
    const roundTripPis = [];
    const roundTripDetail = [];
    const baseState = await ui.ev(readState({ kind: "cm" }));
    roundTripPis.push(baseState.pi);
    /**
     * ⚠️ 每次切换后必须等**恢复流程真正完成**再读数（D1 诊断的结论）
     *
     * 第一版每段只等 1400ms，首轮读到 PI24。单独复测（D1）表明：
     * 切阅读后 14 次 × 200ms 采样**全为 PI29** —— 说明 PI24 是**首次切换时
     * 恢复流程尚未完成**的瞬时读数，不是漂移。
     *
     * 首次切换要额外多等（首次要建 PM view / 采几何缓存 / 跑恢复链），
     * 之后每轮 1800ms 足够。这是"测量窗口"问题，不是产品问题。
     */
    await ui.sleep(800);
    for (let i = 0; i < 6; i++) {
      await ui.command("view.preview");
      await ui.sleep(i === 0 ? 2600 : 1900);
      const pmSt = await ui.ev(readState({ kind: "pm" }));
      await ui.command("view.edit");
      await ui.sleep(i === 0 ? 2600 : 1900);
      const cmSt = await ui.ev(readState({ kind: "cm" }));
      roundTripPis.push(cmSt.pi);
      roundTripDetail.push({ round: i + 1, pmPi: pmSt.pi, pmSt: pmSt.st, cmPi: cmSt.pi, cmSt: cmSt.st });
      ui.log(`[V1-3] 第 ${i + 1} 次往返：阅读面 PI${pmSt.pi}（st=${pmSt.st}）→ 编辑面 PI${cmSt.pi}（st=${cmSt.st}）`);
    }
    const finalState = await ui.ev(readState({ kind: "cm" }));
    const piDelta = Math.abs((finalState.pi ?? 0) - (baseState.pi ?? 0));
    const piRange = Math.max(...roundTripPis.filter((v) => v != null)) - Math.min(...roundTripPis.filter((v) => v != null));
    ui.add("V1-3", "★ R2#8 反复切模式（6 次往返）：进度不漂移（视口中心段号差 ≤1）",
      piDelta <= 1 && piRange <= 2 ? "PASS" : (piDelta <= 3 ? "KNOWN" : "FAIL"),
      `初始 PI${baseState.pi}（st=${baseState.st}）→ 6 次往返后 PI${finalState.pi}（st=${finalState.st}）；` +
      `段号净漂移=${piDelta}；全程段号极差=${piRange}；轨迹=${JSON.stringify(roundTripPis)}`);

    /* ─────────────────── V1-4：R2#9 阅读/编辑文档未对齐 ───────────────────
     * 场景：编辑模式滚到某段 → 切阅读 → 切回编辑，看**同一段文字**的首字屏幕位置。
     * 判据：切回编辑后，锚段首字的屏幕 Y 与**初始**相差 ≤2px。
     *   注意：这里比的是"编辑面 → 编辑面"（绕一圈回来），因为左右两屏的行高不同，
     *   直接比"左屏 vs 右屏"没有可比基准（R2 已实证）。 */
    await wheelTo(ui, 0.45, CM, { settle: 800 });
    await waitStableScroll(ui, CM, { need: 4 });
    const alignProbe = `
      const sc = document.querySelector(".cm-scroller");
      if (!sc) return null;
      const scR = sc.getBoundingClientRect();
      const midY = scR.top + sc.clientHeight / 2;
      let best = null, bestD = Infinity;
      for (const l of sc.querySelectorAll(".cm-line")) {
        if (!/PI\\d{2}/.test(l.textContent || "")) continue;
        const r = l.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - midY);
        if (d < bestD) { bestD = d; best = l; }
      }
      if (!best) return null;
      const m = /PI(\\d{2})/.exec(best.textContent || "");
      return { pi: m ? Number(m[1]) : null, top: Math.round((best.getBoundingClientRect().top - scR.top) * 100) / 100 };
    `;
    const alignBefore = await ui.ev(alignProbe);
    await ui.command("view.preview");
    await ui.sleep(1500);
    await ui.command("view.edit");
    await ui.sleep(1500);
    await waitStableScroll(ui, CM, { need: 3 });
    const alignAfter = await ui.ev(alignProbe);
    const charYDelta = alignBefore && alignAfter ? Math.abs(alignAfter.top - alignBefore.top) : null;
    ui.add("V1-4", "R2#9 编辑→阅读→编辑 绕一圈：锚段屏幕位置重合（≤2px）",
      charYDelta !== null && charYDelta <= 2 ? "PASS" : (charYDelta !== null && charYDelta <= 8 ? "KNOWN" : "FAIL"),
      `切前 PI${alignBefore?.pi}@${alignBefore?.top}px → 切回后 PI${alignAfter?.pi}@${alignAfter?.top}px；` +
      `位移=${charYDelta}px`);

    /* ─────────────────── V1-6：R2#11 切模式过渡效果（380ms） ───────────────────
     * 判据：切模式时 `[data-lmd-mode-anim]` 出现且取值正确，并在 ~380ms 后消失。
     * 为什么用属性而不是截图比对：属性是动画的**唯一驱动源**
     * （`modeSwitchSlide.css` 的所有选择器都以它为条件），有它才可能有动画。 */
    /**
     * ⚠️ 必须用**一次**长采样覆盖两个方向（第一版错在这里）
     *
     * 第一版是「起采样 1.8s → 切阅读 → 取数 → **重新起采样** → 切编辑 → 取数」。
     * 但第二次采样器起跑时，编辑方向的动画**可能已经在上一轮的收尾里播完/或被
     * 重新挂载打断** → `to-edit` 采到空数组（`vals=[] frames=0`）。
     * 那不是"没有动画"，是**采样窗口错过了**。
     *
     * 改为：起一个 5s 的采样循环，中途切两次，最后统一按时间切片分析。
     * 同时记录每次切换的**时刻标记**，切片点确定（不靠猜）。
     */
    await ui.ev(`
      window.__R5_ANIM = [];
      window.__R5_ANIM_MARK = [];
      (function () {
        const T0 = performance.now();
        window.__R5_ANIM_T0 = T0;
        const tick = () => {
          const a = document.querySelector("[data-lmd-mode-anim]");
          window.__R5_ANIM.push({ t: Math.round(performance.now() - T0), v: a ? a.getAttribute("data-lmd-mode-anim") : null });
          if (performance.now() - T0 < 5200) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })();
      return true;
    `);
    await ui.sleep(200);
    const markPrev = await ui.ev(`window.__R5_ANIM_MARK.push(Math.round(performance.now() - window.__R5_ANIM_T0)); return window.__R5_ANIM_MARK.length;`);
    await ui.command("view.preview");
    await ui.sleep(2200);
    const markEdit = await ui.ev(`window.__R5_ANIM_MARK.push(Math.round(performance.now() - window.__R5_ANIM_T0)); return window.__R5_ANIM_MARK.length;`);
    await ui.command("view.edit");
    await ui.sleep(2600);
    const animAll = await ui.ev(`return window.__R5_ANIM || []`);
    const marks = await ui.ev(`return window.__R5_ANIM_MARK || []`);
    // 按标记切片：mark[0]~mark[1] = 切阅读方向；mark[1]~末尾 = 切编辑方向
    const animToPreview = animAll.filter((x) => marks.length >= 1 && x.t >= marks[0] && (marks.length < 2 || x.t < marks[1]));
    const animToEdit = animAll.filter((x) => marks.length >= 2 && x.t >= marks[1]);
    ui.log(`[V1-6] 采样 ${animAll.length} 帧，标记=${JSON.stringify(marks)}，` +
      `切阅读段 ${animToPreview.length} 帧 / 切编辑段 ${animToEdit.length} 帧`);
    const summarizeAnim = (arr) => {
      const vals = [...new Set(arr.map((x) => x.v).filter((v) => v !== null))];
      const firstT = arr.find((x) => x.v !== null)?.t ?? null;
      const lastT = [...arr].reverse().find((x) => x.v !== null)?.t ?? null;
      return { vals, firstT, lastT, dur: firstT !== null && lastT !== null ? lastT - firstT : null, frames: arr.filter((x) => x.v !== null).length };
    };
    const aPrev = summarizeAnim(animToPreview);
    const aEdit = summarizeAnim(animToEdit);
    const animOk = aPrev.vals.includes("to-preview") && aEdit.vals.includes("to-edit")
      && aPrev.dur !== null && aPrev.dur >= 200 && aEdit.dur !== null && aEdit.dur >= 200;
    ui.add("V1-6", "R2#11 切模式有过渡动画（`data-lmd-mode-anim` 出现 ≈380ms 后消失）",
      animOk ? "PASS" : "FAIL",
      `→阅读：取值=${JSON.stringify(aPrev.vals)} 可见帧=${aPrev.frames} 持续≈${aPrev.dur}ms；` +
      `→编辑：取值=${JSON.stringify(aEdit.vals)} 可见帧=${aEdit.frames} 持续≈${aEdit.dur}ms；` +
      `（source: styles/modeSwitchSlide.css 的选择器均以该属性为条件）`);
    // 回到编辑模式
    await ui.command("view.edit");
    await ui.sleep(1600);

    /* ─────────────────── V1-7 / V1-9：R2#12 + R3#12 预览开合抖动 ───────────────────
     * 场景：编辑模式下打开/关闭右侧预览，逐帧采样 `.cm-scroller` 的 scrollTop/scrollHeight。
     * 判据：不可解释跳变 ≤3px 且无反拉。
     * 为什么这也是"滚动"项：R3 实证 231px 的跳变与 scrollHeight 跃变**同帧**
     * → 是 CM6 heightMap 分段重估，不是写者互斗；所以要用 linkage 口径。 */
    const v7 = await runAction(ui, {
      tag: "V1-7",
      kind: "cm", scroller: CM, pct: 0.45, ms: 3200, after: 2600,
      async prepare(u) { return await placeCaretMid(u, { kind: "cm" }); },
      async action(u, cfg) {
        /**
         * A4 证据：预览开合**不改变左屏内容高度**（右屏是独立 iframe/壳），
         * 所以 `len/sh` 判"是否生效"必然失败。真正的证据是
         * **`.split-preview-shell` 的宽度真的变了**（这是开合本身）。
         */
        const wBefore = await u.ev(`
          const el = document.querySelector(".split-preview-shell");
          return el ? Math.round(el.getBoundingClientRect().width) : null;
        `);
        await u.command("view.togglePreview");
        await u.sleep(1300);
        const wAfter = await u.ev(`
          const el = document.querySelector(".split-preview-shell");
          return el ? Math.round(el.getBoundingClientRect().width) : null;
        `);
        return {
          ok: true, how: "togglePreview(close)",
          a4: wBefore !== null && wAfter !== null && Math.abs(wAfter - wBefore) > 20,
          shellWidth: { before: wBefore, after: wAfter },
        };
      },
    });
    report(ui, "V1-7", "R2#12 关闭预览：左屏不抖（不可解释跳变≤3px、无回拉）", v7);

    /**
     * ⚠️ V1-7 与 V1-9 之间必须等**上一次开合的收尾彻底结束**
     *
     * 第一版两项紧挨着跑（V1-7 关 → V1-9 开，中间只隔 2600ms）。
     * 结果 V1-9 报 6px 不可解释跳变 + 1 次反拉；而 D2 诊断**单独复测完全不复现**
     * （0px / 写入 1 次写同值 / 无不可解释帧）⇒ 那 6px 是**上一次收尾的残余**被算进来了。
     * 这是采样窗口串扰，不是产品问题 —— 但必须靠"等够"来消除，不能靠调阈值掩盖。
     */
    await ui.sleep(2200);
    await waitStableScroll(ui, CM, { need: 5, gap: 140 });
    const v9 = await runAction(ui, {
      tag: "V1-9",
      kind: "cm", scroller: CM, pct: 0.45, ms: 3400, after: 3000,
      settle: 1000,
      async action(u, cfg) {
        const wBefore = await u.ev(`
          const el = document.querySelector(".split-preview-shell");
          return el ? Math.round(el.getBoundingClientRect().width) : null;
        `);
        await u.command("view.togglePreview");
        await u.sleep(1300);
        const wAfter = await u.ev(`
          const el = document.querySelector(".split-preview-shell");
          return el ? Math.round(el.getBoundingClientRect().width) : null;
        `);
        return {
          ok: true, how: "togglePreview(open)",
          a4: wBefore !== null && wAfter !== null && Math.abs(wAfter - wBefore) > 20,
          shellWidth: { before: wBefore, after: wAfter },
        };
      },
    });
    report(ui, "V1-9", "R3#12 打开预览：左屏不抖（R3 换判据后重修）", v9);

    /* ─────────────────── V1-8：R3#4 插入格式后退格抖动 ───────────────────
     * 场景：格式栏「粗体」→ 不输入 → Backspace（ghost 整段删除路径）。
     * 判据：退格阶段不可解释跳变 ≤3px、无回拉、scrollHeight 不塌。 */
    const v8 = await runAction(ui, {
      tag: "V1-8",
      kind: "cm", scroller: CM, pct: 0.45, ms: 2800, after: 2400,
      async action(u, cfg) {
        const btn = await u.ev(`
          const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
          const b = btns.find(x => (x.getAttribute("title") || "").indexOf("粗体") >= 0);
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        `);
        if (!btn) return { ok: false, why: "找不到粗体按钮" };
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1 });
        await u.sleep(900);
        // 分段：只分析"退格阶段"（点按钮阶段的重排不参与判据）
        const segFromMs = await u.ev(`
          const tr = window.__R5_TR || [];
          return tr.length ? tr[tr.length - 1].t : 0;
        `);
        // A4 证据：插粗体 + 退格后长度会回到原状（格式符被整段删除），不能拿"前后不同"当证据。
        // 正确证据是「**插入阶段确实加长了**」—— 否则退格什么都没删，轨迹恒 0 会假 PASS。
        const insertedLen = await u.ev(`
          const c = document.querySelector(".cm-content");
          const v = c && c.cmTile && c.cmTile.view;
          return v && v.state ? v.state.doc.length : null;
        `);
        await u.ev(`window.__R5_W = []; return true;`);
        await u.key("Backspace", "Backspace", 8);
        return {
          ok: true, how: "toolbar-bold + Backspace", segFromMs,
          a4: typeof insertedLen === "number" && typeof cfg.beforeLen === "number" ? insertedLen > cfg.beforeLen : true,
          insertedLen, beforeLen: cfg.beforeLen,
        };
      },
    });
    report(ui, "V1-8", "R3#4 插入粗体后 Backspace：不抖（ghost 整段删除路径）", v8);

    /* ─────────────────── V1-10：R4#1 语法栏插入瞬间下跳（**核心**） ───────────────────
     * 判据（R4 实证的指纹）：
     * 1. 不可解释跳变 ≤3px、无回拉；
     * 2. **`scrollHeight` 不塌** —— 塌陷 = 整篇 `setText` 替换指纹
     *    （R4 浏览器实测：修复前塌 1595px / 1048px，修复后 Δ+58/Δ+29）。
     * 这两条缺一不可：只看 scrollTop 会被"事后拉回"骗过（R3 的教训）。 */
    const v10a = await runAction(ui, {
      tag: "V1-10a",
      kind: "cm", scroller: CM, pct: 0.45, ms: 2600, after: 2000,
      async action(u, cfg) {
        const it = await centerOf(u, ".syntax-helper-item", "代码块");
        if (!it) return { ok: false, why: "找不到语法栏「代码块」" };
        if (!it.inView) return { ok: false, why: "目标不在视口内", box: it };
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: it.x, y: it.y, button: "left", clickCount: 1 });
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: it.x, y: it.y, button: "left", clickCount: 1 });
        return { ok: true, how: "syntax-codeblock", it };
      },
    });
    report(ui, "V1-10a", "★ R4#1 语法栏「代码块」：单帧≤3px 且 **scrollHeight 不塌**", v10a, {
      passFn: (r) => r.linkage.maxUnexplained <= 3 && r.linkage.counterMoves.length === 0
        && (r.after.sh ?? 0) >= (r.before.sh ?? 0) - 50,
    });

    const v10b = await runAction(ui, {
      tag: "V1-10b",
      kind: "cm", scroller: CM, pct: 0.45, ms: 2600, after: 2000,
      async action(u, cfg) {
        const it = await centerOf(u, ".syntax-helper-item", "粗体");
        if (!it) return { ok: false, why: "找不到语法栏「粗体」" };
        if (!it.inView) return { ok: false, why: "目标不在视口内", box: it };
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: it.x, y: it.y, button: "left", clickCount: 1 });
        await u.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: it.x, y: it.y, button: "left", clickCount: 1 });
        return { ok: true, how: "syntax-bold", it };
      },
    });
    report(ui, "V1-10b", "★ R4#1 语法栏「粗体」（与格式栏同操作，验证**链路**已修）", v10b, {
      passFn: (r) => r.linkage.maxUnexplained <= 3 && r.linkage.counterMoves.length === 0
        && (r.after.sh ?? 0) >= (r.before.sh ?? 0) - 50,
    });

    /* ─────────────────── V1-11：R4#3 阅读面 Ctrl+T → Ctrl+Z（**核心**） ───────────────────
     * 判据（R4 最终口径）：
     * 1. **撤销期滚动写入 0 次** —— 这是"会不会跳"的单变量判据（R4 实证）；
     * 2. 锚段屏幕 Y 段内无回摆；
     * 3. 撤销后结构签名回到原样。
     *
     * ⚠️ `caretY` 只作诊断不参与判定 —— R4 已证伪（插入必然改变排版 + 点按钮抢焦点）。 */
    await ui.command("view.preview");
    await ui.sleep(2200);
    const inReadMode = await ui.ev(`
      const cm = document.querySelector(".cm-editor");
      const pm = document.querySelector(".ProseMirror");
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none"; };
      let m = null; try { m = JSON.parse(localStorage.getItem("lightmd-view-mode") || "{}").viewMode; } catch (e) {}
      return { m, cmVis: vis(cm), pmVis: vis(pm), sh: (document.querySelector(".editor-container")||{}).scrollHeight };
    `);
    ui.log("[V1-11] 阅读模式检查 = " + JSON.stringify(inReadMode));

    if (inReadMode.m !== "preview" || inReadMode.cmVis) {
      ui.add("V1-11", "R4#3 阅读面 Ctrl+T → Ctrl+Z", "KNOWN",
        `无法进入阅读模式（store=${inReadMode.m} cmVis=${inReadMode.cmVis}）→ 该场景不可达`);
    } else {
      // 滚到中部 → 点有序列表项
      await wheelTo(ui, 0.45, PM_SC, { settle: 800 });
      const li = await ui.ev(`
        const sc = document.querySelector(".editor-container");
        if (!sc) return null;
        const scR = sc.getBoundingClientRect();
        const midY = scR.top + sc.clientHeight / 2;
        const items = [];
        for (const el of sc.querySelectorAll("ol > li")) {
          const r = el.getBoundingClientRect();
          if (r.height <= 0) continue;
          items.push({ el, r, d: Math.abs((r.top + r.bottom) / 2 - midY) });
        }
        if (!items.length) return { ok: false, nOl: document.querySelectorAll("ol").length };
        items.sort((a, b) => a.d - b.d);
        const r = items[0].r;
        /**
         * ⚠️ 必须断言点击点在视口内：第一版 y=948 而视口只有 798px → 点到窗外，
         * 靠"恰好滚轮把它带进来了"才没翻车。这是运气，不是断言。
         * 坐标落到视口外时点击**什么都不做**，而那会被读成"产品没反应"。
         */
        const inView = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
        if (!inView) {
          // 把目标滚进视口再取坐标（宁可多一步，也不要"点到窗外"）
          items[0].el.scrollIntoView({ block: "center" });
          const r2 = items[0].el.getBoundingClientRect();
          return {
            ok: true, retried: true,
            x: Math.round(r2.left + 24), y: Math.round(r2.top + r2.height / 2),
            inView: r2.top >= 0 && r2.bottom <= window.innerHeight,
            text: (items[0].el.textContent || "").slice(0, 26), nOl: document.querySelectorAll("ol").length,
          };
        }
        return { ok: true, x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2), inView, text: (items[0].el.textContent || "").slice(0, 26), nOl: document.querySelectorAll("ol").length };
      `);
      ui.log("[V1-11] 有序列表项 = " + JSON.stringify(li));
      if (!li || !li.ok) {
        ui.add("V1-11", "R4#3 阅读面 Ctrl+T → Ctrl+Z", "KNOWN",
          `视口内没有 ordered list 项（ol 总数=${li?.nOl ?? "?"}）→ 场景不可达`);
      } else if (li.inView === false) {
        ui.add("V1-11", "R4#3 阅读面 Ctrl+T → Ctrl+Z", "KNOWN",
          `INVALID：列表项滚动后仍不在视口内（${JSON.stringify(li)}）→ 点不到，不产出结论`);
      } else {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: li.x, y: li.y, button: "left", clickCount: 1 });
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: li.x, y: li.y, button: "left", clickCount: 1 });
        await ui.sleep(450);
        await waitStableScroll(ui, PM_SC, { need: 4 });

        // 逐帧采样：包住「编辑 + 静置 + 撤销」全过程
        await ui.ev(`
          window.__R5_TR = []; window.__R5_T0 = performance.now();
          window.__R5_A = [];
          (function () {
            const T0 = performance.now();
            const tick = () => {
              const sc = document.querySelector(".editor-container");
              const rec = { t: Math.round(performance.now() - T0) };
              if (sc) {
                const scR = sc.getBoundingClientRect();
                rec.st = Math.round(sc.scrollTop * 100) / 100;
                rec.sh = Math.round(sc.scrollHeight);
                rec.ch = Math.round(sc.clientHeight);
                // 锁定锚段：用 PIxx 标记，不用列表项原文 ——
                // Ctrl+T 会把「甲项 PI30A」改成任务项，文字变了，按文字找锚会失效。
                // PIxx 是**段号标记**，跨结构变化仍存在（R4 用的就是这个手法）。
                const AP = ${JSON.stringify((/PI\d{2}/.exec(li.text) || ["PI30"])[0])};
                for (const n of sc.querySelectorAll("li, p, h1, h2, h3")) {
                  if ((n.textContent || "").indexOf(AP) >= 0) {
                    rec.anchorY = Math.round((n.getBoundingClientRect().top - scR.top) * 100) / 100;
                    break;
                  }
                }
              }
              window.__R5_TR.push(rec);
              if (performance.now() - T0 < 5400) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          })();
          return true;
        `);
        await ui.ev(`window.__R5_W = []; return true;`);
        await ui.sleep(150);
        const sigBefore = await ui.ev(readState({ kind: "pm" }));

        // Ctrl+T
        await ui.key("t", "KeyT", 84, 2);
        await ui.sleep(1800);
        const midIdx = await ui.ev(`return (window.__R5_TR || []).length`);
        const sigAfterEdit = await ui.ev(readState({ kind: "pm" }));

        // Ctrl+Z
        await ui.ev(`const pm=document.querySelector(".ProseMirror"); if(pm) pm.focus(); return true;`);
        await ui.sleep(150);
        const undoT0 = await ui.ev(`return Math.round(performance.now())`);
        await ui.ev(`window.__R5_W = []; return true;`);
        await ui.key("z", "KeyZ", 90, 2);
        await ui.sleep(2400);

        const trace = await ui.ev(`return window.__R5_TR || []`);
        const writes = await ui.ev(`return (window.__R5_W || []).map(w => ({ t: w.t, v: w.v, from: w.from, how: w.how, cls: w.cls, s: (w.s || []).slice(0, 4) }))`);
        const sigAfterUndo = await ui.ev(readState({ kind: "pm" }));
        const undoWrites = writes.filter((w) => w.t >= undoT0 - 60);

        const editSeg = trace.slice(0, midIdx).filter((f) => typeof f.anchorY === "number");
        const undoSeg = trace.slice(midIdx).filter((f) => typeof f.anchorY === "number");
        const editA = analyze(editSeg.map((f) => f.anchorY), editSeg.map((f) => f.t));
        const undoA = analyze(undoSeg.map((f) => f.anchorY), undoSeg.map((f) => f.t));

        const editApplied = (sigAfterEdit.sig ?? "") !== (sigBefore.sig ?? "");
        const restored = (sigAfterUndo.sig ?? "") === (sigBefore.sig ?? "");
        const segReversals = Math.max(editA.reversals, undoA.reversals);
        const noWrite = undoWrites.length === 0;
        const pairedCancel = Math.abs((editA.net ?? 0) + (undoA.net ?? 0)) <= 3;
        const smallJump = Math.max(editA.maxJump, undoA.maxJump) <= 3;
        const pass = editApplied && restored && segReversals === 0 && noWrite && (smallJump || pairedCancel);
        ui.log(`[V1-11] 编辑段 maxJump=${editA.maxJump} 反转=${editA.reversals} 净=${editA.net}；` +
          `撤销段 maxJump=${undoA.maxJump} 反转=${undoA.reversals} 净=${undoA.net}；` +
          `撤销期写入=${undoWrites.length}；结构变化=${editApplied} 还原=${restored}`);

        ui.add("V1-11", "★ R4#3 阅读面 Ctrl+T → Ctrl+Z：**撤销期滚动写入 0 次** + 无回摆 + 结构还原",
          pass ? "PASS" : "FAIL",
          `撤销期滚动写入=${undoWrites.length}（需 0）；锚段Y 编辑段 maxJump=${editA.maxJump}px 反转=${editA.reversals} 净=${editA.net}；` +
          `撤销段 maxJump=${undoA.maxJump}px 反转=${undoA.reversals} 净=${undoA.net}；` +
          `编辑生效=${editApplied} 撤销还原=${restored}；` +
          `成对抵消=${pairedCancel}；写入详情=${JSON.stringify(undoWrites.slice(0, 5).map((w) => `${w.from}->${w.v}@${w.how}`))}`);
      }
    }

    await ui.shot("main-done");
  },
);

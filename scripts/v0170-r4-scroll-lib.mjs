/**
 * v0.17.0 第四轮 · T2「插入/撤销 滚动跳动」探针共用库
 *
 * ## 与上一轮（`v0170-r3-jitter-lib.mjs`）的关系
 *
 * 上一轮那份是为「单场景 × 逐帧曲线」写的，能给出 `maxJump / reversals / deltas`。
 * 本轮有 **4 条插入路径 + 1 个矩阵**，共 10+ 个场景要跑，单场景代码若复制 4 遍
 * 一定会在某个场景里漏装桩/漏前置断言（上一轮 5 个探针坑全是这么来的）。
 * 所以这里把「前置断言 + 装桩 + 采样 + 判据」收成一个 `runScenario()`，
 * 场景之间只差「怎么触发插入」这一个回调。
 *
 * ## 本轮必须守住的三条口径（都是前两轮付过学费的）
 *
 * 1. **判"抖"用 `scrollTop` 曲线，判"内容跑没跑"用 PI 段号**。
 *    R2 教训：整篇替换后 `scrollTop` 本来就该变 —— 只看像素 Δ 会把"正常重排"
 *    当成缺陷，也会把"像素被拉回、内容其实偏了 7 段"当成修好（R3 #4 的实测反例）。
 * 2. **前置条件不成立要响亮地 FAIL，不产出产品结论**。
 *    R3 #1 探针 1.0 因为光标没放好，产出了 1442px 的**假数据**。
 *    本轮 `A1~A5` 任一不满足 → 该场景标 INVALID，`runScenario` 返回 `invalid`，
 *    上层**不得**把它当成"产品通过"或"产品失败"。
 * 3. **smooth 滚动不经过 `scrollTop` setter，必须同时 hook `scrollTo/scrollBy`**。
 *    R3 探针第一版只 hook setter，得出"零写入"的错误结论。
 */

/* ══════════════════════════════════════════════════════════════════════
 * 一、页面内仪器（字符串形式，注入到被测页面）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 滚动写入打桩：记录**谁**写了 scrollTop、写了多少、从哪来（调用栈）。
 *
 * ⚠️ 这里是"找真凶"的唯一手段：上一轮 #12 就是靠它发现"窗口内两个写者交替写了 7 次"。
 * 本轮判据只判现象，但**报告里必须给出写入溯源** —— 否则修完也不知道修的是不是那一条。
 */
export const INSTALL_SPY = `
  if (!window.__R4_SPY) {
    window.__R4_SPY = true;
    window.__R4_WRITES = [];
    const interesting = (el) => {
      const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
      return String(cls).includes("cm-scroller")
        || String(cls).includes("editor-container")
        || String(cls).includes("source-editor")
        || String(cls).includes("ProseMirror");
    };
    const nameOf = (el) => {
      const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
      return String(cls).slice(0, 44);
    };
    const rec = (el, v, how) => {
      try {
        if (!interesting(el)) return;
        const stack = (new Error().stack || "").split("\\n").slice(1, 18)
          .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 120));
        window.__R4_WRITES.push({
          t: Math.round(performance.now()), v: Math.round(v), from: Math.round(el.scrollTop),
          k: nameOf(el), how, stack,
        });
      } catch (e) {}
    };
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true, enumerable: proto.enumerable,
      get() { return proto.get.call(this); },
      set(v) { rec(this, v, "scrollTop="); return proto.set.call(this, v); },
    });
    for (const m of ["scrollTo", "scrollBy"]) {
      const orig = Element.prototype[m];
      if (!orig) continue;
      Element.prototype[m] = function (a, b) {
        try {
          const top = (typeof a === "object" && a) ? a.top : b;
          if (typeof top === "number") rec(this, top, m + "()");
        } catch (e) {}
        return orig.call(this, a, b);
      };
    }
    /** scrollIntoView 也要抓：PM 的 tr.scrollIntoView() 走这条，不经 scrollTop setter */
    const siv = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg) {
      try {
        const cls = (this.className && typeof this.className === "string") ? this.className : (this.tagName || "");
        const stack = (new Error().stack || "").split("\\n").slice(1, 18)
          .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 120));
        window.__R4_WRITES.push({
          t: Math.round(performance.now()), v: -1, from: -1,
          k: String(cls).slice(0, 44), how: "scrollIntoView", arg: JSON.stringify(arg || null), stack,
        });
      } catch (e) {}
      return siv.apply(this, arguments);
    };
  }
  return true;
`;

/**
 * 逐帧采样（rAF ≈ 16ms）。
 *
 * 记的量与"用户眼睛跟着什么走"一一对应：
 * - `st`      滚动位置（判断"跳"：相邻帧差 > 3px 记一次跳）
 * - `pi/piTop` 视口中心那一块的**段号**与其**屏幕 Y**（判断"内容跑没跑"、细到像素）
 * - `caretY`  插入符号屏幕 Y（用户"插入后接着打字"的落点，跳动 = 视线被打断）
 * - `max`     可滚动上限（用来判断"是否被钳到底/到顶"，那是硬跳的常见成因）
 *
 * `kind` 决定用哪套选择器：`cm` = CM6 编辑面，`pm` = ProseMirror 阅读面。
 */
export const startTrace = (opts) => {
  const ms = opts.ms ?? 2600;
  const kind = JSON.stringify(opts.kind ?? "cm");
  const scrollerSel = JSON.stringify(opts.scroller ?? (opts.kind === "pm" ? ".editor-container" : ".cm-scroller"));
  const anchorPi = JSON.stringify(opts.anchorPi ?? null);
  return `
  window.__R4_TR = [];
  (function () {
    const T0 = performance.now();
    window.__R4_T0 = T0;
    const KIND = ${kind};
    const SEL = ${scrollerSel};
    const AP = ${anchorPi};
    const blockSel = "p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, .cm-line";
    const tick = () => {
      const rec = { t: Math.round(performance.now() - T0) };
      const sc = document.querySelector(SEL);
      if (sc) {
        const scR = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        rec.ch = Math.round(sc.clientHeight);
        rec.max = Math.round(sc.scrollHeight - sc.clientHeight);
        const midY = scR.top + sc.clientHeight / 2;
        let best = null, bestD = Infinity;
        for (const el of sc.querySelectorAll(blockSel)) {
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
            if (s && s.rangeCount) {
              rec.caretY = Math.round((s.getRangeAt(0).getBoundingClientRect().top - scR.top) * 100) / 100;
            }
          } catch (e) {}
        }
      }
      window.__R4_TR.push(rec);
      if (performance.now() - T0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;
};

/**
 * 读稳态量。`kind` 决定焦点/滚动容器口径；`fullText` 用**权威来源**而不是拼 DOM：
 * CM6 虚拟化（视口外 .cm-line 不在 DOM）、PM 则整篇在 DOM 里但会含标记语法。
 */
export const readState = (opts) => {
  const kind = JSON.stringify(opts.kind ?? "cm");
  const scrollerSel = JSON.stringify(opts.scroller ?? (opts.kind === "pm" ? ".editor-container" : ".cm-scroller"));
  return `
  const round = (n) => Math.round(n * 100) / 100;
  const sc = document.querySelector(${scrollerSel});
  if (!sc) return { ok: false, why: "no-scroller" };
  const scR = sc.getBoundingClientRect();
  const midY = scR.top + sc.clientHeight / 2;
  let best = null, bestD = Infinity;
  for (const el of sc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, .cm-line")) {
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
    pi: best ? Number(((/PI(\\d{2})/.exec(best.textContent || "")) || [])[1]) : null,
    piTop: best ? round(best.getBoundingClientRect().top - scR.top) : null,
  };
  if (${kind} === "cm") {
    const cur = sc.querySelector(".cm-cursor");
    out.caretY = cur ? round(cur.getBoundingClientRect().top - scR.top) : null;
    out.focused = !!document.querySelector(".cm-focused");
    const ae = document.activeElement;
    out.ae = ae ? String(ae.className || ae.tagName).slice(0, 40) : "none";
    // ⚠️ CM6 是虚拟化渲染：只能走内部 view.state.doc 读全文，不能拼 .cm-line
    try {
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      if (v && v.state && v.state.doc) { out.text = v.state.doc.toString(); out.textFull = true; }
    } catch (e) {}
  } else {
    out.focused = !!document.querySelector(".ProseMirror-focused");
    try {
      const s = window.getSelection();
      if (s && s.rangeCount) out.caretY = round(s.getRangeAt(0).getBoundingClientRect().top - scR.top);
    } catch (e) {}
    const pm = document.querySelector(".ProseMirror");
    if (pm) { out.text = pm.textContent || ""; out.textFull = true; }
    /**
     * ## 结构签名（sig）—— 判"编辑是否真的生效"的唯一可靠量
     *
     * 踩过的坑：用 'textContent' 判 A4「编辑生效」会把**成功的结构性编辑**判成未生效。
     * 「加粗」只加 mark、「标题」只换 node 类型、「列表」只包一层 —— **文本一个字都没变**。
     * 第一版矩阵因此 4/6 INVALID（见 v0170-r4-undo 的产物）。
     *
     * 正确做法：把 PM doc 的「节点类型 + mark 类型 + 文本长度」序列化成一串。
     * 任何结构性编辑必然改变它；纯文本编辑也会。代价 O(节点数)，几十个块可以忽略。
     *
     * 用 pmViewDesc.node（PM 把 doc 挂在这里）而不是读 DOM —— DOM 只反映可见块，
     * 且 mark 的 DOM 表示（strong 标签）与 mark 本身不完全一一对应。
     */
    try {
      const desc = pm && pm.pmViewDesc;
      const doc = desc && desc.node;
      if (doc && typeof doc.descendants === "function") {
        const parts = [];
        doc.descendants((node) => {
          if (node.isText) {
            parts.push("t" + node.text.length + "[" + node.marks.map((m) => m.type.name).join(",") + "]");
            return false;
          }
          parts.push(node.type.name + (node.attrs && Object.keys(node.attrs).length
            ? "(" + Object.entries(node.attrs).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => k + "=" + String(v)).join(",") + ")"
            : ""));
          return true;
        });
        out.sig = parts.join("|");
        out.sigLen = parts.length;
      }
    } catch (e) { out.sig = null; }
  }
  return out;
`;
};

/* ══════════════════════════════════════════════════════════════════════
 * 二、曲线分析（纯 Node 侧）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 逐帧轨迹 → 观感指标。
 *
 * 口径论证（写进报告要复用）：
 * - `maxJump`：相邻帧观测量差的最大值。60Hz 下 **3px/帧 = 180px/s**，
 *   超过它人眼就会把连续滚动看成"顿一下"。取**最大值**而不是均值，
 *   因为用户看到的就是那一次跳（均值会被大量 0 稀释）。
 * - `reversals`：位移方向反转次数。单调移动叫"滚动"，来回摆才叫"抖"。
 * - `jumps`：所有 >3px 的单帧位移（报告里列出来，最硬的证据）。
 */
export function analyze(seqRaw, tArr, field) {
  /**
   * ## ⚠️ 必须"断开空洞"，不能压缩掉 null 再算差（第一版在这里产出过假数据）
   *
   * 第一版实现是 `seq.filter(v => typeof v === "number")` 之后再算相邻差。
   * 于是"某个量在中间缺失了几帧"会被压缩成"相邻两帧"，差值就成了伪影。
   *
   * 实测伪影（P1 格式栏「粗体」，`caretY` 报 **547px** 单帧跳变）：
   * 点按钮时焦点从 `.cm-content` 移到 `<button>` → CM6 的 `drawSelection()`
   * **销毁 `.cm-cursor` 元素**（光标不可见）→ 该帧 `caretY = null` 被过滤掉 →
   * 焦点回来后光标在新位置重建 → 相邻两条有效采样之间隔了几帧 + 一次真实的
   * 位置变更，一并被算成"一帧跳 547px"。
   *
   * 但产品上"点按钮时按钮拿到焦点"是**必然**的（`.format-btn` 是真实 button），
   * 它不是缺陷，更不是"光标跳了 547px"。真正该判的是**回到编辑态后光标落点**，
   * 那由 `caretY` 首末值对照（`net`）与"断点数量"表达，不是 `maxJump`。
   *
   * 所以这里改成：**只在原数组相邻索引之间算差**，跨 null 的区间单列为 `gaps`。
   * 对 `st`（滚动位置，几乎不会缺失）行为与第一版一致；对 `caretY` 则不再撒谎。
   */
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
    // 只有"上一条原数组索引也是有效值"时才算差
    const prev = i > 0 ? seqRaw[i - 1] : undefined;
    if (typeof prev === "number" && Number.isFinite(prev)) {
      const d = Math.round((v - prev) * 100) / 100;
      deltas.push(d);
      const a = Math.abs(d);
      if (a > maxJump) maxJump = a;
      if (a > 3) jumps.push({ frame: i, t: tArr ? tArr[i] : null, from: prev, to: v, d });
    }
  }
  if (pts.length < 2) {
    return { n: pts.length, maxJump: 0, reversals: 0, net: 0, jumps: [], deltas: [], gaps, first: pts[0]?.v, last: pts[0]?.v };
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
    min: Math.min(...pts.map((p) => p.v)),
    max: Math.max(...pts.map((p) => p.v)),
    net: Math.round((pts[pts.length - 1].v - pts[0].v) * 100) / 100,
    frames: deltas.filter((d) => Math.abs(d) >= 0.05).length,
    maxJump: Math.round(maxJump * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    jumps: jumps.slice(0, 12),
    jumpsCount: jumps.length,
    /** 采样空洞（该量在若干帧里不存在，例如光标元素被销毁）。不是跳变，别当跳变读 */
    gaps,
    gapCount: gaps.length,
    deltas,
  };
}

/** 从 trace 里抽字段 + 分析 */
export function track(trace, field) {
  return analyze(trace.map((s) => s[field]), trace.map((s) => s.t), field);
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、浏览器侧动作（滚轮 / 放光标 / 定位元素）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 真实滚轮滚到目标比例。
 *
 * ⚠️ **绝不能用 `scroller.scrollTop = x` 瞬移**（R2 的教训）：CM6 的 `scrollHeight`
 * 来自 heightMap，视口上方没测量过的区块是**估算高度**；瞬移之后任何一次 dispatch
 * 触发重新测量 → 估算被修正 → 总高度变上千像素 → 视口里的**内容**自己就变了
 * （实测 PI30 → PI37），会被误判成"滚动跳动缺陷"。
 * 真实滚轮走原生滚动路径，CM6 按滚动过程逐段测量，无此伪影。
 */
export async function wheelTo(ui, pct, scrollerSel, opts = {}) {
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
    await ui.wheel(box.x, box.y, -Math.min(step * 4, cur));
    cur = await ui.ev(`return Math.round(document.querySelector(${JSON.stringify(scrollerSel)}).scrollTop)`);
  }
  guard = 0;
  while (cur < target - 6 && guard++ < 900) {
    await ui.wheel(box.x, box.y, Math.min(step, target - cur));
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

/**
 * 等滚动**真正稳定**（连续 N 次读数不变）。
 *
 * ⚠️ 这是前置断言 A3 的实现。没有它，采样窗口会与上文动作的滚动尾巴重叠，
 * 首帧就被算进轨迹 → 假的 `maxJump`（R3 #1 探针 1.0 的第二个坑）。
 */
export async function waitStableScroll(ui, scrollerSel, opts = {}) {
  const need = opts.need ?? 4;
  const gap = opts.gap ?? 120;
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
 * 把光标放到"视口中部某个含 PIxx 的块上"。
 *
 * ⚠️ R3 #1 探针 1.0 就是因为"点击视口中央段落经常失败（点击目标 = null）"
 * 而让光标留在文档开头，打字机把文档顶部居中 → 得出 1442px 的**假数据**。
 * 所以本函数返回 `null` 时调用方必须标 INVALID，**不许继续跑**。
 */
export async function placeCaretMid(ui, opts) {
  const kind = opts.kind ?? "cm";
  const scrollerSel = opts.scroller ?? (kind === "pm" ? ".editor-container" : ".cm-scroller");
  const xOff = opts.xOff ?? 40;
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
      x: Math.round(r.left + Math.min(${xOff}, Math.max(8, r.width - 8))),
      y: Math.round(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2))),
      text: (best.textContent || "").trim().slice(0, 40),
      usable: r.bottom <= scR.bottom && r.top >= scR.top,
    };
  `);
  if (!pt) return null;
  await ui.click(pt.x, pt.y);
  await ui.sleep(400);
  return pt;
}

/** 定位一个元素并返回其中心点（找不到返回 null —— 调用方必须据此 FAIL） */
export async function centerOf(ui, selector, textContains) {
  return await ui.ev(`
    const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const el = ${JSON.stringify(textContains ?? null)}
      ? all.find(e => ((e.textContent || "") + " " + (e.getAttribute("title") || "") + " " + (e.getAttribute("aria-label") || "")).indexOf(${JSON.stringify(textContains)}) >= 0)
      : all[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (el.textContent || "").trim().slice(0, 40) };
  `);
}

/** 右键（打开源码面右键菜单）*/
export async function rightClick(ui, x, y) {
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
  await ui.sleep(350);
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、场景执行器（前置断言 + 采样 + 判据）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 跑一个「插入」场景并给出严格判据。
 *
 * ## 为什么把前置断言做成"门"
 *
 * 三个前置条件任一不成立，测出来的数字**不代表产品**：
 * - A1 文档不可滚动（`max <= 200`）→ 任何 scrollTop 变化都被钳死，恒 0，**判据恒真**；
 * - A2 光标不在视口中部 → 用户根本没在"看着中间"做操作，跳一下也无感，**判据失效**；
 * - A3 采样前滚动不稳 → 上文的滚动尾巴被算进轨迹，**假的 maxJump**；
 * - A4 插入没真的发生 → 什么都没动，**恒 PASS**（这是最危险的假绿）。
 *
 * 任一失败 → 返回 `{ invalid: true }`，**不产出产品结论**。
 *
 * @param trigger 触发插入的异步回调（点按钮 / 右键选菜单 / 按键…）
 */
export async function runScenario(ui, cfg) {
  const kind = cfg.kind ?? "cm";
  const scroller = cfg.scroller ?? (kind === "pm" ? ".editor-container" : ".cm-scroller");
  const tag = cfg.tag;

  // ── 定位到指定滚动比例 + 放光标 ──
  if (cfg.pct !== undefined) {
    await wheelTo(ui, cfg.pct, scroller, { settle: cfg.settle ?? 700 });
  }
  const placed = cfg.prepare ? await cfg.prepare(ui) : await placeCaretMid(ui, { kind, scroller });
  if (!placed) return { invalid: true, why: "A2 光标没能放到预期位置（点击目标 = null）", tag };
  await ui.sleep(300);

  const before = await ui.ev(readState({ kind, scroller }));

  // ── A1：文档确实可滚动 ──
  const a1 = before.ok && before.max > 200;
  // ── A3：采样前滚动已稳定 ──
  const stable = await waitStableScroll(ui, scroller, { need: 4, gap: 110 });
  const before2 = await ui.ev(readState({ kind, scroller }));
  // ── A2：光标落在视口内（含 ±2px 容差）──
  const a2 = before2.caretY !== null && before2.caretY !== undefined
    && before2.caretY >= -2 && before2.caretY <= before2.ch + 2;
  // ── A5：内容锚可用（视口中心能读到 PI 段号）──
  const a5 = before2.pi !== null && before2.pi !== undefined;

  if (!a1 || !a2 || !a5 || !stable.ok) {
    return {
      invalid: true, tag,
      why: [
        !a1 && `A1 文档不可滚动(max=${before.max})`,
        !a2 && `A2 光标不在视口内(caretY=${before2.caretY})`,
        !a5 && "A5 视口中心读不到 PI 段号",
        !stable.ok && "A3 采样前滚动不稳定",
      ].filter(Boolean).join("；"),
      before: before2,
    };
  }

  // ── 装桩、清日志、起采样 ──
  await ui.ev(INSTALL_SPY);
  await ui.ev(`window.__R4_WRITES = []; return true;`);
  const anchorPi = "PI" + String(before2.pi).padStart(2, "0");
  const beforeText = before2.text ?? "";
  await ui.ev(startTrace({ ms: cfg.ms ?? 2800, kind, scroller, anchorPi }));
  await ui.sleep(90);

  const markT0 = await ui.ev(`return Math.round(performance.now())`);

  // ── 触发插入（这一步是每个场景唯一的差别）──
  const trig = await cfg.trigger(ui, cfg);
  await ui.sleep(cfg.after ?? 2400);

  const trace = await ui.ev(`return window.__R4_TR || []`);
  const writes = await ui.ev(`return (window.__R4_WRITES || []).map(w => ({ t: w.t, v: w.v, from: w.from, k: w.k, how: w.how, arg: w.arg, s: (w.stack||[]).slice(0,5) }))`);
  const after = await ui.ev(readState({ kind, scroller }));

  // ── A4：插入确实发生了（否则整场恒 PASS —— 最危险的假绿）──
  const lenBefore = (beforeText || "").length;
  const lenAfter = (after.text || "").length;
  const a4 = trig && trig.ok !== false && lenAfter !== lenBefore;

  const stA = track(trace, "st");
  const piA = track(trace, "piTop");
  const caretA = track(trace, "caretY");
  const piSet = [...new Set(trace.map((s) => s.pi).filter((v) => v !== null && v !== undefined))];

  const nWrites = writes.length;
  const bigWrites = writes.filter((w) => w.v >= 0 && Math.abs(w.v - w.from) > 3);

  const rec = {
    tag, before: before2, after, trig, trace, writes,
    st: stA, pi: piA, caret: caretA, piSet,
    lenBefore, lenAfter, a4,
    writeCount: nWrites,
    bigWrites,
    t0: markT0,
    invalid: false,
  };

  /* ══════════════════════════════════════════════════════════════════
   * 逐帧联动分析：把「不可解释的跳变」与「正常重排」分开
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * ## 为什么必须做"联动"分析（这是本轮判据的核心，也是前两轮教训的落点）
   *
   * R2 教训：「整篇替换后 `scrollTop` **本来就该变**，判据必须是**内容**不变」。
   * 但反过来也成立 —— 只看"`scrollTop` 有没有动"会把**正常重排**判成缺陷：
   *
   * 实测（P3 右键插入代码块、P4 斜杠插入代码块）：
   * ```
   * scrollTop    3656 → 3742（Δ+86）
   * scrollHeight 8883 → 8969（Δ+86）   ← 完全同步！
   * 视口中心 PI  28 → 28（**内容没跑**）
   * ```
   * 这是"插入多行模板 → 文档变高 86px → 视口按内容锚补偿下移 86px"，
   * **是正确行为**，用户看到的内容一点没动。
   *
   * 所以判"跳"必须问：**这一帧的位移，能不能被同一帧的高度变化解释？**
   * - `|Δst| ≤ |Δsh| + 3` → 可解释（重排补偿），**不算跳**；
   * - `|Δst| > |Δsh| + 3` → **不可解释的跳变**（高度没变那么多，视口却跑了），算跳。
   *
   * 但这还不够，因为"真实抖动"的另一种形态是**来回摆**：
   * 即使每一次位移都被高度变化解释，只要**方向反复反转**，用户看到的就是抖。
   * 所以还要看**反拉（counter-move）**：同一段操作里，先往一个方向走、
   * 随后又往反方向走超过 3px —— 那是两个写者在打架（R3 #12 的形态）。
   * P3/P4 实测正是这种：`+118 → -55 → +118 → -55 …` 交替 3 轮。
   *
   * @returns `{ jumps, counterMoves, maxUnexplained }`
   */
  function analyzeLinkage(trace) {
    const jumps = [];          // 不可解释的跳变（高度解释不了）
    const counterMoves = [];   // 反拉：某次位移之后，反方向又走了 >3px
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
        jumps.push({ frame: i, t: trace[i].t, dst: Math.round(dst * 100) / 100, dsh: Math.round(dsh * 100) / 100, unexplained: Math.round(unexplained * 100) / 100 });
      }
    }
    // 反拉检测：按"非零位移方向段"压缩，相邻两段方向相反且后一段幅度 >3px
    const runs = [];
    for (let i = 1; i < trace.length; i++) {
      const d = sts[i] - sts[i - 1];
      if (!Number.isFinite(d) || Math.abs(d) < 0.5) continue;
      const sign = d > 0 ? 1 : -1;
      if (!runs.length || runs[runs.length - 1].sign !== sign) runs.push({ sign, sum: 0, startFrame: i });
      runs[runs.length - 1].sum += d;
    }
    for (let k = 1; k < runs.length; k++) {
      if (Math.abs(runs[k].sum) > 3) {
        counterMoves.push({
          frame: runs[k].startFrame,
          t: trace[runs[k].startFrame]?.t ?? null,
          prevSum: Math.round(runs[k - 1].sum * 100) / 100,
          curSum: Math.round(runs[k].sum * 100) / 100,
        });
      }
    }
    return { jumps, counterMoves, maxUnexplained: Math.round(maxUnexplained * 100) / 100 };
  }

  const linkage = analyzeLinkage(trace);
  rec.linkage = linkage;

  /**
   * 判据（口径经本轮实测订正，理由见上面 analyzeLinkage 的长注释）：
   *
   * 1. **内容不变**（主判据）：视口中心 PI 段号只出现 1 种取值。
   *    这是"用户会不会觉得视野跑到别处"的唯一直接量。
   * 2. **没有不可解释的跳变**：每帧位移都能被同帧 `scrollHeight` 变化解释（容差 3px）。
   *    比裸的 `|Δst| ≤ 3` 精确 —— 后者会把"内容变高 86px、视口跟着下移 86px"
   *    这种**正确补偿**判成缺陷（P3/P4 实测反例）。
   * 3. **没有反拉**：方向不来回摆。这是"抖"的字面定义，也是多写者打架的指纹。
   *
   * ## ⚠️ `caretY` 为什么**不作判据**，只作诊断（本轮最重要的判据订正）
   *
   * 任务卡写的是「`caretY` 屏幕位移 ≤ 2px」。本轮实测证明这条**会把正确行为判成缺陷**，
   * 有两处独立的证伪：
   *
   * **(a) 插入必然改变文档长度 → 光标视觉位置合理变化**
   * ```
   * P2 语法栏代码块：插入 `\n```\n\n```\n`（8105→8115 字符）
   *   caretY 421.5 → 478.1（+56.6px）  ← 光标落进围栏内，位置本来就在下一行
   * P1 格式栏粗体：插入 `****`（8101→8105 字符）
   *   caretY 432.8 → 405.0（-27.8px）  ← 该段发生软换行，光标视觉行上移一行
   * ```
   * 两者都是**正确的排版结果**。要求"光标不动"等于要求"插入不许改变排版"。
   *
   * **(b) 点按钮必然抢焦点 → `.cm-cursor` 被销毁重建 → 中途读数不可用**
   * `.format-btn` / `.syntax-helper-item` / 右键菜单项都是真实可聚焦元素，
   * 点它们时焦点离开 `.cm-content`，CM6 的 `drawSelection()` 随即移除 `.cm-cursor`。
   * 第一版拿 `caretY.maxJump` 当判据，读出 **547 / 658px 的"跳变"** ——
   * 那是仪器伪影（与 R3 #1 的 1442px 假数据同一类错误）。
   *
   * **(c) 这个错我自己上一轮已经记进报告了，本轮又犯了一次**
   * `_plan/v0170-r3-t2-scroll-jitter.md` 的「判据订正表」第 3 条原文：
   * > 把 `caretY.maxJump > 3` 算作"抖" → 退格删一行光标上移恰好一个行高 →
   * > B 组（本应完全不动）被误判 → **只看 scrollTop 与内容锚；caretY 仅作诊断。
   * > 光标本来就该随内容移动**
   *
   * 所以本轮按**上一轮已经证伪后的口径**执行：`caretY` 只输出诊断值
   * （net / 可见性 / maxJump / 空洞数），不参与 PASS/FAIL。
   * 报告里会显式说明"任务卡这条判据经实测证伪，改口径的理由与证据"。
   */
  rec.verdict = {
    contentStable: piSet.length <= 1,
    /** 不可解释的跳变（高度变化解释不了的那部分）≤ 3px */
    stJumpOk: linkage.maxUnexplained <= 3,
    /** 没有反拉（来回摆）*/
    stNoReverse: linkage.counterMoves.length === 0,
    // 内容变长 1~40 字符属"插入语法符"，超过说明不是插入而是整篇换
    lengthSane: lenAfter > lenBefore && lenAfter - lenBefore <= 60,
  };
  rec.caretDetail = {
    net: caretA.net,
    endY: caretA.last,
    ch: after.ch,
    visible: caretA.last !== null && caretA.last >= -2 && caretA.last <= after.ch + 2,
    maxJump: caretA.maxJump,
    gaps: caretA.gapCount ?? 0,
    mode: cfg.multiline ? "multiline" : "inline",
    /** 诊断：⌈是否被甩出视口⌋，供人判断是否需要进一步排查 */
    teleport: caretA.maxJump > after.ch * 0.5,
  };
  /**
   * 总判定 = 三条核心判据同时成立。
   * ⚠️ 这里**不再包含 `caretOk`** —— 见上方 verdict 注释里对任务卡第 4 条判据的
   * 实测证伪（`caretY` 会随插入改变的排版合理移动；且点按钮抢焦点会让读数出现伪影）。
   * `caretY` 的全部数字仍在 `caretDetail` 里输出，供人工核对，不参与 PASS/FAIL。
   */
  rec.pass = a4
    && rec.verdict.contentStable
    && rec.verdict.stJumpOk
    && rec.verdict.stNoReverse;
  return rec;
}

/** 把一次 `runScenario` 的结果写成一行 PASS/FAIL/KNOWN */
export function report(ui, id, name, rec, opts = {}) {
  if (!rec) { ui.add(id, name, "FAIL", "场景未执行"); return; }
  if (rec.invalid) {
    // ⚠️ 前置条件不成立 = INVALID，不产出产品结论（用 KNOWN 表示"这轮没测到"，不是 PASS）
    ui.add(id, name + "（前置断言不通过 → INVALID，不产出结论）", "KNOWN", rec.why);
    return;
  }
  if (!rec.a4) {
    ui.add(id, name + "（插入未生效 → 判据不适用）", "FAIL",
      `len ${rec.lenBefore}→${rec.lenAfter}；触发=${JSON.stringify(rec.trig)}`);
    return;
  }
  const v = rec.verdict;
  const lk = rec.linkage ?? { jumps: [], counterMoves: [], maxUnexplained: 0 };
  const detail =
    `PI 轨迹=${JSON.stringify(rec.piSet)}（内容不变=${v.contentStable}）；` +
    `**不可解释的跳变 max=${lk.maxUnexplained}px**（≤3：${v.stJumpOk}，共 ${lk.jumps.length} 次）；` +
    `**反拉 ${lk.counterMoves.length} 次**（需=0：${v.stNoReverse}）` +
    (lk.counterMoves.length ? `：${JSON.stringify(lk.counterMoves.slice(0, 3).map((c) => `${c.prevSum}→${c.curSum}`))}` : "") + `；` +
    `scrollTop ${rec.before.st}→${rec.after.st}；scrollHeight ${rec.before.sh}→${rec.after.sh}` +
    (rec.after.sh - rec.before.sh === 0 ? "（**Δ0，整篇替换指纹消失**）" : `（Δ${rec.after.sh - rec.before.sh}）`) + `；` +
    `文档长度 ${rec.lenBefore}→${rec.lenAfter}；滚动写入 ${rec.writeCount} 次；` +
    `【诊断，不判】caretY 净=${rec.caretDetail.net}px 可见=${rec.caretDetail.visible} maxJump=${rec.caretDetail.maxJump}px 空洞=${rec.caretDetail.gaps}`;
  ui.add(id, name, opts.knownOnly ? "KNOWN" : (rec.pass ? "PASS" : "FAIL"), detail);
}

/** 打印一次场景的完整证据（含滚动写入调用栈 —— 报告里要引用） */
export function dump(ui, rec) {
  if (!rec || rec.invalid) { ui.log(`[${rec?.tag}] INVALID: ${rec?.why}`); return; }
  ui.log(`[${rec.tag}] before=${JSON.stringify({ st: rec.before.st, sh: rec.before.sh, max: rec.before.max, pi: rec.before.pi, piTop: rec.before.piTop, caretY: rec.before.caretY })}`);
  ui.log(`[${rec.tag}] after =${JSON.stringify({ st: rec.after.st, sh: rec.after.sh, max: rec.after.max, pi: rec.after.pi, piTop: rec.after.piTop, caretY: rec.after.caretY })}`);
  ui.log(`[${rec.tag}] PI 轨迹=${JSON.stringify(rec.piSet)}  采样帧=${rec.trace.length}`);
  ui.log(`[${rec.tag}] scrollTop Δ序列(前60)=${JSON.stringify(rec.st.deltas.slice(0, 60))}`);
  ui.log(`[${rec.tag}] caretY  Δ序列(前40)=${JSON.stringify(rec.caret.deltas.slice(0, 40))}`);
  ui.log(`[${rec.tag}] 滚动写入 ${rec.writes.length} 次：`);
  for (const w of rec.writes.slice(0, 14)) {
    ui.log(`    ${w.how} ${w.from}->${w.v} @${w.k} ${w.arg || ""}`);
    for (const s of (w.s || []).slice(1, 4)) ui.log(`        ${s}`);
  }
  ui.log(`[${rec.tag}] verdict=${JSON.stringify(rec.verdict)}  pass=${rec.pass}`);
}

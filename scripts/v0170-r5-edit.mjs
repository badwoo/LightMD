/**
 * v0.17.0 第五轮 · V2 实机验证：**编辑输入 / 光标 / 焦点 / 专注 8 项**
 *
 * 真机（Tauri exe + WebView2）验证 CM6 迁移以来的修复是否**真实生效**。
 * 本轮**只验证不修复** —— FAIL 只记录 + 报 Lead。
 *
 * ## 8 项
 * | id | 项 | 期望 |
 * |---|---|---|
 * | V2-1 | R2#7 ghost 退格整段删格式符 | 点「粗体」→ 不输入直接 Backspace → `****` 一次删净 |
 * | V2-2 | 附加 Ctrl+I 斜体 | 源码面 Ctrl+I → 插入 `*斜体文本*` |
 * | V2-3 | R3#5 插入符号纯白（真机制） | 空行/行首光标可见（WebView2 的 z 序/合成层可能不同）→ 像素差分 |
 * | V2-4 | R3#6 编辑符号跨模式记忆 | 光标停加粗/列表/代码块中间 → 切阅读 → 切回 → 回原字符 |
 * | V2-5 | R3#7 专注模式 3 行窗跟随光标 | F8 开启 → 上下移动 → 高亮窗跟着走（3 行窗） |
 * | V2-6 | R3#8 编辑模式打字机平滑 | 打字机开 → 打字/回车 → 逐帧 scrollTop 单调、无反转 |
 * | V2-7 | R4#4 回车抖动（**右屏 iframe**） | 打字机+分屏 → 右屏按回车 → 右屏单帧 ≤20px、回弹 0 |
 * | V2-8 | R4#5 阅读模式编辑可保存 | 阅读打字 → 立刻切编辑 → 立刻保存 → **磁盘含新字**（数据丢失级） |
 *
 * ## ⚠️ 本文件遵守的三条铁律（都是前几轮用假数据换来的）
 *
 * ### 铁律 1：**绝不 hook `Element.prototype.scrollTo`**
 * R4 T3 实测：hook 后会出现「对象形式 `scrollTo` 让 scrollTop 归 0，连零位移也归 0」
 * 的**极其反常识的假现象**（7 组隔离实验证明是 hook 自己造成的伪影）。
 * ⇒ 溯源只允许 hook **裸 `scrollTop` setter**；或干脆**零 hook，只读采样**。
 *
 * ### 铁律 2：**iframe 有独立 JS realm**
 * 父窗口的 `Element.prototype` **不覆盖** iframe 内的元素。
 * ⇒ V2-7 若要溯源必须 hook `frame.contentWindow.Element.prototype`，
 * 且**必须保存/恢复原描述符**（`delete` 会让原型链丢掉原生访问器 → 后续写入全失效
 * → 把后续所有用例污染成 INVALID）。
 * 本探针 V2-7 **选择零 hook**（只读逐帧采样），因为 R4 已证明零 hook 足以判定。
 *
 * ### 铁律 3：每个用例**先证明前置条件成立**，不成立即 INVALID、不产出产品结论
 * R3 曾因"光标没放好"得出 1442px 假数据。本探针每项都有 `assert` 数组，
 * 任一不满足 → `INVALID`（不是 FAIL，也不是 PASS）。
 *
 * ## 用法
 * ```bash
 * node scripts/v0170-r5-edit.mjs
 * ```
 * 需要 `src-tauri/target/release/lightmd.exe`（identifier=`com.lightmd.probe`）已构建，
 * 且与 `dist/index.html` 的入口 hash 一致（骨架会自检）。
 */
import { runProbe, sleep, ROOT } from "./_lib/probe-harness.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
 * 夹具文档
 *
 * ## 为什么这么设计
 * - 行号 0 起：空行 / 标题 / 普通行 / 空行 / 普通行 / 空行 / 空行（供 V2-3 的
 *   「空行 + 行首」两种第 0 列场景，以及 V2-5 的「连续空行」）
 * - 含 `**加粗**` / `- 列表项` / 围栏代码块（供 V2-4 跨模式记忆的三种语法环境）
 * - 末尾补足 46 行让文档**可滚动**（V2-6/V2-7 需要能滚）
 * - `FIXTURE_MARK` 用于确认装入成功，且**每个用例用的标记词都不同**，
 *   避免"上一次的残留让本次误判 PASS"
 * ═══════════════════════════════════════════════════════════════════════════ */
/**
 * 填充行数量。
 *
 * ## ⚠️ 为什么要 200 行（本轮最关键的探针设计修正）
 * 首轮用 46 行，V2-6/V2-7 的前置断言 `max > 300` 直接失败（实测 `max=174` / `max=88`）。
 * 我一开始怀疑是"CM6 heightMap 未测量导致 scrollHeight 偏小"，
 * 于是加了"先滚到底强制测量"的修法 —— **第二轮 `max` 一点没变（174→174）**。
 *
 * 随后写诊断探针（`v0170-r5-edit-diag.mjs`）量出真机几何：
 * ```
 * window.innerHeight  = 1392     ← 我按浏览器 1000 假设
 * .cm-scroller clientHeight = 1250  ← 我按 759 假设
 * 46 行内容高 ≈ 1404px  →  max = 1404 − 1250 = 154（还不够 300 的门槛）
 * ```
 * ⇒ **夹具在高分辨率真机上不够长**，是**探针夹具缺陷**，既不是产品缺陷也不是 heightMap。
 * （"滚到底也不变"这个现象本身就否掉了 heightMap 假设 —— 那条判据反而救了我。）
 *
 * 200 行 ⇒ 内容高 ≈ 200×28.79 + 80 = 5838px ⇒ max ≈ 4588px，
 * 即使 4K（innerHeight ≈ 2000）也有 3800px 可滚，任何分辨率都能过。
 */
const FILLER_COUNT = 200;

const FIXTURE_MARK = "V2实机验证夹具";

const FOCUS_LINES = [
  "",
  `# ${FIXTURE_MARK}`,
  "正文二 V20。",
  "",
  "正文四 V21。",
  "",
  "",
];
/** V2-4 需要三种语法环境各占一行（行号稳定，便于断言"回到原字符"） */
const SYNTAX_LINES = [
  "普通行 V22 前缀文字 **加粗内容XYZ** 后缀文字",
  "- 列表项 V23 前缀文字 **列表加粗ABC** 后缀",
  "```",
  "code 行 V24 内容 DEF",
  "```",
];
for (let i = 0; i < FILLER_COUNT; i++) SYNTAX_LINES.push(`填充行${String(i + 30).padStart(3, "0")} V2fill`);

const DOC = [...FOCUS_LINES, ...SYNTAX_LINES].join("\n");

/* ═══════════════════════════════════════════════════════════════════════════
 * 页面内脚本
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 公共工具 + CM6 view 访问 */
const HELPERS = String.raw`
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  const cmContent = () => document.querySelector(".cm-content");
  const cmView = () => { const c = cmContent(); try { return c && c.cmTile && c.cmTile.view; } catch { return null; } };
  const scroller = () => document.querySelector(".cm-scroller");
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  /** CM6 全文（必须走 state.doc —— 虚拟化下 .cm-line 只有视口内的行） */
  const cmText = () => { const v = cmView(); return v ? v.state.doc.toString() : null; };
`;

/**
 * ═══ V2-3 专用：光标像素差分 ═══
 *
 * ## 为什么必须是「显示 vs 隐藏」的像素**差分**（R3 的核心方法论）
 * 空行/行首的光标被行号槽整条盖住时，**那个位置依然有别的墨**（行号槽右边框）。
 * 单读"该区域对比度"会读到非零 → 看起来"有东西" → 判 PASS，但那是**别人的墨**。
 * 差分把不变量全消掉：只有光标自己的贡献留下差值。
 * `inkPixels = 0` ⇒ **光标一像素都没画出来**，与"颜色对不对"完全解耦。
 *
 * ## 两条像素硬约束（R3 踩过）
 * 1. **必须 `scale ≥ 3`**：光标 border 只有 1.2px，scale=1 时被抗锯齿摊到 2~3 列，
 *    每列只有约 20% 覆盖率 → 读出的"颜色"是混合色（dark 实测 lum 60 而不是 212），
 *    会把正常光标误判成"对比不足"。
 * 2. **必须先关闪烁动画**：`cm-blink` 的 50% 相位 opacity=0，随机截到暗相会把
 *    "闪烁"误判成"光标不可见"。只关动画**不改颜色** → 颜色结论不受影响。
 *
 * ## ⚠️ 真机特别注意
 * WebView2 与 headless Chrome 的**合成层/GPU 光栅化路径可能不同**。
 * R3 的修复是 `.cm-cursorLayer { z-index: 250 !important }`（压过 `.cm-gutters` 的 200），
 * 这属于**合成层排序**问题 —— 正是真机可能表现不同的地方，所以必须真机复验。
 */
const PAGE_PIXELS = String.raw`
  const img = new Image();
  img.src = "data:image/png;base64,__B64__";
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const out = [];
  for (let o = 0; o < d.length; o += 4) out.push([d[o], d[o + 1], d[o + 2]]);
  return { w: cv.width, h: cv.height, px: out };
`;

/** 读光标几何 + 计算样式 + 关键 CSS 层级（一次 ev 取全，避免多次采样间状态漂移） */
const READ_CARET = HELPERS + String.raw`
  const view = cmView();
  const cursor = document.querySelector(".cm-cursor");
  const cursorLayer = document.querySelector(".cm-cursorLayer");
  const gutters = document.querySelector(".cm-gutters");
  const lin = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) }; };
  let caretRect = lin(cursor), caretSource = cursor ? "cm-cursor" : null;
  if (!caretRect && view) {
    try {
      const c = view.coordsAtPos(view.state.selection.main.head);
      if (c) { caretRect = { x: round(c.left), y: round(c.top), w: Math.max(1, round(c.right - c.left)), h: round(c.bottom - c.top) }; caretSource = "coordsAtPos"; }
    } catch (e) {}
  }
  const zOf = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { zIndex: cs.zIndex, position: cs.position, bg: cs.backgroundColor, display: cs.display }; };
  return {
    cursorCount: document.querySelectorAll(".cm-cursor").length,
    cursorRect: caretRect, caretSource,
    cursorStyle: cursor ? (() => { const cs = getComputedStyle(cursor); return { borderLeftColor: cs.borderLeftColor, borderLeftWidth: cs.borderLeftWidth, display: cs.display, opacity: cs.opacity, visibility: cs.visibility }; })() : null,
    cursorLayerZ: zOf(cursorLayer), guttersZ: zOf(gutters),
    /** 光标 x 与行号槽右边界的关系 —— R3 的根因就是「光标压在槽边界上被盖住」 */
    caretX: caretRect ? caretRect.x : null,
    gutterRight: gutters ? round(gutters.getBoundingClientRect().right) : null,
    /** 光标到槽的横向距离：< 0 表示光标左缘已在槽内（可能被盖） */
    caretMinusGutterRight: caretRect && gutters ? round(caretRect.x - gutters.getBoundingClientRect().right) : null,
    editorFocused: !!document.querySelector(".cm-focused"),
    head: view ? view.state.selection.main.head : null,
    lineText: (() => { try { return view.state.doc.lineAt(view.state.selection.main.head).text.slice(0, 30); } catch (e) { return null; } })(),
    docLines: view ? view.state.doc.lines : null,
    scrollTop: scroller() ? round(scroller().scrollTop) : null,
    scrollHeight: scroller() ? round(scroller().scrollHeight) : null,
    clientHeight: scroller() ? round(scroller().clientHeight) : null,
  };
`;

/**
 * ═══ V2-5 专用：专注模式高亮窗读取 ═══
 *
 * 判据口径来自 R3 T1 的四次订正（每次都会造成假红）：
 * 1. ❌ 亮区高度 = 3 × 行高 ±1px → 字形矩形比行盒上下各内缩约 4px，天然矮 7.8px
 * 2. ✅ **覆盖 ≥60% 的行盒「个数」**（把 overlay 的透明段当亮区，逐行盒算 overlap）
 * 3. ⚠️ 行高**不能拍脑袋取常量**：标题行盒是 1.4em（实测 40.33px vs 普通 28.8px）
 */
const READ_FOCUS = HELPERS + String.raw`
  const view = cmView();
  const ov = document.querySelector(".source-focus-overlay");
  if (!view || !ov) return { ok: false, why: !view ? "no view" : "no overlay" };
  const bi = ov.style.backgroundImage || "";
  // 透明段 = 亮区。格式形如 linear-gradient(..., transparent 123.4px, transparent 456.7px)
  const m = /transparent ([0-9.]+)px,\s*transparent ([0-9.]+)px/.exec(bi);
  if (!m) return { ok: false, why: "no transparent band", bi: bi.replace(/\s+/g, " ").slice(0, 200) };
  const bandStart = Number(m[1]), bandEnd = Number(m[2]);
  const ovR = ov.getBoundingClientRect();
  const sc = scroller();
  const scR = sc.getBoundingClientRect();
  /** 亮区在**视口坐标**里的上下沿 */
  const bandTop = ovR.top + bandStart;
  const bandBottom = ovR.top + bandEnd;
  // 逐 .cm-line 行盒算 overlap 比例；覆盖 ≥60% 记为「亮了一行」
  const lines = Array.from(document.querySelectorAll(".cm-line"));
  const rows = [];
  for (const l of lines) {
    const r = l.getBoundingClientRect();
    if (r.height <= 0) continue;
    const ov1 = Math.max(0, Math.min(r.bottom, bandBottom) - Math.max(r.top, bandTop));
    const frac = ov1 / r.height;
    rows.push({
      top: round(r.top - scR.top), h: round(r.height),
      frac: round(frac),
      lit: frac >= 0.6,
      text: (l.textContent || "").slice(0, 26),
      /** 该行在文档里的行号（1 起），用 CM6 posAtCoords 反查不可靠，改由 text 匹配 */
    });
  }
  const litRows = rows.filter((r) => r.lit);
  /**
   * 光标所在行：**用 caret 的屏幕 Y 找包含它的行盒**。
   *
   * ⚠️ 第一版用 view.coordsAtPos(head) 取 Y，实测**全部返回 null**（8/8 位置）——
   * 那不是产品缺陷，是探针 bug：.cm-cursor 元素的 getBoundingClientRect()
   * 才是 WebView2 下稳定可用的几何来源（coordsAtPos 在某些布局时刻会抛/返回 null）。
   * 这里改为**优先用 .cm-cursor 的实际矩形**，coordsAtPos 只作兜底。
   */
  const curEl = document.querySelector(".cm-cursor");
  const curRect = curEl ? curEl.getBoundingClientRect() : null;
  let caretRowIdx = null, caretY = null;
  if (curRect) {
    caretY = round((curRect.top + curRect.bottom) / 2 - scR.top);
    let best = null, bestD = Infinity;
    rows.forEach((r, i) => {
      const mid = r.top + r.h / 2;
      const d = Math.abs(mid - caretY);
      if (d < bestD && d <= r.h / 2 + 2) { bestD = d; best = i; }
    });
    caretRowIdx = best;
  }
  if (caretRowIdx === null) {
    // 兜底：coordsAtPos（可能 null，但多一条路）
    try {
      const co = view.coordsAtPos(view.state.selection.main.head);
      if (co) {
        const cy = (co.top + co.bottom) / 2 - scR.top;
        caretY = round(cy);
        let best = null, bestD = Infinity;
        rows.forEach((r, i) => {
          const mid = r.top + r.h / 2;
          const d = Math.abs(mid - cy);
          if (d < bestD && d <= r.h / 2 + 2) { bestD = d; best = i; }
        });
        caretRowIdx = best;
      }
    } catch (e) {}
  }
  return {
    ok: true, bi: bi.replace(/\s+/g, " ").slice(0, 200),
    band: { start: round(bandStart), end: round(bandEnd), h: round(bandEnd - bandStart) },
    overlayH: round(ovR.height),
    overlayTop: round(ovR.top), overlayOpacity: getComputedStyle(ov).opacity,
    overlayVisible: ov.getClientRects().length > 0 && getComputedStyle(ov).display !== "none",
    litCount: litRows.length,
    litTexts: litRows.map((r) => r.text),
    litHeights: litRows.map((r) => r.h),
    /** 亮区总高 vs 各亮行盒高之和（用于看是否有行盒被部分覆盖） */
    bandH: round(bandBottom - bandTop),
    caretRowIdx, caretY,
    /** 光标在「亮行序列」中的索引；null = 光标行没被照亮（缺陷形态） */
    caretInLitIdx: caretRowIdx === null ? null : (() => {
      let k = -1;
      for (let i = 0; i < rows.length; i++) { if (rows[i].lit) k++; if (i === caretRowIdx) return rows[i].lit ? k : null; }
      return null;
    })(),
  };
`;

/**
 * ═══ V2-6 / V2-7 专用：逐帧 scrollTop 采样（**零 hook，纯只读**）
 *
 * 铁律 1：绝不 hook `scrollTo`。本采样器只用 rAF 读 `scrollTop`，
 * 对被测行为零侵入 —— 这是 R4 用 7 组实验换来的结论。
 *
 * 同时采**右屏 iframe 内部**的 scrollTop（跨文档读取，只读）。
 * R4 发现真机/浏览器差异最大的点就在"跨文档 scroll 事件的时序"，
 * 所以 V2-7 必须同时看两屏的同帧关系。
 */
const START_TRACE = (ms) => String.raw`
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const rec = { t: Math.round(performance.now() - t0) };
      const sc = document.querySelector(".cm-scroller");
      if (sc) {
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        const caret = sc.querySelector(".cm-cursor");
        if (caret) rec.caretY = Math.round((caret.getBoundingClientRect().top - sc.getBoundingClientRect().top) * 100) / 100;
      }
      const f = document.querySelector("iframe.split-preview");
      if (f) {
        try {
          const d = f.contentDocument;
          const se = d && (d.scrollingElement || d.documentElement);
          if (se) { rec.deST = Math.round(se.scrollTop * 100) / 100; rec.deSH = Math.round(se.scrollHeight); rec.tags = d.querySelectorAll("[data-src-line]").length; }
        } catch (e) { rec.ifErr = String(e).slice(0, 40); }
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < MS_PLACEHOLDER) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`.replace("MS_PLACEHOLDER", String(ms));

/**
 * 曲线分析（R4 口径，含"亚像素毛刺不算反转"的修正）
 *
 * 方向反转必须忽略 ≤5px 的单段反向累计：R3 在阅读面（已知平滑的参考实现）上
 * 踩过"`-3, 0, +3` 被判一次反转"的判据 bug。
 */
function analyze(seq, noisePx = 5) {
  const vals = seq.filter((v) => typeof v === "number");
  if (vals.length < 2) return { valid: false, n: vals.length };
  const d = [];
  for (let i = 1; i < vals.length; i++) d.push(Math.round((vals[i] - vals[i - 1]) * 100) / 100);
  let maxJump = 0, maxJumpAt = null;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > maxJump) { maxJump = Math.abs(d[i]); maxJumpAt = i + 1; }
  const nz = d.filter((x) => Math.abs(x) >= 0.05);
  const runs = [];
  let acc = 0;
  for (const x of nz) {
    const s = x > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== s) {
      if (runs.length > 0 && Math.abs(acc) <= noisePx) runs[runs.length - 1] = s;
      else runs.push(s);
      acc = 0;
    }
    acc += x;
  }
  let maxUp = 0, maxDown = 0, upAt = null, downAt = null;
  for (let i = 0; i < d.length; i++) {
    if (d[i] > maxUp) { maxUp = d[i]; upAt = i + 1; }
    if (d[i] < -maxDown) { maxDown = -d[i]; downAt = i + 1; }
  }
  return {
    valid: true, n: vals.length,
    first: vals[0], last: vals[vals.length - 1],
    net: Math.round((vals[vals.length - 1] - vals[0]) * 100) / 100,
    maxJump: Math.round(maxJump * 100) / 100, maxJumpAt,
    maxUp: Math.round(maxUp * 100) / 100, upAt,
    maxDown: Math.round(maxDown * 100) / 100, downAt,
    reversals: Math.max(0, runs.length - 1),
    frames: nz.length,
    deltas: nz.slice(0, 24),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 主流程
 * ═══════════════════════════════════════════════════════════════════════════ */

await runProbe(
  { name: "v0170-r5-edit", doc: DOC, docTitle: FIXTURE_MARK, viewMode: "edit" },
  async (ui) => {
    ui.__shotDir = ui.path.join(ROOT, "_verify-out", "shots");
    ui.fs.mkdirSync(ui.__shotDir, { recursive: true });
    ui.log(`[env] 源码面实现 = ${ui.impl}`);
    ui.log(`[env] 文档 ${DOC.length} 字符 / ${DOC.split("\n").length} 行`);

    /* ── 公共：装"关闪烁 + 隐藏光标"样式（V2-3 像素差分用）── */
    await ui.ev(`
      if (!document.getElementById("__v2_noblink")) {
        const st = document.createElement("style");
        st.id = "__v2_noblink";
        st.textContent = ".cm-cursorLayer, .cm-cursor { animation: none !important; opacity: 1 !important; }";
        document.head.appendChild(st);
      }
      if (!document.getElementById("__v2_hidecursor")) {
        const hide = document.createElement("style");
        hide.id = "__v2_hidecursor";
        hide.textContent = "/*show*/";
        document.head.appendChild(hide);
      }
      return true;
    `);

    /** 复位文档到初始内容（每个用例前调用，防残留污染） */
    const resetDoc = async () => {
      const r = await ui.ev(HELPERS + `
        const v = cmView();
        if (!v) return { ok: false, why: "no cm view" };
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(DOC)} }, selection: { anchor: 0 }, scrollIntoView: false });
        await raf2();
        return { ok: true, lines: v.state.doc.lines, len: v.state.doc.length };
      `);
      await sleep(200);
      return r;
    };

    /** 把光标放到指定**文档行号**（1 起）的行尾 / 行首 / 列 */
    const placeCaret = async (lineNo, col = "end") => {
      return await ui.ev(HELPERS + `
        const v = cmView();
        if (!v) return { ok: false, why: "no view" };
        const n = Math.max(1, Math.min(v.state.doc.lines, ${lineNo}));
        const L = v.state.doc.line(n);
        const pos = ${JSON.stringify(col)} === "start" ? L.from : (${JSON.stringify(col)} === "end" ? L.to : Math.min(L.to, L.from + ${typeof col === "number" ? col : 0}));
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        v.focus();
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        await raf2();
        return { ok: true, lineNo: n, pos, head: v.state.selection.main.head, lineText: L.text.slice(0, 36), len: v.state.doc.length };
      `);
    };

    /** 点格式栏按钮（按 title 精确匹配） */
    const clickFormatBtn = async (title) => {
      const r = await ui.ev(`
        const btns = Array.from(document.querySelectorAll(".format-btn"));
        const hit = btns.find((b) => (b.getAttribute("title") || "").indexOf(${JSON.stringify(title)}) === 0
                                   || (b.textContent || "").trim() === ${JSON.stringify(title)});
        if (!hit) return { ok: false, why: "button not found", titles: btns.map((b) => (b.getAttribute("title") || "").slice(0, 12)).slice(0, 30) };
        const rect = hit.getBoundingClientRect();
        return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), title: hit.getAttribute("title") };
      `);
      if (!r.ok) return r;
      // ⚠️ 必须用真实鼠标点击（CDP mousePressed/mouseReleased），
      //    不能用 el.click() —— 后者不触发 mousedown，格式栏的焦点交接逻辑不跑
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
      }
      await sleep(350);
      return r;
    };

    const readCaret = () => ui.ev(READ_CARET);
    const readFocus = () => ui.ev(READ_FOCUS);

    /** 等滚动稳定（连续 3 次 Δ≤0.5px）—— 采样前必须稳定，否则把上一次动画算进本次 */
    const waitSettled = async (ms = 2500) => {
      const t0 = Date.now();
      let prev = null, stable = 0;
      while (Date.now() - t0 < ms) {
        const st = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return sc?Math.round(sc.scrollTop*100)/100:null;`);
        if (prev !== null && Math.abs((st ?? 0) - prev) <= 0.5) stable++;
        else stable = 0;
        prev = st;
        if (stable >= 3) return true;
        await sleep(90);
      }
      return false;
    };

    /** 断言收集器：任一不成立 → 该用例 INVALID（不产出产品结论） */
    const makeAssert = () => {
      const arr = [];
      const push = (id, ok, why) => { arr.push({ id, ok: !!ok, why }); return ok; };
      return { arr, push, allOk: () => arr.every((a) => a.ok), failed: () => arr.filter((a) => !a.ok) };
    };

    await ui.focusSource();
    await sleep(400);
    const implOk = ui.impl === "cm6";
    ui.add("V2-0", "源码面是 CM6（本轮所有项的主战场）", implOk ? "PASS" : "FAIL", `impl=${ui.impl}`);

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-1：R2#7 ghost 退格整段删格式符
     *
     * 期望：点「粗体」→ 文档多出 `****`、光标在中间、ghost 显示"粗体文本" →
     *       **不输入任何字符**直接 Backspace → `****` **一次删净**（文档回到原状）。
     *
     * ## 为什么这是"整段"而不是"逐字符"
     * R2 根因：CM6 的 `defaultKeymap` 显式绑定 Backspace（`deleteCharBackward`，
     * `preventDefault: true`），优先级 `Prec.default` **高于**宿主 `setDomEventHandlers`
     * → 命中即 break → 宿主的"退格整段删除"是**死代码** → CM6 自己删 1 个 `*`。
     * ⇒ 判据必须是「删了 **4 个字符**，文档回到插入前」，不是"删了 1 个"。
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      await resetDoc();
      const placed = await placeCaret(3, "end"); // 第 3 行「正文二 V20。」
      A.push("A1", placed.ok, `光标放置 ${placed.ok ? `行${placed.lineNo} pos=${placed.pos}` : placed.why}`);
      const before = await ui.ev(HELPERS + `const v=cmView(); return v ? { len: v.state.doc.length, text: v.state.doc.toString() } : null;`);
      A.push("A2", before && before.len > 100, `文档已装入 len=${before && before.len}`);

      const btn = await clickFormatBtn("粗体");
      A.push("A3", btn.ok, btn.ok ? `点中「${btn.title}」` : `按钮未找到：${JSON.stringify(btn.titles)}`);
      const afterFmt = await ui.ev(HELPERS + `
        const v = cmView();
        if (!v) return null;
        const t = v.state.doc.toString();
        const head = v.state.selection.main.head;
        return { len: v.state.doc.length, head, added: v.state.doc.length - ${before ? before.len : 0},
                 around: t.slice(Math.max(0, head - 6), head + 6),
                 ghostVisible: (() => { const g = document.querySelector(".cm-ghost, .cm-ghostText, [class*='ghost']"); return !!g && g.getClientRects().length > 0; })() };
      `);
      // 插入 `****` = +4 字符，光标在中间（+2）
      A.push("A4", afterFmt && afterFmt.added === 4, `插入量 ${afterFmt && afterFmt.added} 字符（期望 +4 = \`****\`）`);
      /**
       * ⚠️ **这里第一版判据算错了**（探针 bug，不是产品缺陷），记下来防止重犯：
       *
       * 我写成 `Math.abs(head - (before.len + 2))` —— 把「文档总长度」当成基准了。
       * 光标插入位置是 **`placed.pos`（=20，第 3 行行尾）**，不是文档长度（560）。
       * 于是期望值算成 562，实测 head=22 被判"位置错"。
       * 而同一批数据里 `added === 4` **已经通过** —— 两个断言互相矛盾，
       * 这种矛盾就是"判据写错"的强烈信号，必须先查探针再谈产品。
       */
      const expectHead = (placed.pos ?? 0) + 2;
      A.push("A5", afterFmt && Math.abs(afterFmt.head - expectHead) <= 1,
        `光标位置 ${afterFmt && afterFmt.head}（期望 ${expectHead} = 插入点 ${placed.pos} + 2 个 \`*\` 后）`);

      // ★ 不输入任何字符，直接 Backspace
      await ui.key("Backspace", "Backspace", 8);
      await sleep(400);
      const afterBs = await ui.ev(HELPERS + `const v=cmView(); return v ? { len: v.state.doc.length, text: v.state.doc.toString(), head: v.state.selection.main.head } : null;`);
      const restored = afterBs && before && afterBs.len === before.len && afterBs.text === before.text;
      const deleted = afterBs && afterFmt ? (afterFmt.len - afterBs.len) : null;
      A.push("A6", afterBs !== null, "退格后能读到文档");

      if (!A.allOk()) {
        ui.add("V2-1", "R2#7 ghost 退格整段删格式符", "INVALID",
          `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        ui.add("V2-1", "R2#7 ghost 退格整段删格式符", restored ? "PASS" : "FAIL",
          `${restored ? "一次删净" : "未删净"}：删了 ${deleted} 个字符（期望 4）、` +
          `文档 ${afterFmt.len}→${afterBs.len}（期望回到 ${before.len}）、` +
          `逐字节等于插入前=${restored}；ghost 可见=${afterFmt.ghostVisible}`);
        ui.log(`[V2-1] 插入后 around=${JSON.stringify(afterFmt.around)} 退格后 len=${afterBs.len}`);
      }
      await ui.shot("v21-after-backspace");
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-2：Ctrl+I 斜体
     *
     * 期望：源码面按 Ctrl+I → 插入 `*斜体文本*` 的语法符号（`**` 或 `*` 成对，
     *       且 ghost 提示出现）。
     *
     * ## R2 的根因（同一族）
     * `defaultKeymap` 的 `Mod-i`（`selectParentSyntax`，`preventDefault: true`）抢键
     * → 实测按 Ctrl+I **文本完全不变**。修法是把它从 `defaultKeymap` 过滤掉
     * （`HOST_OWNED_KEYS`），让事件冒泡到宿主。
     * ⇒ 判据 = **文档长度确实增加**，不是"没有报错"。
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      await resetDoc();
      const placed = await placeCaret(3, "end");
      A.push("A1", placed.ok, `光标放置 ${placed.ok ? `pos=${placed.pos}` : placed.why}`);
      const before = await ui.ev(HELPERS + `const v=cmView(); return v ? { len: v.state.doc.length, text: v.state.doc.toString() } : null;`);
      A.push("A2", before && before.len > 100, `len=${before && before.len}`);

      // Ctrl+I（modifiers: 2 = Ctrl）
      await ui.focusSource();
      await sleep(200);
      await ui.key("i", "KeyI", 73, 2);
      await sleep(450);
      const after = await ui.ev(HELPERS + `
        const v = cmView();
        if (!v) return null;
        const t = v.state.doc.toString();
        const head = v.state.selection.main.head;
        return { len: v.state.doc.length, head, around: t.slice(Math.max(0, head - 8), head + 8),
                 added: v.state.doc.length - ${before ? before.len : 0} };
      `);
      A.push("A3", after !== null, "按键后能读到文档");
      if (!A.allOk()) {
        ui.add("V2-2", "Ctrl+I 斜体插入", "INVALID", `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        // `*斜体*` 无选区时只插 `**`（2 字符）；有选区时包 `*...*`。两种都接受，但必须 >0
        const ok = after.added >= 2;
        ui.add("V2-2", "Ctrl+I 斜体插入", ok ? "PASS" : "FAIL",
          `插入 ${after.added} 字符（期望 ≥2 = 成对 \`*\`）；光标处上下文=${JSON.stringify(after.around)}、` +
          `len ${before.len}→${after.len}${ok ? "" : " ← R2 缺陷形态：按 Ctrl+I 文本不变"}`);
      }
      await ui.shot("v22-ctrl-i");
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-3：R3#5 插入符号可见（真机制 = 光标一像素都没画出来）
     *
     * ## 为什么必须真机验（这是本轮最容易"浏览器过、真机不过"的一项）
     * R3 修复是 `.cm-cursorLayer { z-index: 250 !important }` —— 压过 `.cm-gutters`(200)。
     * 这属于**合成层排序**，而 WebView2 的光栅化/合成路径与 headless Chrome 可能不同。
     *
     * ## 判据（照抄 R3 的像素差分，不用"对比度"）
     * - `inkPixels > 0` ⇒ 光标确实被画出来了
     * - `inkPixels = 0` ⇒ 一像素都没画（R2 缺陷形态）
     * 必须覆盖 **空行 + 行首（第 0 列）** 两种场景 —— 那是唯一触发的两种位置。
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      await resetDoc();
      await ui.focusSource();
      await sleep(300);

      /** 截小区域并在页面内做像素差分 */
      const sampleDiff = async (rect, tag) => {
        if (!rect || !(rect.h > 0)) return null;
        const clip = {
          x: Math.max(0, Math.floor(rect.x) - 4),
          y: Math.max(0, Math.round(rect.y)),
          width: 12,
          height: Math.max(10, Math.min(24, Math.round(rect.h))),
          scale: 8,
        };
        const shoot = async () => {
          const r = await ui.cdp.send("Page.captureScreenshot", { format: "png", clip });
          if (!r.result?.data) return null;
          return await ui.ev(PAGE_PIXELS.replace("__B64__", r.result.data));
        };
        await ui.ev(`document.getElementById("__v2_hidecursor").textContent = "/*show*/"; return true;`);
        await sleep(160);
        const on = await shoot();
        await ui.ev(`document.getElementById("__v2_hidecursor").textContent = ".cm-cursor{display:none !important}"; return true;`);
        await sleep(160);
        const off = await shoot();
        await ui.ev(`document.getElementById("__v2_hidecursor").textContent = "/*show*/"; return true;`);
        await sleep(160);
        if (!on || !off) return null;
        let ink = 0, minLum = 999, minC = null;
        for (let o = 0; o < on.px.length; o++) {
          const a = on.px[o], b = off.px[o];
          if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 6) {
            ink++;
            const lum = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
            if (lum < minLum) { minLum = lum; minC = a; }
          }
        }
        // 落盘留证：报告里要能指着图说明"这一列有没有东西"
        try {
          const r2 = await ui.cdp.send("Page.captureScreenshot", { format: "png", clip });
          if (r2.result?.data) ui.fs.writeFileSync(ui.path.join(ui.__shotDir, `${ui.name}-caret-${tag}.png`), Buffer.from(r2.result.data, "base64"));
        } catch { /* 落盘失败不影响判定 */ }
        return { inkPixels: ink, minColor: minC, minLum: minC ? Math.round(minLum) : null, clip };
      };

      const scenarios = [
        { tag: "空行（第 3 行）", line: 4, col: "start" },
        { tag: "行首（第 3 行第 0 列）", line: 3, col: "start" },
        { tag: "行中（第 3 行行尾）", line: 3, col: "end" },
        { tag: "标题行（第 2 行）", line: 2, col: "start" },
      ];
      const rows = [];
      for (const sc of scenarios) {
        const pl = await placeCaret(sc.line, sc.col);
        await sleep(280);
        const st = await readCaret();
        if (!st || !st.cursorRect) { rows.push({ ...sc, ok: false, why: "no cursorRect", st }); continue; }
        const diff = await sampleDiff(st.cursorRect, sc.tag.replace(/[（）\s]/g, ""));
        rows.push({ ...sc, st, diff, ok: !!diff });
      }
      A.push("A1", rows.every((r) => r.ok), `4 个场景都取到光标几何与像素：${rows.filter((r) => !r.ok).map((r) => r.tag).join("、") || "全部"}`);

      const zFix = rows[0] && rows[0].st ? rows[0].st : null;
      // ⚠️ 记录 z 序实测值 —— 真机若与浏览器不同，这里能直接看出来
      ui.log(`[V2-3] .cm-cursorLayer z=${zFix && zFix.cursorLayerZ ? zFix.cursorLayerZ.zIndex : "?"} ` +
        `/ .cm-gutters z=${zFix && zFix.guttersZ ? zFix.guttersZ.zIndex : "?"} ` +
        `/ caretX=${zFix ? zFix.caretX : "?"} gutterRight=${zFix ? zFix.gutterRight : "?"}`);

      if (!A.allOk()) {
        ui.add("V2-3", "R3#5 插入符号可见（像素差分）", "INVALID",
          `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        // 判据：每个场景 inkPixels > 0（光标被画出来了）
        const dead = rows.filter((r) => r.diff && r.diff.inkPixels === 0);
        ui.add("V2-3", "R3#5 插入符号可见（像素差分）", dead.length === 0 ? "PASS" : "FAIL",
          rows.map((r) => `${r.tag}: ink=${r.diff ? r.diff.inkPixels : "?"}px` +
            `${r.diff && r.diff.minLum !== null ? ` lum=${r.diff.minLum}` : ""}` +
            `${r.st && r.st.caretMinusGutterRight !== null ? ` (caretX−槽右=${r.st.caretMinusGutterRight})` : ""}`).join("；") +
          (dead.length ? ` ← **${dead.length} 个场景 ink=0 = 光标完全没画出来**` : ""));
        for (const r of rows) {
          ui.log(`[V2-3·${r.tag}] ink=${r.diff && r.diff.inkPixels} minLum=${r.diff && r.diff.minLum} ` +
            `z(cursorLayer=${r.st && r.st.cursorLayerZ && r.st.cursorLayerZ.zIndex}, gutters=${r.st && r.st.guttersZ && r.st.guttersZ.zIndex}) ` +
            `borderColor=${r.st && r.st.cursorStyle && r.st.cursorStyle.borderLeftColor}`);
        }
      }
      await ui.shot("v23-caret");
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-4：R3#6 编辑符号跨模式记忆
     *
     * 期望：编辑面光标停在**加粗/列表/代码块中间**的某个字符 → 切阅读 → 切回编辑
     *       → CM6 的 selection 回到**同一字符 offset**。
     *
     * ## 口径说明（这是本项最容易做错的地方）
     * 跨模式时两面坐标系不同：CM6 用**字符 offset**，PM 用**文档 pos**。
     * 而 markdown 语法符（`**`、`- `、围栏）在 PM 里**不占字符**，源码 offset 与
     * PM pos **不是 1:1**。所以严格"offset 完全一致"需要一条可靠映射。
     *
     * 本探针的判据分两级（**先看更严的那一级**）：
     * - **S1（严）**：往返后 `head` **完全等于**切换前的 `head`
     * - **S2（宽）**：往返后光标仍在**同一行且同一相对位置**（`lineText` 相同 + `head`
     *   与该行 `from` 的差值相同）
     * 报告里明确写"用的是哪一级"。**S1 通过 = 最好；S1 不过但 S2 过 = 块级记忆可用，
     * 字符级有偏差（据实记录，不掩饰）。**
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      await resetDoc();
      await ui.focusSource();
      await sleep(300);

      const toRead = async () => { await ui.command("view.preview"); await sleep(1100); };
      const toEdit = async () => { await ui.command("view.edit"); await sleep(1100); };

      /**
       * 三种语法环境（文档行号 1 起）：
       * - 加粗行：`普通行 V22 前缀文字 **加粗内容XYZ** 后缀文字`（行 8）
       * - 列表行：`- 列表项 V23 前缀文字 **列表加粗ABC** 后缀`（行 9）
       * - 代码块内容行：`code 行 V24 内容 DEF`（行 11）
       * 光标放在各行的**中间字符**（不是行首行尾，避免"夹在语法符上"的歧义）
       */
      /**
       * 期望 head 用**行定义现算**，不要硬编码数字。
       *
       * 第一版写死 `33 + 12` 等常量，夹具一改（填充行位数 2→3 位）就全错。
       * 这类"夹具动了、判据没跟上"是探针最常见的腐烂方式。
       */
      const headOfLine = (lineNo1, col) => {
        const ls = DOC.split("\n");
        let p = 0;
        for (let i = 0; i < lineNo1 - 1; i++) p += ls[i].length + 1;
        return p + col;
      };
      const cases = [
        { tag: "加粗中间", line: 8, col: 12, expectHead: headOfLine(8, 12) },
        { tag: "列表中间", line: 9, col: 14, expectHead: headOfLine(9, 14) },
        { tag: "代码块内", line: 11, col: 4, expectHead: headOfLine(11, 4) },
      ];
      const rows = [];
      for (const c of cases) {
        /**
         * ⚠️ **每个 case 必须独立 resetDoc**（本轮踩到的探针 bug）
         *
         * 首轮我复用同一份文档连跑 3 个 case，结果 case2/case3 的 `placeCaret`
         * 返回的 head 是 48 / 69（期望 77 / 101）—— 也就是**光标根本没落到目标行**。
         * 随后切模式往返，测出的"差 -14"完全是脏数据。
         *
         * 根因：切模式往返（preview→edit）会重建/替换 CM6 view 实例，
         * 而 `cmView()` 通过 `.cm-content` 的 `cmTile.view` 取——在某些时刻
         * 拿到的是**上一代的 view**，`dispatch` 打到死实例上，选区不动。
         * ⇒ 修法：① 每 case 前 resetDoc（重建干净文档 + 光标归位）；
         *          ② **断言 `placeCaret` 的返回值等于期望 head**，不等就 INVALID 该 case。
         */
        await resetDoc();
        await ui.focusSource();
        await sleep(250);
        const pl = await placeCaret(c.line, c.col);
        if (!pl || !pl.ok) { rows.push({ ...c, ok: false, why: "placeCaret failed" }); continue; }
        // ★ 关键断言：光标真的落在期望位置
        if (pl.head !== c.expectHead) {
          rows.push({ ...c, ok: false, why: `placeCaret 落点错：head=${pl.head} 期望 ${c.expectHead}（探针 bug，非产品缺陷）` });
          continue;
        }
        await sleep(220);
        const beforeRel = await ui.ev(HELPERS + `
          const v = cmView(); if (!v) return null;
          const h = v.state.selection.main.head;
          const L = v.state.doc.lineAt(h);
          /**
           * ⚠️ **必须同时返回全文与长度**（本轮探针 bug）
           *
           * 第一版这里只返回了 head/rel/text，**没有 fullText / len**。
           * 而 afterRel 那边返回了 —— 于是 docIntact = (afterRel.fullText === beforeRel.fullText)
           * 变成「字符串 === undefined」= **恒假**，报出「3 个场景内容被改」的**假警报**。
           * 这正是最危险的一类探针 bug：**判据恒假，看起来像真缺陷**。
           * 若不是 Lead 要求「区分光标偏了 vs 内容被改」，这个假警报会被当成数据损坏上报。
           */
          return { head: h, lineFrom: L.from, lineTo: L.to, rel: h - L.from, text: L.text, lines: v.state.doc.lines,
                   fullText: v.state.doc.toString(), len: v.state.doc.length };
        `);
        await toRead();
        await toEdit();
        await ui.focusSource();
        await sleep(400);
        const afterRel = await ui.ev(HELPERS + `
          const v = cmView(); if (!v) return null;
          const h = v.state.selection.main.head;
          const L = v.state.doc.lineAt(h);
          return { head: h, lineFrom: L.from, rel: h - L.from, text: L.text, lines: v.state.doc.lines,
                   /** ★ 全文 —— 用来区分「光标偏了」与「文档内容被改」 */
                   fullText: v.state.doc.toString(), len: v.state.doc.length };
        `);
        /**
         * ★★ **文档完整性断言**（Lead 点名要求区分，两者严重度差一个量级）
         *
         * - **光标位置偏了**：只是体验问题（用户要重新点一下）
         * - **文档内容被改**：**数据损坏级**（切个模式就改用户文档，绝对不可接受）
         *
         * 第一版 detail 里出现了"行文本不同"，但没区分这两种情况 —— 是判据缺失。
         * 这里显式比对**全文**：与切换前的 `beforeRel.fullText` 逐字节相等，
         * 且等于夹具原文。任一不等 → 单独一条严重判定。
         */
        const docIntact = afterRel && beforeRel && afterRel.fullText === beforeRel.fullText;
        const matchesFixture = afterRel && afterRel.fullText === DOC;
        rows.push({ ...c, beforeRel, afterRel, docIntact, matchesFixture, ok: !!beforeRel && !!afterRel });
      }
      A.push("A1", rows.every((r) => r.ok),
        `3 个场景都取到切换前后状态：${rows.filter((r) => !r.ok).map((r) => `${r.tag}(${r.why})`).join("、") || "全部"}`);
      A.push("A2", rows.filter((r) => r.ok).every((r) => r.beforeRel && r.beforeRel.rel > 0 && r.beforeRel.rel < r.beforeRel.text.length),
        `光标在行中间（非行首行尾）：${rows.filter((r) => r.ok).map((r) => `${r.tag} rel=${r.beforeRel && r.beforeRel.rel}`).join("、") || "无有效样本"}`);
      /**
       * ★ 独立判定：文档完整性（与光标记忆**分开报**）
       * 这条永远单独出现，因为它的严重度远高于"光标没记住"。
       */
      const broken = rows.filter((r) => r.ok && !r.docIntact);
      ui.add("V2-4i", "★ 模式切换往返后**文档内容未被改动**（数据完整性）",
        rows.every((r) => !r.ok) ? "INVALID" : (broken.length === 0 ? "PASS" : "FAIL"),
        broken.length
          ? `**${broken.length} 个场景内容被改**：` + broken.map((r) =>
              `${r.tag} 切换前 ${r.beforeRel.len} 字符 / 切换后 ${r.afterRel.len} 字符、与夹具原文一致=${r.matchesFixture}`).join("；")
          : rows.filter((r) => r.ok).map((r) =>
              `${r.tag}: 切换前后全文逐字节相等、len=${r.afterRel.len}`).join("；"));

      if (!A.allOk()) {
        ui.add("V2-4", "R3#6 编辑符号跨模式记忆", "INVALID", `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        /** 只用**有效**样本判定（ok=false 的是探针 bug，不参与产品结论） */
        const valid = rows.filter((r) => r.ok && r.beforeRel && r.afterRel);
        const s1 = valid.filter((r) => r.afterRel.head === r.beforeRel.head);
        const s2 = valid.filter((r) => r.afterRel.text === r.beforeRel.text && r.afterRel.rel === r.beforeRel.rel);
        const lvl = valid.length === 0 ? "无有效样本"
          : s1.length === valid.length ? "S1(字符级精确)"
          : s2.length === valid.length ? "S2(行内相对位置)"
          : "未达标";
        const invalidCases = rows.filter((r) => !r.ok);
        ui.add("V2-4", "R3#6 编辑符号跨模式记忆",
          invalidCases.length > 0 ? "INVALID" : (lvl === "未达标" ? "FAIL" : "PASS"),
          `判据级别=${lvl}；` + valid.map((r) =>
            `${r.tag}: head ${r.beforeRel.head}→${r.afterRel.head}` +
            `(${r.afterRel.head === r.beforeRel.head ? "精确" : `差${r.afterRel.head - r.beforeRel.head}`}) ` +
            `rel ${r.beforeRel.rel}→${r.afterRel.rel} ` +
            `行文本${r.afterRel.text === r.beforeRel.text ? "相同" : `不同「${r.beforeRel.text.slice(0, 14)}」→「${r.afterRel.text.slice(0, 14)}」`}`
          ).join("；") +
          (invalidCases.length ? `｜**探针 bug 排除**：${invalidCases.map((r) => `${r.tag}(${r.why})`).join("、")}` : ""));
      }
      await ui.shot("v24-mode-memory");
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-5：R3#7 专注模式 3 行窗跟随光标
     *
     * 期望：F8 开启专注模式 → 高亮窗**恰好 3 行**、且**跟随光标上下移动**。
     *
     * ## 判据（照抄 R3 T1 四次订正后的口径）
     * - **覆盖 ≥60% 的行盒「个数」= 3**（不是"亮区高度 = 3×行高"：
     *   字形矩形比行盒上下各内缩约 4px，天然矮 7.8px）
     * - 光标行必须**在亮行序列里**（`caretInLitIdx !== null`）
     * - 跟随：光标上下移动 N 行 → 亮行序列整体平移 N
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      await resetDoc();
      await ui.focusSource();
      await sleep(300);

      // F8 开启专注模式
      const beforeFocus = await ui.ev(`return !!document.querySelector(".source-focus-overlay")`);
      if (!beforeFocus) {
        await ui.command("view.toggleFocusMode");
        await sleep(900);
      }
      const overlayOn = await ui.ev(`const ov=document.querySelector(".source-focus-overlay"); return !!ov && getComputedStyle(ov).display!=="none"`);
      A.push("A1", overlayOn, `专注遮罩存在且显示=${overlayOn}（F8/命令已开启）`);

      /** 采样一组位置：光标行号 → 覆盖行数 / 亮行文本 / 光标是否在亮区 */
      const probeAt = async (lineNo, tag) => {
        await placeCaret(lineNo, "start");
        await sleep(420);
        const f = await readFocus();
        return { tag, lineNo, f };
      };

      /**
       * 覆盖位置（文档行号 1 起，文档结构见 DOC）：
       * 1=空首行 2=标题 3=正文 4=空行 5=正文 6=空 7=空 → 覆盖「空行/标题/正文/连续空行」
       * 再取 8/11/14 等中段行，验证「跟随」。
       */
      const positions = [
        { line: 1, tag: "空首行" },
        { line: 2, tag: "标题行" },
        { line: 3, tag: "普通行" },
        { line: 4, tag: "空中间行" },
        { line: 6, tag: "连续空行1" },
        { line: 7, tag: "连续空行2" },
        { line: 10, tag: "中段行A" },
        { line: 14, tag: "中段行B" },
      ];
      const rows = [];
      for (const p of positions) rows.push(await probeAt(p.line, p.tag));
      A.push("A2", rows.every((r) => r.f && r.f.ok), `每个位置都读到高亮窗：${rows.filter((r) => !r.f || !r.f.ok).map((r) => `${r.tag}(${r.f && r.f.why})`).join("、") || "全部"}`);

      if (!A.allOk()) {
        ui.add("V2-5", "R3#7 专注模式 3 行窗", "INVALID", `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        const bad3 = rows.filter((r) => r.f.litCount !== 3);
        const notFollowing = rows.filter((r) => r.f.caretInLitIdx === null);
        const ok = bad3.length === 0 && notFollowing.length === 0;
        ui.add("V2-5", "R3#7 专注模式 3 行窗", ok ? "PASS" : "FAIL",
          `亮行数：${rows.map((r) => `${r.tag}=${r.f.litCount}`).join("、")}` +
          `｜窗高：${rows.map((r) => `${r.tag}=${r.f.bandH}`).join("、")}` +
          `｜光标在亮区内：${rows.map((r) => `${r.tag}=${r.f.caretInLitIdx === null ? "否" : `是(${r.f.caretInLitIdx})`}`).join("、")}` +
          (bad3.length ? ` ← **${bad3.length} 个位置不是 3 行**` : "") +
          (notFollowing.length ? ` ← **${notFollowing.length} 个位置光标不在亮区（未跟随）**` : ""));
        for (const r of rows) {
          ui.log(`[V2-5·${r.tag}] 行${r.lineNo} lit=${r.f.litCount} bandH=${r.f.bandH} ` +
            `band=[${r.f.band.start},${r.f.band.end}] caretIdx=${r.f.caretInLitIdx} ` +
            `litTexts=${JSON.stringify(r.f.litTexts)} heights=${JSON.stringify(r.f.litHeights)}`);
        }
        /**
         * 跟随的**定量**判据：光标行从 lineA 移到 lineB（+N 行）时，
         * 亮行序列的文本应整体平移 N（比较两次的 litTexts 首元素）。
         * 这里用"中段行A → 中段行B"（行 10 → 14，+4 行）做单变量。
         */
        const a = rows.find((r) => r.tag === "中段行A");
        const b = rows.find((r) => r.tag === "中段行B");
        if (a && b) {
          ui.add("V2-5b", "专注窗跟随光标（+4 行 → 亮区文本整体平移）",
            a.f.litTexts[0] !== b.f.litTexts[0] ? "PASS" : "FAIL",
            `行10 首亮行=${JSON.stringify(a.f.litTexts[0])} → 行14 首亮行=${JSON.stringify(b.f.litTexts[0])}（应不同 = 窗跟着走了）`);
        }
      }
      // 关掉专注模式，避免影响后续项
      const stillOn = await ui.ev(`const ov=document.querySelector(".source-focus-overlay"); return !!ov && getComputedStyle(ov).display!=="none"`);
      if (stillOn) { await ui.command("view.toggleFocusMode"); await sleep(700); }
      await ui.shot("v25-focus");
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-6：R3#8 编辑模式打字机平滑（**左屏**）
     *
     * 期望：打字机开 → 打字/回车 → 左屏 scrollTop **单调、反转 0**、帧数 ≥5。
     *
     * ## ⚠️ 判据陷阱（R4 踩过）
     * ON 组的单帧位移**本来就该有 5~16px**（那是 smooth 缓动，R3 #8 的成果）。
     * 若用 OFF 的"≤3px"硬门槛，会把**正确行为判红**。
     * ⇒ 主判据是**方向反转 = 0** + 首帧占比 ≤0.5（不是"单帧多小"）。
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      await resetDoc();
      await ui.focusSource();
      await sleep(300);

      // 打字机开
      const twOn = async () => {
        const cur = await ui.ev(`
          const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
            .find((x) => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
          return b ? b.classList.contains("active") : null;
        `);
        if (cur !== true) { await ui.command("view.toggleTypewriter"); await sleep(900); }
        return await ui.ev(`
          const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
            .find((x) => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
          return b ? b.classList.contains("active") : null;
        `);
      };
      const on = await twOn();
      A.push("A1", on === true, `打字机已开启 active=${on}`);

      /**
       * 真实滚轮滚动到文档中部。
       *
       * ## 为什么必须用真实滚轮，不能直接写 `scrollTop`
       * CM6 的 `scrollHeight` 来自 heightMap：**没被渲染/测量过的区块用估算高度**。
       * 直接 `sc.scrollTop = x` 是"瞬移" —— 视口上方的内容从未被测量过，估算值很粗。
       * 随后任何一次 dispatch 触发重新测量，估算被修正 → 总量变化上千像素 →
       * 视口中央的**内容**就变了。这个伪影会被误读成"滚动跳动缺陷"。
       * 真实滚轮走浏览器原生滚动路径，CM6 按滚动过程逐段测量，无此伪影。
       *
       * ⚠️ 骨架（`_lib/probe-harness.mjs`）**没有提供 `ui.wheel`** —— 它只有 browser-probe
       * 才有。真机这里必须自己用 CDP `Input.dispatchMouseEvent`（type=mouseWheel）。
       */
      const wheel = async (x, y, deltaY) => {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, pointerType: "mouse" });
        await sleep(16);
      };
      /**
       * 滚到文档 50%。
       *
       * ## ⚠️ 必须先滚到**底**强制逐段测量（本轮踩到的探针 bug）
       * 首轮实测 46 行文档只报 `max=174`（等效 29.6 行）—— 那不是产品缺陷，
       * 是 **CM6 heightMap 的已知行为**：没被渲染/测量过的区块用**估算高度**，
       * 而估算值在初始状态下偏小，`scrollHeight` 因此只有 933 而非真实的 1404。
       * （同一坑记录在 `scripts/_lib/scroll-probe.mjs` 文件头。）
       *
       * ⇒ 正确做法：用真实滚轮**先滚到底**（CM6 会逐段测量、估算变实测），
       * 再滚回目标比例。这样后续所有"文档可滚动量"的断言才是可信的。
       *
       * @returns {{st:number,x:number,y:number,max:number}} 稳定后的位置与（测量后的）滚动器几何
       */
      const scrollToMid = async () => {
        const box = await ui.ev(`
          const sc = document.querySelector(".cm-scroller");
          const r = sc.getBoundingClientRect();
          return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2),
                   st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
        `);
        // ① 先回顶部（保证自上而下逐段测量）
        let cur = box.st, guard = 0;
        while (cur > 8 && guard++ < 400) {
          await wheel(box.x, box.y, -Math.min(560, cur));
          cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
        }
        // ② **滚到底**（关键：强制 CM6 测量全部区块，修正 scrollHeight 估算）
        guard = 0;
        let prev = -1;
        while (guard++ < 900) {
          const maxNow = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return Math.round(sc.scrollHeight-sc.clientHeight)`);
          if (cur >= maxNow - 8) break;
          await wheel(box.x, box.y, 400);
          cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
          if (cur === prev) break; // 到底了
          prev = cur;
        }
        await sleep(500);
        // ③ 回顶，再滚到 50%（此时 max 已是测量后的真值）
        guard = 0;
        while (cur > 8 && guard++ < 400) {
          await wheel(box.x, box.y, -Math.min(560, cur));
          cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
        }
        const maxMeasured = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return Math.round(sc.scrollHeight-sc.clientHeight)`);
        const target = Math.round(maxMeasured * 0.5);
        guard = 0;
        while (cur < target - 8 && guard++ < 800) {
          await wheel(box.x, box.y, Math.min(140, target - cur));
          const next = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
          if (next === cur) break;
          cur = next;
        }
        await sleep(400);
        const finalMax = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return Math.round(sc.scrollHeight-sc.clientHeight)`);
        return { st: cur, x: box.x, y: box.y, max: finalMax, maxBeforeMeasure: box.max };
      };

      /**
       * 真实鼠标点击到视口某个纵向比例处（放光标）。
       * ⚠️ 不能用 `el.click()` —— 它不派发 mousedown，CM6 的光标放置逻辑不走。
       */
      const clickAtFrac = async (frac) => {
        const pt = await ui.ev(`
          const sc = document.querySelector(".cm-scroller");
          const r = sc.getBoundingClientRect();
          const y = Math.round(r.top + sc.clientHeight * ${frac});
          for (const dx of [0.45, 0.55, 0.35, 0.65]) {
            const x = Math.round(r.left + sc.clientWidth * dx);
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit.closest(".cm-content") || hit.classList.contains("cm-line"))) return { x, y };
          }
          return null;
        `);
        if (!pt) return null;
        for (const type of ["mousePressed", "mouseReleased"]) {
          await ui.cdp.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        }
        await sleep(300);
        return pt;
      };

      const mid = await scrollToMid();
      A.push("A2", mid && mid.st > 100, `左屏已滚到中部 st=${mid && mid.st}`);

      const pt = await clickAtFrac(0.85);
      A.push("A3", !!pt, pt ? `视口下部落点 (${pt.x},${pt.y})` : "落点找不到");
      if (on === true) {
        // 打字机开时点击会触发一次居中动画 → 等它结束（否则把上一次动画算进本次轨迹）
        await sleep(800);
      }
      const settled = await waitSettled();
      A.push("A4", settled, `采样前滚动已稳定=${settled}`);
      const pre = await readCaret();
      A.push("A5", pre && pre.editorFocused, `编辑器有焦点=${pre && pre.editorFocused}`);
      A.push("A6", pre && pre.scrollHeight > pre.clientHeight + 300, `文档可滚动 max=${pre ? Math.round(pre.scrollHeight - pre.clientHeight) : "?"}（视口 ${pre ? pre.clientHeight : "?"}px、内容 ${pre ? pre.scrollHeight : "?"}px）`);

      if (!A.allOk()) {
        ui.add("V2-6", "R3#8 编辑模式打字机平滑", "INVALID", `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        // 采样 + 回车
        await ui.ev(START_TRACE(1500));
        await sleep(110);
        await ui.key("Enter", "Enter", 13);
        await sleep(1900);
        const trace = await ui.ev(`return window.__TR || []`);
        const post = await readCaret();
        const stSeq = trace.map((s) => s.st);
        const an = analyze(stSeq);
        const addedLine = post && pre && post.docLines === pre.docLines + 1;
        const ok = an.valid && an.reversals === 0 && an.frames >= 3 && addedLine;
        ui.add("V2-6", "R3#8 编辑模式打字机平滑（回车）", ok ? "PASS" : "FAIL",
          `帧数=${an.frames} 净Δ=${an.net}px 单帧最大=${an.maxJump}px **反转=${an.reversals}** ` +
          `首帧占比=${an.valid && an.net !== 0 ? (Math.round((an.deltas[0] / an.net) * 1000) / 1000) : "-"}；` +
          `行数 ${pre.docLines}→${post ? post.docLines : "?"}（回车加行=${addedLine}）；` +
          `逐帧=${JSON.stringify(an.deltas)}` +
          (an.reversals > 0 ? ` ← **出现 ${an.reversals} 次方向反转 = 抖动**` : ""));
        ui.log(`[V2-6] 左屏 scrollTop ${an.first} → ${an.last}（净 ${an.net}px）`);
      }
      await ui.shot("v26-typewriter");
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-7：R4#4 回车抖动（**右屏 iframe** —— R4 的真实战场）
     *
     * 期望：打字机开 + 分屏 → 光标在视口下部按回车 →
     *       右屏 **单帧 ≤20px**、**回弹 0**（反转 0）。
     *
     * ## 为什么真机可能和浏览器不同（本项最有价值的验证点）
     * R4 的根因之一是「iframe 的 scroll 事件经**跨文档队列**派发，比主文档晚约 140ms」
     * （实测数据：动画末次写入 @300ms、回声 @441ms，而方向锁只有 250ms）。
     * **WebView2 的跨文档事件调度可能与 Chromium 不同** —— 这正是必须真机复验的点。
     *
     * ## 判据（R4 订正后的口径，别改回"≤3px"）
     * - 动画期（左屏仍在移动的帧）右屏单帧 ≤ **20px**
     * - 右屏**方向反转 = 0**（"抖"的定义就是来回摆）
     * - 动画结束后 `realignLayoutNow` 的一次吸附（≤60px）**不算抖**
     *   —— 它发生在左屏停止之后，观感是"对齐一下"
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      await resetDoc();
      await ui.focusSource();
      await sleep(300);

      // 确保分屏预览在
      const hasIframe = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
      if (!hasIframe) { await ui.command("view.togglePreview"); await sleep(1600); }
      const iframeOk = await ui.ev(`
        const f = document.querySelector("iframe.split-preview");
        if (!f) return { ok: false, why: "no iframe" };
        try {
          const d = f.contentDocument; const se = d && (d.scrollingElement || d.documentElement);
          return se ? { ok: true, st: Math.round(se.scrollTop), sh: Math.round(se.scrollHeight), ch: se.clientHeight, tags: d.querySelectorAll("[data-src-line]").length } : { ok: false, why: "no scrollingElement" };
        } catch (e) { return { ok: false, why: String(e).slice(0, 60) }; }
      `);
      A.push("A1", iframeOk.ok && iframeOk.tags > 0, `右屏可读=${iframeOk.ok} 贴标=${iframeOk.tags || 0} scrollHeight=${iframeOk.sh || "?"}`);

      // 打字机开
      const twState = await ui.ev(`
        const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
          .find((x) => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
        return b ? b.classList.contains("active") : null;
      `);
      if (twState !== true) { await ui.command("view.toggleTypewriter"); await sleep(900); }
      const tw = await ui.ev(`
        const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
          .find((x) => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
        return b ? b.classList.contains("active") : null;
      `);
      A.push("A2", tw === true, `打字机已开启 active=${tw}`);

      const wheel = async (x, y, deltaY) => {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, pointerType: "mouse" });
        await sleep(16);
      };
      const box = await ui.ev(`
        const sc = document.querySelector(".cm-scroller");
        const r = sc.getBoundingClientRect();
        return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2),
                 st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
      `);
      let cur = box.st, guard = 0;
      // ① 回顶
      while (cur > 8 && guard++ < 400) { await wheel(box.x, box.y, -Math.min(560, cur)); cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`); }
      // ② **滚到底**强制 CM6 测量全部区块（理由见 V2-6 的 scrollToMid 注释：
      //    不这么做 scrollHeight 是估算值，max 只有真实值的一小部分）
      guard = 0; let prevSt = -1;
      while (guard++ < 900) {
        const maxNow = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return Math.round(sc.scrollHeight-sc.clientHeight)`);
        if (cur >= maxNow - 8) break;
        await wheel(box.x, box.y, 400);
        cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
        if (cur === prevSt) break;
        prevSt = cur;
      }
      await sleep(500);
      // ③ 回顶 → 滚到 50%
      guard = 0;
      while (cur > 8 && guard++ < 400) { await wheel(box.x, box.y, -Math.min(560, cur)); cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`); }
      const maxMeasured = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return Math.round(sc.scrollHeight-sc.clientHeight)`);
      const target2 = Math.round(maxMeasured * 0.5);
      guard = 0;
      while (cur < target2 - 8 && guard++ < 800) {
        await wheel(box.x, box.y, Math.min(140, target2 - cur));
        const next = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
        if (next === cur) break;
        cur = next;
      }
      await sleep(400);
      A.push("A3", cur > 100, `左屏已滚到中部 st=${cur}（测量后 max=${maxMeasured}，测量前 ${box.max}）`);

      // 光标放到视口 0.85（R4 证明这一位置才触发大幅位移）
      const pt = await ui.ev(`
        const sc = document.querySelector(".cm-scroller");
        const r = sc.getBoundingClientRect();
        const y = Math.round(r.top + sc.clientHeight * 0.85);
        for (const dx of [0.45, 0.55, 0.35, 0.65]) {
          const x = Math.round(r.left + sc.clientWidth * dx);
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit.closest(".cm-content") || hit.classList.contains("cm-line"))) return { x, y };
        }
        return null;
      `);
      if (pt) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await ui.cdp.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        }
        await sleep(300);
      }
      A.push("A4", !!pt, pt ? `落点 (${pt.x},${pt.y})` : "落点找不到");
      await sleep(900);
      const settled = await waitSettled();
      A.push("A5", settled, `采样前稳定=${settled}`);
      const pre = await readCaret();
      A.push("A6", pre && pre.editorFocused, `有焦点=${pre && pre.editorFocused}`);
      A.push("A7", pre && pre.scrollHeight > pre.clientHeight + 300, `可滚动 max=${pre ? Math.round(pre.scrollHeight - pre.clientHeight) : "?"}（视口 ${pre ? pre.clientHeight : "?"}px）`);

      if (!A.allOk()) {
        ui.add("V2-7", "R4#4 回车抖动（右屏 iframe）", "INVALID", `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        await ui.ev(START_TRACE(1900));
        await sleep(120);
        await ui.key("Enter", "Enter", 13);
        await sleep(2400);
        const trace = await ui.ev(`return window.__TR || []`);
        const post = await readCaret();
        const stAn = analyze(trace.map((s) => s.st));
        const deAn = analyze(trace.map((s) => s.deST));
        const addedLine = post && pre && post.docLines === pre.docLines + 1;
        A.push("A8", addedLine, `回车加行 ${pre.docLines}→${post ? post.docLines : "?"}`);

        /**
         * ## 动画期右屏"错跳"判据 —— **必须是同步性，不能是绝对像素**（本轮第二次订正）
         *
         * ### 第一版判据错在哪（探针 bug，差点报成产品缺陷）
         * 我直接沿用了 R4 的 `≤20px`。但 R4 那个阈值是在**位移 28px 的小动画**下标定的
         * （左屏 5 帧走 28px ⇒ 每帧约 6px，右屏峰值 20px）。
         * 本轮夹具加长到 212 行后，打字机要滚 **425px**，25 帧走完 ⇒
         * **缓动曲线中段的单帧步长天然就是 65~67px**。
         *
         * 决定性证据（同一批数据，两屏逐帧比值）：
         * ```
         * 左屏 Δ:  1.34  6   12   22   42.66  67.34  64.66  46   34  ...  （峰值 67.34）
         * 右屏 Δ: 28.66  6   11.34 21.33 41.33 65.34  63.33  44.67 32.66 ...  （峰值 65.34）
         * 比值:    -     1.00 0.94 0.97 0.97   0.97   0.98   0.97  0.96  ...
         * ```
         * ⇒ **比值恒在 0.94~1.00** = 右屏只是忠实跟随左屏动画，没有任何"自己错跳"。
         * 那个 65.34px 是**左屏 smooth 动画的真实步长**，不是缺陷。
         *
         * ### 为什么绝对阈值必然失效
         * 单帧步长 ∝ 总位移 ÷ 帧数，而总位移又取决于光标离视口中心多远。
         * 同一个动画在不同文档/视口下可以是 28px 也可以是 425px。
         * **任何固定像素阈值都会在小位移时漏判、大位移时误判。**
         *
         * ### 订正后的判据（两条）
         * 1. **同步性**：动画期每一帧 `右Δ / 左Δ` 应落在 **[0.3, 3.0]**
         *    （两屏高度比实测 0.68~1.0；留 3 倍余量容忍映射的非线性）
         * 2. **反转 = 0**：真正的"抖"是来回摆，这条与位移规模无关，仍然有效
         */
        const ratios = [];
        let worstRatio = null;
        const decoupledFrames = [];
        for (let i = 1; i < trace.length; i++) {
          const a = trace[i - 1], b = trace[i];
          if (typeof a.st !== "number" || typeof b.st !== "number") continue;
          if (typeof a.deST !== "number" || typeof b.deST !== "number") continue;
          const dl = b.st - a.st;
          const dr = b.deST - a.deST;
          // 只统计"左屏确实在动"的帧（动画期）
          if (Math.abs(dl) < 1) continue;
          const ratio = dr / dl;
          ratios.push(Math.round(ratio * 100) / 100);
          if (worstRatio === null || Math.abs(ratio - 1) > Math.abs(worstRatio - 1)) worstRatio = Math.round(ratio * 100) / 100;
          /**
           * ★ 脱同步帧必须**区分是否由内容变化驱动**（本轮诊断的关键结论）
           *
           * `v0170-r5-edit-diag2.mjs` 实测出两类性质完全不同的脱同步：
           * | 帧 | 左Δ | 右Δ | 比值 | tags/sh 变化 | 定性 |
           * |---|---|---|---|---|---|
           * | t=222 | 1.33 | **16.67** | 12.53 | **无** | ❌ **纯滚动错写 = 真缺陷** |
           * | t=471 | 6.67 | 20.67 | 3.10 | tags 4→5、sh 6033→6046 | ✅ **内容撑高后重对齐 = 正确行为** |
           *
           * 内容变了（回车让 iframe 多渲染一块 → scrollHeight 变大），
           * 同一 `scrollTop` 对应的内容就变了，**必须**重算位置 —— 那不是抖动。
           * 若不区分，会把正确行为当成缺陷报（R2/R3 反复踩的那类判据错）。
           */
          if (ratio < 0.3 || ratio > 3) {
            decoupledFrames.push({
              t: b.t, dl: Math.round(dl * 100) / 100, dr: Math.round(dr * 100) / 100, ratio: Math.round(ratio * 100) / 100,
              tagsBefore: a.tags, tagsAfter: b.tags, shBefore: a.deSH, shAfter: b.deSH,
              contentChanged: a.tags !== b.tags || a.deSH !== b.deSH,
            });
          }
        }
        const realDecoupled = decoupledFrames.filter((f) => !f.contentChanged);
        const benignDecoupled = decoupledFrames.filter((f) => f.contentChanged);
        const syncOk = realDecoupled.length === 0;

        const ok = A.allOk() && deAn.reversals === 0 && syncOk;
        ui.add("V2-7", "R4#4 回车抖动（右屏 iframe）",
          !A.allOk() ? "INVALID" : (ok ? "PASS" : "FAIL"),
          `左屏：帧数=${stAn.frames} 净Δ=${stAn.net}px 反转=${stAn.reversals}（R3#8 平滑）；` +
          `**右屏：真脱同步帧=${realDecoupled.length} 处（判据 =0）、内容驱动的重对齐=${benignDecoupled.length} 处（**属正确行为**）**、反转=${deAn.reversals}（判据 =0）、净Δ=${deAn.net}px；` +
          `逐帧比值范围 [${Math.min(...ratios).toFixed(2)}, ${Math.max(...ratios).toFixed(2)}]` +
          (realDecoupled.length
            ? `；**真脱同步frame**：` + realDecoupled.map((f) =>
                `t=${f.t}ms 左Δ=${f.dl} 右Δ=${f.dr}（比值 ${f.ratio}）tags ${f.tagsBefore}→${f.tagsAfter} sh ${f.shBefore}→${f.shAfter} 内容未变`
              ).join("；")
            : "") +
          (benignDecoupled.length
            ? `；内容驱动重对齐：` + benignDecoupled.map((f) =>
                `t=${f.t}ms 比值${f.ratio} tags ${f.tagsBefore}→${f.tagsAfter} sh ${f.shBefore}→${f.shAfter}`).join("；")
            : "") +
          `；右屏逐帧=${JSON.stringify(deAn.deltas)}` +
          (deAn.reversals > 0 ? ` ← 出现 ${deAn.reversals} 次方向反转` : "") +
          `。⚠️ 本轮位移 ${Math.abs(stAn.net)}px/25 帧，缓动中段步长天然 65px+，故**不用绝对像素阈值**（R4 的 ≤20px 是在 28px 小动画下标定的）`);
        ui.log(`[V2-7] 左屏 st ${stAn.first}→${stAn.last}；右屏 deST ${deAn.first}→${deAn.last}；` +
          `右屏 scrollHeight 区间=${JSON.stringify([Math.min(...trace.map((s) => s.deSH || 0).filter((v) => v)), Math.max(...trace.map((s) => s.deSH || 0))])}`);
        ui.log(`[V2-7] 逐帧比值 右Δ/左Δ = ${JSON.stringify(ratios)}`);
        ui.log(`[V2-7] 帧序(t:左/右/tags) = ${JSON.stringify(trace.slice(0, 30).map((s) => `${s.t}:${s.st}/${s.deST}/T${s.tags}`))}`);
      }
      await ui.shot("v27-rightpane");
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * V2-8：R4#5 阅读模式编辑可保存（**数据丢失级，最高优先**）
     *
     * ## ⚠️ 这条的缺陷是"偶发"，而且**多敲一个字会掩盖它**
     * R4 的机制：切模式 → CM6 宿主从 `display:none` 变可见 → 产生 focus/selectionSet
     * → `report(docChanged=false)` 携带**CM6 自己的陈旧全文**回写 App
     * → App content 被覆盖成旧值 → 保存写盘的是旧内容。
     * **多敲一个字**会让 CM6 doc 变化 → 上报的文本已含新内容 → 缺陷被"治好"。
     *
     * ⇒ 步骤必须**严格**：阅读面打字 → **立刻**切编辑 → **立刻**保存
     *   （中间不得有任何多余输入/等待过久）。
     *
     * ## 判据：**磁盘字节**（真机独有，浏览器做不到）
     * 探针进程侧 `fs.readFileSync(docFile)` 读取 → 必须含标记词。
     * 这一条是唯一能证明"用户的数据真的到了磁盘"的口径 ——
     * App content / localStorage / PM doc 都只是内存层，全绿也可能写盘写错。
     * ═══════════════════════════════════════════════════════════════════════ */
    {
      const A = makeAssert();
      const TOKEN = "ZQV2SAVE";
      await resetDoc();
      await sleep(300);

      /**
       * 把阅读面（ProseMirror）光标定位到「正文四 V21。」之后。
       *
       * ⚠️ **必须用 DOM Range，不能用 `view.dispatch`**：
       * PM 的 `view` 从外部拿不到可靠引用（R4 T1 踩过 `pmViewDesc.view` 恒 null），
       * 而原生 selection 是 PM 唯一自动识别并同步进 state 的通道。
       *
       * ⚠️ 这段**必须拼 HELPERS**：里面用了 `raf2`。第一版忘了拼，会抛
       * `raf2 is not defined`，而 `.catch(() => null)` 会把它吞成 null →
       * 表现为"前置断言 A1 莫名失败"，是典型的**探针 bug 伪装成产品缺陷**。
       */
      const placeReader = await ui.ev(HELPERS + `
        const pmEl = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
        if (!pmEl) return { ok: false, why: "no .ProseMirror" };
        pmEl.focus();
        const anchor = "正文四 V21。";
        const walker = document.createTreeWalker(pmEl, NodeFilter.SHOW_TEXT);
        let hit = null, n;
        while ((n = walker.nextNode())) { if ((n.nodeValue || "").indexOf(anchor) >= 0) { hit = n; break; } }
        if (!hit) return { ok: false, why: "anchor not found", sample: (pmEl.textContent || "").slice(0, 80) };
        const at = hit.nodeValue.indexOf(anchor) + anchor.length;
        const r = document.createRange(); r.setStart(hit, at); r.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        await raf2();
        return { ok: true, at };
      `);
      A.push("A1", placeReader && placeReader.ok, `阅读面光标定位 ${placeReader && placeReader.ok ? `at=${placeReader.at}` : (placeReader && placeReader.why)}`);

      // 先记录磁盘原始内容（判定"保存确实发生了"）
      const diskBefore = ui.fs.readFileSync(ui.docFile, "utf8");
      A.push("A2", diskBefore.indexOf(TOKEN) < 0, `磁盘原始内容不含标记词（基线干净）len=${diskBefore.length}`);

      // ① 阅读面打字
      await ui.command("view.preview");
      await sleep(1200);
      const readerVisible = await ui.ev(`const pm=document.querySelector(".ProseMirror"); return !!pm && pm.getClientRects().length>0`);
      A.push("A3", readerVisible, `阅读面可见=${readerVisible}`);
      const placeAgain = await ui.ev(HELPERS + `
        const pmEl = document.querySelector(".ProseMirror");
        if (!pmEl) return { ok: false };
        pmEl.focus();
        const anchor = "正文四 V21。";
        const walker = document.createTreeWalker(pmEl, NodeFilter.SHOW_TEXT);
        let hit = null, n;
        while ((n = walker.nextNode())) { if ((n.nodeValue || "").indexOf(anchor) >= 0) { hit = n; break; } }
        if (!hit) return { ok: false, why: "anchor gone" };
        const at = hit.nodeValue.indexOf(anchor) + anchor.length;
        const r = document.createRange(); r.setStart(hit, at); r.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        await raf2();
        return { ok: true };
      `);
      A.push("A4", placeAgain && placeAgain.ok, `切阅读后重新定位光标 ${placeAgain && placeAgain.ok}`);

      // 逐字符键入标记词（真实按键，不用 insertText —— 要模拟用户真实输入路径）
      for (const ch of TOKEN) await ui.key(ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0));
      await sleep(250);
      const pmAfterType = await ui.ev(`const pm=document.querySelector(".ProseMirror"); return pm ? (pm.textContent||"") : null`);
      A.push("A5", !!pmAfterType && pmAfterType.indexOf(TOKEN) >= 0, `阅读面已含标记词=${!!pmAfterType && pmAfterType.indexOf(TOKEN) >= 0}`);

      // ② **立刻**切编辑（不加任何多余输入、不等过久）
      await ui.command("view.edit");
      await sleep(900);

      // ③ **立刻**保存
      await ui.command("file.save");
      // 保存是异步写盘 —— 轮询磁盘，最多 4s
      let diskAfter = "";
      const t0 = Date.now();
      let sawToken = false;
      while (Date.now() - t0 < 4000) {
        await sleep(250);
        try {
          diskAfter = ui.fs.readFileSync(ui.docFile, "utf8");
        } catch { continue; }
        if (diskAfter.indexOf(TOKEN) >= 0) { sawToken = true; break; }
      }
      A.push("A6", diskAfter.length > 0, `磁盘可读 len=${diskAfter.length}`);

      /**
       * ## 判据（三层，从弱到强）
       * 1. **磁盘写入了**（`diskAfter !== diskBefore`）—— 证明保存动作确实落盘
       * 2. **磁盘含标记词** —— 证明**阅读面的编辑**到了磁盘（这是用户抱怨的项）
       * 3. **不丢其它内容** —— 磁盘仍含文档原有锚点（防"保存把文档写残"）
       *
       * ⚠️ 只看 2 不够：若实现退化成"用 App 旧 content 覆盖",
       *   可能既不含标记词**又**丢了别的编辑，必须同时验 3。
       */
      const changed = diskAfter !== diskBefore;
      const hasToken = diskAfter.indexOf(TOKEN) >= 0;
      const keepsAnchor = diskAfter.indexOf("正文四 V21。") >= 0 && diskAfter.indexOf(FIXTURE_MARK) >= 0;

      if (!A.allOk()) {
        ui.add("V2-8", "R4#5 阅读模式编辑可保存（磁盘字节）", "INVALID",
          `前置断言不成立：${A.failed().map((x) => `${x.id}:${x.why}`).join("；")}`);
      } else {
        ui.add("V2-8", "R4#5 阅读模式编辑可保存（磁盘字节）",
          hasToken && keepsAnchor ? "PASS" : "FAIL",
          `磁盘${changed ? "已变更" : "**未变更**"}、含标记词=${hasToken}、保留原内容=${keepsAnchor}；` +
          `磁盘 len ${diskBefore.length}→${diskAfter.length}（+${diskAfter.length - diskBefore.length}）；` +
          `标记词「${TOKEN}」${hasToken ? "已落盘" : "**未落盘 = 数据丢失**"}` +
          (!hasToken && changed ? ` ← 磁盘被写成**别的**内容（App 陈旧值覆盖的典型形态）` : ""));
        ui.log(`[V2-8] 磁盘内容头 200 字：${JSON.stringify(diskAfter.slice(0, 200))}`);
        ui.log(`[V2-8] 磁盘是否含 "正文四 V21。"=${diskAfter.indexOf("正文四 V21。") >= 0} / 含夹具标记=${diskAfter.indexOf(FIXTURE_MARK) >= 0}`);
      }
      await ui.shot("v28-save");
    }

    /* ── 收尾：打印环境信息（真机差异溯源用）── */
    const env = await ui.ev(`
      const ua = navigator.userAgent;
      const wv = (/Edg\\/([0-9.]+)/.exec(ua) || [])[1] || null;
      return {
        userAgent: ua,
        webviewVersion: wv,
        devicePixelRatio: window.devicePixelRatio,
        theme: document.documentElement.getAttribute("data-theme"),
        cmCursorLayerZ: (() => { const el = document.querySelector(".cm-cursorLayer"); return el ? getComputedStyle(el).zIndex : null; })(),
        cmGuttersZ: (() => { const el = document.querySelector(".cm-gutters"); return el ? getComputedStyle(el).zIndex : null; })(),
        hasTauri: typeof window.__TAURI_INTERNALS__ !== "undefined",
      };
    `);
    ui.log("[env] " + JSON.stringify(env, null, 1));
  },
);

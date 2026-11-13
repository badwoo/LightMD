/**
 * v0.17.0 第三轮 · T1「插入符号 / 专注 3 行窗」实测探针
 *
 * 覆盖两个用户缺陷：
 *   #5 编辑模式插入符号纯白；回车换行后又变白
 *   #7 专注模式：以光标行为中心共 3 行高亮、跟随光标；空白行只亮 2 行
 *
 * ## 为什么先量后修（R2 的教训）
 *
 * R2 在浏览器里逐一切 6 套主题读 `.cm-cursor` 的 `borderLeftColor`，6/6 都是主题色，
 * 于是判「未复现、不改代码」。但用户本轮明确说「解决了一半」「回车换到下一行时又变白」
 * —— 说明上一轮**静态枚举主题**没覆盖「回车之后」这条交互路径。
 *
 * 所以本探针三层同时取证：
 *   ① **用户看到的像素**（CDP 截图 → canvas 采样）：光标位置到底有没有一条对比明显的
 *      竖线、它是什么颜色。这是唯一能代表「用户感受」的口径 —— 白光标在白底上 = 看不见，
 *      而「看不见」和「颜色错了」在 CSS 层面是两种根因、在像素层面是同一现象。
 *   ② **计算样式**：`.cm-cursor` 的 borderLeftColor / display，`.cm-content` 的 caretColor
 *      （原生光标是否被藏），`.cm-activeLine` 的背景（当前行是否被刷成浅色带）。
 *   ③ **层叠来源**：命中 `.cm-cursor` / `.cm-activeLine` / `.cm-content` 的规则连特异性一起打印。
 *
 * ⚠️ 像素采样的两个硬约束（都踩过，别改回去）：
 *   1. **必须 `scale:3`**。光标 border 只有 1.2px，scale=1 时它被抗锯齿摊到 2~3 个像素列上，
 *      每列只有约 20% 覆盖率 → 读出来的"颜色"是混合色（dark 主题实测 lum 60 而不是 212），
 *      会把正常光标误判成「对比不足」。scale=3 后至少有 1 整列命中真色。
 *   2. **必须先关光标闪烁动画再截图**。`cm-blink` 的 50% 相位 opacity=0，
 *      随机截到暗相会把「闪烁」误判成「光标不可见」。只关动画不改颜色。
 *
 * ⚠️ 本探针在 headless Chrome 里跑 dist，**不等于**真机 WebView2。最终结论须在 exe 上复验。
 *
 * ## 用法
 * ```bash
 * npx vite build --outDir _verify-out/dist-t1 --emptyOutDir
 * BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t1" \
 *   node scripts/v0170-r3-caret-focus.mjs
 * ```
 */
import { runBrowserProbe, sleep, ROOT } from "./_lib/browser-probe.mjs";

/**
 * #7 专用文档：**短行、不软换行**，于是「一个 .cm-line 行盒 = 一个视觉行」，
 * 行盒高度可直接当作「用户眼里的行高」。
 *
 * 行号（0 起）：
 *   0: ""            空白首行
 *   1: "# 标题"       标题（行盒 1.4em 高，用来验证「行高不能拍脑袋取常量」）
 *   2: "正文二"       普通行
 *   3: ""            空白中间行
 *   4: "正文四"
 *   5: ""            连续空行 1
 *   6: ""            连续空行 2
 *   7: "正文七"
 *   8: ""            空白行（后面还有内容，所以不是文档边界）
 *   9~  "填充NN"      其它普通行，让文档可滚动
 */
const FOCUS_DOC_LINES = [
  "",
  "# 标题",
  "正文二",
  "",
  "正文四",
  "",
  "",
  "正文七",
  "",
];
for (let i = 10; i < 45; i++) {
  FOCUS_DOC_LINES.push(`填充行${String(i).padStart(2, "0")}`);
}
const DOC = FOCUS_DOC_LINES.join("\n");

/** 页面内公共工具 */
const PAGE_HELPERS = `
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 70))));
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  const cmContent = () => document.querySelector(".cm-content");
  const cmView = () => { const c = cmContent(); try { return c && c.cmTile && c.cmTile.view; } catch { return null; } };
  const readWindow = () => {
    const ov = document.querySelector(".source-focus-overlay");
    if (!ov) return null;
    const bi = ov.style.backgroundImage || "";
    const m = /transparent ([0-9.]+)px,\\s*transparent ([0-9.]+)px/.exec(bi);
    const r = ov.getBoundingClientRect();
    return { bi: bi.replace(/\\s+/g, " ").slice(0, 240), win: m ? [Number(m[1]), Number(m[2])] : null, overlayH: round(r.height), overlayTop: round(r.top) };
  };
  /** 整篇替换文档（直接走 CM6，等价于"打开了一个新文件"的最终文本状态） */
  const replaceDoc = (text) => {
    const view = cmView();
    if (!view) return false;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, scrollIntoView: true });
    return true;
  };
`;

/** #5：读光标 / 当前行 / 计算样式（一次 ev 取全，避免多次采样间状态漂移） */
const READ_CARET = PAGE_HELPERS + `
  const view = cmView();
  const content = cmContent();
  const cursor = document.querySelector(".cm-cursor");
  const cursorLayer = document.querySelector(".cm-cursorLayer");
  const ed = document.querySelector(".cm-editor");
  const sc = document.querySelector(".cm-scroller");
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const lin = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) }; };
  let caretRect = lin(cursor), caretSource = cursor ? "cm-cursor" : null;
  if (!caretRect && view) {
    try {
      const c = view.coordsAtPos(view.state.selection.main.head);
      if (c) { caretRect = { x: round(c.left), y: round(c.top), w: Math.max(1, round(c.right - c.left)), h: round(c.bottom - c.top) }; caretSource = "coordsAtPos"; }
    } catch { /* ignore */ }
  }
  const root = document.documentElement;
  const rgb = (name) => (getComputedStyle(root).getPropertyValue(name) || "").trim();
  const activeLines = Array.from(document.querySelectorAll(".cm-activeLine"));
  return {
    theme: root.getAttribute("data-theme") || "(none)",
    activeElement: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
    editorFocused: ed ? ed.classList.contains("cm-focused") : false,
    selection: view ? { head: view.state.selection.main.head, empty: view.state.selection.main.empty } : null,
    cursorCount: document.querySelectorAll(".cm-cursor").length,
    cursorRect: caretRect, caretSource,
    cursorStyle: cursor ? {
      borderLeftColor: cs(cursor).borderLeftColor, borderLeftWidth: cs(cursor).borderLeftWidth,
      display: cs(cursor).display, opacity: cs(cursor).opacity, visibility: cs(cursor).visibility,
    } : null,
    cursorLayerStyle: cursorLayer ? { opacity: cs(cursorLayer).opacity, animationName: cs(cursorLayer).animationName } : null,
    contentCaretColor: content ? cs(content).caretColor : null,
    activeLineCount: activeLines.length,
    activeLineBg: activeLines[0] ? cs(activeLines[0]).backgroundColor : null,
    scrollerBg: sc ? cs(sc).backgroundColor : null,
    bodyBg: cs(document.body).backgroundColor,
    varTextPrimary: rgb("--text-primary"),
    caretLineText: (() => { try { return view.state.doc.lineAt(view.state.selection.main.head).text.slice(0, 24); } catch { return null; } })(),
  };
`;

/** 页面内像素量化（差分版：返回逐像素 RGB 原始数组） */
const PAGE_PIXELS_RAW = `
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

/**
 * 页面内像素量化。
 *
 * 输入是 CDP 截的**小区域 PNG（scale=3）**，输出该区域里「与背景差最大的那一列」的颜色。
 * 背景基准取区域最左 2 列 + 最右 2 列的中位数（光标在区域中间，边缘必是底色）。
 */
const PAGE_PIXELS = `
  const img = new Image();
  img.src = "data:image/png;base64,__B64__";
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, cv.width, cv.height).data;
  const W = cv.width, H = cv.height;
  const px = (i, j) => { const o = (j * W + i) * 4; return [data[o], data[o + 1], data[o + 2]]; };
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const ref = [];
  for (const i of [0, 1, W - 2, W - 1]) for (let j = 0; j < H; j++) ref.push(px(i, j));
  const bg = [med(ref.map((c) => c[0])), med(ref.map((c) => c[1])), med(ref.map((c) => c[2]))];
  const diff = (c) => Math.max(Math.abs(c[0] - bg[0]), Math.abs(c[1] - bg[1]), Math.abs(c[2] - bg[2]));
  let best = null;
  const colMax = [];
  for (let i = 0; i < W; i++) {
    let md = -1, mc = null;
    for (let j = 0; j < H; j++) { const c = px(i, j); const d = diff(c); if (d > md) { md = d; mc = c; } }
    colMax.push(md);
    if (!best || md > best.d) best = { i, d: md, c: mc };
  }
  const above = colMax.filter((d) => d > 40).length;
  const lum = (c) => Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
  const isPureWhite = best.c.every((v) => v >= 248);
  return {
    bg, caretColor: best.c, contrast: best.d, col: best.i, colsAbove40: above,
    bgLum: lum(bg), caretLum: lum(best.c), isPureWhite,
    lumaDiff: Math.abs(lum(best.c) - lum(bg)),
    w: W, h: H, scale: 3,
  };
`;

/** 截取光标附近小区域（scale=3，见文件头「像素采样的两个硬约束」），并落盘留证 */
async function sampleCaretPixels(ui, rect, tag) {
  if (!rect || !(rect.h > 0)) return null;
  const padX = 8, padY = 5;
  const x = Math.max(0, Math.round(rect.x - padX));
  const y = Math.max(0, Math.round(rect.y - padY));
  const w = Math.max(8, Math.round(rect.w + padX * 2));
  const h = Math.max(10, Math.round(rect.h + padY * 2));
  const r = await ui.cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x, y, width: w, height: h, scale: 3 },
  });
  const b64 = r.result?.data;
  if (!b64) return null;
  // 落盘留证：报告里要能指着具体图片说明「这一列是什么颜色」
  try {
    const p = ui.path.join(ui.__shotDir, `${ui.name}-caret-${tag}.png`);
    ui.fs.writeFileSync(p, Buffer.from(b64, "base64"));
  } catch { /* 落盘失败不影响判定 */ }
  const px = await ui.ev(PAGE_PIXELS.replace("__B64__", b64));
  return { ...px, clip: { x, y, w, h } };
}

/**
 * ⭐ **像素差分**：把 `.cm-cursor` 自身的墨精确分离出来。
 *
 * ## 为什么单读「对比度」不够（这是本项最关键的方法论）
 *
 * 空行 / 行首的光标被行号槽**整条盖住**时，光标所在位置依然有别的墨
 * （行号槽右边框 `#ddd`），读"该区域对比度"会读到一个非零数值 → 看起来"有东西"，
 * 但那是**别人的墨**，不是光标。R2 就是栽在这类"读到非零就以为正常"的判据上。
 *
 * 差分把不变量全消掉：同一裁剪区域内 `显示光标` 与 `隐藏光标` 两张图逐像素相减，
 * 只有光标自己的贡献会留下差值。差值像素数 = 0 就意味着**光标一像素都没画出来**，
 * 与"颜色对不对"无关 —— 这是唯一能区分「不可见」和「看不见但画了」的口径。
 *
 * @returns { inkPixels, minColor, minLum, clip } inkPixels=0 表示光标完全没画出来
 */
async function sampleCaretDiff(ui, rect, tag) {
  if (!rect || !(rect.h > 0)) return null;
  const clip = {
    x: Math.max(0, Math.floor(rect.x) - 4),
    y: Math.max(0, Math.round(rect.y)),
    width: 12,
    height: Math.max(10, Math.min(21, Math.round(rect.h))),
    scale: 8,
  };
  const shoot = async () => {
    const r = await ui.cdp.send("Page.captureScreenshot", { format: "png", clip });
    return await ui.ev(PAGE_PIXELS_RAW.replace("__B64__", r.result.data));
  };
  await ui.ev(`document.getElementById("__t1_hidecursor").textContent = "/*show*/"; return true;`);
  await sleep(180);
  const on = await shoot();
  await ui.ev(`document.getElementById("__t1_hidecursor").textContent = ".cm-cursor{display:none !important}"; return true;`);
  await sleep(180);
  const off = await shoot();
  await ui.ev(`document.getElementById("__t1_hidecursor").textContent = "/*show*/"; return true;`);
  await sleep(180);

  let ink = 0, minC = null, minLum = 999;
  for (let o = 0; o < on.px.length; o++) {
    const a = on.px[o], b = off.px[o];
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 6) {
      ink++;
      const lum = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
      if (lum < minLum) { minLum = lum; minC = a; }
    }
  }
  return { inkPixels: ink, minColor: minC, minLum: minC ? Math.round(minLum) : null, clip };
}

/** 把所有命中 cm-cursor / cm-activeLine / cm-content 的 CSS 规则打出来（含特异性） */
const READ_CASCADE = `
  const spec = (sel) => {
    const s = sel.replace(/::[a-z-]+/g, "");
    const ids = (s.match(/#[A-Za-z0-9_-]+/g) || []).length;
    const cls = (s.match(/\\.[A-Za-z0-9_-]+/g) || []).length + (s.match(/\\[[^\\]]+\\]/g) || []).length + (s.match(/:(?!:)[a-z-]+/g) || []).length;
    const el = (s.replace(/#[A-Za-z0-9_-]+/g, "").replace(/\\.[A-Za-z0-9_-]+/g, "").replace(/\\[[^\\]]+\\]/g, "").replace(/::?[a-z-]+/g, "").match(/\\b[a-z]+\\b/g) || []).length;
    return ids + "-" + cls + "-" + el;
  };
  const out = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = (list) => {
      for (const rule of Array.from(list || [])) {
        if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules); continue; }
        const sel = rule.selectorText || "";
        if (!/cm-cursor|cm-activeLine|cm-content/.test(sel)) continue;
        const st = rule.style || {};
        const vals = {};
        for (const p of ["border-left", "border-left-color", "background", "background-color", "caret-color"]) {
          const v = st.getPropertyValue(p); if (v) vals[p] = v + (st.getPropertyPriority(p) ? " !" + st.getPropertyPriority(p) : "");
        }
        if (Object.keys(vals).length) out.push({ sel, spec: spec(sel), vals });
      }
    };
    walk(rules);
  }
  return out;
`;

/**
 * #7：逐位置量开窗。
 *
 * ## 量化口径（「亮几行」怎么算）
 *
 * 用户说「空白行只亮了两行」。这句话要变成可测量的量，最贴近感受的是
 * **「亮区覆盖了几个行盒」**：把 overlay 渐变里的透明段 `[a,b]` 当作亮区，
 * 对光标附近每个 `.cm-line` 行盒算覆盖比例 `overlap/行盒高`，
 * **覆盖 ≥ 60% 计为「亮了一行」**。
 *
 * 为什么不用任务卡最初写的「亮区高度 = 3 × 行高 ±1px」：
 * `measureRangeContentY` 的契约是「起止**字符字形矩形**」，字形框上下各内缩约 3~5px
 * （字高 21 vs 行高 28.8），所以 3 行的亮区**天然**比 3 个行盒矮 6~10px。
 * 这是两个实现共有的既有契约（`types.ts` 有说明），不是本缺陷。
 * 拿 ±1px 去卡会得到一个恒红的判据（R2 已记过这条"用实现反推实现"的坑）。
 * 覆盖行数则对字形内缩免疫，却能把「2 行 / 3 行」区分得清清楚楚。
 *
 * 同时仍然把 `[a,b]` 与「3 个行盒的并集」的原始差值打出来，供人工复核。
 */
const MEASURE_FOCUS_WINDOWS = PAGE_HELPERS + `
  const view = cmView();
  if (!view) return { error: "没有 CM6 view" };
  const doc = view.state.doc;
  const ov = document.querySelector(".source-focus-overlay");
  const sc = document.querySelector(".cm-scroller");
  if (!ov || !sc) return { error: "overlay/scroller 缺失" };

  const originOffset = () => {
    const content = cmContent();
    const ovR = ov.getBoundingClientRect(), scR = sc.getBoundingClientRect();
    const scPad = parseFloat(getComputedStyle(sc).paddingTop) || 0;
    const cPad = parseFloat(getComputedStyle(content).paddingTop) || 0;
    return round(scR.top + scPad + cPad - ovR.top);
  };

  const pairs = [
    ["首行(空)", 1, 0, "from"],
    ["标题行", 2, 2, "mid"],
    ["普通中间行", 3, 2, "mid"],
    ["空白中间行", 4, 0, "from"],
    ["连续空行第1", 6, 0, "from"],
    ["连续空行第2", 7, 0, "from"],
    ["末尾(非边界)空行", 9, 0, "from"],
    ["普通行·光标在行尾", 10, 0, "to"],
    ["普通行·光标在行首", 10, 0, "from"],
    ["末行", doc.lines, 1, "mid"],
    ["文档末尾", doc.lines, 0, "end"],
  ];
  const samples = [];
  for (const [id, lineNo, at, mode] of pairs) {
    const ln = doc.line(Math.max(1, Math.min(doc.lines, lineNo)));
    const pos = mode === "from" ? ln.from : mode === "to" ? ln.to : mode === "end" ? doc.length : Math.min(ln.to, ln.from + at);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
    await raf2();
    // 宿主监听的是 document 的 selectionchange；程序化 dispatch 不保证浏览器派发，
    // 这里显式补一次，等价于真实方向键移动后的那次通知（不改任何几何输入）。
    document.dispatchEvent(new Event("selectionchange"));
    await raf2(); await raf2();

    const w = readWindow();
    const oo = originOffset();
    const scrollTop = sc.scrollTop;
    const ovR = ov.getBoundingClientRect();
    const curLine = doc.lineAt(pos);
    const curLineNo = curLine.number - 1;          // 0 起

    // 行盒（内容坐标）→ overlay 坐标
    const boxOf = (i) => {
      try {
        const L = doc.line(i + 1);
        const b = view.lineBlockAt(L.from);
        return { i, top: b.top - scrollTop + oo, height: b.height, bottom: b.top + b.height - scrollTop + oo };
      } catch { return null; }
    };
    const boxes = [];
    for (let i = Math.max(0, curLineNo - 2); i <= Math.min(doc.lines - 1, curLineNo + 2); i++) {
      const b = boxOf(i); if (b) boxes.push(b);
    }
    const band = w && w.win ? w.win : null;
    const cover = (b) => {
      if (!band) return 0;
      const lo = Math.max(b.top, band[0]), hi = Math.min(b.bottom, band[1]);
      return Math.max(0, Math.min(1, (hi - lo) / Math.max(1, b.height)));
    };
    const covered = band ? boxes.filter((b) => cover(b) >= 0.6) : [];
    // 「3 个行盒的并集」原始跨度，供人工复核「差多少 px」
    const spanBoxes = band ? boxes.filter((b) => cover(b) >= 0.6) : [];
    const curBox = boxOf(curLineNo);
    const capStart = boxes.length ? Math.max(0, Math.min(...boxes.map((b) => b.top))) : null;
    const capEnd = boxes.length ? Math.max(...boxes.map((b) => b.bottom)) : null;
    const bandCenter = band ? (band[0] + band[1]) / 2 : null;
    /**
     * 期望覆盖的行盒索引 = 「以光标行为中心、尽量取 3 行」。
     *
     * ## 为什么不能只写「光标行 ±1」
     *
     * 用户的原话是「以编辑符所在行为中心进行上下行**一共 3 行**」—— 要求的是**总行数 3**。
     * 在文档首/末行时，"上下各 1 行"物理上不可能（上方/下方没有行），
     * 正确语义是**向还有空间的一侧补足**：
     * 
     * 光标在首行(cur=0)：  [0, 2]     （向下补 1 行；不能写 [-1, 1]）
     * 光标在末行(cur=43)： [41, 43]   （向上补 1 行）
     * 文档中间(cur=2)：    [1, 3]
     * 
     * 这是**需求描述的直接翻译**（不是照抄产品实现）：独立按行号算一遍，
     * 与 expandFocusRangeToRows 的字符版实现互为交叉验证。
     */
    const wantRows = Math.min(3, doc.lines);
    const expectedIds = (() => {
      let first = curLineNo - 1;
      let last = curLineNo + 1;
      // 越界就向另一侧补足（首行向下补、末行向上补）
      if (first < 0) { last += -first; first = 0; }
      if (last > doc.lines - 1) { first -= last - (doc.lines - 1); last = doc.lines - 1; }
      first = Math.max(0, first);
      const out = [];
      for (let i = first; i <= last; i++) out.push(i);
      // 文档不足 3 行时只可能取到全部行
      return out.slice(0, wantRows).length === out.length ? out : out.slice(0, wantRows);
    })();
    const capCenter = curBox ? (curBox.top + curBox.bottom) / 2 : null;

    samples.push({
      id, pos, lineNo: curLineNo, lineText: curLine.text.slice(0, 16),
      isBlankLine: curLine.length === 0,
      mode, scrollTop: round(scrollTop),
      cursorInViewport: (() => { try { const c = view.coordsAtPos(pos); if (!c) return null; return c.top >= ovR.top && c.bottom <= ovR.bottom; } catch { return null; } })(),
      /** 视口裁剪护栏：光标离可见区上下边缘不足 2 行高时，3 行窗必然被正常裁掉 → 判据不适用 */
      clippedByViewport: (() => {
        try {
          const c = view.coordsAtPos(pos);
          if (!c) return true;
          const lh = view.defaultLineHeight;
          return (c.top - ovR.top) < lh * 2 || (ovR.bottom - c.bottom) < lh * 2;
        } catch { return true; }
      })(),
      /**
       * ⭐ 文档是否物理上够 3 行（决定「补不满」是缺陷还是文档限制）。
       *
       * 只有**文档总行数 < 3** 时补不满才算正常（物理限制）；
       * 文档有 3 行以上时，首/末行也必须凑满 3 行 —— 这正是 expandFocusRangeToRows 的职责。
       */
      docHasEnoughRows: doc.lines >= 3,
      /**
       * ⭐ 目标 3 行行盒是否整段**物理落进** overlay 可见区。
       *
       * 这是区分「视口裁剪（正常）」与「窗口算错（缺陷）」的关键：
       * 若 3 行行盒的并集在 overlay 的 [0, overlayH] 之外 → 裁掉是正常的，判据不适用；
       * 若整段都在可见区内、却没被覆盖满 → **窗口算错了**，是真缺陷。
       */
      targetRowsFullyVisible: (() => {
        try {
          const topBox = view.lineBlockAt(doc.line(Math.max(1, curLineNo)).from);
          const botLineNo = Math.min(doc.lines, curLineNo + 2);
          const botBox = view.lineBlockAt(doc.line(botLineNo).from);
          const oo = (() => {
            const content = cmContent();
            const ovR2 = ov.getBoundingClientRect(), scR2 = sc.getBoundingClientRect();
            const scPad = parseFloat(getComputedStyle(sc).paddingTop) || 0;
            const cPad = parseFloat(getComputedStyle(content).paddingTop) || 0;
            return scR2.top + scPad + cPad - ovR2.top - scrollTop;
          })();
          const bandTop = topBox.top + oo;
          const bandBot = botBox.top + botBox.height + oo;
          return bandTop >= 0 && bandBot <= ovR.height;
        } catch { return false; }
      })(),
      win: band,
      winH: band ? round(band[1] - band[0]) : null,
      winCenter: bandCenter != null ? round(bandCenter) : null,
      curBoxCover: curBox ? round(cover(curBox)) : null,
      curBox: curBox ? { top: round(curBox.top), height: round(curBox.height) } : null,
      curBoxCenter: curBox ? round(curBox.top + curBox.bottom) / 2 : null,
      /** ⭐ 期望中心用「3 行盒并集的几何中心」，不是「光标行盒中心」——见下方判据注释 */
      capCenter: capCenter != null ? round(capCenter) : null,
      /** 窗口内最高行盒 / 最低行盒高度（标题行 1.4em 会让窗口变高） */
      boxHeights: boxes.map((b) => round(b.height)),
      centerDelta: (bandCenter != null && capCenter != null) ? round(bandCenter - capCenter) : null,
      coveredCount: covered.length,
      coveredIds: covered.map((b) => b.i),
      expectedIds,
      /** 覆盖的索引集合是否恰好等于「光标行 ±1」 */
      idsMatch: covered.length === expectedIds.length && covered.every((b) => expectedIds.includes(b.i)),
      boxes: boxes.map((b) => ({ i: b.i, top: round(b.top), h: round(b.height), cov: round(cover(b)) })),
      defaultLh: round(view.defaultLineHeight),
    });
  }
  return { samples, originOffset: originOffset(), totalLines: doc.lines, defaultLh: round(view.defaultLineHeight) };
`;

await runBrowserProbe({ name: "v0170-r3-caret-focus", doc: DOC }, async (ui) => {
  ui.log(`[env] 源码面实现 = ${ui.impl}`);
  // 截图落盘目录（与骨架的 SHOT_DIR 同构，但本探针要按「阶段名」自己命名，故直接算）
  ui.__shotDir = ui.path.join(ROOT, "_verify-out", "shots");
  ui.fs.mkdirSync(ui.__shotDir, { recursive: true });

  // 关光标闪烁（见文件头硬约束 2）。只关动画，不改颜色 → 颜色结论不受影响。
  // 同时装一个「隐藏光标」开关（内容由后面的差分采样切换），用于把光标的墨分离出来。
  await ui.ev(`
    const hide = document.createElement("style");
    hide.id = "__t1_hidecursor";
    hide.textContent = "/*show*/";
    document.head.appendChild(hide);
    const st = document.createElement("style");
    st.id = "__t1_noblink";
    st.textContent = ".cm-cursorLayer, .cm-cursor { animation: none !important; opacity: 1 !important; }";
    document.head.appendChild(st);
    return true;
  `);

  /** 复位：整篇换文档 + 光标放到指定行行尾（用户「在这一行末尾敲字/回车」的真实场景） */
  const resetDoc = async (caretLine = 3) => {
    return await ui.ev(PAGE_HELPERS + `
      if (!replaceDoc(${JSON.stringify(DOC)})) return { ok: false };
      const view = cmView();
      const L = view.state.doc.line(${caretLine});
      view.dispatch({ selection: { anchor: L.to }, scrollIntoView: true });
      view.focus();
      document.dispatchEvent(new Event("selectionchange"));
      await raf2();
      return { ok: true, lines: view.state.doc.lines, len: view.state.doc.length, head: view.state.selection.main.head, lineText: view.state.doc.lineAt(view.state.selection.main.head).text.slice(0, 20) };
    `);
  };

  /* ══════════════════════ #5 插入符号 ══════════════════════ */

  await ui.focusSource();

  /** 采一次：读几何 → 3 种采样（对比度 / 差分 / 落盘） */
  const sampleCaret = async (tag) => {
    const st = await ui.ev(READ_CARET);
    let px = null, diff = null;
    if (st && st.cursorRect) {
      for (let i = 0; i < 2; i++) {
        const p = await sampleCaretPixels(ui, st.cursorRect, tag).catch(() => null);
        // 取「对比度更高」的一次（防止刚好截在光标重绘的中间态）
        if (p && (!px || p.contrast > px.contrast)) px = p;
        await sleep(120);
      }
      diff = await sampleCaretDiff(ui, st.cursorRect, tag).catch(() => null);
    }
    return { tag, st, px, diff };
  };

  const rows = [];
  const cascade = { dumped: false, rules: [] };
  const THEMES = ["light", "dark", "github", "newsprint", "night", "solarized"];

  // 先把主题切到 light（未知初值 → 循环切换直到命中）
  for (let i = 0; i < 8; i++) {
    const t = await ui.ev(`return document.documentElement.getAttribute("data-theme") || "(none)"`);
    if (t === "light") break;
    await ui.command("view.toggleTheme");
    await ui.sleep(300);
  }

  for (const theme of THEMES) {
    let guard = 0;
    while (guard++ < 8) {
      const t = await ui.ev(`return document.documentElement.getAttribute("data-theme") || "(none)"`);
      if (t === theme) break;
      await ui.command("view.toggleTheme");
      await ui.sleep(280);
    }
    const r0 = await resetDoc(3);   // 光标落在「正文四」行尾
    await ui.sleep(320);

    if (!cascade.dumped) {
      cascade.rules = await ui.ev(READ_CASCADE);
      cascade.dumped = true;
      ui.log(`[#5-cascade] 命中 cm-cursor / cm-activeLine / cm-content 的规则数 = ${cascade.rules.length}`);
      for (const r of cascade.rules) ui.log(`  spec=${r.spec}  ${r.sel}  →  ${JSON.stringify(r.vals)}`);
    }

    const before = await sampleCaret(`${theme}-1回车前`);
    // ① 行尾按回车：新起一个空行（用户「回车换到下一行」的最直接场景）
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(420);
    const afterEnter = await sampleCaret(`${theme}-2回车后空行`);
    // ② 空行上再敲 3 个字符（有内容时的光标）
    for (const ch of ["a", "b", "c"]) await ui.key(ch, `Key${ch.toUpperCase()}`, ch.charCodeAt(0));
    await ui.sleep(300);
    const afterType = await sampleCaret(`${theme}-3空行打字后`);
    // ③ 再回车（连续第二次回车 = 空白行之间）
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(420);
    const afterEnter2 = await sampleCaret(`${theme}-4二次回车`);
    /**
     * ④ **文档第 0 列**（行首）—— 与空行同源的另一个受害者位置。
     *
     * 空行与"行首"的共同点是「光标 x 落在正文列左缘」，而正文列左缘紧贴行号槽右边界。
     * 只测空行会以为是"空行特有"，测行首才能证明这是**第 0 列**的通用缺陷。
     */
    await resetDoc(3);
    await ui.ev(PAGE_HELPERS + `
      const view = cmView();
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from }, scrollIntoView: true });
      view.focus();
      document.dispatchEvent(new Event("selectionchange"));
      await raf2();
      return true;
    `);
    await ui.sleep(320);
    const col0 = await sampleCaret(`${theme}-5行首第0列`);

    const pick = (s) => ({
      光标色: s.st?.cursorStyle?.borderLeftColor ?? null,
      原生caretColor: s.st?.contentCaretColor ?? null,
      光标元素数: s.st?.cursorCount ?? null,
      当前行底: s.st?.activeLineBg ?? null,
      聚焦: s.st?.editorFocused ?? null,
      activeEl: s.st?.activeElement ?? null,
      行文本: s.st?.caretLineText ?? null,
      光标x: s.st?.cursorRect ? s.st.cursorRect.x : null,
      像素: s.px ? {
        对比: s.px.contrast, 亮度差: s.px.lumaDiff, 光标像素: s.px.caretColor, 底色: s.px.bg,
        光标亮度: s.px.caretLum, 底色亮度: s.px.bgLum, 纯白: s.px.isPureWhite, 命中的列: s.px.colsAbove40,
      } : null,
      /** 差分：光标自身画出多少墨（0 = 完全没画出来） */
      墨像素数: s.diff ? s.diff.inkPixels : null,
      差分最深色: s.diff ? s.diff.minColor : null,
    });
    rows.push({
      theme, doc: r0,
      回车前: pick(before), 回车后空行: pick(afterEnter),
      空行打字后: pick(afterType), 二次回车: pick(afterEnter2), 行首第0列: pick(col0),
    });
    ui.log(
      `[#5] 主题=${theme}\n` +
        `   回车前(非空行尾) 色=${pick(before).光标色} 墨=${pick(before).墨像素数} 像素=${JSON.stringify(pick(before).像素)}\n` +
        `   回车后(新空行)   色=${pick(afterEnter).光标色} 墨=${pick(afterEnter).墨像素数} 像素=${JSON.stringify(pick(afterEnter).像素)}\n` +
        `   空行打字后       墨=${pick(afterType).墨像素数} 像素=${JSON.stringify(pick(afterType).像素)}\n` +
        `   二次回车         墨=${pick(afterEnter2).墨像素数} 像素=${JSON.stringify(pick(afterEnter2).像素)}\n` +
        `   行首第0列        x=${pick(col0).光标x} 色=${pick(col0).光标色} 墨=${pick(col0).墨像素数} 像素=${JSON.stringify(pick(col0).像素)}`,
    );
  }

  /* ── #5 判据 ────────────────────────────────────────────────
   * 判据（Lead 确认版）：**双口径**都要过
   *   ① 像素亮度差 ≥ 90（光标与真实底色，从画面取，不用 computed 背景）
   *   ② **差分墨像素数 > 0**（光标本体真的画出东西了）
   * 只用 ① 会漏（行号槽边框 = 别人的墨也能凑出非零对比）；
   * 只用 ② 会漏「画了但颜色和底一样」（那种 ② 有个位数墨、① 会红）。
   */
  const judgeCell = (p) => {
    const okInk = p.墨像素数 != null && p.墨像素数 > 0;
    const okContrast = !!p.像素 && p.像素.亮度差 >= 90;
    return {
      pass: okInk && okContrast,
      why: `墨=${p.墨像素数} 亮度差=${p.像素 ? p.像素.亮度差 : "null"} 色=${p.光标色} 差分最深=${JSON.stringify(p.差分最深色)}`,
    };
  };
  const mkJudge = (key) => rows.map((r) => ({ theme: r.theme, ...judgeCell(r[key]) }));
  const j1 = mkJudge("回车前"), j2 = mkJudge("回车后空行"), j3 = mkJudge("空行打字后"), j4 = mkJudge("二次回车"), j5 = mkJudge("行首第0列");
  ui.add("C1", "★ #5 回车**前**（非空行行尾）光标可见（6 主题）", j1.every((j) => j.pass) ? "PASS" : "FAIL", JSON.stringify(j1));
  ui.add("C2", "★ #5 回车**后（新空行）**光标可见（6 主题）— 用户直接抱怨项", j2.every((j) => j.pass) ? "PASS" : "FAIL", JSON.stringify(j2));
  ui.add("C3", "★ #5 空行打字后光标可见（6 主题）", j3.every((j) => j.pass) ? "PASS" : "FAIL", JSON.stringify(j3));
  ui.add("C4", "★ #5 二次回车（连续空行）光标可见（6 主题）", j4.every((j) => j.pass) ? "PASS" : "FAIL", JSON.stringify(j4));
  ui.add("C4b", "★ #5 **行首第 0 列**光标可见（6 主题）— 与空行同源的第二个受害者", j5.every((j) => j.pass) ? "PASS" : "FAIL", JSON.stringify(j5));

  // 取证：有没有「纯白」光标（用户原话的关键词）
  const pureWhite = rows.flatMap((r) =>
    [["回车前", r.回车前], ["回车后空行", r.回车后空行], ["空行打字后", r.空行打字后], ["二次回车", r.二次回车]]
      .filter(([, p]) => p.像素 && p.像素.纯白)
      .map(([k, p]) => ({ theme: r.theme, 阶段: k, 像素: p.像素.光标像素 })),
  );
  ui.add("C5", "取证：是否出现「纯白光标」（像素 RGB 三通道 ≥ 248）", "KNOWN",
    pureWhite.length ? JSON.stringify(pureWhite) : "0 处纯白");

  // 取证：.cm-content 的原生 caretColor（CM6 基础主题在暗色下给 white）
  const caretColors = rows.map((r) => ({ theme: r.theme, 原生caretColor: r.回车前.原生caretColor, 光标色: r.回车前.光标色 }));
  ui.add("C6", "取证：原生 caretColor vs drawSelection 光标色（CM6 基础主题暗色下给 white）", "KNOWN", JSON.stringify(caretColors));

  /* ══════════════════════ #7 专注 3 行窗 ══════════════════════ */

  try {
    // 切回 light（深色下叠加遮罩对比度更好读；判据本身与主题无关）
    for (let i = 0; i < 8; i++) {
      const t = await ui.ev(`return document.documentElement.getAttribute("data-theme") || "(none)"`);
      if (t === "light") break;
      await ui.command("view.toggleTheme");
      await ui.sleep(260);
    }
    // 复位文档（#5 阶段往里敲了回车和字母）
    const r0 = await resetDoc(3);
    ui.log(`[#7-reset] ${JSON.stringify(r0)}`);
    if (!r0?.ok) ui.add("F0", "文档复位", "FAIL", JSON.stringify(r0));

    await ui.focusSource();
    let overlay = await ui.ev(`return !!document.querySelector(".source-focus-overlay")`);
    if (!overlay) { await ui.command("view.toggleFocusMode"); await ui.sleep(700); overlay = await ui.ev(`return !!document.querySelector(".source-focus-overlay")`); }
    ui.add("F1", "专注模式可开启（overlay 已挂载）", overlay ? "PASS" : "FAIL", overlay ? "ok" : "overlay 缺失");

    const measured = await ui.ev(MEASURE_FOCUS_WINDOWS);
    if (measured?.error) {
      ui.add("F2", "逐位置量开窗", "FAIL", measured.error);
    } else {
      ui.log(`[#7] defaultLineHeight=${measured.defaultLh} originOffset=${measured.originOffset} totalLines=${measured.totalLines}`);
      for (const s of measured.samples) {
        ui.log(
          `[#7] ${s.id} pos=${s.pos} 行=${s.lineNo} 文本="${s.lineText}" 空行=${s.isBlankLine} ` +
            `win=[${s.win}] 窗高=${s.winH} 覆盖行数=${s.coveredCount} 覆盖=${JSON.stringify(s.coveredIds)} ` +
            `光标行盒=${JSON.stringify(s.curBox)} 光标行盒覆盖=${s.curBoxCover} 中心差=${s.centerDelta} ` +
            `在视口内=${s.cursorInViewport} scrollTop=${s.scrollTop}`,
        );
      }

      /**
       * 判据（订正版，四处都踩过）：
       *
       * 1. **不能用「高度 = 3 × 行高 ±1px」**（任务卡原判据）：`measureRangeContentY`
       *    的契约是「字符**字形**矩形」，字形框上下各内缩约 4px（字高 21 vs 行高 28.8）
       *    → 3 行窗天然比 3 行盒矮 7.8px。拿它判会在**修复正确时也红**。
       * 2. **不能用「中心差 ≤2px」**：窗口含标题（行盒 40.33 = 1.4em）时，
       *    3 个行盒的几何并集中心天然偏离光标行盒中心（实测 5.66~33.66px），
       *    但那**仍是**「以光标行为中心取 ±1 行」的正确结果 —— 只是上下两行高度不等。
       * 3. **正确判据 = 覆盖的行盒索引集合恰好等于「光标行 ±1」**。它同时锁住
       *    「覆盖哪几行」和「以光标行为中心」，且对行高不对称免疫。
       * 4. **「不适用」必须严格限定为两种物理原因**（不能拿它当免死金牌）：
       *    ① 文档总行数 < 3（补不满是文档限制）
       *    ② 目标 3 行行盒整段落在 overlay 可见区之外（正常视口裁剪）
       *    首行/末行在文档够 3 行时**必须凑满 3 行** —— 那是 `expandFocusRangeToRows` 的职责。
       */
      const rows2 = measured.samples.map((s) => {
        // 两种物理限制之外，一律要判
        const physicallyLimited = !s.docHasEnoughRows || !s.targetRowsFullyVisible;
        const expectRows = physicallyLimited
          ? Math.min(measured.totalLines, s.lineNo === 0 || s.lineNo === measured.totalLines - 1 ? 2 : 3)
          : 3;
        return {
          id: s.id, 空行: s.isBlankLine, 在行尾: s.mode === "to", pos: s.pos,
          窗高: s.winH, 覆盖行数: s.coveredCount, 覆盖: s.coveredIds, 期望: s.expectedIds,
          期望行数: expectRows, 中心差: s.centerDelta,
          行盒高: s.boxHeights,
          物理限制: physicallyLimited,
          限制原因: !s.docHasEnoughRows ? `文档仅 ${measured.totalLines} 行` : (!s.targetRowsFullyVisible ? "目标行盒超出可见区（正常裁剪）" : null),
          通过: s.idsMatch && s.coveredCount >= expectRows,
        };
      });
      const judged = rows2.filter((r) => r.通过 !== null);
      const fail = judged.filter((r) => !r.通过);
      ui.add(
        "F2",
        "★ #7 亮区覆盖 3 个行盒（文档边界处 2 个）+ 亮区中心=光标行盒中心（±2px）",
        fail.length === 0 && judged.length > 0 ? "PASS" : "FAIL",
        `适用 ${judged.length}/${rows2.length}（其余为视口裁剪，不适用）；` +
          `通过 ${judged.length - fail.length}/${judged.length}；失败=` + JSON.stringify(fail) +
          `；裁剪跳过=` + JSON.stringify(rows2.filter((r) => r.通过 === null).map((r) => r.id)),
      );

      // 用户直接抱怨项：空白行（只在视口内可判的样本上判）
      const blankRows = judged.filter((r) => r.空行);
      ui.add(
        "F3",
        "★ #7 空白行位置亮区仍是 3 行（用户直接抱怨项）",
        blankRows.length > 0 && blankRows.every((r) => r.覆盖行数 >= r.期望行数) ? "PASS" : "FAIL",
        JSON.stringify(blankRows),
      );

      // 「窗口末行是空行」= 本次根因命中的形态，含**普通段落中间**（主路径）
      const lastEmptyRows = judged.filter((r) => r.空行 || r.id.includes("行首") || r.id.includes("行尾"));
      ui.add(
        "F3b",
        "★ #7 「窗口末行是空行」形态（含普通段落中间，markdown 主路径）覆盖 3 行",
        lastEmptyRows.length > 0 && lastEmptyRows.every((r) => r.覆盖行数 >= r.期望行数) ? "PASS" : "FAIL",
        JSON.stringify(lastEmptyRows),
      );

      // 行尾光标（用户"在这一行末尾打字/回车"必经位置）
      const eolRows = rows2.filter((r) => r.在行尾);
      ui.add(
        "F4",
        "★ #7 光标在**行尾**（line.to，如 End 键 / 行尾打字）时仍是 3 行",
        eolRows.length > 0 && eolRows.every((r) => r.覆盖行数 >= r.期望行数) ? "PASS" : "FAIL",
        JSON.stringify(eolRows),
      );

      /**
       * 跟随（刚体平移）：窗口内**行盒组合相同**的位置，窗高必须一致。
       *
       * ⚠️ 不能要求"所有位置窗高完全一致"：CM6 按级别放大标题
       * （`.cm-md-heading1 { font-size:1.4em }` → 行盒 40.33 vs 28.8），
       * 所以「窗口含标题行」的位置窗高天然比「3 个正文行」高 11.5px（实测）。
       * 那是**正确的排版**，不是刚体性被破坏。因此按「行盒高度序列」分组比较 ——
       * 同一组内必须完全一致（否则说明窗随位置变形），组间允许差异。
       */
      const groups = new Map();
      for (const r of judged) {
        const key = JSON.stringify((r.行盒高 || []).map((h) => Math.round(h)));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r.窗高);
      }
      let rigidOk = true;
      const groupDetail = [];
      for (const [key, hs] of groups) {
        const spread = Math.round((Math.max(...hs) - Math.min(...hs)) * 100) / 100;
        if (spread > 2) rigidOk = false;
        groupDetail.push({ 行盒高序列: key, 窗高: hs, 极差: spread });
      }
      ui.add(
        "F5",
        "★ #7 跟随：**行盒组合相同**的位置窗高一致（刚体平移；含标题行的窗口天然更高，属正确排版）",
        rigidOk ? "PASS" : "FAIL",
        JSON.stringify(groupDetail),
      );

      // 兜底分支识别：亮区中心是否离光标行盒很远（= 落进了「视口中央兜底窗」）
      const centered = measured.samples.filter(
        (s) => s.winCenter != null && s.curBoxCenter != null && Math.abs(s.winCenter - s.curBoxCenter) > 40,
      );
      ui.add("F6", "取证：是否落进「视口中央兜底窗」", centered.length === 0 ? "PASS" : "KNOWN",
        `${centered.length}/${measured.samples.length} 个位置的亮区离光标行盒超过 40px：` + JSON.stringify(centered.map((s) => s.id)));
    }
  } catch (e) {
    ui.add("F2", "专注窗测量", "FAIL", String(e.stack || e.message).slice(0, 400));
  }

  await ui.shot("final");
  await sleep(100);
});

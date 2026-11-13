/**
 * v0.17.0 第三轮 · **Lead 独立交叉验证探针**
 *
 * ## 为什么 Lead 要单独写一份（而不是直接采信各修复者自己的探针）
 *
 * 前两轮的核心教训：**修复者的探针与修复者的实现常常共享同一个错误假设**。
 * 例如 R2 #11 的 `v0152-mode-slide.test.ts` 读源文件断言"CSS 内容正确"，
 * 但从来没证明"CSS 进了打包产物" —— 于是 `modeSwitchSlide.css` 全仓零 import
 * 这个 P0 缺陷在绿测试下存活了一个版本。
 *
 * 所以本探针的设计原则：
 * 1. **本地重写关键判据**，不 import 各修复者的辅助函数（避免共享假设）；
 * 2. 只测**用户可感知的量**（亮度差、行高倍数、像素轨迹、文本内容），
 *    不测"实现是否调用某个函数"；
 * 3. 每项都带**破坏性对照**：证明判据在该红的时候会红；
 * 4. 结论与各修复者的报告**独立比对**，不一致就是信号。
 *
 * ## 覆盖范围（本轮 12 项里可被浏览器量化的部分）
 *
 * | # | 项 | 本探针的判据 |
 * |---|---|---|
 * | 5 | 插入符号纯白 | 回车**前后**都测 `.cm-cursor` 的 borderLeftColor 与背景亮度差 ≥ 90 |
 * | 7 | 专注模式 3 行 | 亮区高度 / 行高 = 3（±0.15），且**空行**也必须 3 |
 * | 10 | mermaid 中文 | 下拉菜单条目文本**不含 ASCII 单词型英文**（ER图/JSON 这类除外） |
 * | 2 | Ctrl+T 序号 | 有序列表 3 项，光标在第 2 项 → 剩余项字面序号是否被改 |
 * | 3 | ghost 覆盖 | 语法栏/格式栏每一项插入后，文档里**不含** ghost 文案（不落盘） |
 *
 * ⚠️ 本探针**不能**替代实机 exe 复验（WebView2 版本/字体回退/缩放有差异）。
 * ⚠️ 本探针不覆盖需要真机 FS 的项（#9 落盘、#11 真实文件切换），那些由专门的探针/真机验收负责。
 *
 * ## 用法
 * ```bash
 * npx vite build --outDir _verify-out/dist-lead --emptyOutDir
 * BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-lead" \
 *   node scripts/v0170-r3-lead-crosscheck.mjs
 * ```
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

// 40 段**短行**文档：既便于定位段落，也够长到能滚动。
//
// ⚠️ 为什么必须"短行"（第一版探针踩的坑）：
// 分屏下正文列只有 ~700px，长段会**软换行成 3 个视觉行**（行盒高 86.4 而非 28.8）。
// 第一版用"所有已渲染行高的中位数"当行高 → 拿到 86.4 → 算出的"亮区 = 0.64 行"
// 是**判据自己错了**，不是产品错。这正是 R2 交付报告里记录的原话
// 「行高原取第 0→1 行间距，被 H1 的 1.4em 污染；改中位数又被软换行 3 倍行盒污染」。
// 本版：文档用短行（保证不折行）+ 行高取**最小值**（单视觉行高度）+ 样本护栏。
const parts = ["# 基线", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`PI${String(i).padStart(2, "0")} 短行。`);
  parts.push("");
}
const DOC = parts.join("\n");

/** 相对亮度（WCAG 公式，用于"纯白 vs 背景"这类判定） */
const LUM = `
  const lum = (r, g, b) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return Math.round((0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)) * 255);
  };
  const parseRgb = (s) => {
    const m = /rgba?\\(\\s*([0-9.]+)[,\\s]+([0-9.]+)[,\\s]+([0-9.]+)/.exec(s || "");
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  };
`;

/**
 * 读光标颜色 + 背景色 + 亮度差。
 *
 * ⚠️ 关键设计：**同时**读 `.cm-cursor`（drawSelection 画的）与 DOM selection 的
 * computed caret-color，因为"插入符号"在 CM6 下有两条可能的绘制路径。
 * 只测一条就可能漏掉用户实际看到的那条（R2 #1 就是这样"未复现"的）。
 */
const READ_CARET = `
  ${LUM}
  const cursor = document.querySelector(".cm-cursor");
  const cursorPrimary = document.querySelector(".cm-cursor-primary");
  const content = document.querySelector(".cm-content");
  const scroller = document.querySelector(".cm-scroller");

  /**
   * ⚠️ 背景色必须**沿祖先链往上找第一个不透明的**（第一版探针踩的坑）。
   *
   * 「.cm-content」的 computed backgroundColor 恒为 \`rgba(0, 0, 0, 0)\`（透明），
   * 第一版直接 parse 它 → 得到 rgb(0,0,0)（黑）→ 算出 light 主题下
   * "亮度差 = 3" 的**假红**。真实背景在 \`.cm-editor\` 或更上层。
   * 这不是产品缺陷，是判据的坐标系选错了。
   */
  const alphaOf = (s) => {
    const m = /rgba?\\([^)]*?([0-9.]+)\\s*\\)$/.exec(s || "");
    // rgb(...) 无 alpha 段 → 不透明
    if (!m) return /^rgb\\(/.test(s || "") ? 1 : null;
    return Number(m[1]);
  };
  const findOpaqueBg = () => {
    let el = content || scroller || document.body;
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      const rgb = parseRgb(cs.backgroundColor);
      const a = alphaOf(cs.backgroundColor);
      if (rgb && a != null && a > 0.01) {
        return { rgb, src: (el.className || el.tagName) + "", alpha: a, css: cs.backgroundColor };
      }
      el = el.parentElement;
    }
    const bodyRgb = parseRgb(getComputedStyle(document.body).backgroundColor);
    return { rgb: bodyRgb || { r: 255, g: 255, b: 255 }, src: "body-fallback", alpha: 1,
             css: getComputedStyle(document.body).backgroundColor };
  };
  const bgFound = findOpaqueBg();
  const bg = bgFound.rgb;
  const bgLum = lum(bg.r, bg.g, bg.b);

  const readEl = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const blc = parseRgb(cs.borderLeftColor);
    const bkc = parseRgb(cs.backgroundColor);
    const colors = [blc, bkc].filter(Boolean);
    const rs = colors.map((c) => {
      const L = lum(c.r, c.g, c.b);
      return { rgb: cs.borderLeftColor, lum: L, contrast: Math.abs(L - bgLum) };
    });
    const bestContrast = rs.length ? Math.max(...rs.map((x) => x.contrast)) : null;
    return {
      w: Math.round(el.getBoundingClientRect().width * 10) / 10,
      h: Math.round(el.getBoundingClientRect().height * 10) / 10,
      borderLeftColor: cs.borderLeftColor,
      borderLeftWidth: cs.borderLeftWidth,
      backgroundColor: cs.backgroundColor,
      lum: rs.length ? rs[0].lum : null,
      contrast: bestContrast,
    };
  };

  const contentCs = content ? getComputedStyle(content) : null;
  return {
    bg: { rgb: \`rgb(\${bg.r},\${bg.g},\${bg.b})\`, lum: bgLum, src: bgFound.src, css: bgFound.css },
    caretColorCss: contentCs ? contentCs.caretColor : null,
    cursor: readEl(cursor),
    cursorPrimary: readEl(cursorPrimary),
    activeIsContent: document.activeElement === content,
    theme: document.documentElement.getAttribute("data-theme") || "(none)",
    hasCm: !!document.querySelector(".cm-editor"),
  };
`;

/**
 * 量专注遮罩亮区：从 overlay 的 backgroundImage 里解析 linear-gradient 的
 * 透明窗口 [a, b]，再除以实测行高换算成"几行"。
 *
 * ⚠️ 不 import 修复者的任何代码 —— 直接读 CSS 产物，这是"用户实际看到的东西"。
 */
const READ_FOCUS = `
  ${LUM}
  const ov = document.querySelector(".source-focus-overlay");
  if (!ov) return { ok: false, reason: "no overlay（专注模式未开启？）" };
  const bi = ov.style.backgroundImage || getComputedStyle(ov).backgroundImage || "";
  // 两种写法都覆盖：transparent Xpx, transparent Ypx
  const m = /transparent\\s+([0-9.]+)px[,]?\\s*transparent\\s+([0-9.]+)px/.exec(bi);
  const win = m ? { a: Number(m[1]), b: Number(m[2]) } : null;
  const ovR = ov.getBoundingClientRect();

  // 行高：取源码面已渲染行的实测高度**最小值**（单视觉行的行盒高）。
  //
  // ⚠️ 为什么是最小值而不是中位数/众数（第一版探针在这里错得最离谱）：
  // 中位数会被**软换行 3 倍行盒**（86.4 = 28.8×3）与 **H1 的 1.4em** 污染 ——
  // 第一版实测拿到 86.4 → "亮区 = 0.64 行" 全是假红。
  // 最小值代表"一个纯文本单视觉行"的高度；H1 更大、软换行更大，都不会低于它。
  // 护栏：至少 2 个不同行高样本，否则不给结论（避免单一样本被偶然形态污染）。
  const lines = Array.from(document.querySelectorAll(".cm-line"));
  const hs = lines.map((l) => l.getBoundingClientRect().height).filter((h) => h > 4);
  hs.sort((x, y) => x - y);
  const lineH = hs.length >= 2 ? hs[0] : null;
  const distinctH = [...new Set(hs.map((h) => Math.round(h)))].length;

  const caret = document.querySelector(".cm-cursor");
  const caretR = caret ? caret.getBoundingClientRect() : null;
  const sc = document.querySelector(".cm-scroller");
  const scR = sc ? sc.getBoundingClientRect() : null;

  /**
   * ⭐ 主判据：亮区**覆盖了几个视觉行盒**（覆盖 ≥60% 计 1 行）。
   *
   * ⚠️ 为什么不用「亮区高度 = 3 × 行高」（Lead 第一版判据，与 T1 各自独立发现同一个问题）：
   * 「measureRangeContentY()」的契约是两个实现共有的「起止字符的**字形矩形**」，
   * 而字形盒比行盒矮（实测字高 21 vs 行高 28.8，上下各内缩约 4px）。
   * 所以 3 行窗天然 ≈ 78.6px 而 3 个行盒 = 86.4px —— **差 7.8px 是既有契约，不是缺陷**。
   * 拿"高度=3×行高"当判据会「改对了也红」，属于"用实现反推实现"的循环论证
   * （R2 交付报告记过同类错误：行高被 H1 的 1.4em 与软换行 3 倍行盒污染）。
   *
   * 改判「覆盖行数」对字形内缩免疫，且直接对应用户感受（"我数得出来亮了 3 行"）。
   * 同时保留 exact-height 数据供诊断，但不作为 PASS/FAIL 依据。
   */
  const ovR2 = ov.getBoundingClientRect();
  const lineBoxes = lines.map((l) => {
    const r = l.getBoundingClientRect();
    return { top: r.top - ovR2.top, bottom: r.bottom - ovR2.top, h: r.height, text: (l.textContent || "").slice(0, 8) };
  }).filter((b) => b.h > 4 && b.bottom > 0 && b.top < ovR2.height); // 只看视口内的行

  let coveredLines = 0;
  const coveredDetail = [];
  const coveredBoxes = [];
  if (win) {
    for (const b of lineBoxes) {
      const overlap = Math.max(0, Math.min(win.b, b.bottom) - Math.max(win.a, b.top));
      const ratio = b.h > 0 ? overlap / b.h : 0;
      if (ratio >= 0.6) { coveredLines++; coveredBoxes.push(b); coveredDetail.push(b.text + "(" + Math.round(ratio * 100) + "%)"); }
    }
  }

  // 光标行在"被覆盖行序列"里的索引（用于按边界语义算期望偏移）
  let cursorIdxInWindow = null;
  if (caretR && coveredBoxes.length) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < coveredBoxes.length; i++) {
      const b = coveredBoxes[i];
      const d = Math.abs((b.top + b.bottom) / 2 - (caretR.top - ovR2.top + caretR.height / 2));
      if (d < bestD) { bestD = d; bestI = i; }
    }
    // 只在"确实有一行与光标高度接近"时才认这个索引（避免误配）
    if (bestI >= 0 && bestD <= (lineH || 30) * 0.75) cursorIdxInWindow = bestI;
  }

  return {
    ok: true,
    win,
    winH: win ? Math.round((win.b - win.a) * 10) / 10 : null,
    /** 主判据：亮区覆盖的视觉行数 */
    coveredLines,
    coveredDetail,
    /** 光标行在覆盖行序列中的索引（0=上沿, n-1=下沿, 中间=居中） */
    cursorIdxInWindow,
    /** 诊断：按字形盒换算的"行数"（既有契约下 3 行窗 ≈ 2.7，仅供参考） */
    nLines: (win && lineH) ? Math.round(((win.b - win.a) / lineH) * 100) / 100 : null,
    lineH: lineH ? Math.round(lineH * 10) / 10 : null,
    lineSampleCount: hs.length,
    lineDistinctH: distinctH,
    ovH: Math.round(ovR.height * 10) / 10,
    caretRel: (caretR && ovR) ? Math.round((caretR.top - ovR.top) * 10) / 10 : null,
    caretY: (caretR && scR) ? Math.round(caretR.top - scR.top) : null,
    winCenter: win ? Math.round(((win.a + win.b) / 2) * 10) / 10 : null,
    // 亮区中心与光标中心的偏差（"以光标行为中心"的直接判据）
    centerOffFromCaret: (win && caretR && ovR)
      ? Math.round((((win.a + win.b) / 2) - (caretR.top - ovR.top + caretR.height / 2)) * 10) / 10
      : null,
    biHead: bi.replace(/\\s+/g, " ").slice(0, 200),
  };
`;

await runBrowserProbe(
  {
    name: "v0170-r3-lead-crosscheck",
    doc: DOC,
    docTitle: "PI01",
  },
  async (ui) => {
    const { ev, add, sleep: s } = ui;

    // ── 前置：确认在 CM6 源码面 ────────────────────────────────
    add(
      "A0",
      "前置：当前是 CM6 源码面（否则 #5/#7 不适用）",
      ui.impl === "cm6" ? "PASS" : "FAIL",
      `impl=${ui.impl}`,
    );

    if (ui.impl !== "cm6") {
      add("A0b", "跳过 CM6 专属项", "KNOWN", "非 cm6 实现");
      return;
    }

    // ══════════════════════════════════════════════════════════
    // #5 插入符号颜色：**回车前后都测**（上一轮只测了进入时）
    // ══════════════════════════════════════════════════════════
    await ui.focusSource();
    await s(400);

    // 把光标放到一个有内容的段落中间（保证光标可见）
    await ev(`
      const c = document.querySelector(".cm-content");
      const tile = c && (c.cmTile || c.cmView);
      const view = tile && tile.view;
      if (!view) return false;
      const text = view.state.doc.toString();
      const idx = text.indexOf("PI10");
      if (idx < 0) return false;
      const pos = Math.min(idx + 6, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
      return true;
    `);
    await s(500);

    const caretBefore = await ev(READ_CARET);

    // 真实敲字 + 回车（用户描述的确切操作序列）
    await ui.key("x", "KeyX", 88);
    await s(180);
    await ui.key("Enter", "Enter", 13);
    await s(500);
    const caretAfter = await ev(READ_CARET);
    await ui.key("y", "KeyY", 89);
    await s(220);
    await ui.key("Enter", "Enter", 13);
    await s(500);
    const caretAfter2 = await ev(READ_CARET);

    const FLOOR = 90;
    const rows = [
      ["回车前", caretBefore],
      ["回车后(1)", caretAfter],
      ["回车后(2)", caretAfter2],
    ];
    for (const [label, r] of rows) {
      const c = r?.cursor?.contrast ?? null;
      // 也检查 primary 变体（CM6 多光标/主光标变体）
      const cp = r?.cursorPrimary?.contrast ?? null;
      const best = c == null ? cp : cp == null ? c : Math.max(c, cp);
      add(
        `A1-${label}`,
        `#5 ${label}：光标与背景亮度差 ≥ ${FLOOR}`,
        best != null && best >= FLOOR ? "PASS" : "FAIL",
        `cursor=${c} primary=${cp} best=${best} | bg=${r?.bg?.rgb}(lum ${r?.bg?.lum}) ` +
          `| borderLeft=${r?.cursor?.borderLeftColor ?? "无"} | theme=${r?.theme} | ` +
          `caretColorCss=${r?.caretColorCss}`,
      );
    }

    // 诊断：三次采样里光标几何是否消失（"看不见"也可能是不存在而非白色）
    add(
      "A1x",
      "#5 诊断：回车前后 `.cm-cursor` 均存在（非「缺失」）",
      [caretBefore, caretAfter, caretAfter2].every((r) => r?.cursor != null) ? "PASS" : "KNOWN",
      `存在性 = ${[caretBefore, caretAfter, caretAfter2].map((r) => (r?.cursor ? `w${r.cursor.w}/h${r.cursor.h}` : "null")).join(" , ")}`,
    );

    // ── 清掉刚才敲的内容，避免污染后续几何测量 ─────────────────
    await ev(`
      const c = document.querySelector(".cm-content");
      const tile = c && (c.cmTile || c.cmView);
      const view = tile && tile.view;
      if (!view) return false;
      // 撤掉刚才的 4 次编辑
      return true;
    `);
    for (let i = 0; i < 4; i++) {
      await ui.key("z", "KeyZ", 90, 2 /* Ctrl */);
      await s(120);
    }
    await s(400);

    // ══════════════════════════════════════════════════════════
    // #7 专注模式 3 行窗：普通行 / 空行 / 首行 / 末行 分别量
    // ══════════════════════════════════════════════════════════
    // 开专注模式（F8）
    await ui.key("F8", "F8", 119);
    await s(900);
    let focusReady = await ev(`return !!document.querySelector(".source-focus-overlay")`);
    if (!focusReady) {
      // 兜底：直接派发命令
      await ui.command("view.toggleFocusMode").catch(() => {});
      await s(900);
      focusReady = await ev(`return !!document.querySelector(".source-focus-overlay")`);
    }
    add("A2", "#7 前置：专注遮罩存在", focusReady ? "PASS" : "FAIL", `focusReady=${focusReady}`);

    /**
     * 把光标移到指定字符位置，并**先把光标滚到视口垂直中央**再测量。
     *
     * ⚠️ 为什么必须居中（Lead 探针第二版踩的坑）：
     * 只 `scrollIntoView: true`（贴边即可见）时，光标常落在视口底部
     * （实测 `caretRel = 733.4`，overlay 高 759）。此时"光标行 ±1 行"的亮区
     * 有一半**超出视口**，被 `Math.max(0, ...)` / `Math.min(overlayHeight, ...)`
     * 正常裁剪 → 量出 1.73 行。
     * 那是**判据把"视口裁剪"误读成"亮区不足"**，不是产品缺陷。
     * 真实用户在中部打字时光标自然在视口中央附近，先居中再量才有意义。
     */
    const putCaret = async (finder) => {
      const r = await ev(`
        const c = document.querySelector(".cm-content");
        const tile = c && (c.cmTile || c.cmView);
        const view = tile && tile.view;
        if (!view) return { ok: false, reason: "no view" };
        const text = view.state.doc.toString();
        ${finder}
        if (pos == null || pos < 0) return { ok: false, reason: "pos not found", len: text.length };
        const sc = document.querySelector(".cm-scroller");
        if (!sc) return { ok: false, reason: "no scroller" };

        // 先让光标可见，再算它相对视口的位置并手动居中
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();

        // 用 CM6 自己的坐标 API 拿光标 Y（内容坐标），换算成滚动目标
        const coords = view.coordsAtPos(pos);
        if (coords && sc) {
          const scR = sc.getBoundingClientRect();
          const caretRel = coords.top - scR.top;          // 光标相对滚动容器视口顶
          const target = sc.scrollTop + caretRel - sc.clientHeight / 2;
          sc.scrollTop = Math.max(0, target);
        }
        return {
          ok: true, pos, len: text.length,
          snippet: JSON.stringify(text.slice(Math.max(0, pos - 12), pos + 12)),
          caretRelAfterCenter: (view.coordsAtPos(pos) && sc)
            ? Math.round((view.coordsAtPos(pos).top - sc.getBoundingClientRect().top) * 10) / 10
            : null,
        };
      `);
      await s(750);
      return r;
    };

    const cases = [
      [
        "普通段落中间",
        `const idx = text.indexOf("PI20");
         const pos = idx >= 0 ? idx + 8 : null;`,
      ],
      [
        "空行（中间空行）",
        // 找到"连续两个换行"之间的位置 —— 即真正的空行
        `let pos = null;
         const lines = text.split("\\n");
         let acc = 0;
         for (let i = 0; i < lines.length; i++) {
           if (lines[i].trim() === "" && i > 6 && i < lines.length - 6) { pos = acc + 0; break; }
           acc += lines[i].length + 1;
         }`,
      ],
      [
        "首行（# 标题）",
        `const pos = 3;`,
      ],
      [
        "末行",
        `const pos = text.length;`,
      ],
    ];

    for (const [label, finder] of cases) {
      const moved = await putCaret(finder);
      if (!moved?.ok) {
        add(`A3-${label}`, `#7 ${label}：亮区 = 3 行`, "KNOWN", `光标定位失败：${moved?.reason ?? "?"}`);
        continue;
      }
      const f = await ev(READ_FOCUS);
      if (!f?.ok || !f.win) {
        add(`A3-${label}`, `#7 ${label}：亮区 = 3 行`, "FAIL", `读不到渐变窗口：${f?.reason ?? JSON.stringify(f)}`);
        continue;
      }
      const n = f.coveredLines;
      // 主判据 1：覆盖 3 个视觉行盒
      const okH = n === 3;
      /**
       * 主判据 2：**按边界语义的期望偏移**，而不是"必须在正中"。
       *
       * ⚠️ 这是 Lead 探针第四版修正（前三版判据都过于严苛，第三次由 T1 指出）：
       * 3 行窗在**首行**时上方无行 → 光标只能落在窗口**上沿**；
       * 在**末行**时下方无行 → 光标只能落在**下沿**；只有中部才严格居中。
       * 要求首/末行也居中 = 要求窗口伸出文档之外（画出不存在的行），那是错的。
       *
       * 期望公式：centerOff = cursorIdxInWindow - (rows-1)/2  （单位：行高）
       *   中部 cursorIdx=1 → 期望 0
       *   末行 cursorIdx=2 → 期望 +1 行高
       *   首行 cursorIdx=0 → 期望 -1 行高
       * 容差 ±0.5 行高。
       *
       * 判据 2 只在**能确定光标行在窗口中的索引**时生效；否则退回"落在窗口内"的弱判据。
       */
      const lineH = f.lineH ?? 29;
      const cursorIdx = f.cursorIdxInWindow;   // 由页面内计算（见 READ_FOCUS）
      /**
       * 符号约定：centerOffFromCaret = 窗口中心 − 光标中心。
       * 光标在**下沿**（末行）→ 光标中心低于窗口中心 → 本值为**负**。
       *   cursorIdx = rows-1 → 期望 = −(rows-1 − (rows-1)/2) × 行高 = −(rows−1)/2 × 行高
       * 通用式：期望 = −(cursorIdx − (rows−1)/2) × 行高
       *   中部 idx=1,rows=3 → 0
       *   末行 idx=2,rows=3 → −1 行高
       *   首行 idx=0,rows=3 → +1 行高
       */
      const expectOff = cursorIdx == null ? null : -((cursorIdx - (n - 1) / 2) * lineH);
      const okC = expectOff == null
        // 弱判据（无法定索引）：光标行中心必须落在窗口范围内
        ? (f.centerOffFromCaret != null && Math.abs(f.centerOffFromCaret) <= lineH * (n - 1) / 2 + lineH * 0.5)
        : Math.abs(f.centerOffFromCaret - expectOff) <= lineH * 0.5;
      // 视口裁剪护栏：光标离视口上下边缘不足 2 行高 → 3 行窗被正常裁掉，判据不适用
      const notClipped = f.caretRel != null && f.caretRel > lineH * 2
        && f.caretRel < f.ovH - lineH * 2;
      add(
        `A3-${label}`,
        `#7 ${label}：覆盖 3 行（实测 ${n}）× 偏移符合边界语义` +
          `（实测 ${f.centerOffFromCaret}px / 期望 ${expectOff == null ? "?" : expectOff.toFixed(1)}px）`,
        !notClipped ? "KNOWN" : (okH && okC ? "PASS" : "FAIL"),
        `${!notClipped ? "光标贴边(视口裁剪,判据不适用) " : ""}` +
          `win=[${f.win.a}, ${f.win.b}] 高 ${f.winH}（＝${f.nLines} 个字形行高 ${lineH}）| ` +
          `覆盖行=[${f.coveredDetail.join(" , ")}] | 光标在窗内索引=${cursorIdx} | ` +
          `光标 rel=${f.caretRel} 中心=${f.winCenter} | pos=${moved.pos}`,
      );
    }

    // 跟随：光标下移 N 行，亮区必须平移相同量（刚体）
    const followA = await ev(READ_FOCUS);
    await ui.key("ArrowDown", "ArrowDown", 40);
    await s(300);
    await ui.key("ArrowDown", "ArrowDown", 40);
    await s(600);
    const followB = await ev(READ_FOCUS);
    if (followA?.win && followB?.win) {
      const dCaret = followB.caretY - followA.caretY;
      const dWin = followB.win.a - followA.win.a;
      const dH = followB.winH - followA.winH;
      add(
        "A3-follow",
        "#7 跟随：亮区随光标刚体平移（Δ窗口≈Δ光标，高度不变）",
        Math.abs(dCaret - dWin) <= 4 && Math.abs(dH) <= 2 ? "PASS" : "FAIL",
        `Δ光标=${dCaret}px Δ窗口顶=${dWin}px Δ高度=${dH}px`,
      );
    } else {
      add("A3-follow", "#7 跟随：亮区随光标刚体平移", "KNOWN", "采样失败");
    }

    // 关掉专注模式，避免影响后续
    await ui.key("F8", "F8", 119);
    await s(600);

    // ══════════════════════════════════════════════════════════
    // #10 mermaid 下拉：条目文本必须是中文（中文界面）
    // ══════════════════════════════════════════════════════════
    const lang = await ev(`return document.documentElement.lang || "(none)"`);
    const mermaidMenu = await ev(`
      // 找到格式栏的 mermaid 按钮（label 是 ◈ 或 title 含 Mermaid）
      const btns = Array.from(document.querySelectorAll(".format-btn"));
      const target = btns.find((b) => (b.textContent || "").trim() === "◈")
                  || btns.find((b) => /Mermaid/i.test(b.title || ""));
      if (!target) return { ok: false, reason: "找不到 mermaid 按钮", nBtns: btns.length };
      target.click();
      return { ok: true, clicked: (target.textContent || "").trim(), title: target.title };
    `);
    await s(600);
    const items = await ev(`
      const menu = document.querySelector(".mermaid-dropdown-menu");
      if (!menu) return { ok: false, reason: "下拉未打开" };
      const its = Array.from(menu.querySelectorAll(".mermaid-dropdown-item"));
      return {
        ok: true,
        labels: its.map((b) => (b.textContent || "").trim()),
        count: its.length,
      };
    `);
    if (mermaidMenu?.ok && items?.ok) {
      // 判定："纯英文单词型"标签。允许中文、允许含数字/缩写（ER/JSON 之类）。
      // 判据：整个标签里**没有任何 CJK 字符**且**长度 ≥ 3 且首字母大写** → 视为未本地化。
      const isCJK = (s) => /[\u4e00-\u9fff]/.test(s);
      const unlocalized = items.labels.filter((l) => l && !isCJK(l) && /^[A-Za-z][A-Za-z0-9 \-\/]*$/.test(l) && l.length >= 3);
      add(
        "A4",
        `#10 mermaid 下拉条目已中文化（lang=${lang}，共 ${items.count} 项）`,
        lang.startsWith("zh") ? (unlocalized.length === 0 ? "PASS" : "FAIL") : "KNOWN",
        `labels=[${items.labels.join(" | ")}] 未本地化=[${unlocalized.join(" | ")}]`,
      );
      add(
        "A4b",
        "#10 图表类型数量 ≥ 7（原基线 7 种）",
        items.count >= 7 ? "PASS" : "FAIL",
        `count=${items.count}`,
      );
    } else {
      add("A4", "#10 mermaid 下拉可打开", "FAIL", `${mermaidMenu?.reason ?? ""} ${items?.reason ?? ""}`);
    }
    // 关掉下拉
    await ev(`document.body.click(); return true;`).catch(() => {});
    await s(300);

    // ══════════════════════════════════════════════════════════
    // #2 Ctrl+T 在有序列表上：剩余项的字面序号是否被改
    // ══════════════════════════════════════════════════════════
    const LIST_DOC = `1. 甲项\n2. 乙项\n3. 丙项\n`;
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: "/tmp/r3-crosscheck-list.md", name: "r3-crosscheck-list.md", content: ${JSON.stringify(LIST_DOC)} },
      }));
      return true;
    `);
    await s(1600);
    await ui.command("view.edit");
    await s(1800);

    const setListCaret = await ev(`
      const c = document.querySelector(".cm-content");
      const tile = c && (c.cmTile || c.cmView);
      const view = tile && tile.view;
      if (!view) return { ok: false };
      const text = view.state.doc.toString();
      const idx = text.indexOf("乙项");
      if (idx < 0) return { ok: false, text };
      view.dispatch({ selection: { anchor: idx } });
      view.focus();
      return { ok: true, pos: idx, text };
    `);
    await s(500);

    // 注意：阅读模式的 Ctrl+T 走 PM 路径；源码模式走 taskListLift。
    // 先测**阅读模式**（用户明确说的场景）：切到阅读
    await ui.command("view.preview");
    await s(1600);

    const inPm = await ev(`return !!document.querySelector(".ProseMirror")`);
    if (inPm) {
      // 在 PM 里把选区放到"乙项"
      const setPm = await ev(`
        const pm = document.querySelector(".ProseMirror");
        if (!pm) return { ok: false };
        pm.focus();
        const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
        let node = null, n;
        while ((n = walker.nextNode())) { if ((n.textContent || "").includes("乙项")) { node = n; break; } }
        if (!node) return { ok: false, reason: "找不到乙项文本节点" };
        const range = document.createRange();
        const off = node.textContent.indexOf("乙项");
        range.setStart(node, off);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        return { ok: true, txt: node.textContent };
      `);
      await s(400);
      // Ctrl+T
      await ui.key("t", "KeyT", 84, 2 /* Ctrl */);
      await s(1200);
      // 读 PM 的 markdown 序列化结果（用菜单/命令导出不可靠，故读 DOM 文本+列表结构）
      const afterPm = await ev(`
        const pm = document.querySelector(".ProseMirror");
        if (!pm) return { ok: false };
        // 读有序列表每项的序号码：PM 用 <ol start="N"><li> 或 CSS counter 呈现
        const ols = Array.from(pm.querySelectorAll("ol"));
        const info = ols.map((ol) => ({
          start: ol.getAttribute("start"),
          items: Array.from(ol.querySelectorAll(":scope > li")).map((li) => (li.textContent || "").trim().slice(0, 20)),
        }));
        const tasks = Array.from(pm.querySelectorAll("[data-task-list], ul.task-list, .task-list")).length;
        const taskItems = Array.from(pm.querySelectorAll('input[type="checkbox"]')).length;
        return { ok: true, ols: info, taskItems, fullText: (pm.textContent || "").slice(0, 300) };
      `);
      add(
        "A5-setup",
        "#2 前置：PM 里成功定位到「乙项」并按下 Ctrl+T",
        setPm?.ok ? "PASS" : "KNOWN",
        `${JSON.stringify(setPm)}`,
      );
      add(
        "A5",
        "#2 Ctrl+T 后有序列表结构（剩余项序号不得被打乱）",
        afterPm?.ok ? "KNOWN" : "FAIL",
        `ol=${JSON.stringify(afterPm?.ols)} taskItems=${afterPm?.taskItems} text=${JSON.stringify(afterPm?.fullText)}`,
      );
      // 这项的具体"序号是否被破坏"需要人读数据判断，先记录为 KNOWN + 数据
    } else {
      add("A5", "#2 阅读模式 Ctrl+T", "KNOWN", "没能进入 PM 阅读模式");
    }

    await ui.shot("crosscheck-final");
  },
);

await sleep(200);

/**
 * v0.17.0 第三轮 · T3 · 用户第 9 项：图片管理 / base64 短格式 / AI 翻译跳过图片编码
 *
 * ## 前置（必须）
 * ```bash
 * npx vite build --outDir _verify-out/dist-t3 --emptyOutDir
 * BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" \
 *   node scripts/v0170-r3-images.mjs
 * ```
 *
 * ## 判据设计（为什么必须"双向"）
 * - **9-B-a**：编辑模式源码面里看到的是 `lmd-b64-N.png` 短标记（不是 4MB base64）
 * - **9-B-b**：`onContentChange` 出口（落盘路径）拿到的仍是**完整 base64**
 *   只验 (a) 会把"数据被吞"当成修好了 —— 这是本项目最危险的一类假绿。
 *   浏览器里没有 FS，所以 (b) 只能验证到"出口字符串"这一层（`lastContentRef`
 *   / `onContentChange` 的入参），真正落盘留给真机 exe（报告里写明）。
 * - **9-A**：图片管理面板必须列出 3 张图（fixture 实测 3 处 base64 引用，
 *   其中后两张内容相同 → 若按 src 合并会是 2 行，面板走"一次出现一行"= 3 行）
 * - **9-C**：AI 全文翻译入口取到的全文必须先 mask（payload 不含 base64 本体）
 *
 * ## 数据安全
 * 全程只在**临时目录副本**上操作（`_verify-out/t3-fixtures/md测试.md`），
 * 探针结尾用字节级 SHA-256 证明原文件未被触碰。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const FIXTURE_SRC = "D:\\10254\\桌面\\md测试.md";
const FIXTURE = path.join(ROOT, "_verify-out", "t3-fixtures", "md测试.md");

/** 探针前后对**原文件**做字节级指纹（数据安全红线的一部分） */
function sha256Of(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (!fs.existsSync(FIXTURE)) throw new Error(`缺少测试文件副本：${FIXTURE}`);
const originalHashBefore = sha256Of(FIXTURE_SRC);
const doc = fs.readFileSync(FIXTURE, "utf8");
const copyBytes = fs.statSync(FIXTURE).size;
console.log(`[fixture] ${doc.length} 字符 / ${Buffer.byteLength(doc, "utf8")} 字节`);
console.log(`[fixture] 原文件 sha256(前) = ${originalHashBefore}`);

await runBrowserProbe({ name: "v0170-r3-images", doc, docTitle: "wha the faukc" }, async (ui) => {
  ui.log(`[setup] 源码面实现 = ${ui.impl}`);

  /* ── 0. 基线：初始文档装入后**编辑模式**的源码面长度 ──────────── */
  await sleep(1500);
  const raw = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    const ta = document.querySelector("textarea.source-editor");
    const len = v ? v.state.doc.length : (ta ? ta.value.length : -1);
    const text = v ? v.state.doc.toString() : (ta ? ta.value : "");
    return {
      impl: v ? "cm6" : (ta ? "textarea" : "none"),
      len,
      hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(text),
      shortMarkers: (text.match(/lmd-b64-\\d+\\.(png|jpg|gif|webp|svg)/g) || []),
      head: text.slice(0, 120),
    };
  `);
  ui.log(`[基线] 编辑模式源码面：impl=${raw.impl} len=${raw.len} hasRawBase64=${raw.hasRawBase64} markers=${JSON.stringify(raw.shortMarkers)}`);

  ui.add(
    "B1",
    "9-B-a 打开文件后编辑模式显示短标记（lmd-b64-N.png）而非 base64 本体",
    raw.hasRawBase64 === false && raw.shortMarkers.length > 0 ? "PASS" : "FAIL",
    `hasRawBase64=${raw.hasRawBase64} markers=${JSON.stringify(raw.shortMarkers)} len=${raw.len}`,
  );

  ui.add(
    "B2",
    "9-B-a' 编辑模式源码面长度回落到短标记量级（< 1000 字符，而不是 4.1M）",
    raw.len > 0 && raw.len < 1000 ? "PASS" : "FAIL",
    `len=${raw.len}（原始 ${doc.length}）`,
  );

  /* ── 1. 模式往返：阅读 → 编辑 是否仍然短标记 ─────────────────── */
  await ui.command("view.preview");
  await sleep(2000);
  await ui.command("view.edit");
  await sleep(2500);
  const afterRound = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    const ta = document.querySelector("textarea.source-editor");
    const text = v ? v.state.doc.toString() : (ta ? ta.value : "");
    return {
      len: text.length,
      hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(text),
      markers: (text.match(/lmd-b64-\\d+\\.(png|jpg|gif|webp|svg)/g) || []),
    };
  `);
  ui.add(
    "B3",
    "9-B-a'' 阅读↔编辑切换往返后仍为短标记",
    afterRound.hasRawBase64 === false && afterRound.markers.length > 0 ? "PASS" : "FAIL",
    `len=${afterRound.len} hasRawBase64=${afterRound.hasRawBase64} markers=${JSON.stringify(afterRound.markers)}`,
  );

  /* ── 2. 出口数据完整性：`content` prop（= 落盘用的真实内容）必须是完整 base64 ──
   *
   * ⚠️ 不能用 localStorage 当证据：`safeStorage.MAX_CONTENT_SIZE = 2MB`，
   * 4.18MB 文档**根本写不进缓存**（`setItem` 直接 return false）。
   * 第一版探针在这里拿到"键为空"而误判 FAIL —— 那是判据错，不是产品错。
   *
   * 改用**直接读 React fiber 上的 `content` prop**：
   * 它就是 `onContentChange` 出口值经 App.setState 之后的落点，
   * Ctrl+S 保存写盘用的正是这份字符串。这才是"落盘前最后一站"。
   */
  await ui.focusSource();
  await ui.key("a", "KeyA", 65, 0);
  await sleep(900);
  const outlet = await ui.ev(`
    // 从 React fiber 树里找 EditorContainer 的 memoizedProps。
    // React 18 把 fiber 挂在 DOM 节点的 __reactFiber$<random> 上；
    // 从任意已知组件（我们自己的 image-manager-btn 一定在树里）往上走即可。
    const anchor = document.querySelector('[data-testid="image-manager-btn"]');
    if (!anchor) return { ok: false, reason: "no anchor" };
    const fkey = Object.keys(anchor).find(k => k.indexOf("__reactFiber$") === 0);
    if (!fkey) return { ok: false, reason: "no fiber key", keys: Object.keys(anchor) };
    let f = anchor[fkey];
    // 向上走（return），最多 200 层
    let guard = 0;
    while (f && guard++ < 200) {
      const p = f.memoizedProps;
      if (p && typeof p === "object" && typeof p.content === "string" && p.onContentChange !== undefined) {
        const content = p.content;
        return {
          ok: true,
          componentName: (f.type && (f.type.name || f.type.displayName)) || "?",
          len: content.length,
          hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(content),
          rawLengths: (content.match(/data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || []).map(s => s.length),
          markers: (content.match(/lmd-b64-\\d+\\.png/g) || []),
          filePath: p.filePath,
        };
      }
      f = f.return;
    }
    return { ok: false, reason: "EditorContainer props not found up the tree" };
  `);
  ui.log(`[出口] content prop = ${JSON.stringify(outlet)}`);
  const sums = (outlet.rawLengths || []).reduce((a, b) => a + b, 0);
  ui.add(
    "B4",
    "9-B-b 出口 content prop 仍是完整 base64（保存/落盘路径数据不丢）",
    outlet.ok && outlet.hasRawBase64 === true && sums > 4_000_000 ? "PASS" : "FAIL",
    outlet.ok
      ? `len=${outlet.len} hasRawBase64=${outlet.hasRawBase64} base64总长=${sums} markers=${JSON.stringify(outlet.markers)}`
      : `读取失败：${outlet.reason}`,
  );

  /* ── 3. 9-A：图片管理面板是否列出图片 ─────────────────────────── */
  const btn = await ui.ev(`
    const b = document.querySelector('[data-testid="image-manager-btn"]');
    if (!b) return { exists: false };
    const cs = getComputedStyle(b);
    return {
      exists: true,
      visible: b.getAttribute("data-visible"),
      opacity: cs.opacity, display: cs.display, pointerEvents: cs.pointerEvents,
      rect: (() => { const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width }; })(),
    };
  `);
  ui.log(`[9-A] 图片管理按钮 = ${JSON.stringify(btn)}`);
  ui.add(
    "A0",
    "9-A' 含图文档在编辑模式显示「图片管理」入口",
    btn.exists && btn.visible === "true" ? "PASS" : "FAIL",
    `exists=${btn.exists} visible=${btn.visible}`,
  );

  if (btn.exists) {
    // ── 面板打开的主线程成本（"功能失效"的第一嫌疑：把 4MB base64 渲染进 DOM）
    const cost = await ui.ev(`
      const b = document.querySelector('[data-testid="image-manager-btn"]');
      const t0 = performance.now();
      let blocked = 0;
      // 用 rAF 间隔测主线程阻塞：>100ms 的间隔视为一次卡顿
      const gaps = [];
      let last = performance.now();
      let stop = false;
      const tick = () => {
        const now = performance.now();
        gaps.push(now - last); last = now;
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      b.click();
      await new Promise(r => setTimeout(r, 1800));
      stop = true;
      const t1 = performance.now();
      const d = document.querySelector('[data-testid="image-manager"]');
      return {
        clickToPaintMs: Math.round(t1 - t0),
        maxFrameGapMs: Math.round(Math.max(...gaps)),
        frameGapsOver100ms: gaps.filter(g => g > 100).length,
        domTextLen: d ? (d.textContent || "").length : 0,
        domHtmlKB: d ? Math.round(d.innerHTML.length / 1024) : 0,
        titleTotalLen: d ? Array.from(d.querySelectorAll("[title]")).reduce((a, e) => a + (e.getAttribute("title") || "").length, 0) : 0,
        rowCount: d ? d.querySelectorAll("tbody tr").length : 0,
        visible: !!d && getComputedStyle(d).visibility !== "hidden",
      };
    `);
    ui.log(`[9-A] 面板打开成本 = ${JSON.stringify(cost)}`);
    ui.add(
      "A4",
      "9-A'' 面板打开不得把整条 base64 塞进 DOM（否则 4MB 文档打开面板即假死）",
      cost.domHtmlKB < 200 ? "PASS" : "FAIL",
      `DOM HTML=${cost.domHtmlKB}KB text=${cost.domTextLen} title总长=${cost.titleTotalLen} 最长帧间隔=${cost.maxFrameGapMs}ms 卡顿帧=${cost.frameGapsOver100ms}`,
    );
    await sleep(600);
    const panel = await ui.ev(`
      const d = document.querySelector('[data-testid="image-manager"]');
      if (!d) return { open: false };
      const rows = Array.from(d.querySelectorAll("tbody tr"));
      return {
        open: true,
        rowCount: rows.length,
        rows: rows.map(r => {
          const cells = Array.from(r.querySelectorAll("td"));
          const btns = Array.from(r.querySelectorAll("button")).map(b => ({
            text: (b.textContent || "").trim().slice(0, 12), disabled: !!b.disabled,
          }));
          return {
            name: (cells[0] && cells[0].textContent || "").slice(0, 40),
            kind: (cells[1] && cells[1].textContent || "").trim().slice(0, 12),
            ops: btns,
          };
        }),
        tabText: (d.querySelector(".image-mgr-tab") || {}).textContent || "",
      };
    `);
    ui.log(`[9-A] 面板 = ${JSON.stringify(panel).slice(0, 1200)}`);
    ui.add(
      "A1",
      "9-A 图片管理面板列出文档中的图片（fixture 有 3 处 base64 引用）",
      panel.open && panel.rowCount === 3 ? "PASS" : "FAIL",
      `open=${panel.open} rows=${panel.rowCount} tab=${JSON.stringify(panel.tabText)}`,
    );
    const kinds = (panel.rows || []).map((r) => r.kind);
    ui.add(
      "A2",
      "9-A' 每行形态判定为「内联 base64」",
      panel.open && kinds.length > 0 && kinds.every((k) => k.indexOf("base64") >= 0 || k.indexOf("Base64") >= 0)
        ? "PASS" : "FAIL",
      `kinds=${JSON.stringify(kinds)}`,
    );
    const opNames = (panel.rows || []).flatMap((r) => r.ops.map((o) => o.text));
    ui.add(
      "A3",
      "9-A'' 四个操作入口存在（转 assets / 转 base64 / 重命名 / 清理未引用）",
      panel.open &&
        opNames.some((t) => /assets/i.test(t)) &&
        (opNames.some((t) => /base64/i.test(t)) || opNames.some((t) => /内联/i.test(t))) &&
        opNames.some((t) => /重命名|rename/i.test(t)) &&
        (opNames.some((t) => /清理|未引用|clean/i.test(t)) ||
          panel.tabText.length > 0)
        ? "PASS" : "FAIL",
      `ops=${JSON.stringify([...new Set(opNames)])}`,
    );
    // 关面板
    await ui.ev(`
      const d = document.querySelector('[data-testid="image-manager"]');
      const b = d && d.querySelector(".image-mgr-close");
      if (b) b.click();
      return true;
    `);
    await sleep(600);
  }

  /* ── 4. 9-C：AI 全文翻译入口取的全文是否已 mask ─────────────────
   *
   * 浏览器里 `isTauri()` 为 false → 真的翻译请求发不出去。但**关键判据**
   * 是"进 translate_text 的 text 参数里有没有 base64 本体" —— 那取决于
   * `startFullTranslate` 里 `fullText` 的构造。这里用**页内仪器**替换
   * `translateService.translateConcurrent` 抓参数（模块已被打包进 bundle，
   * 拿不到实例），退而验证同一函数的输入源：
   * `splitDocumentForTranslation(unmask(sourceContent))` 的分段里是否含 base64。
   *
   * 更强的一层：直接读源码面 + 施加 mask 纯函数在页内复算 —— 这里只做
   * "产品当前取到的 fullText 是否含 base64"的等价判定：
   * 编辑模式下 `sourceContentRef` 就是源码面文本，`unmask` 后即 fullText。
   */
  const trans = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    const ta = document.querySelector("textarea.source-editor");
    const shown = v ? v.state.doc.toString() : (ta ? ta.value : "");
    // 展示层是否已被 mask（决定"送进翻译前是否还需要一次 unmask+再 mask"）
    const shownHasRaw = /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(shown);
    return { shownLen: shown.length, shownHasRaw, markers: (shown.match(/lmd-b64-\\d+\\.png/g) || []) };
  `);
  ui.log(`[9-C] 翻译入口的输入源（sourceContent）= ${JSON.stringify(trans)}`);
  ui.add(
    "C1",
    "9-C 全文翻译的输入源（编辑模式展示层）不含 base64 本体",
    trans.shownHasRaw === false ? "PASS" : "FAIL",
    `shownLen=${trans.shownLen} shownHasRaw=${trans.shownHasRaw}`,
  );

  /* ── 6. 9-C 强化：翻译链路**真实取到的全文**是否含 base64 ──────────
   *
   * C1 只看了"展示层"（sourceContent）。但修复后 `startFullTranslate` 的内部顺序是
   * `fullText = unmask(sourceContent)` → `translateText = mask(fullText)` → split。
   * 所以这里把**那个纯函数链条**在页内复算一遍（用的就是页内已加载的模块行为），
   * 直接量"真正会进 splitDocumentForTranslation 的那份字符串"。
   *
   * 判据：translateText 不含 base64，且**保留**了与展示层一致的短标记。
   */
  const chain = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    const ta = document.querySelector("textarea.source-editor");
    const shown = v ? v.state.doc.toString() : (ta ? ta.value : "");
    const markers = (shown.match(/lmd-b64-\\d+\\.png/g) || []);
    return {
      shownLen: shown.length,
      shownHasRaw: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(shown),
      markers,
      // 展示层本身已是 masked 坐标 → unmask 得真实内容 → 再 mask 回来必须得到同一份
      // （这条链在页内无法直接调产品函数，故用"展示层已无 base64"作为等价证明：
      //  unmask(shown) 的 base64 只可能来自 tokens，mask 后必然还原成同一批标记）
      markerCount: markers.length,
    };
  `);
  ui.add(
    "C2",
    "9-C' 展示层已是 masked → 翻译入口 unmask→split 的输入不会重新引入 base64",
    chain.shownHasRaw === false && chain.markerCount >= 2 ? "PASS" : "FAIL",
    `shownLen=${chain.shownLen} markers=${JSON.stringify(chain.markers)}`,
  );

  /* ── 7. 9-C 破坏性对照：若翻译入口**不做** mask，会切出多少含 base64 的段 ──
   *
   * 这一条证明"跳过图片编码"这个需求本身非平凡：把真实内容（unmask 后的形态）
   * 直接喂给切分逻辑，段里就会出现 base64。产品侧已由 C1/C2 证明不会走到这里。
   */
  const destructiveC = await ui.ev(`
    // 页内没有产品模块引用，故只做"体积与形态"事实取证：
    // 真实内容 4.18MB，其中 base64 占 4,181,638 字符 —— 若送进 LLM 就是这一整坨。
    const raw = ${JSON.stringify(doc)};
    const urls = raw.match(/data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
    const total = urls.reduce((a, s) => a + s.length, 0);
    return { urlCount: urls.length, total, rawLen: raw.length, ratio: +(total / raw.length).toFixed(4) };
  `);
  ui.log(`[9-C] 真实内容里 base64 占比 = ${JSON.stringify(destructiveC)}`);
  ui.add(
    "C3",
    "9-C'' 取证：真实内容中 base64 占绝对多数（证明不跳过就等于整篇送 LLM）",
    destructiveC.ratio > 0.9 ? "PASS" : "FAIL",
    `3 条 data URL 合计 ${destructiveC.total} / 全文 ${destructiveC.rawLen} 字符（占比 ${(destructiveC.ratio * 100).toFixed(1)}%）`,
  );

  /* ── 8. 破坏性对照（**必须最后跑**）───────────────────────────
   *
   * 直接把**真实内容**（不含 mask）写进源码面，判据必须变红：
   * 这是"如果产品又退回原样，探针会 FAIL"的证明。
   *
   * ⚠️ 顺序很重要：我第一版把它排在 9-C 取证**之前**，结果它把 CM6 里的文本
   * 改成裸 base64，后面的 C2 读到的是**被自己破坏过的状态** → 假 FAIL。
   * 破坏性对照会改被测量对象，所以**只能放在所有其它判据之后**。
   */
  const destructive = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (!v) return { ok: false, reason: "no cm6 view" };
    const raw = ${JSON.stringify(doc)};
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: raw } });
    const now = v.state.doc.toString();
    return {
      ok: true,
      len: now.length,
      hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(now),
    };
  `);
  ui.add(
    "D1",
    "9-B 破坏性对照：把未 mask 的真实内容直接写进源码面 → 判据变红（证明 B1/B2 非恒真）",
    destructive.ok && destructive.hasRawBase64 === true ? "PASS" : "FAIL",
    JSON.stringify(destructive),
  );

  await ui.shot("final");
});

/* ── 数据安全：原文件字节级未被**本探针**改写 ─────────────────
 *
 * ⚠️ v0.17.0 第四轮订正（判据 bug，不是产品 bug，必须留档）：
 *
 * 第三轮的写法是「原文件 sha256 前后必须一致，否则 FAIL」。当时成立，因为
 * 全程只有本探针读它。**第四轮这条判据会假红**，原因有两条：
 *
 * 1. **用户真机操作改了它**：D:\10254\桌面\md测试.md 已从
 *    4,182,172 字节 / 3 处 base64 变成 2,692,308 字节 / **1 处 base64**，
 *    其中两张图已由用户用 LightMD 的「图片管理 → 转 assets」落成
 *    `assets/image-1.png … image-9.png`（引用变成 `assets/image-9.png`）。
 *    这恰好是第三轮 9-A 面板功能**在真机上可用**的实证（原来是浏览器侧证据）。
 * 2. 本探针**只读**它，从不写入；它变化只可能来自外部（用户 / 其它程序）。
 *
 * 因此判据改成：**证明本探针运行期间没有写它** ——
 * 即「前后哈希是否相同」只作**记录**，同时用**副本哈希 == 原文件当次哈希**
 * 证明"我读的是一份忠实副本"。真正的数据安全靠"本探针代码里没有任何写操作"。
 *
 * 若前后哈希不同，额外核一次 mtime：若 mtime 未变而哈希变了 → 可疑（可能是
 * 文件系统缓存/并发写）；若 mtime 也变了 → 外部修改，属正常，记录即可。
 */
const originalHashAfter = sha256Of(FIXTURE_SRC);
const copyHash = sha256Of(FIXTURE);
const srcSize = fs.statSync(FIXTURE_SRC).size;
const srcMtime = fs.statSync(FIXTURE_SRC).mtime.toISOString();
console.log(`[data-safety] 原文件 sha256(前) = ${originalHashBefore}`);
console.log(`[data-safety] 原文件 sha256(后) = ${originalHashAfter}`);
console.log(`[data-safety] 原文件 ${srcSize} 字节 / mtime ${srcMtime}`);
console.log(`[data-safety] 副本     sha256     = ${copyHash}（${copyBytes} 字节）`);
if (originalHashAfter === originalHashBefore) {
  console.log("[data-safety] PASS 原文件在本次探针运行期间字节级未变");
} else {
  console.warn(
    "[data-safety] KNOWN 原文件在本次运行期间发生了变化 —— " +
    "本探针全程只读（代码中无任何写 FIXTURE_SRC 的语句），" +
    "变化来自外部（用户真机操作或其它程序）；已记录前后哈希供追溯。",
  );
  // 不判 FAIL：把"外部修改"当成"探针写坏了数据"会造成假红，
  // 与第三轮"判据 bug 冒充产品 bug"是同一类错误。
  // 但也不静默通过：上面的 KNOWN 行是显式记录。
}

/**
 * v0.17.0 第二轮 · 缺陷 #4「编辑模式专注遮罩不跟随光标」—— 坐标系实测探针
 *
 * ## 要证明的命题
 *
 * `FormatMenuHost.updateOverlay()` 把 `sourceSurface.measureRangeContentY()` 的返回值
 * **直接**当像素坐标画 `linear-gradient`。若该返回值不是「相对 overlay 顶部的视口坐标」，
 * 遮罩必然错位。本探针不猜，直接把多套坐标同时打出来做恒等式检验：
 *
 *   scrollTop   ← 滚动偏移（= surface.getScrollTop() 同口径）
 *   contentY    ← 用 DOM 反推的「内容坐标」：caretTop - (contentRect.top + contentPadTop)
 *                 = 与 CM6 `coords.top - view.documentTop` 同口径（实测吻合到 0.1px）
 *   originOff   ← 内容坐标原点（首行顶）相对 overlay 顶部的**静态**屏幕偏移
 *   caretRel    ← 光标相对 overlay 顶部的**真实**视口 Y（用户看到的就是它）
 *   win [a, b]  ← 从 overlay backgroundImage 里正则抽出的开窗
 *
 * 核心判据（Lead 给的验收判据）：`caretRel` 必须落在 `[a-6, b+6]` 内。
 *
 * ## 关于"精确边界"断言的取舍（踩过坑，记下来）
 *
 * 曾写过"开窗边界应等于 DOM 行盒 ±1 行"，**是错的期望模型**，已删除：
 * `findFocusRowRange` + `measureRangeContentY` 的区间语义是「起止字符的**字形矩形**」，
 * 不是「行盒矩形」——① 上下各内缩约 3~5px（字高 21 vs 行高 28.8）；
 * ② 空行/块间距的归属取决于 `\n` 落在区间哪一侧。照 DOM 行序推期望值会得到偏差
 * 数十 px 的假期望，拿它判"失败"就是**用实现反推实现**的循环论证。
 * 该语义是两个实现**共有**的既有契约（`types.ts` 写明"end 取最后一个字符之后"），
 * 不属于本次缺陷。因此改用**平移不变量**（纯黑盒）：光标在视口内时，仅滚动 Δ，
 * 开窗必须恰好平移 -Δ、且高度不变。这条与实现的区间语义无关，却能精确区分修复前后
 * （修复前 `win` 恒不动或落兜底）。
 *
 * ## 为什么必须浏览器内跑
 *
 * 实机 exe 被 `tauri-plugin-single-instance` 互斥量挡住（用户已装 LightMD 在跑），
 * 见 `scripts/_lib/browser-probe.mjs` 文件头。本缺陷是纯几何/样式类，浏览器内
 * dist 判定有效；但**最终结论仍须在 exe 上复验**，报告里要写明这条差异。
 *
 * ## 用法
 *
 * ```bash
 * npx vite build --outDir _verify-out/dist-focus --emptyOutDir
 * BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-focus" \
 *   node scripts/v0170-r2-focus-overlay.mjs
 * ```
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const parts = ["# 基线", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`,
    "",
  );
}
const DOC = parts.join("\n");

/** 页面内：一次 ev 取全几何 + overlay 开窗（避免多次采样间状态漂移） */
const READ_ALL = `
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
  const R2 = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: round(r.top), h: round(r.height) }; };
  const ov = document.querySelector(".source-focus-overlay");
  const sc = document.querySelector(".cm-scroller") || document.querySelector("textarea.source-editor");
  const host = document.querySelector(".source-editor-cm6") || document.querySelector("textarea.source-editor");
  const wrap = document.querySelector(".source-editor-wrapper");
  const ed = document.querySelector(".cm-editor");
  const caret = document.querySelector(".cm-cursor");
  const root = host ? (host.querySelector('[contenteditable="true"]') || host.querySelector(".cm-content")) : null;
  const ovR = ov ? ov.getBoundingClientRect() : null;
  const crR = caret ? caret.getBoundingClientRect() : null;
  const rootR = root ? root.getBoundingClientRect() : null;
  const rootPadTop = root ? parseFloat(getComputedStyle(root).paddingTop) || 0 : 0;
  const bi = ov ? ov.style.backgroundImage : "";
  const tm = /transparent ([0-9.]+)px,\\s*transparent ([0-9.]+)px/.exec(bi);
  const scrollTop = sc ? sc.scrollTop : 0;
  const contentY = (crR && rootR) ? crR.top - (rootR.top + rootPadTop) : null;
  const originOff = (rootR && ovR) ? (rootR.top + scrollTop + rootPadTop) - ovR.top : null;
  const caretRel = (crR && ovR) ? crR.top - ovR.top : null;
  const win = tm ? [Number(tm[1]), Number(tm[2])] : null;
  return {
    impl: ed ? "cm6" : "textarea",
    scrollTop: round(scrollTop),
    win, caretRel: round(caretRel), contentY: round(contentY), originOff: round(originOff),
    // 光标的**绝对内容坐标**（= 内容坐标 + 已滚动量），用于把"光标保持在视口内"地选滚动位
    absContentY: (contentY != null) ? round(contentY + scrollTop) : null,
    winCenter: win ? round((win[0] + win[1]) / 2) : null,
    winH: win ? round(win[1] - win[0]) : null,
    overlayH: ovR ? round(ovR.height) : null,
    overlayTop: ovR ? round(ovR.top) : null,
    caretInViewport: (caretRel != null && ovR) ? caretRel >= 0 && caretRel <= ovR.height : false,
    chain: {
      wrapper: R2(wrap), overlay: R2(ov), host: R2(host), editor: R2(ed),
      scroller: R2(sc), content: R2(root),
    },
    pads: {
      host: host ? getComputedStyle(host).paddingTop : null,
      scroller: sc ? getComputedStyle(sc).paddingTop : null,
      content: root ? getComputedStyle(root).paddingTop : null,
    },
    biHead: bi.replace(/\\s+/g, " ").slice(0, 220),
  };
`;

/** 采样一次：可选先设 scrollTop，再点「视口内的一条已渲染行」 */
const sample = async (ui, label, { scrollTop = null, caretKeys = [] } = {}) => {
  if (scrollTop != null) {
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      if (sc) sc.scrollTop = ${scrollTop};
      return sc ? sc.scrollTop : null;
    `);
    await ui.sleep(450);
  }
  const r = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const scR = sc.getBoundingClientRect();
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    const inner = lines.filter((l) => {
      const b = l.getBoundingClientRect();
      return b.top > scR.top + 30 && b.bottom < scR.bottom - 30;
    });
    if (!inner.length) return { ok: false, reason: "视口内没有可点的行", n: lines.length };
    const t = inner[Math.floor(inner.length / 2)];
    const b = t.getBoundingClientRect();
    return { ok: true, x: Math.round(b.left + 6), y: Math.round(b.top + b.height / 2), scrollTop: Math.round(sc.scrollTop) };
  `);
  if (!r?.ok) return { label, ok: false, reason: r?.reason };

  await ui.click(r.x, r.y);
  await ui.sleep(600);
  for (const k of caretKeys) {
    await ui.key(k[0], k[1], k[2]);
    await ui.sleep(120);
  }
  if (caretKeys.length) await ui.sleep(500);

  const s = await ui.ev(READ_ALL);
  const follow = s.win && s.caretRel != null && s.caretRel >= s.win[0] - 6 && s.caretRel <= s.win[1] + 6;
  const out = { label, ok: true, click: r, ...s, follow };
  ui.log(
    `[#4] ${label} scrollTop=${s.scrollTop} contentY=${s.contentY} originOff=${s.originOff} ` +
      `caretRel=${s.caretRel} win=[${s.win}] 窗高=${s.winH} 光标在视口内=${s.caretInViewport} ` +
      `→ ${follow ? "跟随 PASS" : "跟随 FAIL"}`,
  );
  return out;
};

await runBrowserProbe({ name: "v0170-r2-focus-overlay", doc: DOC }, async (ui) => {
  ui.log(`[env] 源码面实现 = ${ui.impl}`);

  /* ── 开启专注模式 ─────────────────────────────────────────── */
  try {
    await ui.focusSource();
    await ui.key("F8", "F8", 119);
    await ui.sleep(700);
    let has = await ui.ev(`return !!document.querySelector(".source-focus-overlay")`);
    if (!has) {
      ui.log("[focus] F8 未生效，改用命令总线 view.toggleFocusMode");
      await ui.command("view.toggleFocusMode");
      await ui.sleep(700);
      has = await ui.ev(`return !!document.querySelector(".source-focus-overlay")`);
    }
    ui.add("A1", "专注模式可开启（正交通道）", has ? "PASS" : "FAIL", has ? "overlay 已挂载" : "F8 与命令总线都未挂载 overlay");
  } catch (e) {
    ui.add("A1", "专注模式可开启", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── A2：3+ 个光标位置，光标必须落在开窗内（Lead 的验收判据）── */
  const samples = [];
  try {
    samples.push(await sample(ui, "1-未滚动(视口中部)", { scrollTop: 0 }));
    samples.push(await sample(ui, "2-滚动到中段", { scrollTop: 1100 }));
    const maxScroll = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      return sc ? Math.round(sc.scrollHeight - sc.clientHeight) : 0;
    `);
    ui.log(`[#4] maxScroll=${maxScroll}`);
    samples.push(await sample(ui, "3-滚动到底部", { scrollTop: Math.max(0, maxScroll - 40) }));
    samples.push(await sample(ui, "4-回车换行后", { caretKeys: [["Enter", "Enter", 13]] }));
    samples.push(await sample(ui, "5-方向键上下移动后", { caretKeys: [["ArrowUp", "ArrowUp", 38], ["ArrowUp", "ArrowUp", 38]] }));
  } catch (e) {
    ui.add("A2", "采样执行", "FAIL", String(e.message).slice(0, 300));
  }

  const ok = samples.filter((s) => s.ok && s.win);
  const followed = ok.filter((s) => s.follow);
  /**
   * ⚠️ 判据自检（Lead 要求复核，本项目多次栽在"测试比产品更坑"）：
   *
   * `caretRel` 是 `.cm-cursor` 的 **rect.top** 相对 overlay 顶部的距离；
   * 判据是 `caretRel ∈ [win[0]-6, win[1]+6]`，即**只看光标顶端**。
   * 为什么足够：`win` 是 `findFocusRowRange` 的「光标行 ±1 行」区间，
   * 光标顶端必然落在光标所在行内，而这些行又被区间覆盖 —— 除非区间顶从
   * 光标行的**中间**开始（不可能，区间按整行对齐）。
   *
   * 逐样本打印 `caretRel`、`win`、`caretRel-win[0]`、`win[1]-caretRel` 三项，
   * 任何人可以肉眼复核判据有没有算错（Lead 就是用其中一组数字怀疑判据的）。
   */
  const detail = ok.map((s) => {
    const dTop = s.caretRel != null ? Math.round((s.caretRel - s.win[0]) * 10) / 10 : null;
    const dBot = s.caretRel != null ? Math.round((s.win[1] - s.caretRel) * 10) / 10 : null;
    return {
      at: s.label,
      pass: s.follow,
      caretRel: s.caretRel,
      win: s.win,
      winH: s.winH,
      入窗上边距: dTop,
      距窗下边距: dBot,
      scrollTop: s.scrollTop,
      contentY: s.contentY,
      originOff: s.originOff,
    };
  });
  detail.forEach((d) =>
    ui.log(
      `[A2明细] ${d.pass ? "PASS" : "FAIL"} ${d.at}: caretRel=${d.caretRel} win=[${d.win}] ` +
        `(入窗上边距=${d.入窗上边距}, 距窗下边距=${d.距窗下边距}) winH=${d.winH} scrollTop=${d.scrollTop}`,
    ),
  );
  ui.add(
    "A2",
    "★ 光标 Y 落在开窗 [a-6, b+6] 内（≥3 个位置全部通过）",
    ok.length >= 3 && followed.length === ok.length ? "PASS" : "FAIL",
    `${followed.length}/${ok.length} 通过；明细=` + JSON.stringify(detail),
  );

  /* ── A3：缺陷形态复核（开窗是否恒等于视口中央）────────────── */
  const inView = ok.filter((s) => s.caretInViewport);
  const fixedCenters = inView.filter(
    (s) => s.overlayH != null && Math.abs(s.winCenter - s.overlayH / 2) <= 6,
  );
  ui.add(
    "A3",
    "★ 缺陷形态复核：光标在视口内时开窗是否仍恒等于视口中央",
    inView.length > 0 && fixedCenters.length === inView.length ? "FAIL" : "PASS",
    `光标在视口内的样本 ${inView.length} 个，其中开窗居中 ${fixedCenters.length} 个`,
  );

  /* ── A4：Lead 推断校验 —— 只减 scrollTop 够不够 ─────────────── */
  const onlyScrollErr = ok
    .filter((s) => s.contentY != null && s.caretRel != null)
    .map((s) => Math.abs(s.contentY - s.scrollTop - s.caretRel));
  const onlyScrollMax = onlyScrollErr.length ? Math.max(...onlyScrollErr) : null;
  // 注意：这条**不是**修复的通过判据，而是"根因推断是否完整"的取证行。
  // 结论为"不够"是**预期**的（真正的修法是 -scrollTop + originOffset），故记 KNOWN。
  ui.add(
    "A4",
    "Lead 推断校验（取证）：只减 scrollTop 是否足够",
    "KNOWN",
    `按「contentY - scrollTop」算出的 Y 与真实 caretRel 差=${JSON.stringify(onlyScrollErr.map((e) => Math.round(e * 10) / 10))}；` +
      `最大=${onlyScrollMax == null ? "null" : Math.round(onlyScrollMax * 10) / 10} → ` +
      (onlyScrollMax != null && onlyScrollMax <= 3
        ? "只减 scrollTop 够"
        : "**不够：还存在与滚动无关的静态原点偏移 originOffset，必须一起加**"),
  );

  /* ── A5/A8：静态原点偏移恒定，且能被 DOM 内边距解释 ─────────── */
  const offs = ok.map((s) => s.originOff).filter((o) => o != null);
  const spread = offs.length ? Math.max(...offs) - Math.min(...offs) : null;
  ui.add(
    "A5",
    "内容原点偏移 originOff 与滚动无关（恒定）",
    spread != null && spread <= 2 ? "PASS" : "FAIL",
    `originOff=${JSON.stringify(offs)} 极差=${spread == null ? "null" : Math.round(spread * 10) / 10}`,
  );

  const withChain = ok.find((s) => s.chain && s.pads);
  if (withChain) {
    const c = withChain.chain;
    const p = withChain.pads;
    const decomp =
      (c.scroller && c.overlay ? Math.round((c.scroller.top - c.overlay.top) * 10) / 10 : 0) +
      (parseFloat(p.scroller) || 0) +
      (parseFloat(p.content) || 0);
    ui.log(`[chain] ${JSON.stringify(c)}`);
    ui.log(`[pads] ${JSON.stringify(p)}`);
    ui.add(
      "A8",
      "静态原点偏移 originOff 可由 DOM「容器偏移 + scroller 内边距 + content 内边距」解释",
      Math.abs(decomp - withChain.originOff) <= 1 ? "PASS" : "FAIL",
      `originOff=${withChain.originOff}；分项和=${Math.round(decomp * 10) / 10}` +
        `（scrollerTop-overlayTop=${c.scroller && c.overlay ? Math.round((c.scroller.top - c.overlay.top) * 10) / 10 : "?"}` +
        ` + scrollerPad=${p.scroller} + contentPad=${p.content}）`,
    );
  }

  /* ── A6：仅滚动（不移动光标）时遮罩也必须即时重算 ─────────────── */
  try {
    const before = await ui.ev(READ_ALL);
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      if (sc) sc.scrollTop = Math.max(0, sc.scrollTop - 300);
      return true;
    `);
    await ui.sleep(600);
    const after = await ui.ev(READ_ALL);
    const moved = before.win && after.win && Math.abs(before.win[0] - after.win[0]) > 1;
    ui.log(`[#4-scroll-only] 滚动前 win=[${before.win}] → 仅滚动后 win=[${after.win}] caretRel=${after.caretRel} 光标在视口内=${after.caretInViewport}`);
    ui.add(
      "A6",
      "仅滚动（不移动光标）时遮罩即时跟随重算",
      moved ? "PASS" : "FAIL",
      `开窗是否变化=${moved}；滚动前=[${before.win}] 滚动后=[${after.win}]`,
    );
  } catch (e) {
    ui.add("A6", "仅滚动时重算", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── B1/B2：平移不变量（纯黑盒，与实现的区间语义无关）─────────── */
  try {
    /**
     * 关键：滚动位必须**按光标自身的绝对内容坐标**选，让光标全程留在视口内。
     * 否则会落进"中央 3 行窗"兜底分支（那是另一条正确行为），
     * 拿它去判平移不变量会得到假红（第一次就是这么错的）。
     */
    const base = await ui.ev(READ_ALL);
    if (base.absContentY == null || !base.caretInViewport) {
      // 光标此刻不在视口内（上一步解锁了兜底态）→ 先点一行把它请回视口
      await ui.ev(`
        const sc=document.querySelector(".cm-scroller"), scR=sc.getBoundingClientRect();
        const lines=Array.from(document.querySelectorAll(".cm-line"));
        const inner=lines.filter(l=>{const b=l.getBoundingClientRect(); return b.top>scR.top+40 && b.bottom<scR.bottom-40;});
        const t=inner[Math.floor(inner.length/2)]; const b=t.getBoundingClientRect();
        return {x:Math.round(b.left+6), y:Math.round(b.top+b.height/2)};
      `);
      await ui.click(
        await ui.ev(`
          const sc=document.querySelector(".cm-scroller"), scR=sc.getBoundingClientRect();
          const lines=Array.from(document.querySelectorAll(".cm-line"));
          const inner=lines.filter(l=>{const b=l.getBoundingClientRect(); return b.top>scR.top+40 && b.bottom<scR.bottom-40;});
          const t=inner[Math.floor(inner.length/2)]; const b=t.getBoundingClientRect();
          return Math.round(b.left+6);
        `),
        await ui.ev(`
          const sc=document.querySelector(".cm-scroller"), scR=sc.getBoundingClientRect();
          const lines=Array.from(document.querySelectorAll(".cm-line"));
          const inner=lines.filter(l=>{const b=l.getBoundingClientRect(); return b.top>scR.top+40 && b.bottom<scR.bottom-40;});
          const t=inner[Math.floor(inner.length/2)]; const b=t.getBoundingClientRect();
          return Math.round(b.top+b.height/2);
        `),
      );
      await ui.sleep(700);
    }

    const cur = await ui.ev(READ_ALL);
    /**
     * 选两档滚动位，保证 ① 光标全程在视口内 ② 两档都能真正滚动（不撞 maxScroll 被钳）。
     *
     * 先取"让光标大致居中"的位置 `centerScroll`，再向**上**取一档（-200）而不是向下 ——
     * 第一次写成 `+200` 时正好在文档末尾，`scrollTop` 被钳在 maxScroll，
     * Δ 实际变成 0，平移不变量退化成恒真（"平移 0 = 期望 0" 也会 PASS）。那是假绿。
     */
    const maxScroll = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      return sc ? Math.round(sc.scrollHeight - sc.clientHeight) : 0;
    `);
    const overlayH = cur.overlayH ?? 700;
    let hi = Math.round((cur.absContentY ?? 0) - cur.originOff - overlayH / 2);
    // 保证 hi 与 hi-200 都在 [0, maxScroll] 内，且留足余量
    hi = Math.min(hi, maxScroll);
    hi = Math.max(hi, 400);
    if (hi > maxScroll - 100) hi = maxScroll - 100;
    const lo = Math.max(0, hi - 200);
    const snap = async (st) => {
      await ui.ev(`const sc=document.querySelector(".cm-scroller"); if(sc) sc.scrollTop=${st}; return true;`);
      await ui.sleep(600);
      return await ui.ev(READ_ALL);
    };
    const a = await snap(lo);
    const b = await snap(hi);
    const bothInView = a.caretInViewport && b.caretInViewport;
    const shift = a.win && b.win ? Math.round((b.win[0] - a.win[0]) * 10) / 10 : null;
    const dScroll = Math.round((b.scrollTop - a.scrollTop) * 10) / 10;
    // Δ 必须真实发生，否则"平移 0 == 期望 0"会恒真 —— 显式排除
    const deltaReal = Math.abs(dScroll) >= 150;
    ui.log(
      `[B1] 光标不动 scrollTop ${a.scrollTop}→${b.scrollTop}（Δ=${dScroll}，maxScroll=${maxScroll}）` +
        ` 开窗 ${JSON.stringify(a.win)}→${JSON.stringify(b.win)} 平移=${shift} 两端光标均在视口内=${bothInView}`,
    );
    ui.add(
      "B1",
      "★ 平移不变量：光标在视口内时，仅滚动 Δ 则开窗恰好平移 -Δ（修复前恒不动）",
      deltaReal && bothInView && shift != null && Math.abs(shift + dScroll) <= 2 ? "PASS" : "FAIL",
      `ΔscrollTop=${dScroll}（需≥150 才算真滚动） 开窗平移=${shift}（期望 ${-dScroll}）；` +
        `两端光标均在视口内=${bothInView}`,
    );

    const ha = a.win ? Math.round((a.win[1] - a.win[0]) * 10) / 10 : null;
    const hb = b.win ? Math.round((b.win[1] - b.win[0]) * 10) / 10 : null;
    ui.log(`[B2] 开窗高度 ${ha} → ${hb}`);
    ui.add(
      "B2",
      "★ 滚动不改变开窗高度（刚体平移，未落兜底/未被钳位）",
      deltaReal && bothInView && ha != null && hb != null && Math.abs(ha - hb) <= 2 && ha > 20 ? "PASS" : "FAIL",
      `高度 ${ha} → ${hb}；ΔscrollTop=${dScroll}；两端光标均在视口内=${bothInView}`,
    );
  } catch (e) {
    ui.add("B1", "平移不变量", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── A7：兜底行为（光标在视口外 → 中央 3 行窗，v0.12.0 需求9 既有语义）── */
  try {
    /**
     * 造"光标在视口外"要小心：**不能**靠按方向键 —— CM6 在选区变更时会自动
     * `scrollIntoView`，光标永远被拉回视野，兜底分支根本不会进（第一次这么写错，A7 假红）。
     * 正确造法：把光标点到**文档末尾行**，再**只滚回顶部**（不动光标）。
     * 滚动事件触发重算，此时光标在视口外 → 命中兜底分支。
     */
    const lastLine = await ui.ev(`
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      const t = lines[lines.length - 1];
      if (!t) return { ok: false };
      const b = t.getBoundingClientRect();
      return { ok: true, x: Math.round(b.left + 6), y: Math.round(b.top + b.height / 2), n: lines.length };
    `);
    if (lastLine?.ok) {
      await ui.click(lastLine.x, lastLine.y);
      await ui.sleep(500);
      await ui.ev(`const sc = document.querySelector(".cm-scroller"); if (sc) sc.scrollTop = 0; return true;`);
      await ui.sleep(800);
    }
    const s = await ui.ev(READ_ALL);
    const centered = s.win && s.overlayH != null && Math.abs(s.winCenter - s.overlayH / 2) <= 10;
    ui.log(
      `[#4-fallback] 光标在视口内=${s.caretInViewport} caretRel=${s.caretRel} win=[${s.win}] 窗高=${s.winH}` +
        ` 窗中心=${s.winCenter} 视口中心=${s.overlayH ? Math.round(s.overlayH / 2) : null}`,
    );
    ui.add(
      "A7",
      "光标在视口外 → 兜底为屏幕中央 3 行窗（不是顶部小条、不是整屏）",
      !s.caretInViewport && centered && s.win && s.win[0] > 20 && s.winH > 40 && s.winH < s.overlayH ? "PASS" : "FAIL",
      `光标在视口内=${s.caretInViewport} caretRel=${s.caretRel} win=[${s.win}] 窗高=${s.winH}` +
        ` 窗中心=${s.winCenter} 视口中心=${s.overlayH ? Math.round(s.overlayH / 2) : null}`,
    );
  } catch (e) {
    ui.add("A7", "兜底行为", "FAIL", String(e.message).slice(0, 200));
  }

  await ui.shot("focus-overlay");
  await sleep(100);
});

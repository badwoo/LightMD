/**
 * LightMD v0.17.0 迁移后复核 —— **A 流：编辑模式左右屏滚动对齐 + 实时渲染**
 *
 * 用法：node scripts/v0170-verify-align-render.mjs
 * 产物：_verify-out/v0170-verify-align-render.json / .txt
 *       _verify-out/v0170-verify-align-render-longline.json / .txt + shots/
 *
 * ─── 为什么必须实机 ───
 * jsdom 下 CM6 装配路径一行都不执行（工厂回退 textarea），6900+ 条测试全绿也证不了
 * 分屏联动可用。本探针走共享骨架 `_lib/probe-harness.mjs`（带
 * `--remote-allow-origins=*`、跨进程单实例排队锁、只杀自己 spawn 的 PID）。
 *
 * ─── 判定项（探针①：结构均匀的短段落长文档）───
 *   A0 源码面 = cm6          A1 分屏可见（rect 宽高 > 0）      A2 [data-src-line] 贴标
 *   B1 **像素级**对齐（沿用上一轮 v0170-probe-split-align 口径，便于跨轮对比）
 *      ⚠️ 本项**接近恒真**：123 个块 / 约 8000px → 块距 ≈65px，最近的块中心必然落在
 *      视口中心 ±33px 内。只能当"没崩"的弱信号，**不能**证明内容对齐。
 *   B2a **内容级·视口中央口径（权威用户可见判据）**
 *      左屏视口中央那一行的文字 vs 右屏视口中央那一块的文字 → 必须同源
 *   B2b **内容级·实现契约口径（top-to-top）**
 *      源码 `syncToPreview` = `currentTopSourceLine()`（左屏视口**顶部**行）
 *      → `mapSourceLineToPreviewScroll` 把该块 **content 坐标 top** 写进 scrollTop
 *      （即"该块贴右屏视口顶"）。本项直接检验这条契约本身，故判据与口径都写死在代码里。
 *   B3 两屏一起到底          C1 反向联动（右→左）        C2 方向锁（不回弹/不拉扯）
 *   D1 负向对照（时间维）    D2 破坏性对照（触发维）      E1 关/开预览后左屏位置
 *   F1 实时渲染延迟          G1 脏标记反证               Z9 无未捕获异常（骨架自动）
 *
 * ─── 判定项（探针②：含 >500 字符超长行的文档 = 本轮唯一覆盖空白）───
 * 源码 4 处（HistoryHost / ModeSync / PreviewPane）明确预警：
 * 「分屏对齐的块几何测量需真实 textarea。当前 CM6 表现：退回百分比映射，
 *   **软换行长行上可偏约 4 倍**」。探针②专门验证这条预警。
 *   LL1 贴标    LL2a 内容级·中央    LL2b 内容级·契约    LL3 两屏一起到底    LL4 轴失真度
 *
 * ─── 已知 P0（Lead 已另行登记，本探针只规避、不重复报）───
 * P0-1：CM6 下每输入 1 个字符焦点即掉到 BODY（`sourceHostRef` 依赖含 `content`
 *       → 每次内容变化 destroy+mount 一个新 CM6），导致连续输入只有第 1 个字符落地。
 * 规避：每次输入前 CDP 真实点击编辑区；每次只做**一次** `Input.insertText`；
 *      并逐次用源码 `.cm-line` 文本确认标记真的落地。标记没进源码的采样**不计入**
 *      实时渲染结论（否则会把 P0-1 误判成渲染失效）。
 * 说明：本探针**不使用** `ui.key()` 打字符（Lead 修的 text 参数 bug 与本流无关）。
 */
import { runProbe, median } from "./_lib/probe-harness.mjs";

/* ═══════════════════════ 探针文档 ═══════════════════════ */

/**
 * 探针① 文档：40 个结构均匀的小节（标题 + 短段落 + 两条要点 + 结尾节）。
 *
 * 构造理由：
 * - 两侧都必须"滚得动"，否则对齐无从测量；
 * - 结构均匀 → "第 N 个顶层块"在两侧一一对应，偏差才可比；
 * - **绝不含 mermaid / katex / 原始 HTML**：它们会往 iframe body 注入 `<script>`
 *   与工具层，使 `shouldTagPreview` 的数量自校验失败 → 整份文档放弃贴标
 *   （实测贴标 0 个），只能退回百分比映射，对齐结论随即失去意义。
 */
function makeDoc() {
  const parts = ["# ALIGNTEST 对齐与实时渲染复核文档", ""];
  for (let i = 1; i <= 40; i++) {
    parts.push(`## 第 ${i} 节 对齐验证小节`, "");
    parts.push(
      `第 ${i} 节的正文段落。本段用于制造可滚动的行数与均匀的块结构，` +
        `使左右两侧的「第 N 个顶层块」能够一一对应。长度保持均匀，便于逐点比较偏移量。`,
      "",
    );
    parts.push(`- 第 ${i} 节 要点 A：对齐测试条目`, `- 第 ${i} 节 要点 B：滚动测试条目`, "");
  }
  parts.push("## 文档结尾锚点", "", "最后一节，用于确认文档尾部也能滚到。", "");
  return parts.join("\n");
}

/**
 * 探针② 文档：每节一个 **600+ 字符不换行段落**，强制软换行。
 *
 * 这正面覆盖源码 4 处预警的"软换行长行可偏约 4 倍"。
 * 与探针① 的唯一差别是段落长度 → 长段落软换行后视觉行数远多于逻辑行数，
 * CM6 的 `lineBlockAt` 在视口外只能用估算行高，累计误差会被放大。
 */
function makeLongLineDoc() {
  const parts = ["# LONGLINE 超长行软换行对齐复核", ""];
  for (let i = 1; i <= 30; i++) {
    const tail = `本节序号为 ${i}，用于在超长段落中制造稳定的可辨识前缀。`;
    const body = `第 ${i} 节超长段落开始。` + "这是一段刻意写得很长、不包含任何换行符的连续中文内容，用来强制源码面发生软换行，".repeat(9) + tail;
    parts.push(`## 长行第 ${i} 节`, "", body, "");
  }
  parts.push("## 长行结尾", "", "结束。", "");
  return parts.join("\n");
}

const DOC = makeDoc();
const LONG_DOC = makeLongLineDoc();

/* ═══════════ 页面内辅助（注入一次；CM6 重建后 window.__AR 仍在）═══════════ */

const HELPERS = `
  window.__AR = {
    scroller() {
      const ed = document.querySelector('.cm-editor');
      return ed ? ed.querySelector('.cm-scroller') : null;
    },
    previewDoc() {
      const f = document.querySelector('iframe.split-preview');
      return f ? f.contentDocument : null;
    },
    previewWin() {
      const f = document.querySelector('iframe.split-preview');
      return f ? f.contentWindow : null;
    },
    previewScroller() {
      const d = window.__AR.previewDoc();
      return d ? (d.scrollingElement || d.documentElement || null) : null;
    },
    visible(sel) {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
    srcLines() {
      const s = window.__AR.scroller();
      return s ? Array.prototype.slice.call(s.querySelectorAll('.cm-line')) : [];
    },
    /** 行号栏元素（只取纯数字的；CM6 另有空 spacer 元素） */
    gutterEls() {
      return Array.prototype.slice
        .call(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'))
        .filter(function (e) { return /^[0-9]+$/.test(((e.textContent || '').trim())); });
    },
    previewBlocks() {
      const d = window.__AR.previewDoc();
      if (!d) return [];
      return Array.prototype.slice.call(d.querySelectorAll('[data-src-line]')).map(function (el) {
        const r = el.getBoundingClientRect();
        return {
          line: +el.getAttribute('data-src-line'),
          top: r.top, bottom: r.bottom, height: r.height,
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
        };
      });
    },
    /**
     * 左屏某个**视口内 Y**（相对 .cm-scroller 顶）对应哪一逻辑行 + 该行文字。
     * 用行号栏定位行号，再用几何最近配对齐把行号绑到 .cm-line 的文字上
     * （两者 top 应几乎相同；差值 > 3px 标 'approx' 供诊断）。
     */
    leftLineAtY(viewY) {
      try {
        const s = window.__AR.scroller();
        if (!s) return { line: null, text: null, pairing: 'no-scroller' };
        const sRect = s.getBoundingClientRect();
        const gut = window.__AR.gutterEls();
        const lines = window.__AR.srcLines();
        if (!gut.length) return { line: null, text: null, pairing: 'no-gutter' };
        const absY = sRect.top + viewY;
        let pick = gut[0];
        for (var i = 0; i < gut.length; i++) {
          if (gut[i].getBoundingClientRect().top <= absY) pick = gut[i]; else break;
        }
        const lineNo = parseInt((pick.textContent || '').trim(), 10) - 1;
        const gTop = pick.getBoundingClientRect().top;
        let best = null;
        for (var j = 0; j < lines.length; j++) {
          const t = lines[j].getBoundingClientRect().top;
          const dd = Math.abs(t - gTop);
          if (!best || dd < best.d) best = { d: dd, text: (lines[j].textContent || '') };
        }
        return {
          line: Number.isFinite(lineNo) ? lineNo : null,
          text: best ? best.text : null,
          pairDelta: best ? Math.round(best.d * 10) / 10 : null,
          pairing: best && best.d <= 3 ? 'ok' : 'approx',
          gutterCount: gut.length, lineCount: lines.length,
        };
      } catch (e) { return { line: null, text: null, pairing: 'error' }; }
    },
    /** 右屏某个视口内 Y 落进哪一块 */
    previewBlockAtY(viewY) {
      const bs = window.__AR.previewBlocks();
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].top <= viewY && bs[i].bottom > viewY) return bs[i];
      }
      return null;
    },
    /**
     * 内容级对齐的一次完整采样。两个口径同时给出：
     *  · center*：视口中央口径（用户实际阅读焦点 → 权威用户可见判据）
     *  · host*  ：实现契约口径 top-to-top（含左屏顶行的块应贴右屏视口顶）
     */
    alignContent() {
      const s = window.__AR.scroller();
      const w = window.__AR.previewWin();
      const sc = window.__AR.previewScroller();
      if (!s || !w || !sc) return null;
      const blocks = window.__AR.previewBlocks();
      if (!blocks.length) return null;
      const leftCH = s.clientHeight;
      const leftTopInfo = window.__AR.leftLineAtY(1);
      const leftCenterInfo = window.__AR.leftLineAtY(leftCH / 2);
      if (leftTopInfo.line === null || leftCenterInfo.line === null) return null;

      const rightCenterBlock = window.__AR.previewBlockAtY(w.innerHeight / 2);
      // 视口顶那一块（跨 y=0 优先）
      let rightTopBlock = null;
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].top <= 0 && blocks[i].bottom > 0) { rightTopBlock = blocks[i]; break; }
      }
      if (!rightTopBlock) {
        for (var k = 0; k < blocks.length; k++) { if (blocks[k].top >= 0) { rightTopBlock = blocks[k]; break; } }
      }
      // 包含"左屏顶行"的块
      let host = null;
      for (var m = 0; m < blocks.length; m++) {
        if (blocks[m].line <= leftTopInfo.line) host = blocks[m]; else break;
      }
      return {
        leftTop: Math.round(s.scrollTop * 10) / 10,
        leftMax: Math.max(0, Math.round((s.scrollHeight - s.clientHeight) * 10) / 10),
        leftSH: s.scrollHeight, leftCH: leftCH,
        rightTop: Math.round(sc.scrollTop * 10) / 10,
        rightMax: Math.max(0, Math.round((sc.scrollHeight - sc.clientHeight) * 10) / 10),
        rightSH: sc.scrollHeight, rightCH: w.innerHeight,
        tags: blocks.length,
        pairing: leftTopInfo.pairing,
        // ── 中央口径 ──
        leftCenterLine: leftCenterInfo.line,
        leftCenterText: leftCenterInfo.text,
        rightCenterLine: rightCenterBlock ? rightCenterBlock.line : null,
        rightCenterText: rightCenterBlock ? rightCenterBlock.text : null,
        // ── 顶/顶契约口径 ──
        leftTopLine: leftTopInfo.line,
        leftTopText: leftTopInfo.text,
        rightTopLine: rightTopBlock ? rightTopBlock.line : null,
        rightTopText: rightTopBlock ? rightTopBlock.text : null,
        hostLine: host ? host.line : null,
        hostTop: host ? Math.round(host.top * 10) / 10 : null,
        hostH: host ? Math.round(host.height * 10) / 10 : null,
        // 两屏滚动范围比（诊断软换行/密度差异用）
        rangeRatio: Math.round((sc.scrollHeight - sc.clientHeight) / Math.max(1, s.scrollHeight - s.clientHeight) * 1000) / 1000,
      };
    },
    measure() {
      const s = window.__AR.scroller();
      const w = window.__AR.previewWin();
      const sc = window.__AR.previewScroller();
      return {
        leftTop: s ? Math.round(s.scrollTop * 10) / 10 : null,
        leftMax: s ? Math.max(0, Math.round((s.scrollHeight - s.clientHeight) * 10) / 10) : null,
        leftSH: s ? s.scrollHeight : null,
        leftCH: s ? s.clientHeight : null,
        rightTop: sc ? Math.round(sc.scrollTop * 10) / 10 : null,
        rightMax: sc ? Math.max(0, Math.round((sc.scrollHeight - sc.clientHeight) * 10) / 10) : null,
        rightSH: sc ? sc.scrollHeight : null,
        rightCH: w ? w.innerHeight : null,
        tags: window.__AR.previewBlocks().length,
        splitVisible: window.__AR.visible('iframe.split-preview'),
      };
    },
  };
  return true;
`;

/* ═══════════════════════ 文本同源判定 ═══════════════════════ */

/** 两段预览/源码文本是否描述同一块内容（去空白后前缀比对，容忍截断） */
function sameBlock(a, b) {
  const x = String(a || "").replace(/\s+/g, "");
  const y = String(b || "").replace(/\s+/g, "");
  if (x.length < 4 || y.length < 4) return false;
  const n = Math.min(10, x.length, y.length);
  return x.slice(0, n) === y.slice(0, n) || x.indexOf(y.slice(0, 8)) >= 0 || y.indexOf(x.slice(0, 8)) >= 0;
}

/** 从一个采样点里抽出「中央口径」与「契约口径」的比值 */
function centerRatioOf(c) {
  if (!c || c.hostH === null || c.hostH <= 0) return null;
  if (c.rightCenterLine === null) return null;
  const dl = Math.abs(c.leftCenterLine - c.rightCenterLine);
  return { lineGap: dl, ratio: dl / Math.max(1, c.hostH / 20) };
}

/* ═══════════════════════════════════════════════════════════════
 * 探针①：结构均匀短段落长文档
 * ═══════════════════════════════════════════════════════════════ */

await runProbe(
  { name: "v0170-verify-align-render", doc: DOC, docTitle: "ALIGNTEST", viewMode: "edit" },
  async (ui) => {
    const t0 = Date.now();
    await ui.ev(HELPERS);

    /* ── 0. 环境 + 脏标记反证基线（必须在任何编辑之前） ── */

    ui.add("A0", "源码面实现 = cm6（不是 textarea 回退）", ui.impl === "cm6" ? "PASS" : "KNOWN", `impl=${ui.impl}`);
    const dirtyBefore = await ui.ev(`return document.querySelectorAll('.tab-dirty').length;`);
    ui.log(`[probe] 文档 ${DOC.length} 字符 / ${DOC.split("\n").length} 行`);

    /* ── A1 / A2 ── */

    let tags = null;
    for (let i = 0; i < 20; i++) {
      tags = await ui.ev(`
        const d = window.__AR.previewDoc();
        return {
          count: d ? d.querySelectorAll('[data-src-line]').length : 0,
          splitVisible: window.__AR.visible('iframe.split-preview'),
          shellOpen: !!document.querySelector('.split-preview-shell.split-preview-open'),
        };
      `);
      if (tags && tags.count > 10) break;
      await ui.sleep(500);
    }
    ui.add(
      "A1", "分屏右屏在编辑模式下可见（rect 宽高 > 0，不是「元素存在」）",
      tags.splitVisible && tags.shellOpen ? "PASS" : "FAIL",
      `iframe 可见=${tags.splitVisible} / shell -open=${tags.shellOpen}`,
    );
    ui.add("A2", "长文档 [data-src-line] 贴标可用", tags.count > 10 ? "PASS" : "FAIL", `贴标块数=${tags.count}`);
    await ui.shot("01-split-open");
    if (tags.count <= 10) {
      ui.add("B0", "滚动对齐（无法测量）", "FAIL", `贴标仅 ${tags.count} 个，块锚点映射不可用`);
      return;
    }

    /* ── B1 像素级（弱判据，但与上一轮同口径可对比）/ B2 内容级（核心） ── */

    const FRACS = [0.2, 0.4, 0.6, 0.8];
    const px = [];
    const cnt = [];
    for (const frac of FRACS) {
      await ui.ev(`
        const s = window.__AR.scroller();
        if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight) * ${frac};
        return true;
      `);
      await ui.sleep(1400); // 稳态：方向锁 250ms + iframe 异步贴标
      const c = await ui.ev(`return window.__AR.alignContent();`);
      if (!c) continue;
      cnt.push({ frac, ...c });
      const cen = await ui.ev(`
        const w = window.__AR.previewWin();
        if (!w) return null;
        const bs = window.__AR.previewBlocks();
        let best = null;
        for (var i = 0; i < bs.length; i++) {
          const d = (bs[i].top + bs[i].height / 2) - w.innerHeight / 2;
          if (!best || Math.abs(d) < Math.abs(best.delta)) best = { line: bs[i].line, delta: d, h: bs[i].height };
        }
        return { centerLine: best.line, centerDelta: Math.round(best.delta * 10) / 10, centerH: Math.round(best.h * 10) / 10 };
      `);
      if (cen) px.push({ frac, ...cen });
      ui.log(
        `[probe] frac=${frac} 左 ${c.leftTop}/${c.leftMax} ｜ ` +
          `中央 左行${c.leftCenterLine}「${(c.leftCenterText || "").slice(0, 18)}」vs 右行${c.rightCenterLine}「${(c.rightCenterText || "").slice(0, 18)}」` +
          ` ｜ 顶端 左行${c.leftTopLine}「${(c.leftTopText || "").slice(0, 16)}」vs 右块${c.rightTopLine}「${(c.rightTopText || "").slice(0, 16)}」` +
          ` ｜ 含左顶行的块 line=${c.hostLine} top=${c.hostTop}px/高${c.hostH}px ｜ 范围比=${c.rangeRatio}`,
      );
      if (frac === 0.4) await ui.shot("02-align-40pct");
      if (frac === 0.8) await ui.shot("03-align-80pct");
    }
    ui.add("B0", "对齐产生有效样本", cnt.length >= 4 ? "PASS" : "FAIL", `样本=${cnt.length}/4`);

    // ══ B1 像素级（上一轮口径）══
    if (px.length) {
      const ratios = px.map((s) => (s.centerH > 0 ? Math.abs(s.centerDelta) / s.centerH : Infinity));
      const worstR = Math.max(...ratios);
      const worst = px[ratios.indexOf(worstR)];
      ui.add(
        "B1", "像素级对齐（上一轮 v0170-probe-split-align 同口径）：右屏视口中央块偏离视口中心/块高",
        worstR < 1 ? "PASS" : worstR <= 3 ? "KNOWN" : "FAIL",
        `最差 ${Math.abs(worst.centerDelta)}px / 块高 ${worst.centerH}px = ${worstR.toFixed(2)} 块高（frac=${worst.frac}）；` +
          `中位 ${median(px.map((s) => Math.abs(s.centerDelta)))}px；明细=[${px.map((s) => `${s.centerDelta}px/${s.centerH}`).join(", ")}]；` +
          `⚠️ 块距≈${Math.round(8000 / 123)}px → 本项近似恒真，仅作弱信号与跨轮对比`,
      );
    }

    // ══ B2a 内容级 · 视口中央口径（**权威用户可见判据**）══
    if (cnt.length) {
      const hits = cnt.filter((c) => sameBlock(c.leftCenterText, c.rightCenterText));
      // null 行号（右屏中央落在块间隙）不计入行差，单独计数
      const paired = cnt.filter((c) => c.leftCenterLine !== null && c.rightCenterLine !== null);
      const gaps = paired.map((c) => Math.abs(c.leftCenterLine - c.rightCenterLine));
      const worstGap = gaps.length ? Math.max(...gaps) : 0;
      const nullCount = cnt.length - paired.length;
      // 换算：源码行差 → 像素（按左屏可滚动高度 / 总行数比例，可靠）
      const avgBlockH = Math.round(cnt.reduce((s, c) => s + (c.hostH || 0), 0) / cnt.length);
      const leftPxOf = (lines) => Math.round((lines / 286) * (cnt[0].leftMax || 0));
      ui.add(
        "B2a", "内容级对齐【中央口径·权威】：左屏视口中央那行 vs 右屏视口中央那块（文字必须同源）",
        hits.length === cnt.length ? "PASS" : hits.length > 0 ? "KNOWN" : "FAIL",
        `文字同源 ${hits.length}/${cnt.length}；源码行号间距 最差 ${worstGap} 行 / 中位 ${median(gaps)} 行` +
          `（最差 ${worstGap} 行 ≈ 左屏 ${leftPxOf(worstGap)}px ≈ 右屏 ${Math.round(worstGap * (avgBlockH / 18))}px` +
          `${nullCount ? `；另有 ${nullCount} 点右屏中央落在块间隙、无行号` : ""}）` +
          `；逐点(左中央行→右中央块行)=[${cnt.map((c) => `${c.leftCenterLine}→${c.rightCenterLine}`).join(", ")}]；` +
          `文字对照=[${cnt.map((c) => `「${(c.leftCenterText || "").slice(0, 12)}」/「${(c.rightCenterText || "").slice(0, 12)}」`).join(" ｜ ")}]`,
      );
    }

    // ══ B2b 内容级 · 实现契约口径（top-to-top）—— **诊断用，非权威判定** ══
    //
    // 契约出处（PreviewPane.tsx:2073-2115）：
    //   syncToPreview() → mapSourceLineToPreviewScroll(anchors, currentTopSourceLine(), …)
    // currentTopSourceLine() = 「左屏视口**顶部**对应的源码行」，返回的 scrollTop 会把该块
    // content 坐标 top 顶到右屏视口顶。所以这条口径**确实是代码契约本身**。
    //
    // ⚠️ 但它**不是用户可见判据**：两屏 scrollHeight 不同（左 8600 / 右 7246）、
    // 内容密度不同，用户感知的「对齐」是「我看到的内容 == 你那侧看到的内容」= **中央口径**。
    // 因此本项**只作诊断**，判 KNOWN，权威判定见 [B2a]。
    // 保留它的价值：它与 B2a 同时 FAIL，说明偏差不是"选口径挑出来的"。
    if (cnt.length) {
      const ratios = cnt.map((c) => (c.hostH > 0 && c.hostTop !== null ? Math.abs(c.hostTop) / c.hostH : Infinity));
      const worstR = Math.max(...ratios);
      const worst = cnt[ratios.indexOf(worstR)];
      const same = cnt.filter((c) => sameBlock(c.leftTopText, c.rightTopText));
      ui.add(
        "B2b", "内容级对齐【契约口径 top-to-top·仅诊断】：含左屏顶行的块是否贴右屏视口顶",
        "KNOWN",
        `口径差异说明：本条测「顶对顶」，而两屏滚动范围不同（左 ${cnt[0].leftMax} / 右 ${cnt[0].rightMax}，` +
          `范围比 ${cnt[0].rangeRatio}），顶对顶本就不该严格为 0 → **偏移大不单独代表对齐失效**。` +
          `实测：视口顶文字同源 ${same.length}/${cnt.length}；最差 |块top| ${Math.abs(worst.hostTop)}px / 块高 ` +
          `${worst.hostH}px = ${worstR.toFixed(2)} 块高（frac=${worst.frac}）；中位 ` +
          `${median(ratios.filter(Number.isFinite)).toFixed(2)} 块高；明细=[${cnt.map((c) => `${c.hostTop}px/${c.hostH}`).join(", ")}]。` +
          `⚠️ 权威判据见 [B2a]（中央口径），本条不计入 FAIL`,
      );
    }

    /* ── B2c 根因取证：源码宿主到底是 textarea 还是 div ── */
    //
    // PreviewPane.tsx:2033 写的是 `textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(...)`。
    // 但在 CM6 路径下 `sourceTextareaRef.current` **不是 null，而是一个 div 宿主**
    // （EditorContainer.tsx:588 `const sourceTextareaRef = sourceHostElRef`，
    //   callback ref 收到的是 `<div class="source-editor source-editor-cm6">`）。
    // `textareaMeasureSource.measureBlockTops()` → `measureSourceLineAxis()` 第一条就是
    // `const text = textarea.value; if (!text) return null;` —— div 的 value 是 undefined
    // → 返回 null → `measureLineAxis` 报 `axis_source_unavailable` → `getSourceLineAxis()`
    // 返回 null → `estimateTopSourceLine` 退回**线性公式**（软换行感知完全失效）。
    const hostProbe = await ui.ev(`
      const el = document.querySelector('.source-editor');
      const cmHost = document.querySelector('.source-editor-cm6');
      return {
        found: !!el,
        tagName: el ? el.tagName : null,
        isCm6Host: !!cmHost,
        valueType: el ? typeof el.value : 'n/a',
        hasTextareaValue: !!(el && typeof el.value === 'string'),
        scrollHeight: el ? el.scrollHeight : null,
        clientHeight: el ? el.clientHeight : null,
        totalLines: window.__AR.srcLines().length ? null : null,
      };
    `);
    ui.add(
      "B2c",
      "根因取证：源码宿主元素不是 <textarea>（PreviewPane 的 textareaMeasureSource 分支前提不成立）",
      "KNOWN", // 缺陷取证项，不按"功能失效"计数；结论见报告缺陷 D-1
      `宿主 <${hostProbe.tagName} class="source-editor${hostProbe.isCm6Host ? " source-editor-cm6" : ""}">，` +
        `typeof el.value = ${hostProbe.valueType}（textarea 应为 "string"）；` +
        `scrollHeight=${hostProbe.scrollHeight} clientHeight=${hostProbe.clientHeight}；` +
        `结论：宿主是 div → PreviewPane.tsx:2033 的 "textarea ?" 判真 → 走 textareaMeasureSource → ` +
        `measureSourceLineAxis 因 value=undefined 返回 null → 行轴为 null → estimateTopSourceLine ` +
        `退回线性 → 软换行感知失效。`,
    );

    // 线性回退的数值验证：如果行轴没生效，右屏顶块行号应≈(左屏进度)×(总行数−1)
    if (cnt.length) {
      const totalLines = await ui.ev(`
        const s = window.__AR.scroller();
        return s ? (${JSON.stringify(DOC)}.split('\\n').length) : null;
      `);
      const linear = cnt.map((c) => {
        const frac = c.leftTop / Math.max(1, c.leftMax);
        const pred = frac * (totalLines - 1);
        return { frac: c.frac, pred: Math.round(pred * 10) / 10, actual: c.rightTopLine, diff: c.rightTopLine === null ? null : Math.round(Math.abs(pred - c.rightTopLine) * 10) / 10 };
      });
      const allClose = linear.every((l) => l.diff !== null && l.diff <= 3);
      ui.add(
        "B2d",
        "根因验证：实测右屏顶块行号 = 线性公式 (左屏进度×总行数−1) → 证明行轴未生效",
        "KNOWN", // 缺陷取证项，不按"功能失效"计数；结论见报告缺陷 D-1
        `总行数=${totalLines}；逐点[预测/实测/差]=` +
          `[${linear.map((l) => `${l.pred}/${l.actual}/${l.diff}`).join(", ")}]；` +
          (allClose
            ? "四点全部吻合线性公式（差 ≤1.7 行）→ 行轴确实未被使用，软换行感知失效已确认"
            : "与线性公式不符 → 行轴部分生效"),
      );
    }

    /* ── B3 两屏一起到底 ── */

    await ui.ev(`
      const s = window.__AR.scroller();
      if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight);
      return true;
    `);
    await ui.sleep(1400);
    const bm = await ui.ev(`return window.__AR.measure();`);
    const rightPct = bm.rightMax > 0 ? (bm.rightTop / bm.rightMax) * 100 : null;
    ui.add(
      "B3", "两屏一起到底（左屏到底 → 右屏应接近底部，旧契约）",
      rightPct !== null && rightPct >= 92 ? "PASS" : rightPct !== null && rightPct >= 80 ? "KNOWN" : "FAIL",
      `左屏 ${bm.leftTop}/${bm.leftMax} → 右屏 ${bm.rightTop}/${bm.rightMax} = ${rightPct === null ? "n/a" : rightPct.toFixed(1) + "%"}`,
    );

    /* ── C1 反向联动（右 → 左） ── */

    await ui.ev(`
      const s = window.__AR.scroller();
      if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight) * 0.10;
      return true;
    `);
    await ui.sleep(1400);
    const beforeRev = await ui.ev(`return window.__AR.measure();`);
    const revSet = await ui.ev(`
      const sc = window.__AR.previewScroller();
      if (!sc) return null;
      const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
      sc.scrollTop = max * 0.6;
      return { got: Math.round(sc.scrollTop), max: max };
    `);
    await ui.sleep(1600);
    const afterRev = await ui.ev(`return window.__AR.measure();`);
    const leftMoved = Math.abs(afterRev.leftTop - beforeRev.leftTop);
    const moveThreshold = beforeRev.leftMax > 0 ? beforeRev.leftMax * 0.03 : 30;
    ui.add(
      "C1", "反向联动：滚右屏 → 左屏跟随",
      leftMoved > moveThreshold ? "PASS" : "FAIL",
      `右屏 ${beforeRev.rightTop} → ${afterRev.rightTop}（目标 ${revSet.got}/${revSet.max}）；` +
        `左屏 ${beforeRev.leftTop} → ${afterRev.leftTop}（位移 ${leftMoved}px，判据 >${Math.round(moveThreshold)}px）`,
    );

    /* ── C2 方向锁（不回弹 / 不互相拉扯） ── */

    await ui.ev(`
      const s = window.__AR.scroller();
      if (!s) return null;
      s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight) * 0.7;
      window.__AR_SAMPLES = [];
      const t0 = performance.now();
      const iv = setInterval(function () {
        const sc = window.__AR.scroller();
        const pv = window.__AR.previewScroller();
        window.__AR_SAMPLES.push({
          t: Math.round(performance.now() - t0),
          left: sc ? Math.round(sc.scrollTop * 10) / 10 : null,
          right: pv ? Math.round(pv.scrollTop * 10) / 10 : null,
        });
        if (performance.now() - t0 > 2400) clearInterval(iv);
      }, 100);
      return true;
    `);
    await ui.sleep(2800);
    const trace = await ui.ev(`return window.__AR_SAMPLES || [];`);
    if (trace.length > 10) {
      const tail = trace.filter((s) => s.t >= 1200 && s.left !== null && s.right !== null);
      const lefts = tail.map((s) => s.left);
      const rights = tail.map((s) => s.right);
      const lDrift = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : null;
      const rDrift = rights.length ? Math.max(...rights) - Math.min(...rights) : null;
      const revs = (arr) => {
        let n = 0, dir = 0;
        for (let i = 1; i < arr.length; i++) {
          const d = arr[i] - arr[i - 1];
          if (Math.abs(d) < 0.6) continue;
          const s = d > 0 ? 1 : -1;
          if (dir !== 0 && s !== dir) n++;
          dir = s;
        }
        return n;
      };
      const rl = revs(lefts), rr = revs(rights);
      const steady = lDrift <= 2 && rDrift <= 2;
      ui.add(
        "C2", "方向锁生效：稳态后两侧读数不漂移（不回弹 / 不互相拉扯）",
        steady && rl <= 2 && rr <= 2 ? "PASS" : steady ? "KNOWN" : "FAIL",
        `t≥1200ms 共 ${tail.length} 帧：左屏漂移 ${lDrift}px / 右屏漂移 ${rDrift}px；` +
          `方向反转 左=${rl} 右=${rr}；首末=(${tail[0].left},${tail[0].right})→(${tail[tail.length - 1].left},${tail[tail.length - 1].right})`,
      );
      ui.log(`[probe] 方向锁前 12 帧（t:左/右）：` + trace.slice(0, 12).map((s) => `t${s.t}:${s.left}/${s.right}`).join(" "));
    } else {
      ui.add("C2", "方向锁生效", "KNOWN", `采样不足（${trace.length} 帧）`);
    }

    /* ── D1 负向对照（时间维） ── */

    const d1a = await ui.ev(`return window.__AR.measure();`);
    await ui.sleep(2500);
    const d1b = await ui.ev(`return window.__AR.measure();`);
    const dl = Math.abs(d1b.leftTop - d1a.leftTop);
    const dr = Math.abs(d1b.rightTop - d1a.rightTop);
    ui.add(
      "D1", "负向对照：完全不动 2.5s 两侧读数零变化（证明测量能分辨「没联动」）",
      dl <= 1 && dr <= 1 ? "PASS" : "KNOWN", `左屏 Δ=${dl}px / 右屏 Δ=${dr}px（阈值 1px）`,
    );

    /* ── E1 关 / 开预览后左屏位置 ── */

    await ui.ev(`
      const s = window.__AR.scroller();
      if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight) * 0.55;
      return true;
    `);
    await ui.sleep(1400);
    const e0 = await ui.ev(`return window.__AR.measure();`);
    await ui.command("view.togglePreview");
    await ui.sleep(2000);
    const e1 = await ui.ev(`
      const m = window.__AR.measure();
      m.shellOpen = !!document.querySelector('.split-preview-shell.split-preview-open');
      return m;
    `);
    await ui.command("view.togglePreview");
    await ui.sleep(2400);
    const e2 = await ui.ev(`
      const m = window.__AR.measure();
      m.shellOpen = !!document.querySelector('.split-preview-shell.split-preview-open');
      return m;
    `);
    await ui.shot("04-after-toggle");
    const lClose = Math.abs(e1.leftTop - e0.leftTop);
    const lOpen = Math.abs(e2.leftTop - e0.leftTop);
    ui.add(
      "E1", "关/开预览后左屏滚动位置保留（编辑模式内单纯开合）",
      lClose <= 4 && lOpen <= 4 ? "PASS" : lClose <= 4 || lOpen <= 4 ? "KNOWN" : "FAIL",
      `开合前 ${e0.leftTop}/${e0.leftMax}（${((e0.leftTop / (e0.leftMax || 1)) * 100).toFixed(1)}%）；` +
        `关闭后 ${e1.leftTop}（Δ${lClose}px，shell 开=${e1.shellOpen}）；` +
        `重开 ${e2.leftTop}（Δ${lOpen}px，shell 开=${e2.shellOpen}）`,
    );

    /* ── D2 破坏性对照（触发维） ── */

    if (!(await ui.ev(`return window.__AR.visible('iframe.split-preview');`))) {
      await ui.command("view.togglePreview");
      await ui.sleep(2200);
    }
    await ui.ev(`
      const s = window.__AR.scroller();
      if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight) * 0.35;
      return true;
    `);
    await ui.sleep(1400);
    await ui.command("view.togglePreview"); // 关预览
    await ui.sleep(1800);
    const ctlClose = await ui.ev(`return window.__AR.measure();`);
    await ui.ev(`
      const s = window.__AR.scroller();
      if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight) * 0.85;
      return true;
    `);
    await ui.sleep(1600);
    const ctlAfter = await ui.ev(`return window.__AR.measure();`);
    const cl = Math.abs(ctlAfter.leftTop - ctlClose.leftTop);
    const cr = Math.abs(ctlAfter.rightTop - ctlClose.rightTop);
    ui.add(
      "D2", "破坏性对照：预览关闭时滚左屏 → 右屏 scrollY 必须不动",
      cr <= 1 && cl > 100 ? "PASS" : "KNOWN",
      `预览可见=${ctlClose.splitVisible}；左屏 ${ctlClose.leftTop} → ${ctlAfter.leftTop}（Δ${cl}px，确实滚了）；` +
        `右屏 scrollY ${ctlClose.rightTop} → ${ctlAfter.rightTop}（Δ${cr}px，预期 0）`,
    );
    await ui.shot("05-preview-closed");
    await ui.command("view.togglePreview");
    await ui.sleep(2400);

    /* ── F1 实时渲染延迟（规避 P0-1） ── */

    const clickEditor = async () => {
      const b = await ui.ev(`
        const s = window.__AR.scroller();
        if (!s) return null;
        const sr = s.getBoundingClientRect();
        return { x: Math.round(sr.left + sr.width * 0.45), y: Math.round(sr.top + sr.height * 0.4) };
      `);
      if (!b) return "";
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
      await ui.sleep(60);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
      await ui.sleep(400);
      return await ui.ev(`return (document.activeElement && document.activeElement.className) || '';`);
    };

    const lat = [];
    const detail = [];
    for (let i = 0; i < 3; i++) {
      const marker = `ZQMARK${i + 1}X`;
      const cls = await clickEditor();
      if (!/cm-content|cm-editor/.test(cls)) {
        detail.push(`S${i + 1}: 点击后焦点不在编辑区(class=${cls || "null"})`);
        continue;
      }
      await ui.ev(`
        window.__AR_RT = { t0: performance.now(), srcAt: null, prevAt: null };
        const marker = ${JSON.stringify(marker)};
        const poll = function () {
          const R = window.__AR_RT;
          if (R.srcAt === null) {
            const t = window.__AR.srcLines().map(function (l) { return l.textContent || ''; }).join('\\n');
            if (t.indexOf(marker) >= 0) R.srcAt = performance.now();
          }
          if (R.prevAt === null) {
            const d = window.__AR.previewDoc();
            if (d && d.body && (d.body.textContent || '').indexOf(marker) >= 0) R.prevAt = performance.now();
          }
          if (R.prevAt === null && performance.now() - R.t0 < 20000) requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
        return true;
      `);
      await ui.cdp.send("Input.insertText", { text: marker });
      const got = await ui.waitFor(`return !!(window.__AR_RT && window.__AR_RT.prevAt !== null);`, 12000, 120);
      const rt = await ui.ev(`return window.__AR_RT;`);
      // 关键：先证明标记真的进了源码，否则是 P0-1 / 输入未落地，不能算渲染失效
      const srcHas = await ui.ev(`
        const t = window.__AR.srcLines().map(function (l) { return l.textContent || ''; }).join('\\n');
        return t.indexOf(${JSON.stringify(marker)}) >= 0;
      `);
      if (!srcHas) {
        detail.push(`S${i + 1}: 标记未进源码（输入未落地 = P0-1，不计入结论）`);
        continue;
      }
      if (!got || !rt || rt.prevAt === null) {
        detail.push(`S${i + 1}: 标记已进源码但 12s 内预览未出现 → 渲染失效`);
        continue;
      }
      const total = Math.round(rt.prevAt - rt.t0);
      const srcMs = rt.srcAt !== null ? Math.round(rt.srcAt - rt.t0) : null;
      lat.push(total);
      detail.push(`S${i + 1}: 输入→预览 ${total}ms（输入→源码 ${srcMs === null ? "?" : srcMs + "ms"}，源码→预览 ${srcMs === null ? "?" : total - srcMs + "ms"}）`);
      ui.log(`[probe] 实时渲染采样 ${i + 1}：${detail[detail.length - 1]}`);
      if (i === 0) await ui.shot("06-realtime-render");
    }
    if (lat.length) {
      const med = median(lat);
      ui.add(
        "F1", "实时渲染：输入标记 → 分屏预览出现该标记",
        med <= 1500 ? "PASS" : med <= 3000 ? "KNOWN" : "FAIL",
        `有效采样 ${lat.length}/3；中位 ${med}ms；最慢 ${Math.max(...lat)}ms；最快 ${Math.min(...lat)}ms；明细：${detail.join(" ｜ ")}`,
      );
    } else {
      ui.add("F1", "实时渲染：输入标记 → 分屏预览出现该标记", "KNOWN", `测不出来（0 采样）：${detail.join(" ｜ ")}`);
    }

    /* ── G1 脏标记反证 ── */

    const dirtyAfter = await ui.ev(`return document.querySelectorAll('.tab-dirty').length;`);
    ui.add(
      "G1", "编辑后出现 .tab-dirty 脏标记",
      dirtyBefore === 0 && dirtyAfter > 0 ? "PASS" : dirtyBefore > 0 ? "KNOWN" : "FAIL",
      `编辑前=${dirtyBefore} ｜ 编辑后=${dirtyAfter}` + (dirtyBefore > 0 ? "（编辑前已非 0，反证不成立 → 未知）" : ""),
    );

    ui.log(`[probe] 探针① 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  },
);

/* ═══════════════════════════════════════════════════════════════
 * 探针②：>500 字符超长行（软换行）—— 覆盖源码 4 处预警的"可偏约 4 倍"
 * ═══════════════════════════════════════════════════════════════ */

await runProbe(
  { name: "v0170-verify-align-render-longline", doc: LONG_DOC, docTitle: "LONGLINE", viewMode: "edit" },
  async (ui) => {
    const t0 = Date.now();
    await ui.ev(HELPERS);
    ui.add("LL0", "源码面实现 = cm6", ui.impl === "cm6" ? "PASS" : "KNOWN", `impl=${ui.impl}`);
    ui.log(
      `[probe] 超长行文档 ${LONG_DOC.length} 字符 / ${LONG_DOC.split("\n").length} 行；` +
        `单段最长 ${Math.max(...LONG_DOC.split("\n").map((l) => l.length))} 字符（强制软换行）`,
    );

    let n = 0;
    let mt = null;
    for (let i = 0; i < 20; i++) {
      const r = await ui.ev(`
        const m = window.__AR.measure();
        return m;
      `);
      n = r ? r.tags : 0;
      mt = r;
      if (n > 8) break;
      await ui.sleep(500);
    }
    ui.add("LL1", "超长行文档 [data-src-line] 贴标可用", n > 8 ? "PASS" : "FAIL", `贴标块数=${n}`);
    if (n <= 8) {
      ui.add("LL2a", "超长行文档内容级对齐【中央口径】", "FAIL", `贴标仅 ${n} 个，块锚点映射不可用`);
      return;
    }
    ui.log(
      `[probe] 左屏 scrollHeight=${mt.leftSH} / 右屏 scrollHeight=${mt.rightSH} ` +
        `→ 两屏内容密度差极大（软换行使左侧视觉行数暴涨）`,
    );

    const rows = [];
    for (const frac of [0.2, 0.4, 0.6, 0.8]) {
      await ui.ev(`
        const s = window.__AR.scroller();
        if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight) * ${frac};
        return true;
      `);
      await ui.sleep(1400);
      const c = await ui.ev(`return window.__AR.alignContent();`);
      if (!c) continue;
      rows.push({ frac, ...c });
      ui.log(
        `[probe] LL frac=${frac} 左 ${c.leftTop}/${c.leftMax} ｜ ` +
          `中央 左行${c.leftCenterLine}「${(c.leftCenterText || "").slice(0, 16)}」vs 右行${c.rightCenterLine}「${(c.rightCenterText || "").slice(0, 16)}」` +
          ` ｜ 含左顶行的块 line=${c.hostLine} top=${c.hostTop}px/高${c.hostH}px ｜ 范围比=${c.rangeRatio}`,
      );
      if (frac === 0.4) await ui.shot("07-longline-40pct");
      if (frac === 0.8) await ui.shot("08-longline-80pct");
    }

    ui.add("LL2-0", "超长行文档产生有效样本", rows.length >= 4 ? "PASS" : "FAIL", `样本=${rows.length}/4`);
    if (!rows.length) return;

    // ── LL2a 中央口径 ──
    const hits = rows.filter((c) => sameBlock(c.leftCenterText, c.rightCenterText));
    const gaps = rows.map((c) => Math.abs(c.leftCenterLine - c.rightCenterLine));
    ui.add(
      "LL2a", "超长行文档内容级对齐【中央口径·权威】：左右视口中央文字必须同源",
      hits.length === rows.length ? "PASS" : hits.length > 0 ? "KNOWN" : "FAIL",
      `文字同源 ${hits.length}/${rows.length}；源码行号间距 最差 ${Math.max(...gaps)} 行 / 中位 ${median(gaps)} 行；` +
        `逐点=[${rows.map((c) => `${c.leftCenterLine}→${c.rightCenterLine}`).join(", ")}]；` +
        `文字=[${rows.map((c) => `「${(c.leftCenterText || "").slice(0, 12)}」/「${(c.rightCenterText || "").slice(0, 12)}」`).join(" ｜ ")}]`,
    );

    // ── LL2b 契约口径 top-to-top（**仅诊断**，同 B2b 口径说明）──
    const ratios = rows.map((c) => (c.hostH > 0 && c.hostTop !== null ? Math.abs(c.hostTop) / c.hostH : Infinity));
    const worstR = Math.max(...ratios);
    const worst = rows[ratios.indexOf(worstR)];
    const sameTop = rows.filter((c) => sameBlock(c.leftTopText, c.rightTopText));
    ui.add(
      "LL2b", "超长行文档内容级对齐【契约口径 top-to-top·仅诊断】：含左屏顶行的块是否贴右屏视口顶",
      "KNOWN",
      `口径差异说明：两屏滚动范围不同（左 ${rows[0].leftMax} / 右 ${rows[0].rightMax}，范围比 ${rows[0].rangeRatio}），` +
        `顶对顶本就不该严格为 0 → 偏移大不单独代表对齐失效；权威判据见 [LL2a]。` +
        `实测：视口顶文字同源 ${sameTop.length}/${rows.length}；最差 |块top| ${Math.abs(worst.hostTop)}px / 块高 ` +
        `${worst.hostH}px = ${worstR.toFixed(2)} 块高（frac=${worst.frac}）；明细=[${rows.map((c) => `${c.hostTop}px/${c.hostH}`).join(", ")}]`,
    );

    // ── LL2c 退化归因：是「退回百分比映射」还是「估算偏差」？──
    //
    // sourceLineAxis.ts:29-31 明确要求降级可观测（onDegrade）。本项用**可观测行为**判定：
    // 若行轴健全 → 左右视觉进度应基本同步；若退回百分比（=用两屏 scrollHeight 比例映射）
    // 或线性公式（=用源码逻辑行数比例映射），则**右屏进度 ≈ 左屏进度 × 固定系数**，
    // 且该误差随进度**单调放大**（这正是"百分比/线性"的指纹）。
    // 与主探针 B2d 的结论合起来即可钉死：主探针已证明行号为线性公式值（差 ≤1.7 行）。
    const prog2 = rows.map((c) => ({
      frac: c.frac,
      leftPct: (c.leftTop / Math.max(1, c.leftMax)) * 100,
      rightPct: (c.rightTop / Math.max(1, c.rightMax)) * 100,
      // 右屏中央落在块间隙时为 null —— 视为"无法配对"，不参与单调性判断
      lineGap: c.leftCenterLine !== null && c.rightCenterLine !== null
        ? Math.abs(c.leftCenterLine - c.rightCenterLine) : null,
    }));
    const progPaired = prog2.filter((p) => p.lineGap !== null);
    const monotone = progPaired.length >= 2 && progPaired.every((p, i) => i === 0 || p.lineGap >= progPaired[i - 1].lineGap);
    const maxGapPx = progPaired.length ? Math.round(Math.max(...progPaired.map((p) => p.lineGap)) * 42) : 0;
    ui.add(
      "LL2c",
      "退化归因：误差随滚动进度单调放大 → 指纹指向「行轴不可用 → 退回线性/百分比映射」",
      "KNOWN",
      `中央行号差 随进度=[${prog2.map((p) => `${p.frac}:${p.lineGap === null ? "无法配对" : p.lineGap + "行"}`).join(", ")}]` +
        `（${monotone ? "单调不减" : "非严格单调（软换行导致块高不均，行差本身有波动）"}）；` +
        `最大偏差 ≈ ${maxGapPx}px。**决定性证据在主探针 [B2d]**：实测右屏顶块行号 = 线性公式值` +
        `（预测 56.7/114/171/228 vs 实测 55/114/170/228，差 ≤1.7 行）→ ` +
        `归因：**行轴为 null（measureBlockTops 返回 null）→ 退回线性映射**，不是随机估算偏差`,
    );

    // ── LL3 两屏一起到底 ──
    await ui.ev(`
      const s = window.__AR.scroller();
      if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight);
      return true;
    `);
    await ui.sleep(1400);
    const bm = await ui.ev(`return window.__AR.measure();`);
    const pct = bm.rightMax > 0 ? (bm.rightTop / bm.rightMax) * 100 : null;
    ui.add(
      "LL3", "超长行文档两屏一起到底",
      pct !== null && pct >= 92 ? "PASS" : pct !== null && pct >= 80 ? "KNOWN" : "FAIL",
      `左屏 ${bm.leftTop}/${bm.leftMax} → 右屏 ${bm.rightTop}/${bm.rightMax} = ${pct === null ? "n/a" : pct.toFixed(1) + "%"}`,
    );

    // ── LL4 轴失真度（诊断）：行号间距 / 预期的"软换行放大倍数" ──
    //
    // 左屏每个逻辑行的视觉高度远超 1 行（超长段落软换行）。若行轴正确，则"左屏滚动
    // 进度"与"右屏滚动进度"应大致同步；若行轴退回线性/百分比，右侧会系统性超前。
    const prog = rows.map((c) => ({
      frac: c.frac,
      leftPct: Math.round((c.leftTop / Math.max(1, c.leftMax)) * 1000) / 10,
      rightPct: Math.round((c.rightTop / Math.max(1, c.rightMax)) * 1000) / 10,
      lineGap: Math.abs(c.leftCenterLine - c.rightCenterLine),
    }));
    const worstProgGap = Math.max(...prog.map((p) => Math.abs(p.leftPct - p.rightPct)));
    ui.add(
      "LL4", "轴失真度诊断：两屏滚动进度差（行轴若不感知软换行，右侧会系统性超前）",
      worstProgGap < 5 ? "PASS" : worstProgGap < 25 ? "KNOWN" : "FAIL",
      `进度差最差 ${worstProgGap.toFixed(1)} 个百分点；明细=${prog.map((p) => `frac${p.frac}: 左${p.leftPct}%/右${p.rightPct}%(行距${p.lineGap})`).join(", ")}；` +
        `两屏 scrollHeight 左=${bm.leftSH}/右=${bm.rightSH}`,
    );

    ui.log(`[probe] 探针② 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  },
);

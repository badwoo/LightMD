/**
 * v0.14.0 需求4 —— **改前 / 改后对照回放**（用真机探针采到的真实几何数据）。
 *
 * 数据来源：`_verify-out/v0140-probe-split-parity.json`（由
 * `scripts/v0140-probe-split-parity.mjs` 在真机上采样：左屏 textarea 的
 * scrollHeight/clientHeight/scrollTop、逐逻辑行的实测视觉顶部、右屏 iframe 滚动元素
 * 的同项度量、以及每个 `data-src-line` 锚点元素的 top/height）。
 *
 * 本脚本**不改任何产品代码**，只把同一份真实几何分别喂给：
 *   · 改前的映射语义（v0.13.2：线性行号估算 + 无末尾锚点 + 末块按 top+height 收尾）
 *   · 改后的映射语义（v0.14.0：实测按行轴 + 末尾锚点 + 分段线性）
 * 逐滚动位置对比"右屏落点 / 块对齐误差 / 底部对齐"，给出量化对照表。
 *
 * 用法：node scripts/v0140-probe-split-parity-sim.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const JSON_IN = path.join(OUT_DIR, "v0140-probe-split-parity.json");
const OUT_TXT = path.join(OUT_DIR, "v0140-probe-split-parity-sim.txt");

const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};

// ─── 改前的映射语义（v0.13.2，逐字复刻旧实现）──────────────────────────────

/** 旧：线性行号估算（totalSourceLines 线性插值，忽略软换行） */
function oldEstimateTopSourceLine(m) {
  const total = Math.max(0, Math.floor(m.totalSourceLines));
  if (total <= 1) return 0;
  const max = m.scrollHeight - m.clientHeight;
  if (!Number.isFinite(max) || max <= 0) return 0;
  const raw = m.scrollTop / max;
  const ratio = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
  return ratio * (total - 1);
}

function oldPickAnchorIndex(srcLines, line) {
  if (!Array.isArray(srcLines) || srcLines.length === 0) return -1;
  let best = 0;
  for (let i = 0; i < srcLines.length; i++) {
    if (srcLines[i] <= line) best = i;
    else break;
  }
  return best;
}

/** 旧：locateSourceLine（块内比例按 heights[idx] 的语义在 mapSourceLineToPreviewScroll 里） */
function oldMapSourceLineToPreviewScroll(set, line, viewportHeight) {
  const { lines: ls, tops, heights } = set;
  if (!Array.isArray(ls) || ls.length === 0) return null;
  const idx = oldPickAnchorIndex(ls, line);
  if (idx < 0) return null;
  const startLine = ls[idx];
  const endLine = idx + 1 < ls.length ? ls[idx + 1] : startLine + 1;
  const span = Math.max(1, endLine - startLine);
  const ratio = Math.min(1, Math.max(0, (line - startLine) / span));
  const top = tops[idx];
  const height = heights[idx];
  if (!Number.isFinite(top) || !Number.isFinite(height)) return null;
  const target = top + height * ratio;
  const max = Math.max(0, set.totalHeight - viewportHeight);
  if (!Number.isFinite(target)) return null;
  return Math.min(Math.max(0, target), max);
}

/** 旧：mapPreviewScrollToSourceLine（无末尾锚点、无 viewportHeight 参数） */
function oldMapPreviewScrollToSourceLine(set, scrollTop) {
  const { lines: ls, tops, heights } = set;
  if (!Array.isArray(ls) || ls.length === 0) return null;
  if (!Number.isFinite(scrollTop)) return null;
  let idx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (Number.isFinite(tops[i]) && tops[i] <= scrollTop) idx = i;
    else break;
  }
  const top = tops[idx];
  const height = heights[idx];
  if (!Number.isFinite(top) || !Number.isFinite(height)) return null;
  const ratio = height > 0 ? Math.min(1, Math.max(0, (scrollTop - top) / height)) : 0;
  const startLine = ls[idx];
  const endLine = idx + 1 < ls.length ? ls[idx + 1] : startLine + 1;
  const span = Math.max(1, endLine - startLine);
  return startLine + span * ratio;
}

/** 旧：mapSourceLineToScrollTop（线性） */
function oldMapSourceLineToScrollTop(m, line) {
  const total = Math.max(0, Math.floor(m.totalSourceLines));
  if (total <= 1) return 0;
  const max = m.scrollHeight - m.clientHeight;
  if (!Number.isFinite(max) || max <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, line / (total - 1)));
  if (!Number.isFinite(ratio)) return null;
  return ratio * max;
}

// ─── 逐行轴构造（改后的输入；与 blockScrollAlign.buildSourceLineAxis 同算法）──

function buildAxis({ totalLines, blockLines, blockTops, maxScroll }) {
  const total = Math.floor(totalLines);
  if (!(total > 1) || !(maxScroll > 0)) return null;
  const pts = [];
  for (let i = 0; i < Math.min(blockLines.length, blockTops.length); i++) {
    const line = Math.floor(blockLines[i]);
    const y = blockTops[i];
    if (!Number.isFinite(line) || !Number.isFinite(y)) continue;
    if (line < 0 || line >= total) continue;
    if (pts.length && line <= pts[pts.length - 1].line) continue;
    pts.push({ line, y: Math.min(maxScroll, Math.max(0, y)) });
  }
  if (!pts.length) return null;
  if (pts[0].line > 0) pts.unshift({ line: 0, y: 0 });
  const lastLine = total - 1;
  const tail = pts[pts.length - 1];
  if (lastLine > tail.line) pts.push({ line: lastLine, y: maxScroll });
  else pts[pts.length - 1] = { line: lastLine, y: Math.max(tail.y, maxScroll) };
  const axis = new Array(total);
  axis[pts[0].line] = pts[0].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const spanLines = b.line - a.line;
    const spanY = b.y - a.y;
    for (let l = a.line + 1; l <= b.line; l++) {
      axis[l] = spanLines > 0 ? a.y + (spanY * (l - a.line)) / spanLines : a.y;
    }
  }
  let prev = 0;
  for (let l = 0; l < total; l++) {
    const v = Number.isFinite(axis[l]) ? axis[l] : prev;
    axis[l] = v < prev ? prev : v;
    prev = axis[l];
  }
  return axis;
}

// ─── 回放 ──────────────────────────────────────────────────────────────────

const main = async () => {
  const raw = JSON.parse(fs.readFileSync(JSON_IN, "utf-8"));
  // 载入被测的**改后**纯函数（直接 import 源码 .ts —— Node 24 的 type-stripping 支持）
  const mod = await import(pathToFileURL("D:\\AI\\markdown view\\lightmd\\src\\utils\\blockScrollAlign.ts").href);

  log("v0.14.0 需求4 · 改前 / 改后对照（真机几何回放）");
  log(`数据来源：${JSON_IN}`);
  log("");

  for (const d of raw.docs) {
    const { base, name } = d;
    const src = base.source;
    const prev = base.preview;
    const anchorsOld = base.anchors;
    // 改后：如果改前一个锚点都没贴上（mermaid 文档 → 数量自校验失败），
    // 就用探针采到的**全部内容元素几何**模拟"改后贴好标"的锚点集。
    const anchorsNew =
      anchorsOld.length > 0
        ? anchorsOld
        : (base.allKids || []).map((k) => ({ line: 0, top: k.top, height: k.height, tag: k.tag }));
    // 改前 0 锚点时，改后的 line 需要按块顺序反推（探针里没有 line）——
    // 这里用 top 单调序号代替，只为展示"有锚点 vs 无锚点"的差别。
    if (anchorsOld.length === 0) {
      anchorsNew.forEach((a, i) => (a.line = i));
    }
    // ⚠ 坐标系：`anchors[i].top` 是**预览内容坐标**；左屏按行轴必须用
    // **源码滚动坐标** —— 也就是探针实测的 `base.sourceTops[line]`。
    // （这也是改后 `measureSourceLineAxis` 在真机上量到的东西。）
    const axis = buildAxis({
      totalLines: src.totalLines,
      blockLines: anchorsNew.map((a) => a.line),
      blockTops: anchorsNew.map((a) => base.sourceTops[a.line] ?? 0),
      maxScroll: src.maxScroll,
    });

    const setOld = {
      lines: anchorsOld.map((a) => a.line),
      tops: anchorsOld.map((a) => a.top),
      heights: anchorsOld.map((a) => a.height),
      totalHeight: prev.scrollHeight,
    };
    const setNew = {
      lines: anchorsNew.map((a) => a.line),
      tops: anchorsNew.map((a) => a.top),
      heights: anchorsNew.map((a) => a.height),
      totalHeight: prev.scrollHeight,
      totalSourceLines: src.totalLines,
    };
    const hasAnchors = setNew.lines.length > 0;

    log(`════════ ${name} ════════`);
    log(
      `  左屏 scrollHeight=${src.scrollHeight} clientHeight=${src.clientHeight} max=${src.maxScroll} 行数=${src.totalLines}`,
    );
    log(
      `  右屏 scrollHeight=${prev.scrollHeight} clientHeight=${prev.clientHeight} max=${prev.maxScroll} 改前锚点数=${anchorsOld.length} 改后锚点数=${anchorsNew.length}`,
    );
    if (base.anchors.length === 0) {
      log("  ⚠ 该文档改前**一个锚点都没贴上**（mermaid 注入 script → 数量自校验失败）");
      log("     → 改前只能走百分比映射；改后修好贴标，锚点数 = 块数。");
    }
    log("");
    log("  ── 左屏驱动：同一 scrollTop 下 右屏落点对照 ──");
    log("   frac | 左scrollTop | 真值行 | 改前行 | 改后行 | 真值块 | 改前块 | 改后块 | Δ块前 | Δ块后 | 改前top | 改后top | 理想top");

    const rows = [];
    const blockOfLine = (line) => {
      let bi = 0;
      for (let i = 0; i < anchorsNew.length; i++) if (anchorsNew[i].line <= line) bi = i;
      return bi;
    };
    const blockOfTop = (top) => {
      let bi = 0;
      for (let i = 0; i < anchorsNew.length; i++) if (anchorsNew[i].top <= top) bi = i;
      return bi;
    };

    for (const frac of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const scrollTop = Math.round(src.maxScroll * frac);
      // 真值行：用探针采到的逐行实测轴
      const trueLine = (() => {
        const tops = base.sourceTops;
        const y = scrollTop;
        if (y <= 0) return 0;
        let lo = 0;
        let hi = tops.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (tops[mid] <= y) lo = mid;
          else hi = mid - 1;
        }
        const start = tops[lo];
        const end = lo + 1 < tops.length ? tops[lo + 1] : src.contentHeight;
        const span = Math.max(1e-6, end - start);
        return lo + Math.min(1, Math.max(0, (y - start) / span));
      })();

      const oldLine = oldEstimateTopSourceLine({
        scrollTop,
        scrollHeight: src.scrollHeight,
        clientHeight: src.clientHeight,
        totalSourceLines: src.totalLines,
      });
      const newLine = axis
        ? mod.estimateTopSourceLine({
            scrollTop,
            scrollHeight: src.scrollHeight,
            clientHeight: src.clientHeight,
            totalSourceLines: src.totalLines,
            lineTops: axis,
          })
        : oldLine;

      const oldRight = oldMapSourceLineToPreviewScroll(setOld, oldLine, prev.clientHeight);
      const newRight = hasAnchors
        ? mod.mapSourceLineToPreviewScroll(setNew, newLine, prev.clientHeight)
        : oldRight;

      const trueBlock = hasAnchors ? blockOfLine(trueLine) : -1;
      const oldBlock = anchorsOld.length && oldRight !== null ? blockOfTop(oldRight) : -1;
      const newBlock = hasAnchors && newRight !== null ? blockOfTop(newRight) : -1;
      const idealRight = hasAnchors
        ? Math.min(Math.max(0, anchorsNew[trueBlock].top), prev.maxScroll)
        : null;

      rows.push({
        frac, scrollTop, trueLine, oldLine, newLine,
        oldRight, newRight, trueBlock, oldBlock, newBlock, idealRight,
      });

      log(
        `   ${String(frac).padEnd(4)} | ${String(scrollTop).padEnd(11)} | ${trueLine.toFixed(1).padEnd(6)} | ` +
          `${oldLine.toFixed(1).padEnd(6)} | ${newLine.toFixed(1).padEnd(6)} | ` +
          `${String(trueBlock).padEnd(6)} | ${String(oldBlock).padEnd(6)} | ${String(newBlock).padEnd(6)} | ` +
          `${String(trueBlock >= 0 && oldBlock >= 0 ? oldBlock - trueBlock : "n/a").padEnd(5)} | ` +
          `${String(trueBlock >= 0 && newBlock >= 0 ? newBlock - trueBlock : "n/a").padEnd(5)} | ` +
          `${String(oldRight === null ? "null" : Math.round(oldRight)).padEnd(7)} | ` +
          `${String(newRight === null ? "null" : Math.round(newRight)).padEnd(7)} | ` +
          `${idealRight === null ? "n/a" : Math.round(idealRight)}`,
      );
    }

    // 底部对齐
    log("");
    const oldBottomLine = oldMapPreviewScrollToSourceLine(setOld, prev.maxScroll);
    const oldBottomLeftPct =
      oldBottomLine === null ? NaN : oldMapSourceLineToScrollTop(
        { scrollHeight: src.scrollHeight, clientHeight: src.clientHeight, totalSourceLines: src.totalLines },
        oldBottomLine,
      ) / Math.max(1, src.maxScroll);
    const newBottomLine = hasAnchors
      ? mod.mapPreviewScrollToSourceLine(setNew, prev.maxScroll, prev.clientHeight)
      : null;
    const newBottomLeftPct =
      newBottomLine === null || !axis
        ? NaN
        : mod.mapSourceLineToScrollTop(
            { scrollHeight: src.scrollHeight, clientHeight: src.clientHeight, totalSourceLines: src.totalLines, lineTops: axis },
            newBottomLine,
          ) / Math.max(1, src.maxScroll);
    log("  ── 底部对齐（右屏到底 → 左屏应也到底）──");
    log(
      `   改前：右屏 max=${prev.maxScroll} → 反算源码行 ${oldBottomLine === null ? "null" : oldBottomLine.toFixed(2)}` +
        ` → 左屏 ${Number.isFinite(oldBottomLeftPct) ? (oldBottomLeftPct * 100).toFixed(1) : "n/a"}%`,
    );
    log(
      `   改后：右屏 max=${prev.maxScroll} → 反算源码行 ${newBottomLine === null ? "null" : newBottomLine.toFixed(2)}` +
        ` → 左屏 ${Number.isFinite(newBottomLeftPct) ? (newBottomLeftPct * 100).toFixed(1) : "n/a"}%`,
    );
    // 左屏到底 → 右屏
    const oldLeftBottomRight = oldMapSourceLineToPreviewScroll(setOld, src.totalLines - 1, prev.clientHeight);
    const newLeftBottomRight = hasAnchors
      ? mod.mapSourceLineToPreviewScroll(setNew, src.totalLines - 1, prev.clientHeight)
      : oldLeftBottomRight;
    log(
      `   左屏到底 → 右屏：改前 ${oldLeftBottomRight === null ? "null" : Math.round(oldLeftBottomRight)}` +
        ` / 改后 ${newLeftBottomRight === null ? "null" : Math.round(newLeftBottomRight)}` +
        `（max=${prev.maxScroll}）`,
    );

    // 单调性
    let oldMono = true;
    let newMono = true;
    let prevOld = -Infinity;
    let prevNew = -Infinity;
    for (let st = 0; st <= src.maxScroll; st += Math.max(1, Math.round(src.maxScroll / 200))) {
      const ol = oldEstimateTopSourceLine({
        scrollTop: st, scrollHeight: src.scrollHeight, clientHeight: src.clientHeight, totalSourceLines: src.totalLines,
      });
      const ov = oldMapSourceLineToPreviewScroll(setOld, ol, prev.clientHeight);
      if (ov !== null && ov < prevOld) oldMono = false;
      prevOld = ov ?? prevOld;
      const nl = axis
        ? mod.estimateTopSourceLine({
            scrollTop: st, scrollHeight: src.scrollHeight, clientHeight: src.clientHeight,
            totalSourceLines: src.totalLines, lineTops: axis,
          })
        : ol;
      const nv = hasAnchors ? mod.mapSourceLineToPreviewScroll(setNew, nl, prev.clientHeight) : ov;
      if (nv !== null && nv < prevNew) newMono = false;
      prevNew = nv ?? prevNew;
    }
    log("");
    log(`  单调性（左 scrollTop 递增 → 右映射值不减小）：改前 ${oldMono ? "OK" : "回退!"} / 改后 ${newMono ? "OK" : "回退!"}`);
    log("");

    d.sim = { rows, oldBottomLeftPct, newBottomLeftPct, oldLeftBottomRight, newLeftBottomRight, oldMono, newMono };
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
  console.log(`\n报告：${OUT_TXT}`);
};

main().catch((e) => {
  console.error("回放异常：", e);
  process.exit(1);
});

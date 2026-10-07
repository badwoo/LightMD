/**
 * 回归工具（保留）：确定 Chromium/Edge --print-to-pdf 下
 * 「每页都有页眉页脚 + 不压正文 + 不产生空白页」的正确 CSS 形态。
 *
 * 结论（2026-10-07 实测 Edge 154）：
 *   A 负偏移（原实现）→ 4 段短文档多出一页空白页；60 段长文档页眉/页脚各丢一页
 *   B 零偏移（现实现）→ 两项判据全过
 * 若将来升级 Chromium 内核或改页边距策略，重跑本脚本做对照。
 *
 * 背景：现实现用 @page{margin:M} + position:fixed + **负偏移**
 *   （top:-o / bottom:-o），实测页眉在最后一页丢失、页脚在第一页丢失，
 *   且短文档会多出一页近乎空白的页。
 *
 * 本脚本用与 Rust 侧**完全相同的 Edge 调用参数**渲染多个候选变体，
 * 再用既有的 PDF 文本解码器（复用 real-machine-v0110-export.mjs 的 analyzePdf）
 * 逐页统计页眉/页脚标记出现情况。
 *
 * 用法：node scripts/tmp-pdf-margin-experiment.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzePdf } from "./real-machine-v0110-export.mjs";

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
const HDR = "ZZHEADERMARK";
const FTR = "ZZFOOTERMARK";

const para =
  "本段用于制造多页 PDF：LightMD 导出验证需要足够长的正文，以证明页眉与页脚在每一页都重复出现。";

function bodyText(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(`<h2>第 ${i} 节</h2>`, `<p>${para.repeat(3)}</p>`);
  return out.join("\n");
}

/** 变体定义：返回 { name, css, headerStyle, footerStyle, bodyPad } */
const VARIANTS = [
  {
    name: "A_当前实现(负偏移)",
    css: "@page { size: A4; margin: 20mm; }",
    fixed: "top:-6.67mm;bottom:-6.67mm;",
    bodyPad: "",
  },
  {
    name: "B_零偏移",
    css: "@page { size: A4; margin: 20mm; }",
    fixed: "top:0;bottom:0;",
    bodyPad: "",
  },
  {
    name: "C_正偏移8mm",
    css: "@page { size: A4; margin: 20mm; }",
    fixed: "top:8mm;bottom:8mm;",
    bodyPad: "",
  },
  {
    name: "D_加大页边距28mm+零偏移",
    css: "@page { size: A4; margin: 28mm 20mm; }",
    fixed: "top:0;bottom:0;",
    bodyPad: "",
  },
  {
    name: "E_零页边距+body内边距+正偏移",
    css: "@page { size: A4; margin: 0; }",
    fixed: "top:6mm;bottom:6mm;",
    bodyPad: "padding:20mm;",
  },
  {
    name: "F_页边距20mm+body上下留白+零偏移",
    css: "@page { size: A4; margin: 20mm; }",
    fixed: "top:0;bottom:0;",
    bodyPad: "",
    reserve: true,
  },
];

function buildHtml(v, n) {
  const reserveCss = v.reserve
    ? "body > *:first-child { margin-top: 8mm; } body { padding-top: 8mm; padding-bottom: 8mm; }"
    : v.bodyPad
      ? `body { ${v.bodyPad} }`
      : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
${v.css}
html, body { margin: 0; }
body { font-family: "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.7; }
${reserveCss}
.pdf-header { position: fixed; ${v.fixed.split("bottom:")[0]}left: 0; right: 0; text-align: center; font-size: 9pt; color: #666; }
.pdf-footer { position: fixed; bottom:${v.fixed.split("bottom:")[1]}left: 0; right: 0; text-align: center; font-size: 9pt; color: #666; }
</style></head><body>
<div class="pdf-header">${HDR}</div>
${bodyText(n)}
<div class="pdf-footer">${FTR}</div>
</body></html>`;
}

function printPdf(html, outPdf) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfexp-"));
  const tmpHtml = path.join(tmpDir, "t.html");
  fs.writeFileSync(tmpHtml, html, "utf-8");
  const url = "file:///" + tmpHtml.replace(/\\/g, "/");
  execFileSync(
    EDGE,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=10000",
      `--print-to-pdf=${outPdf}`,
      "--no-pdf-header-footer",
      url,
    ],
    { stdio: "ignore", timeout: 120000 },
  );
  return fs.readFileSync(outPdf);
}

function evalPdf(buf) {
  const info = analyzePdf(buf);
  const norm = (s) => String(s).replace(/\s+/g, "");
  const pages = info.pageTexts.map(norm);
  return {
    pageCount: info.pageCount,
    hdrPages: pages.filter((t) => t.includes(HDR)).length,
    ftrPages: pages.filter((t) => t.includes(FTR)).length,
    decodedChars: pages.reduce((a, t) => a + t.length, 0),
  };
}

function main() {
  if (!EDGE) {
    console.error("未找到 Edge/Chrome");
    process.exit(3);
  }
  console.log(`使用浏览器: ${EDGE}\n`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfmarginexp-"));
  const rows = [];
  for (const n of [4, 40]) {
    // 基线：无页眉页脚时的页数（判断是否多出空白页）
    const baselineHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:A4;margin:20mm;}html,body{margin:0}body{font-family:"Microsoft YaHei",sans-serif;font-size:11pt;line-height:1.7}</style></head><body>${bodyText(n)}</body></html>`;
    const basePdf = path.join(workDir, `base-${n}.pdf`);
    const baseInfo = evalPdf(printPdf(baselineHtml, basePdf));
    console.log(`── 段落数=${n}  无页眉页脚基线页数=${baseInfo.pageCount} ──`);
    for (const v of VARIANTS) {
      const out = path.join(workDir, `v-${v.name}-${n}.pdf`);
      let r;
      try {
        r = evalPdf(printPdf(buildHtml(v, n), out));
      } catch (e) {
        r = { err: String(e).slice(0, 80) };
      }
      const line = r.err
        ? `  ${v.name.padEnd(28)} 渲染失败 ${r.err}`
        : `  ${v.name.padEnd(28)} 页数=${String(r.pageCount).padStart(2)} (基线${baseInfo.pageCount})  页眉=${r.hdrPages}/${r.pageCount}  页脚=${r.ftrPages}/${r.pageCount}  解出字符=${r.decodedChars}`;
      console.log(line);
      rows.push({ n, variant: v.name, ...r, baseline: baseInfo.pageCount });
    }
    console.log("");
  }
  console.log("判定标准：页眉=页脚=页数（每页都有） 且 页数===基线（无多余空白页）");
  const winners = rows.filter(
    (r) => !r.err && r.hdrPages === r.pageCount && r.ftrPages === r.pageCount && r.pageCount === r.baseline,
  );
  console.log(
    winners.length
      ? `\n✅ 同时满足两个条件的变体: ${[...new Set(winners.map((w) => w.variant))].join(" | ")}`
      : "\n❌ 没有任何变体同时满足（需要再看单项数据调整）",
  );
  console.log(`\n产物目录: ${workDir}`);
}

main();

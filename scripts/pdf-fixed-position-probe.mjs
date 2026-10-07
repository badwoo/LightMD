/**
 * 回归工具（保留）：判定 Chromium --print-to-pdf 下 `position:fixed` 的
 * 定位基准是**页面盒（含页边距）**还是**内容盒（页边距以内）**。
 *
 * 结论（2026-10-07 实测 Edge 154）：首个文本 Y 在两个页边距下完全相同（差 0.0pt）
 * ⇒ **页面盒基准**，故 `top:0` / `bottom:0` 落在页边距区内、不会压正文，
 * 零偏移方案安全（这正是 pdfExport.ts 返修的依据）。若将来升级 Chromium 内核，
 * 重跑本脚本即可确认该前提是否仍成立。
 *
 * 判据：同一 header 在 `@page{margin:20mm}` 与 `@page{margin:40mm}` 下的
 * 首个文本基线 Y 坐标（PDF 坐标，原点左下、单位 pt）：
 *   - 基准=页面盒 → header 贴物理页顶，两个 margin 下 Y 几乎相同（差 ≈ 0）
 *   - 基准=内容盒 → header 落在内容顶，Y 随 margin 下移（差 ≈ 20mm ≈ 56.7pt）
 * 若为页面盒 → `top:0` 落在页边距区内，不会压正文，零偏移方案安全。
 *
 * 用法：node scripts/tmp-pdf-offset-probe.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePdfObjects } from "./real-machine-v0110-export.mjs";

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

const HDR = "HDRPOSMARK";
const FTR = "FTRPOSMARK";
const para = "本段用于制造多页 PDF 并测量页眉的纵向位置，需要足够长以产生多页内容。";

function body(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(`<p>${para.repeat(4)}</p>`);
  return out.join("\n");
}

function html(margin) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@page { size: A4; margin: ${margin}; }
html, body { margin: 0; }
body { font-family: "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.7; }
.pdf-header { position: fixed; top: 0; left: 0; right: 0; text-align: center; font-size: 9pt; color: #666; }
.pdf-footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 9pt; color: #666; }
</style></head><body>
<div class="pdf-header">${HDR}</div>
${body(60)}
<div class="pdf-footer">${FTR}</div>
</body></html>`;
}

function run(margin, out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfpos-"));
  const h = path.join(dir, "t.html");
  fs.writeFileSync(h, html(margin), "utf-8");
  execFileSync(
    EDGE,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=10000",
      `--print-to-pdf=${out}`,
      "--no-pdf-header-footer",
      "file:///" + h.replace(/\\/g, "/"),
    ],
    { stdio: "ignore", timeout: 120000 },
  );
  return fs.readFileSync(out);
}

/** 取前 N 个文本定位 Y 坐标（Tm 的 f 分量） */
function firstTextYs(buf, pageIndex = 0, take = 4) {
  const objs = parsePdfObjects(buf);
  const pageNums = [];
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Page(?![sA-Za-z])/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)) pageNums.push(num);
  }
  const num = pageNums[pageIndex];
  if (num === undefined) return { error: "no-page", pageCount: pageNums.length };
  const o = objs.get(num);
  const refs = [];
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(o.dict);
  if (single) refs.push(Number(single[1]));
  else {
    const arr = /\/Contents\s*\[([^\]]*)\]/.exec(o.dict);
    if (arr) for (const r of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(r[1]));
  }
  const content = refs.map((r) => (objs.get(r) || {}).text || "").join("\n");
  const ys = [];
  // `a b c d e f Tm` → e=x, f=y
  for (const m of content.matchAll(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g)) {
    ys.push(Number(m[6]));
  }
  return { pageCount: pageNums.length, firstYs: ys.slice(0, take), lastYs: ys.slice(-take), total: ys.length };
}

function main() {
  if (!EDGE) {
    console.error("未找到 Edge");
    process.exit(3);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfpos-out-"));
  const a = run("20mm", path.join(dir, "m20.pdf"));
  const b = run("40mm", path.join(dir, "m40.pdf"));
  const ra = firstTextYs(a, 0);
  const rb = firstTextYs(b, 0);
  console.log("A4 高 = 842pt；20mm = 56.69pt\n");
  console.log(`margin=20mm 第1页 前4个文本Y: ${JSON.stringify(ra.firstYs)}  (总Tm数=${ra.total}, 页数=${ra.pageCount})`);
  console.log(`margin=40mm 第1页 前4个文本Y: ${JSON.stringify(rb.firstYs)}  (总Tm数=${rb.total}, 页数=${rb.pageCount})`);
  const da = ra.firstYs?.[0];
  const db = rb.firstYs?.[0];
  if (typeof da === "number" && typeof db === "number") {
    const shift = da - db;
    console.log(`\n首个文本 Y 差 = ${shift.toFixed(1)}pt`);
    console.log(
      Math.abs(shift) < 15
        ? "⇒ 判定：**页面盒基准**（fixed 元素贴物理页顶，落在页边距区内）→ 零偏移安全，不压正文"
        : "⇒ 判定：**内容盒基准**（fixed 随 @page margin 下移）→ top:0 会压正文首行，需另想办法",
    );
  }
  console.log(`\n产物目录: ${dir}`);
}

main();

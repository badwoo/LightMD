/**
 * v0.17.0 第四轮 T6（task-11）：mask 标记撞名缺陷的**纯函数层**证据探针
 *
 * ## 为什么这个探针不启动浏览器
 * 缺陷完全在纯函数层（`maskBase64Images` / `unmaskBase64Images`），
 * 不需要 DOM/React/CM6。本轮另有 4 个成员在构建 `dist/`，
 * 起浏览器既慢又可能读到别人的半成品 —— 直接在 Node 里 import 模块测最干净。
 *
 * ## 探针要证明的三件事
 * 1. **缺陷真实存在**（回退修复时变红）
 * 2. **修复后真实引用逐字节不变**（正向）
 * 3. **mask 标记仍能正确还原**（反向，防止为修复而废掉功能）
 *
 * 用法：`node scripts/v0170-r4-mask.mjs`
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const FIXTURE = path.join(ROOT, "_verify-out", "t3-fixtures", "md测试.md");

// 用 vite 的 SSR 能力加载 TS 模块（项目没有 ts-node；vite 已是依赖）
const { createServer } = await import("vite");
const server = await createServer({
  root: ROOT,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
const mod = await server.ssrLoadModule("/src/utils/base64ImageMask.ts");
const { maskBase64Images, unmaskBase64Images, hasRawBase64Image, countBase64Markers } = mod;

const results = [];
const add = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS " : "FAIL "} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
};

const makeDataUrl = (len = 600, mime = "image/png") =>
  `data:${mime};base64,${"A".repeat(len)}`;

/* ── 1. 缺陷复现：共存场景 ───────────────────────────────── */
{
  const tokens = new Map();
  const b64 = makeDataUrl(600);
  const doc = `# 标题\n\n![内联](${b64})\n\n![真实](image-1.png)\n\n正文\n`;
  const { text: masked } = maskBase64Images(doc, tokens);
  const restored = unmaskBase64Images(masked, tokens);
  const realIntact = restored.includes("![真实](image-1.png)");
  add("1", "真实裸文件名引用 image-1.png 不被吞成 base64", realIntact,
    realIntact ? "引用逐字节保留" : `被吞成 ${restored.match(/!\[真实\]\((.{0,30})/)?.[1]}…`);
  add("2", "严格往返 restored === doc", restored === doc, `len ${restored.length} vs ${doc.length}`);
}

/* ── 2. 反向：mask 标记仍能还原 ─────────────────────────── */
{
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp", "image/x-icon"]) {
    const tokens = new Map();
    const url = makeDataUrl(600, mime);
    const original = `![图](${url})`;
    const { text: masked } = maskBase64Images(original, tokens);
    const ok = unmaskBase64Images(masked, tokens) === original && !hasRawBase64Image(masked);
    add("3", `反向还原 ${mime}`, ok, `masked=${masked}（短标记）`);
  }
}

/* ── 3. 幂等 ─────────────────────────────────────────────── */
{
  const tokens = new Map();
  const original = `![a](${makeDataUrl(600)})\n\n![b](${makeDataUrl(601)})`;
  const once = maskBase64Images(original, tokens).text;
  const back = unmaskBase64Images(once, tokens);
  const twice = maskBase64Images(back, tokens).text;
  add("4", "幂等：mask→unmask→mask 后标记不变", back === original && twice === once,
    `tokens=${[...tokens.keys()].join(",")}`);
}

/* ── 4. 真实 4MB fixture ─────────────────────────────────── */
if (existsSync(FIXTURE)) {
  const real = readFileSync(FIXTURE, "utf8");
  const tokens = new Map();
  const t0 = Date.now();
  const { text: masked, replacements } = maskBase64Images(real, tokens);
  const maskMs = Date.now() - t0;
  const t1 = Date.now();
  const restored = unmaskBase64Images(masked, tokens);
  const unmaskMs = Date.now() - t1;
  add("5", "真实 fixture：mask 后无裸 base64、长度回落到短标记量级",
    !hasRawBase64Image(masked) && masked.length < 1000,
    `${real.length} → ${masked.length} 字符，${replacements.length} 处替换，${maskMs}ms`);
  add("6", "真实 fixture：unmask 严格逐字节往返",
    restored === real && Buffer.byteLength(restored, "utf8") === 4182172,
    `${Buffer.byteLength(restored, "utf8")} 字节，unmask ${unmaskMs}ms，tokens=${tokens.size}`);

  // 在真实文档末尾追加裸文件名真实引用 —— 这正是用户会遇到的形态
  const withReal = `${real}\n\n![真实图](image-1.png)\n\n![真实图2](image-2.png)\n`;
  const t2 = new Map();
  const { text: m2 } = maskBase64Images(withReal, t2);
  const r2 = unmaskBase64Images(m2, t2);
  add("7", "真实 fixture + 裸文件名真实引用：严格往返",
    r2 === withReal && r2.endsWith("![真实图2](image-2.png)\n"),
    `尾部 = ${JSON.stringify(r2.slice(-40))}`);

  // 数据安全：fixture 只读
  const after = readFileSync(FIXTURE);
  add("8", "数据安全：fixture 文件未被修改（字节数）",
    after.length === 4182172, `${after.length} 字节`);
} else {
  add("5", "真实 fixture 存在", false, `缺少 ${FIXTURE}`);
}

/* ── 5. 标记形态自证 ────────────────────────────────────── */
{
  const tokens = new Map();
  const { text } = maskBase64Images(`![](${makeDataUrl(600)})`, tokens);
  const marker = [...tokens.keys()][0];
  add("9", "标记命名与真实文件名解耦（前缀非 image-）",
    !marker.startsWith("image-"), `marker = ${marker}（text = ${text}）`);
  const counts = countBase64Markers(text);
  add("10", "countBase64Markers 与 tokens 口径同源",
    counts.size === 1 && tokens.has([...counts.keys()][0]),
    `counts = ${JSON.stringify([...counts])}`);
}

await server.close();

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n[probe] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;

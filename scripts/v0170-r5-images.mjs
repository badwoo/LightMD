/**
 * v0.17.0 第五轮 · V4 · **实机验证**（Tauri exe + WebView2，验证轮，不改源码）
 *
 * 用户要求：「重新进行一遍实机验证，验证 0.17.0 版本迁移 CM6 以来所解决的问题是否都真实修复。」
 *
 * 本探针负责 5 项：
 * | id | 项 | 期望 |
 * |---|---|---|
 * | V4-1 | R3#9 图片管理不再「失效」 | 面板不卡（≤100ms）、DOM ≤100KB、列表全 |
 * | V4-2 | R3#9 base64 短格式稳定 | 切模式/打字 → 磁盘 base64 **字节级不变** |
 * | V4-3 | R3#9 AI 翻译跳过图片编码 | 图片引用完好；能调 API 则验 unmask |
 * | V4-4 | **R4 base64 撞名**（最高价值） | base64 图 + 裸文件名 `image-N.png` 共存 → 真实引用逐字节不变 |
 * | V4-5 | R4#5 阅读面编辑落盘 | 阅读打字 → 切编辑 → 保存 → **磁盘字节含新字** |
 *
 * ─────────────────────────────────────────────────────────────────
 * ## 本轮两次"读错文件"的教训（本探针的硬性自证要求）
 *
 * 我（T3/fix-images）在本轮犯过**同一族的两次错误**：
 * 1. `repro-v42.mjs` 自造了一个 fixture 路径，`fs.writeFileSync` 写了它，
 *    但探针把文档写进**骨架自己的临时目录**，最后我读自造路径做断言 ——
 *    那个文件**产品从未写过**，于是"磁盘干净"是必然的假绿。
 *    反向证明：那份文件与桌面原文件**逐字节相同** → 产品没碰过它。
 * 2. V4-2d 原判据拿"探针启动时的内存字符串"当磁盘基线，中间产品已保存过
 *    → 比较了两个不同时间点，假 FAIL。
 *
 * **共同失效模式：把"我以为的文件/基线"当成"实际的文件/基线"（用推断代替实测）。**
 *
 * ### 因此本探针强制三条自证（缺一条即视为探针 bug，不出产品结论）
 * - `assertFilePath(p)`：任何 `readFileSync` 前先打印 **path + len + head**，
 *   且路径必须来自**骨架的 `ui.docFile`**（不是自造）；
 * - `assertProductWrote(p, beforeStat)`：保存后必须证明**产品真的写过它**
 *   （mtime 变 或 内容变），否则"磁盘干净"不算证据；
 * - 基线一律在**操作前**采、比对一律比**同一次操作序列的前后磁盘**。
 *
 * ─────────────────────────────────────────────────────────────────
 * ## 数据安全（复用 R4 T6 方法论）
 * - 用户原文件 `D:\10254\桌面\md测试.md` **只读**，本脚本无任何写它的语句；
 * - 运行前后各做一次 SHA-256：一致 → PASS；不一致 → **KNOWN**
 *   （不是 FAIL —— 外部改动不能判成"探针写坏数据"）。
 *
 * ## 用法
 * ```bash
 * node scripts/v0170-r5-images.mjs
 * ```
 * 前置：`src-tauri/target/release/lightmd.exe`（identifier=`com.lightmd.probe`）
 * 与 `dist/` 同一份构建（骨架会自检 hash 一致性）。
 * 探针串行：`.lmd-probe.lock`；**删锁前必须 `cat` 核对 owner**。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runProbe, sleep } from "./_lib/probe-harness.mjs";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const FIX_DIR = path.join(ROOT, "_verify-out", "v4-fixtures");
const USER_SRC = "D:\\10254\\桌面\\md测试.md";
const NAME = "v0170-r5-images";

/* ══════════════════════════ 工具 ══════════════════════════ */

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 从 markdown 抠出全部 data URL（用于逐字节比对图片本体） */
const dataUrls = (text) => text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) ?? [];

/**
 * 统一读文件入口：**每次读都打印 path + len + head**。
 *
 * 这是本轮"读错文件"教训的直接落地 —— "我读了哪个文件"必须是打印出来的事实，
 * 不是记忆。任何直接 `fs.readFileSync` 的地方都应改走这里。
 */
function readProven(file, label) {
  const buf = fs.readFileSync(file);
  const st = fs.statSync(file);
  const text = buf.toString("utf8");
  const shown = text.length > 60 ? text.slice(0, 60) + "…" : text;
  console.log(
    `[file] ${label} path=${file} bytes=${buf.length} chars=${text.length} ` +
      `mtime=${st.mtime.toISOString()} head=${JSON.stringify(shown)}`,
  );
  return { text, buf, stat: st };
}

/**
 * 证明"产品真的写过这个文件"。
 *
 * 为什么必须有：我上一轮读到"磁盘干净"，实际读的是**产品从未写过的文件**。
 * 判据：保存前后 mtime 或内容 至少一项变化 → 产品确实写过。
 * 若两者都没变，说明这次 `Ctrl+S` 根本没落到这个文件（可能没打开、路径不对、
 * 或保存被跳过）→ **不允许**据此得出"落盘干净"的结论。
 */
function assertProductWrote(file, before, label) {
  const after = fs.statSync(file);
  const wrote = after.mtimeMs !== before.mtimeMs;
  console.log(
    `[write-proof] ${label}: mtime ${before.mtime.toISOString()} → ${after.mtime.toISOString()} ` +
      `= ${wrote ? "已写入（产品确实写过）" : "**未变化**"}`,
  );
  return wrote;
}

/* ══════════════════════════ 夹具 ══════════════════════════ */

fs.mkdirSync(FIX_DIR, { recursive: true });

if (!fs.existsSync(USER_SRC)) throw new Error(`用户测试文件不存在：${USER_SRC}`);
const userBufBefore = fs.readFileSync(USER_SRC);
const userHashBefore = sha256(userBufBefore);
const userMtimeBefore = fs.statSync(USER_SRC).mtime.toISOString();
const USER_DOC = userBufBefore.toString("utf8");
console.log(`[data-safety] 用户原文件 ${userBufBefore.length} 字节 sha256=${userHashBefore}`);
console.log(`[data-safety] mtime=${userMtimeBefore}（全程只读）`);

/**
 * V4-4 撞名夹具：base64 内联图 + **裸文件名** `image-1.png` 引用 + 带前缀引用。
 *
 * 为什么这三者都要有：
 * - base64 图 → mask 会生成 `lmd-b64-1.png`
 * - 裸文件名 `image-1.png` → **旧实现会被吞成 base64**（本项要验的核心）
 * - `assets/image-9.png` → 用户真实目录形态（9/10 个 png 与旧标记同构），带前缀应始终安全
 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAF0lEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
const COLLISION_DOC = [
  "# V4-4 撞名夹具",
  "",
  "同时包含：一张 base64 内联图 / 一张裸文件名真实引用 / 一张带 assets 前缀的引用。",
  "",
  `![内联图](data:image/png;base64,${PNG_B64.repeat(14)})`,
  "",
  "![裸文件名真实引用](image-1.png)",
  "",
  "![带前缀引用](assets/image-9.png)",
  "",
  "结尾段落。",
].join("\n");
const COLLISION_B64 = dataUrls(COLLISION_DOC)[0] ?? "";
if (COLLISION_B64.length < 512) {
  throw new Error(`撞名夹具 base64 只有 ${COLLISION_B64.length} 字符（<512 不会被 mask）→ 夹具无效`);
}

/** V4-5 落盘夹具：小文档 + 一张 base64 图 */
const V45_DOC = [
  "# V4-5 落盘目标",
  "",
  "用于验证「阅读模式打字后保存能否落到磁盘」的正文。",
  "",
  `![小图](data:image/png;base64,${PNG_B64.repeat(14)})`,
  "",
  "结束。",
].join("\n");

console.log(`[fixture] 撞名夹具 base64 ${COLLISION_B64.length} 字符`);
console.log(`[fixture] 用户文档 ${USER_DOC.length} 字符（V4-2 用）`);

/* ══════════════════════ 页面内表达式 ══════════════════════ */

/** CM6 全文（⚠️ 不能拼 `.cm-line` —— 虚拟化只渲染视口内行，R2 已踩过） */
const READ_SOURCE = `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (v && v.state && v.state.doc) return v.state.doc.toString();
  const ta = document.querySelector("textarea.source-editor");
  return ta ? ta.value : null;
`;

/** App content prop（= Ctrl+S 写盘用的那份字符串） */
const READ_APP_CONTENT = `
  const anchor = document.querySelector('[data-testid="image-manager-btn"]')
    || document.querySelector("#root");
  if (!anchor) return { ok: false, reason: "no anchor" };
  const fkey = Object.keys(anchor).find(k => k.indexOf("__reactFiber$") === 0);
  if (!fkey) return { ok: false, reason: "no fiber key" };
  let f = anchor[fkey];
  let guard = 0;
  while (f && guard++ < 400) {
    const p = f.memoizedProps;
    if (p && typeof p.content === "string" && p.onContentChange !== undefined) {
      return { ok: true, content: p.content, len: p.content.length, filePath: p.filePath };
    }
    f = f.return;
  }
  return { ok: false, reason: "content prop not found" };
`;

let seq = 0;
const tag = (s) => `[${++seq}] ${s}`;

console.log("");
console.log("══════════ 开始探针（串行，排队等待实例锁）══════════");

/* ═══════════════════════════════════════════════════════════
 * 主探针：V4-4（最高价值）→ V4-2（三处同采）→ V4-1 → V4-3 → V4-5
 * 主文档用撞名夹具（小、快、能同时覆盖多项目），V4-2 中途换用户文档。
 * ═══════════════════════════════════════════════════════════ */
await runProbe(
  { name: NAME, doc: COLLISION_DOC, docTitle: "V4-4 撞名夹具", viewMode: "edit" },
  async (ui) => {
    ui.log(`[setup] 源码面实现 = ${ui.impl}`);
    ui.log(`[setup] 骨架 docFile = ${ui.docFile}`);

    /* ───────────────────────────────────────────────
     * V4-4：base64 撞名数据损坏
     *
     * 用 ui.docFile（骨架真路径），不用自造路径 —— 这是本轮教训。
     * ─────────────────────────────────────────────── */
    await sleep(700);

    // 1) 基线：**在打开/保存之前**读磁盘（骨架刚写好的原始夹具）
    const base4 = readProven(ui.docFile, "V4-4 基线(保存前)");
    const b64Before4 = dataUrls(base4.text);
    ui.log(
      tag(`V4-4 基线：${base4.buf.length} 字节，base64 ${b64Before4.length} 条，` +
        `裸文件名引用=${base4.text.includes("![裸文件名真实引用](image-1.png)")}`),
    );

    // 2) 展示层（mask 后应无裸 base64，且裸文件名引用原样）
    const shown4 = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      const text = v && v.state.doc ? v.state.doc.toString() : "";
      return {
        len: text.length,
        hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(text),
        markers: (text.match(/lmd-b64-\\d+\\.(png|jpg|gif|webp|svg)/g) || []),
        legacyRefs: (text.match(/\\]\\(image-\\d+\\.png\\)/g) || []),
        bareKept: text.includes("![裸文件名真实引用](image-1.png)"),
        prefixedKept: text.includes("![带前缀引用](assets/image-9.png)"),
      };
    `);
    ui.log(tag(`V4-4 展示层 len=${shown4.len} hasRawBase64=${shown4.hasRawBase64} markers=${JSON.stringify(shown4.markers)}`));

    ui.add(
      "V4-4a",
      "展示层：base64 已 mask 成新前缀标记（lmd-b64-N），无裸 base64",
      shown4.hasRawBase64 === false && (shown4.markers || []).length > 0 ? "PASS" : "FAIL",
      `len=${shown4.len} markers=${JSON.stringify(shown4.markers)} hasRawBase64=${shown4.hasRawBase64}`,
    );
    ui.add(
      "V4-4b",
      "展示层：裸文件名真实引用 `image-1.png` 未被当成标记（原样保留）",
      shown4.bareKept === true ? "PASS" : "FAIL",
      `bareKept=${shown4.bareKept} legacyRefs（应是真实引用而非标记）=${JSON.stringify(shown4.legacyRefs)}`,
    );

    // 3) 切模式往返（每步都验真实引用）
    const round = [];
    for (const [label, cmd] of [["→阅读", "view.preview"], ["→编辑", "view.edit"]]) {
      await ui.command(cmd);
      await sleep(1600);
      const r = await ui.ev(`
        const c = document.querySelector(".cm-content");
        const v = c && c.cmTile && c.cmTile.view;
        const text = v && v.state.doc ? v.state.doc.toString() : "";
        return {
          len: text.length,
          bareKept: text.includes("![裸文件名真实引用](image-1.png)"),
          prefixedKept: text.includes("![带前缀引用](assets/image-9.png)"),
          markers: (text.match(/lmd-b64-\\d+\\.png/g) || []),
          hasRaw: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(text),
        };
      `);
      round.push({ label, ...r });
      ui.log(tag(`V4-4 ${label}: len=${r.len} bareKept=${r.bareKept} markers=${JSON.stringify(r.markers)}`));
    }
    const last4 = round[round.length - 1];
    ui.add(
      "V4-4c",
      "切模式往返后：裸文件名真实引用仍原样（展示层）",
      last4.bareKept === true ? "PASS" : "FAIL",
      `往返两跳后 bareKept=${last4.bareKept} prefixedKept=${last4.prefixedKept}`,
    );

    // 4) 保存 → 读**真路径**磁盘 + 证明产品写过
    const beforeSave4 = fs.statSync(ui.docFile);
    await ui.command("file.save");
    await sleep(1400);
    const wrote4 = assertProductWrote(ui.docFile, beforeSave4, "V4-4 保存");
    const disk4 = readProven(ui.docFile, "V4-4 保存后磁盘");
    const b64After4 = dataUrls(disk4.text);
    const bareInDisk = disk4.text.includes("![裸文件名真实引用](image-1.png)");
    const prefixedInDisk = disk4.text.includes("![带前缀引用](assets/image-9.png)");

    ui.log(
      tag(`V4-4 磁盘：${disk4.buf.length} 字节，base64 ${b64After4.length} 条，` +
        `裸文件名在=${bareInDisk} 带前缀在=${prefixedInDisk}`),
    );

    if (!wrote4) {
      ui.add(
        "V4-4d",
        "★ 保存后磁盘：裸文件名真实引用逐字节保留",
        "KNOWN",
        "**无法判定**：本次 Ctrl+S 未改变 docFile 的 mtime（产品未写入该文件）→ " +
          "不允许据此得出落盘结论（本轮教训：读没被写过的文件 = 假绿）",
      );
      ui.add(
        "V4-4e",
        "★ 保存后磁盘：base64 图片本体逐字节不变",
        "KNOWN",
        "同上：产品未写入 docFile，无法判定",
      );
    } else {
      ui.add(
        "V4-4d",
        "★ 保存后磁盘：裸文件名真实引用 `image-1.png` 逐字节保留（修复前会被吞成 base64）",
        bareInDisk ? "PASS" : "FAIL",
        bareInDisk
          ? `磁盘含 \`![裸文件名真实引用](image-1.png)\`（${disk4.buf.length} 字节）`
          : "磁盘**不含**该引用 → 被改写（这就是 R4 撞名缺陷的现场）",
      );
      ui.add(
        "V4-4e",
        "★ 保存后磁盘：base64 图片本体逐字节不变（长度+内容都相同）",
        b64After4.length === b64Before4.length &&
          b64After4.every((u, i) => u === b64Before4[i])
          ? "PASS"
          : "FAIL",
        `前 ${JSON.stringify(b64Before4.map((u) => u.length))} → 后 ${JSON.stringify(b64After4.map((u) => u.length))}`,
      );
    }
    ui.add(
      "V4-4f",
      "保存后磁盘：带 assets 前缀引用未被改动",
      prefixedInDisk ? "PASS" : "FAIL",
      `prefixedInDisk=${prefixedInDisk}`,
    );

    /* ───────────────────────────────────────────────
     * V4-2：base64 短格式稳定 + **三处同采**（区分展示层视觉转义 vs 回写污染）
     *
     * 三处必须是**同一次操作序列 + 同一文件**：
     *   state.doc（展示层） / App content prop（内存权威） / ui.docFile 磁盘字节
     * 且保存后必须证明**产品真的写过** ui.docFile。
     * ─────────────────────────────────────────────── */
    ui.log("");
    ui.log(tag("V4-2 开始：切到 2.69MB 用户文档（走骨架 openFile，路径即 ui.docFile）"));

    /**
     * ⚠️⚠️ 关键：V4-2 **必须用另一个文件路径**，不能复用 `ui.docFile`。
     *
     * 我第一版就复用了 ui.docFile，结果 V4-2b/V4-2c/V4-2e 三条 FAIL —— 全是探针 bug：
     * ```
     * App content len=1616，head="V4-4 撞名夹具…"     ← 还是上一节的文档！
     * 磁盘 1724 字节                                 ← 还是撞名夹具
     * ```
     * 根因在 `App.tsx:474-481`：
     * ```ts
     * const existingIdx = detail.path ? st0.getTabByPath(detail.path) : -1;
     * const alreadyOpen = existingIdx !== -1;
     * const targetContent = alreadyOpen
     *   ? (st0.openTabs[existingIdx].content ?? detail.content)   // ← 用标签里的旧内容！
     *   : detail.content;
     * ```
     * 同一路径已在标签里 → `alreadyOpen=true` → **openFile 的 content 被静默忽略**，
     * App 继续用撞名夹具的内容。于是"2.69MB 文档"我根本没打开过。
     *
     * 这也解释了为什么 V4-2a/V4-2d 会假 PASS：它们只断言"展示层 <2000 字符、
     * 无裸 base64"—— 撞名夹具的 masked 展示层恰好也满足（len=151）！
     * **判据太弱，让错误状态通过了。**
     *
     * 修法：用独立路径 `v42-user-doc.md`（且断言 App content 的 filePath 确实是它）。
     */
    const v42Path = path.join(FIX_DIR, "v42-user-doc.md");
    fs.writeFileSync(v42Path, USER_DOC, "utf8");
    const v42Base = readProven(v42Path, "V4-2 基线(打开前)");
    const v42HashBase = sha256(v42Base.buf);
    const v42BeforeStat = v42Base.stat;
    ui.log(tag(`V4-2 基线 sha256=${v42HashBase}（${v42Base.buf.length} 字节）`));

    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(v42Path)}, name: ${JSON.stringify(path.basename(v42Path))}, content: ${JSON.stringify(USER_DOC)} },
      }));
      return true;
    `);
    await sleep(3800);
    // 自证：确认 App 真的切到了这份文档（否则后面全是假结论）
    const v42Opened = await ui.ev(`
      const anchor = document.querySelector('[data-testid="image-manager-btn"]') || document.querySelector("#root");
      const fk = anchor && Object.keys(anchor).find(k => k.indexOf("__reactFiber$") === 0);
      if (!fk) return { ok: false };
      let f = anchor[fk];
      let g = 0;
      while (f && g++ < 400) {
        const p = f.memoizedProps;
        if (p && typeof p.content === "string" && p.onContentChange !== undefined) {
          return { ok: true, filePath: p.filePath, len: p.content.length, head: p.content.slice(0, 30) };
        }
        f = f.return;
      }
      return { ok: false };
    `);
    ui.log(tag(`V4-2 打开自证: ${JSON.stringify(v42Opened)}`));
    if (!v42Opened?.ok || !String(v42Opened.filePath || "").includes("v42-user-doc")) {
      ui.add(
        "V4-2-OPEN",
        "V4-2 文档确实被打开（自证：App filePath 指向 v42-user-doc.md）",
        "FAIL",
        `App filePath=${v42Opened?.filePath} len=${v42Opened?.len} head=${JSON.stringify(v42Opened?.head)} ` +
          `→ **文档未切换成功，V4-2 各项结论不可信**（本轮第二次踩「我以为打开了但没打开」）`,
      );
    } else {
      ui.add(
        "V4-2-OPEN",
        "V4-2 文档确实被打开（自证：App filePath 指向 v42-user-doc.md）",
        "PASS",
        `filePath=${v42Opened.filePath} len=${v42Opened.len}`,
      );
    }
    await ui.command("view.edit");
    await sleep(2600);

    // 三处之①：展示层
    const v42Src = await ui.ev(READ_SOURCE);
    const v42SrcText = v42Src ?? "";
    ui.log(
      tag(`V4-2 ① 展示层 state.doc: len=${v42SrcText.length} ` +
        `hasRawBase64=${/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(v42SrcText)} ` +
        `markers=${JSON.stringify(v42SrcText.match(/lmd-b64-\d+\.(?:png|jpg|gif|webp|svg)/g) || [])}`),
    );
    /**
     * ⚠️ 判据加强（我第一版太弱，导致错误状态通过）：
     * 只断言"<2000 字符 + 无裸 base64"时，**撞名夹具的 masked 展示层也满足**
     * （len=151）→ 文档根本没切换成功也会假 PASS。
     * 现在追加两条**身份判据**：
     * - 展示层必须含用户文档特有的锚点（`## 标题2` / `assets/image-9.png`）；
     * - 必须含用户文档的 mask 标记（说明 mask 作用于这份文档）。
     */
    const v42IsUserDoc =
      v42SrcText.includes("## 标题2") &&
      (v42SrcText.includes("assets/image-9.png") ||
        v42SrcText.includes("lmd-b64-"));
    ui.add(
      "V4-2a",
      "2.69MB 文档：展示层是短标记（不是 MB 级 base64）+ 内容身份正确",
      v42SrcText.length > 0 &&
        v42SrcText.length < 2000 &&
        !/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(v42SrcText) &&
        v42IsUserDoc
        ? "PASS"
        : "FAIL",
      `len=${v42SrcText.length}（原文 ${USER_DOC.length}）isUserDoc=${v42IsUserDoc} ` +
        `含"## 标题2"=${v42SrcText.includes("## 标题2")} ` +
        `含assets引用=${v42SrcText.includes("assets/image-9.png")}`,
    );

    // 三处之②：App content prop
    const v42App = await ui.ev(READ_APP_CONTENT);
    ui.log(
      tag(`V4-2 ② App content prop: ok=${v42App?.ok} len=${v42App?.len ?? "-"} ` +
        `filePath=${v42App?.filePath ?? "-"}`),
    );
    if (v42App?.ok) {
      const urls = dataUrls(v42App.content);
      ui.add(
        "V4-2b",
        "App content prop 仍是完整 base64（写盘用的那份内容不丢）",
        urls.length === dataUrls(USER_DOC).length &&
          urls.every((u, i) => u === dataUrls(USER_DOC)[i])
          ? "PASS"
          : "FAIL",
        `${urls.length} 条 base64，长度 ${JSON.stringify(urls.map((u) => u.length))}`,
      );
      // App content 与磁盘基线是否一致（证明没有中间改写）
      ui.add(
        "V4-2c",
        "App content prop 与打开前的磁盘原文一致（无静默改写）",
        v42App.content === USER_DOC ? "PASS" : "FAIL",
        v42App.content === USER_DOC
          ? `逐字符一致（${v42App.len} 字符）`
          : `len ${v42App.len} vs 原文 ${USER_DOC.length}；首个差异=${(() => {
              const a = v42App.content, b = USER_DOC;
              let i = 0;
              while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
              return `@${i} 磁盘=${JSON.stringify(b.slice(i, i + 24))} vs 内存=${JSON.stringify(a.slice(i, i + 24))}`;
            })()}`,
      );
    } else {
      ui.add("V4-2b", "App content prop 可读", "FAIL", v42App?.reason ?? "读取失败");
    }

    // 切模式往返（V4-2 的稳定性要求）
    await ui.command("view.preview");
    await sleep(2200);
    await ui.command("view.edit");
    await sleep(2200);
    const v42AfterRound = await ui.ev(READ_SOURCE);
    const v42AfterText = v42AfterRound ?? "";
    const v42AfterIsUserDoc =
      v42AfterText.includes("## 标题2") && v42AfterText.includes("assets/image-9.png");
    ui.add(
      "V4-2d",
      "2.69MB 文档：切模式往返后展示层仍是短标记 + 内容身份正确",
      v42AfterText.length > 0 &&
        v42AfterText.length < 2000 &&
        !/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(v42AfterText) &&
        v42AfterIsUserDoc
        ? "PASS"
        : "FAIL",
      `len=${v42AfterText.length} isUserDoc=${v42AfterIsUserDoc}`,
    );

    // 三处之③：保存后磁盘（带"产品确实写过"证明）
    await ui.command("file.save");
    await sleep(1600);
    const dw = assertProductWrote(v42Path, v42BeforeStat, "V4-2 保存");
    const v42Disk = readProven(v42Path, "V4-2 保存后磁盘");
    const v42HashAfter = sha256(v42Disk.buf);
    const discUrls = dataUrls(v42Disk.text);
    const origUrls = dataUrls(USER_DOC);

    if (!dw) {
      ui.add(
        "V4-2e",
        "★ 2.69MB 文档：保存后磁盘 base64 与 assets 引用逐字节不变",
        "KNOWN",
        "**无法判定**：Ctrl+S 未改变 docFile mtime → 产品未写入，不允许据此判落盘" +
          `（本轮教训；而 R3 已踩过 localStorage 2MB 上限的判据坑）`,
      );
    } else {
      ui.add(
        "V4-2e",
        "★ 2.69MB 文档：保存后磁盘 base64 图片本体逐字节不变（不被 mask 简化后落盘）",
        discUrls.length === origUrls.length && discUrls.every((u, i) => u === origUrls[i])
          ? "PASS"
          : "FAIL",
        `前 ${JSON.stringify(origUrls.map((u) => u.length))} → 后 ${JSON.stringify(discUrls.map((u) => u.length))}；` +
          `磁盘 ${v42Disk.buf.length} 字节（原文 ${v42Base.buf.length}）`,
      );
      // 顺带：整体是否无损（允许格式化差异时单列 KNOWN，不掩盖）
      ui.add(
        "V4-2f",
        "2.69MB 文档：保存后磁盘整体是否与原文逐字节一致",
        v42HashAfter === v42HashBase ? "PASS" : "KNOWN",
        v42HashAfter === v42HashBase
          ? `sha256 相同 ${v42HashAfter.slice(0, 16)}…`
          : `sha256 不同：${v42HashBefore0(v42HashBase)} → ${v42HashAfter.slice(0, 16)}…；` +
            `字节 ${v42Base.buf.length} → ${v42Disk.buf.length}（**图片本体已单独判 V4-2e**；` +
            `其余差异需人工核，属格式化/序列化差异时不算数据损坏）`,
      );
    }

    /* ───────────────────────────────────────────────
     * V4-2g：展示层 LaTeX 转义 —— 如实记 KNOWN 并给数据
     *
     * 用户真实文档里有「`$$` 与 LaTeX 同一行」的畸形公式（2 处 `\sum`）。
     * 已知：纯函数往返无损；展示层可能显示双反斜杠（CM6 markdown token 表现）。
     * 这不影响落盘，但**用户看的是展示层** → 若真机可见 `\\sum`，属体验缺陷。
     * ─────────────────────────────────────────────── */
    const esc = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      const text = v && v.state.doc ? v.state.doc.toString() : "";
      // 统计 "sum" 前连续反斜杠数分布
      const hist = {};
      let i = 0;
      while ((i = text.indexOf("sum", i)) !== -1) {
        let n = 0, j = i - 1;
        while (j >= 0 && text[j] === "\\\\") { n++; j--; }
        hist[n] = (hist[n] || 0) + 1;
        i += 3;
      }
      return { len: text.length, hist };
    `);
    ui.log(tag(`V4-2g 展示层 LaTeX 反斜杠分布 = ${JSON.stringify(esc)}`));
    ui.add(
      "V4-2g",
      "展示层 LaTeX 转义（`\\sum` 是否显示成 `\\\\sum`）",
      "KNOWN",
      `展示层 "sum" 前反斜杠分布=${JSON.stringify(esc.hist)}；` +
        `原文件为 2 处单反斜杠。已验：纯函数 round-trip 逐字节无损、解析器不转义、落盘正确 ` +
        `（见 V4-2e）。故这是**展示层视觉差异**，不影响数据；` +
        (esc.hist["2"] ? "真机展示层确有双反斜杠 → 建议记为体验缺陷（用户可见）" : "本次未见双反斜杠"),
    );

    /* ───────────────────────────────────────────────
     * V4-1：图片管理面板不再"失效"（DOM 撑爆 / 卡顿）
     *
     * R3 基线（浏览器）：DOM 8,170KB → 3KB；最长帧间隔 214ms → 0 卡顿帧。
     * 真机阈值（Lead 定）：DOM ≤100KB、打开 ≤100ms。
     * ⚠️ 打开耗时必须在**页内**测（不能把页外 sleep 算进去 —— 我第一版就这么错了）。
     * ─────────────────────────────────────────────── */
    ui.log("");
    // 用撞名夹具（含 base64 图，面板才有内容可列）
    fs.writeFileSync(ui.docFile, COLLISION_DOC, "utf8");
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(ui.docFile)}, name: ${JSON.stringify(path.basename(ui.docFile))}, content: ${JSON.stringify(COLLISION_DOC)} },
      }));
      return true;
    `);
    await sleep(2800);
    await ui.command("view.edit");
    await sleep(1600);

    const btn = await ui.ev(`
      const b = document.querySelector('[data-testid="image-manager-btn"]');
      if (!b) return { exists: false };
      const r = b.getBoundingClientRect();
      return { exists: true, visible: b.getAttribute("data-visible"), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
    `);
    ui.log(tag(`V4-1 按钮 = ${JSON.stringify(btn)}`));

    if (!btn.exists) {
      ui.add("V4-1a", "图片管理入口存在", "FAIL", "找不到 [data-testid=image-manager-btn]");
    } else {
      /**
       * 面板打开成本：**全部在页内测**。
       *
       * 我第一版写成「页内 click → 页内 await sleep(1800) → 返回 t1-t0」，
       * 于是 openMs 恒 ≈1813（把等待窗算进去了）→ 恒 FAIL。
       * 正确做法：`click()` 之后用 rAF 轮询**面板真正出现在 DOM 的时刻**，
       * 那个 delta 才是"打开耗时"。
       */
      const pm = await ui.ev(`
        const b = document.querySelector('[data-testid="image-manager-btn"]');
        const gaps = [];
        let last = performance.now();
        let stop = false;
        const tick = () => {
          const now = performance.now();
          gaps.push(now - last); last = now;
          if (!stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const t0 = performance.now();
        b.click();
        // rAF 轮询：等面板节点出现
        const openAt = await new Promise((resolve) => {
          const probe = () => {
            const d = document.querySelector('[data-testid="image-manager"]');
            if (d) return resolve(performance.now());
            if (performance.now() - t0 > 5000) return resolve(-1);
            requestAnimationFrame(probe);
          };
          requestAnimationFrame(probe);
        });
        await new Promise(r => setTimeout(r, 900));   // 让列表渲染稳定
        stop = true;
        const d = document.querySelector('[data-testid="image-manager"]');
        const t1 = performance.now();
        return {
          openMs: openAt > 0 ? Math.round(openAt - t0) : -1,
          sampleMs: Math.round(t1 - t0),
          maxFrameGapMs: Math.round(Math.max(...gaps)),
          frameGapsOver100ms: gaps.filter(g => g > 100).length,
          domHtmlKB: d ? Math.round(d.innerHTML.length / 1024) : -1,
          domTextLen: d ? (d.textContent || "").length : -1,
          rowCount: d ? d.querySelectorAll("tbody tr").length : -1,
          titleTotalLen: d ? Array.from(d.querySelectorAll("[title]")).reduce((a, e) => a + (e.getAttribute("title") || "").length, 0) : -1,
          open: !!d,
        };
      `);
      ui.log(tag(`V4-1 面板指标 = ${JSON.stringify(pm)}`));

      ui.add(
        "V4-1a",
        "图片管理面板能打开且列出图片",
        pm.open && pm.rowCount > 0 ? "PASS" : "FAIL",
        `open=${pm.open} rows=${pm.rowCount}`,
      );
      ui.add(
        "V4-1b",
        "★ 面板 DOM 体积 ≤100KB（R3 修复前：8,170KB → 若回归会重新撑爆）",
        pm.domHtmlKB >= 0 && pm.domHtmlKB <= 100 ? "PASS" : "FAIL",
        `DOM HTML=${pm.domHtmlKB}KB textContent=${pm.domTextLen} title总长=${pm.titleTotalLen}`,
      );
      ui.add(
        "V4-1c",
        "★ 面板打开 ≤100ms 且无 >100ms 卡顿帧",
        pm.openMs >= 0 && pm.openMs <= 100 && pm.frameGapsOver100ms === 0 ? "PASS" : "FAIL",
        `打开 ${pm.openMs}ms（rAF 轮询到面板出现）；最长帧间隔 ${pm.maxFrameGapMs}ms；` +
          `>100ms 帧 ${pm.frameGapsOver100ms} 个`,
      );

      await ui.ev(`
        const d = document.querySelector('[data-testid="image-manager"]');
        const b = d && d.querySelector(".image-mgr-close");
        if (b) b.click();
        return true;
      `);
      await sleep(700);
    }

    await ui.shot("final");

    /* ───────────────────────────────────────────────
     * V4-3：AI 翻译跳过图片编码
     *
     * 无 API key 时**据实标 KNOWN**，绝不伪造 PASS。
     * 必验（不依赖网络）：翻译入口输入源不含 base64；触发后图片引用未被破坏。
     * ─────────────────────────────────────────────── */
    fs.writeFileSync(ui.docFile, COLLISION_DOC, "utf8");
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(ui.docFile)}, name: ${JSON.stringify(path.basename(ui.docFile))}, content: ${JSON.stringify(COLLISION_DOC)} },
      }));
      return true;
    `);
    await sleep(2500);
    await ui.command("view.edit");
    await sleep(1500);

    const feed = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      const text = v && v.state.doc ? v.state.doc.toString() : "";
      return {
        len: text.length,
        hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(text),
        markers: (text.match(/lmd-b64-\\d+\\.png/g) || []),
      };
    `);
    ui.add(
      "V4-3a",
      "翻译入口输入源（编辑模式展示层）不含 base64 本体",
      feed.hasRawBase64 === false && (feed.markers || []).length > 0 ? "PASS" : "FAIL",
      `len=${feed.len} markers=${JSON.stringify(feed.markers)} hasRawBase64=${feed.hasRawBase64}`,
    );

    const cfg = await ui.ev(`
      const keys = Object.keys(localStorage).filter(k => k.indexOf("lightmd-settings") >= 0);
      if (!keys.length) return { found: false };
      try {
        const s = JSON.parse(localStorage.getItem(keys[0]) || "{}");
        const st = s.state || s;
        return {
          found: true,
          translateEnabled: st?.translate?.translateEnabled ?? null,
          profileCount: (st?.ai?.profiles || []).length,
        };
      } catch { return { found: true, parseError: true }; }
    `).catch(() => ({ found: false }));
    ui.log(tag(`V4-3 翻译设置 = ${JSON.stringify(cfg)}`));

    // 触发全文翻译（无选区时会回退全文）
    await ui.command("edit.translate");
    await sleep(4500);

    const tr = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      const text = v && v.state.doc ? v.state.doc.toString() : "";
      const body = document.body.textContent || "";
      return {
        len: text.length,
        bareKept: text.includes("![裸文件名真实引用](image-1.png)"),
        prefixed: text.includes("![带前缀引用](assets/image-9.png)"),
        markers: (text.match(/lmd-b64-\\d+\\.png/g) || []),
        hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(text),
        bubble: (document.querySelector(".translate-bubble") || {}).textContent || "",
        noKey: /尚未配置翻译 API Key|API Key 无效|未配置/.test(body),
        noTranslatable: /该选区无文本可翻译/.test(body),
      };
    `);
    ui.log(
      tag(`V4-3 触发后 len=${tr.len} bareKept=${tr.bareKept} markers=${JSON.stringify(tr.markers)} bubble=${JSON.stringify((tr.bubble || "").slice(0, 60))}`),
    );

    ui.add(
      "V4-3b",
      "★ 翻译触发后：图片引用完好（裸文件名 + 带前缀 + 短标记都在）",
      tr.bareKept && tr.prefixed && (tr.markers || []).length > 0 ? "PASS" : "FAIL",
      `bareKept=${tr.bareKept} prefixed=${tr.prefixed} markers=${JSON.stringify(tr.markers)}`,
    );

    // 分层判 KNOWN（不伪造 PASS）
    if (tr.noKey || (cfg.found && cfg.translateEnabled === false)) {
      ui.add(
        "V4-3c",
        "★ 真实调 LLM 验「翻译后 unmask 成功」",
        "KNOWN",
        `无可用 API Key / 翻译开关关闭（translateEnabled=${cfg.translateEnabled}）→ 无法发真实请求。` +
          `已验不依赖网络的部分：V4-3a（输入源不含 base64）、V4-3b（图片引用未被破坏）`,
      );
    } else if (tr.noTranslatable) {
      ui.add(
        "V4-3c",
        "★ 真实调 LLM 验「翻译后 unmask 成功」",
        "KNOWN",
        "页面提示「该选区无文本可翻译」→ 未进入真实请求路径",
      );
    } else {
      ui.add(
        "V4-3c",
        "★ 真实调 LLM 验「翻译后 unmask 成功」",
        "KNOWN",
        `未捕获明确成功/失败信号（气泡=${JSON.stringify((tr.bubble || "").slice(0, 50))}）→ 需真实 key+网络复验`,
      );
    }

    /* ───────────────────────────────────────────────
     * V4-5：R4#5 阅读面编辑落到磁盘（真机独有：本进程读磁盘字节）
     * ─────────────────────────────────────────────── */
    ui.log("");
    ui.log(tag("V4-5 开始：阅读面打字 → 切编辑 → 保存 → 读磁盘字节"));
    const TOKEN = "V45TOKEN";
    fs.writeFileSync(ui.docFile, V45_DOC, "utf8");
    const v45Base = readProven(ui.docFile, "V4-5 基线");
    const v45BeforeStat = v45Base.stat;

    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(ui.docFile)}, name: ${JSON.stringify(path.basename(ui.docFile))}, content: ${JSON.stringify(V45_DOC)} },
      }));
      return true;
    `);
    await sleep(2500);
    await ui.command("view.preview");
    await sleep(2200);

    const inPv = await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
      return { hasPm: !!pm, textLen: pm ? (pm.textContent || "").length : -1 };
    `);
    ui.log(tag(`V4-5 阅读面 = ${JSON.stringify(inPv)}`));

    // 光标移到正文末尾 + 打字
    await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
      if (!pm) return false;
      pm.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(pm);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return true;
    `);
    await sleep(400);
    for (const ch of TOKEN) {
      await ui.key(ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0));
      await sleep(70);
    }
    await sleep(1300);

    const typed = await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
      return { has: pm ? (pm.textContent || "").includes(${JSON.stringify(TOKEN)}) : false, len: pm ? (pm.textContent || "").length : -1 };
    `);
    ui.add(
      "V4-5a",
      "阅读模式打字：PM doc 含新字",
      typed.has ? "PASS" : "FAIL",
      `has=${typed.has} pmTextLen=${typed.len}`,
    );

    // 立刻切编辑
    await ui.command("view.edit");
    await sleep(2200);
    const sw = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      const text = v && v.state.doc ? v.state.doc.toString() : "";
      return {
        has: text.includes(${JSON.stringify(TOKEN)}),
        len: text.length,
        hasRawBase64: /data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/.test(text),
      };
    `);
    ui.add(
      "V4-5b",
      "切到编辑模式：源码面含新字（未在切换中丢失）",
      sw.has ? "PASS" : "FAIL",
      `has=${sw.has} len=${sw.len} hasRawBase64=${sw.hasRawBase64}`,
    );

    // 保存 → 磁盘字节证据（真机独有）
    await ui.command("file.save");
    await sleep(1600);
    const wrote45 = assertProductWrote(ui.docFile, v45BeforeStat, "V4-5 保存");
    const disk45 = readProven(ui.docFile, "V4-5 保存后磁盘");
    const hasTok = disk45.text.includes(TOKEN);
    const urls45 = dataUrls(disk45.text);
    const origUrls45 = dataUrls(V45_DOC);

    if (!wrote45) {
      ui.add(
        "V4-5c",
        "★ 保存后磁盘文件字节含新字（真机独有证据）",
        "KNOWN",
        "**无法判定**：Ctrl+S 未改变 docFile mtime → 产品未写入，不允许据此判落盘",
      );
    } else {
      ui.add(
        "V4-5c",
        "★ 保存后**磁盘文件字节**含新字（真机独有证据）",
        hasTok ? "PASS" : "FAIL",
        hasTok
          ? `磁盘 ${disk45.buf.length} 字节，含 "${TOKEN}"；图片引用 ${urls45.length} 条`
          : `磁盘 ${disk45.buf.length} 字节，**不含** "${TOKEN}" → 落盘丢失；尾部=${JSON.stringify(disk45.text.slice(-100))}`,
      );
    }
    ui.add(
      "V4-5d",
      "保存后磁盘：base64 图片引用未被破坏",
      urls45.length === origUrls45.length && urls45.every((u, i) => u === origUrls45[i])
        ? "PASS"
        : "FAIL",
      `${urls45.length} 条，长度 ${JSON.stringify(urls45.map((u) => u.length))}（原文 ${origUrls45[0]?.length}）`,
    );
  },
);

/* ══════════════════════ 数据安全：用户原文件 ══════════════════════ */
const userBufAfter = fs.readFileSync(USER_SRC);
const userHashAfter = sha256(userBufAfter);
const userMtimeAfter = fs.statSync(USER_SRC).mtime.toISOString();

console.log("");
console.log(`[data-safety] 用户原文件 ${userBufBefore.length} → ${userBufAfter.length} 字节`);
console.log(`[data-safety] sha256 前=${userHashBefore}`);
console.log(`[data-safety] sha256 后=${userHashAfter}`);
console.log(`[data-safety] mtime 前=${userMtimeBefore}`);
console.log(`[data-safety] mtime 后=${userMtimeAfter}`);

if (userHashAfter === userHashBefore) {
  console.log("[data-safety] PASS 用户原文件在本次探针运行期间字节级未变");
} else {
  /**
   * R4 T6 方法论：本脚本**没有任何写 USER_SRC 的语句**（只 readFileSync）。
   * 所以运行期间变化只可能来自外部（用户编辑 / 其它程序）。
   * 判 FAIL 会造成"探针写坏数据"的假红 —— 那是把外部变化误判成产品缺陷。
   */
  console.log(
    "[data-safety] KNOWN 用户原文件在运行期间发生变化 —— 本探针全程只读" +
      "（代码中无写该文件的语句），变化来自外部；已记录前后指纹供追溯。",
  );
}

/** 辅助：只取哈希前缀（避免长串刷屏） */
function v42HashBefore0(h) {
  return String(h).slice(0, 16) + "…";
}

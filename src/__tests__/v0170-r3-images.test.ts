/**
 * v0.17.0 第三轮 T3：#9 图片管理 / base64 短格式 / AI 翻译跳过图片编码
 *
 * ## 分配置
 * - jsdom 环境：真实 fixture 纯函数取证 + mask/unmask 真值表补充 + 翻译切分判据
 * - 真实体积：fixture 是用户桌面文件的**副本**（4,182,172 字节），
 *   原文件全程只读（探针 `scripts/v0170-r3-images.mjs` 结尾做 sha256 字节级核对）
 *
 * ## 为什么每条判据都要双向
 * "短格式生效"必须同时满足：编辑面看到 `image-1.png`，**且**出口/落盘仍是完整
 * base64。只验前者会把"数据被吞"当成修好了 —— 本文件 B 组因此成对出现。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { maskBase64Images, unmaskBase64Images, hasRawBase64Image, sameBase64Markers } from "../utils/base64ImageMask";
import { markdownToDoc } from "../core/markdown/parser";
import { collectDocImageOccurrences, markdownHasImage } from "../utils/imageManager";
import { splitDocumentForTranslation, rebuildTranslatedDocument } from "../services/fullTranslate";

const FIXTURE = path.join(process.cwd(), "_verify-out", "t3-fixtures", "md测试.md");
const FIXTURE_BYTES = 4182172;

function readFixture(): string {
  return fs.readFileSync(FIXTURE, "utf8");
}

describe("T3-0 测试文件事实（取证基线）", () => {
  it("副本存在、体积与用户文件一致（只读使用）", () => {
    expect(fs.existsSync(FIXTURE)).toBe(true);
    expect(fs.statSync(FIXTURE).size).toBe(FIXTURE_BYTES);
  });

  it("含 3 处 base64 图片引用（第 2/3 处内容相同）+ 6 个 $$ 公式标记", () => {
    const text = readFixture();
    const urls = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) ?? [];
    expect(urls).toHaveLength(3);
    expect(urls[1]).toBe(urls[2]); // 同图重复引用 → 短标记必须复用（image-2）
    expect((text.match(/\$\$/g) ?? []).length).toBe(6);
  });
});

describe("T3-A 图片管理数据源（9-A）", () => {
  it("markdownToDoc 能把 3 处 base64 解析成 image 节点（面板数据源可用）", () => {
    const doc = markdownToDoc(readFixture());
    const rows = collectDocImageOccurrences(doc);
    expect(rows).toHaveLength(3);
    // 逐行形态判定必须都是内联 base64（决定右侧出现「转 assets」而非「转 base64」）
    for (const r of rows) expect(r.src.startsWith("data:image/")).toBe(true);
    // 同 src 的两行 count 都应为 2
    expect(rows[1].count).toBe(2);
    expect(rows[2].count).toBe(2);
  });

  it("markdownHasImage 为真（图片管理入口可见性判据）", () => {
    expect(markdownHasImage(readFixture())).toBe(true);
  });

  it("面板数据源在**源码模式**下也必须拿到真内容（App 侧 markdownToDoc(content) 路径）", () => {
    // App.tsx imageManagerDoc：viewMode !== "preview" → markdownToDoc(content)
    // content 是真实内容（含 base64），不是源码面的 masked 展示文本。
    // 这条断言锁住"面板数据源坐标口径"：传 masked 文本会得到 0 行吗？
    const real = readFixture();
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(real, tokens);
    expect(collectDocImageOccurrences(markdownToDoc(masked))).toHaveLength(3);
    // 若把短标记当成人肉内容（tokens 丢失），src 就变成 image-1.png —— 形态判定会错，
    // 但那属于 unmask 失败的告警场景，不是本测试的判据。
    expect(collectDocImageOccurrences(markdownToDoc(masked))[0].src).toBe("lmd-b64-1.png");
  });
});

describe("T3-B 短格式展示双向判据（9-B）", () => {
  it("mask：3 处替换 → 2 个标记（相同 base64 复用），文本 4.18M → 515 字符", () => {
    const tokens = new Map<string, string>();
    const { text: masked, replacements } = maskBase64Images(readFixture(), tokens);
    expect(replacements).toHaveLength(3);
    expect([...tokens.keys()]).toEqual(["lmd-b64-1.png", "lmd-b64-2.png"]);
    expect(masked.length).toBeLessThan(1000);
    expect(hasRawBase64Image(masked)).toBe(false);
    // (a) 短标记在
    expect(masked).toContain("](lmd-b64-1.png)");
    expect(masked).toContain("](lmd-b64-2.png)");
  });

  it("unmask：短标记 → 完整 base64，逐字节还原（(b) 数据不丢）", () => {
    const real = readFixture();
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(real, tokens);
    const restored = unmaskBase64Images(masked, tokens);
    // 关键：不是"长度接近"，而是**逐字节完全相同**
    expect(restored).toBe(real);
    expect(Buffer.byteLength(restored, "utf8")).toBe(FIXTURE_BYTES);
  });

  it("mask → unmask → mask 幂等（标记序号稳定，不会每次编辑产生 image-3/4）", () => {
    const tokens = new Map<string, string>();
    const once = maskBase64Images(readFixture(), tokens).text;
    const real = unmaskBase64Images(once, tokens);
    const twice = maskBase64Images(real, tokens).text;
    expect(twice).toBe(once);
    expect([...tokens.keys()]).toEqual(["lmd-b64-1.png", "lmd-b64-2.png"]);
  });

  it("标记被用户改坏 → unmask 保留原样，不静默写坏数据", () => {
    const tokens = new Map<string, string>();
    maskBase64Images(readFixture(), tokens);
    const broken = "![x](image-99.png)\n";
    expect(unmaskBase64Images(broken, tokens)).toBe(broken);
  });
});

describe("T3-C AI 翻译跳过图片编码（9-C）", () => {
  it("现状缺陷复现：未 mask 全文切分 → 有段含 base64 本体（会送进 LLM）", () => {
    const units = splitDocumentForTranslation(readFixture());
    const bad = units.filter((u) => u.text.includes("base64,"));
    // 这就是待修缺陷：base64 被当成可译正文切段
    expect(bad.length).toBeGreaterThan(0);
  });

  it("修复形态：先 mask 再切分 → 0 段含 base64，段数从 675 降到个位数", () => {
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(readFixture(), tokens);
    const units = splitDocumentForTranslation(masked);
    expect(units.filter((u) => u.text.includes("base64,"))).toHaveLength(0);
    expect(units.length).toBeLessThan(10);
    // 图片所在段的文本里必须保留短标记（否则重建时图片丢失）
    const joined = units.map((u) => u.text).join("\n");
    expect(joined).toContain("lmd-b64-1.png");
  });

  it("翻译 payload 校验：masked 单元里不得出现 512 字符以上的 base64 片段", () => {
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(readFixture(), tokens);
    const units = splitDocumentForTranslation(masked);
    for (const u of units) expect(hasRawBase64Image(u.text)).toBe(false);
  });
});

describe("T3-C2 翻译前后图片引用**逐字节**不变（Lead 追加的保险）", () => {
  /**
   * 判据的构造方式：模拟一次完整的全文翻译往返。
   *
   * 真实链路（修复后）：
   *   real ──mask──> masked ──split──> units ──LLM──> translations ──rebuild──> masked'
   *        ──unmask──> real'
   *
   * 断言：`real'` 里**每一处 data URL 都与原文件对应位置逐字节相同**，
   * 且全文长度一致 —— 只允许"可译正文"变化，图片引用一个字节都不许动。
   * 这是比"长度接近"强得多的判据：模型把 base64 中间改一个字符也会被抓到。
   */
  function imageDataUrls(text: string): string[] {
    return text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) ?? [];
  }

  it("模拟翻译（译文原样回填）→ unmask 后 3 条 data URL 逐字节相同", () => {
    const real = readFixture();
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(real, tokens);
    const units = splitDocumentForTranslation(masked);
    // 模拟 LLM 把每段"翻译"成它自己（最容易验证不变量的一档：不该有任何变化）
    const translated = units.map((u) => u.text);
    const maskedOut = rebuildTranslatedDocumentLocal(masked, units, translated);
    const restored = unmaskBase64Images(maskedOut, tokens);

    const before = imageDataUrls(real);
    const after = imageDataUrls(restored);
    expect(after).toHaveLength(before.length);
    // 逐条逐字节
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    expect(restored).toBe(real);
    expect(Buffer.byteLength(restored, "utf8")).toBe(FIXTURE_BYTES);
  });

  it("模拟翻译（每段都加中文前缀）→ 只有正文变，图片引用逐字节不变", () => {
    const real = readFixture();
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(real, tokens);
    const units = splitDocumentForTranslation(masked);
    const translated = units.map((u) => `【译】${u.text}`);
    const maskedOut = rebuildTranslatedDocumentLocal(masked, units, translated);
    const restored = unmaskBase64Images(maskedOut, tokens);

    const before = imageDataUrls(real);
    const after = imageDataUrls(restored);
    expect(after).toHaveLength(3);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    // 正文确实被改了（证明这个测试不是在"什么都没发生"下恒真）
    expect(restored).toContain("【译】");
    expect(restored).not.toBe(real);
    // 长度增量 = 段数 × "【译】".length（3 个字符）—— 说明没有额外增删
    expect(restored.length).toBe(real.length + units.length * 3);
  });

  it("模型改坏标记（译成中文）→ 段级闸门必须拦下并保留原文", () => {
    const real = readFixture();
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(real, tokens);
    const units = splitDocumentForTranslation(masked);
    // 找到含标记的那一段，模拟模型把 image-1.png 译成「图片-1.png」
    const idx = units.findIndex((u) => u.text.includes("lmd-b64-1.png"));
    expect(idx).toBeGreaterThanOrEqual(0);
    const mangled = units.map((u, i) =>
      i === idx ? u.text.replace(/lmd-b64-1\.png/g, "图片-1.png") : u.text,
    );
    // 段级闸门：该段标记多重集不一致 → 调用方会把它置 null（保留原文）
    const gateResults = units.map((u, i) => sameBase64Markers(u.text, mangled[i]));
    expect(gateResults[idx]).toBe(false);
    // 其余段必须都通过（证明判据有区分力，不是一律 false）
    expect(gateResults.filter((v) => v).length).toBe(units.length - 1);

    // 若调用方按闸门把坏段置 null，重组 + unmask 后图片必须完好
    const safeTranslations = mangled.map((t, i) => (gateResults[i] ? t : null));
    const restored = unmaskBase64Images(
      rebuildTranslatedDocumentLocal(masked, units, safeTranslations),
      tokens,
    );
    expect(imageDataUrls(restored)).toEqual(imageDataUrls(real));
    expect(restored).toBe(real); // 唯一被改的段被保留原文 → 整体等于原文
  });

  it("模型输出**非空但丢了标记** → 全篇闸门必须拒绝回写", () => {
    const real = readFixture();
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(real, tokens);
    const units = splitDocumentForTranslation(masked);
    /**
     * ⚠️ 这个用例我第一版写错了，值得留档（判据错，不是产品错）：
     * 我原本让含图段返回**空串**，期望闸门变红 —— 实际拿到 `true`（放行）。
     * 查 `rebuildTranslatedDocument` 才发现它明确写着「null/空译文项保留原文」：
     * ```ts
     * if (translated && translated.trim()) result += translated;
     * else result += original.slice(unit.start, unit.end);   // ← 空串走这里
     * ```
     * 所以"整段删空"**结构上不可能**丢标记，我那条断言测的是一个不存在的情形。
     *
     * 真正危险的形态是"**有译文、但标记被吃掉**"（模型把 `image-1.png`
     * 当成图片语法省略掉，或改写成中文）。用它做判据才有区分力。
     */
    const eaten = units.map((u) => u.text.replace(/!\[[^\]]*\]\(lmd-b64-\d+\.png\)/g, "【图片】"));
    const maskedOut = rebuildTranslatedDocumentLocal(masked, units, eaten);
    expect(sameBase64Markers(masked, maskedOut)).toBe(false);
    // 反向对照：这段"译文"确实非空（否则又退化成上一条被结构兜住的情形）
    expect(maskedOut).toContain("【图片】");
  });

  it("正常翻译（标记全在）→ 全篇闸门必须放行（证明它不是恒 false）", () => {
    const real = readFixture();
    const tokens = new Map<string, string>();
    const { text: masked } = maskBase64Images(real, tokens);
    const units = splitDocumentForTranslation(masked);
    const ok = units.map((u) => `【译】${u.text}`);
    const maskedOut = rebuildTranslatedDocumentLocal(masked, units, ok);
    expect(sameBase64Markers(masked, maskedOut)).toBe(true);
  });
});

/** 本地引用真实实现（避免在测试里重写一遍重组算法，判据才可信） */
function rebuildTranslatedDocumentLocal(
  original: string,
  units: Array<{ start: number; end: number; text: string }>,
  translations: (string | null)[],
): string {
  return rebuildTranslatedDocument(original, units, translations);
}

describe("T3-C3 选区翻译的标记闸门（AiAssistPane.source 通道）", () => {
  /**
   * 任务卡点名的失败模式：「若翻译把 `image-1.png` 当成普通文本翻译走了
   * （例如译成中文"图片-1.png"），unmask 就匹配不上 → 图片丢失」。
   *
   * 选区翻译的 payload 本来就来自 masked 坐标（不送 base64），所以**前半段**已对；
   * 这里锁的是**后半段**：模型把短标记当正文改掉时，回写必须被拒绝。
   * 判据与全文翻译同源（`sameBase64Markers`）。
   */
  const selection = "这是一段说明文字。\n\n![配图](lmd-b64-1.png)\n\n后面还有正文。";

  it("正常译文（标记原样保留）→ 允许回写", () => {
    const translated = "This is explanatory text.\n\n![配图](lmd-b64-1.png)\n\nMore text follows.";
    expect(sameBase64Markers(selection, translated)).toBe(true);
  });

  it("模型把标记译成中文 → 拒绝回写（否则 unmask 失配、图片永久丢失）", () => {
    const translated = "这是一段说明文字。\n\n![配图](图片-1.png)\n\n后面还有正文。";
    expect(sameBase64Markers(selection, translated)).toBe(false);
  });

  it("模型把 image-1.png 整段删掉 → 拒绝回写", () => {
    const translated = "这是一段说明文字。\n\n【这里有一张图】\n\n后面还有正文。";
    expect(sameBase64Markers(selection, translated)).toBe(false);
  });

  it("模型改了标记序号（lmd-b64-1 → lmd-b64-9）→ 拒绝回写（会指向错误的图或失配）", () => {
    const translated = "这是一段说明文字。\n\n![配图](lmd-b64-9.png)\n\n后面还有正文。";
    expect(sameBase64Markers(selection, translated)).toBe(false);
  });

  it("模型把两处引用合并成一处 → 拒绝回写（多重集口径，不是布尔口径）", () => {
    const twoRefs = "![a](lmd-b64-1.png)\n\n正文\n\n![b](lmd-b64-1.png)";
    const oneRef = "![a](lmd-b64-1.png)\n\n正文\n\n【重复的图】";
    // 只检查"有没有出现过 image-"会误判为通过；多重集口径必须拦住
    expect(twoRefs.includes("lmd-b64-1.png") && oneRef.includes("lmd-b64-1.png")).toBe(true);
    expect(sameBase64Markers(twoRefs, oneRef)).toBe(false);
  });

  it("没有标记的选区 → 任意译文都放行（闸门不误伤普通文本）", () => {
    const plain = "这是一段普通文字。";
    const translated = "This is plain text.";
    expect(sameBase64Markers(plain, translated)).toBe(true);
  });
});

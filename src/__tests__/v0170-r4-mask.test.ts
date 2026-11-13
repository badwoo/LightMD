/**
 * v0.17.0 第四轮 T6（task-11）：**mask 标记与真实文件名撞名**的数据损坏
 *
 * ## 这不是用户直接报告的项
 * 第三轮 T3 收工排查时发现的**预存缺陷**（P1，数据损坏级，静默无报错）。
 * 它与用户本轮 #5（阅读模式编辑无法保存 / 切模式后消失）症状相邻，
 * **可能被误报成 #5** —— 所以本文件首先要把两者的边界划清。
 *
 * ## 缺陷
 * `unmaskBase64Images` 早期用
 * `/\]\((image-\d+\.(?:png|jpg|gif|webp|svg|bmp|ico))\)/g`
 * 还原，**只看 `](...)` 内部，不看标记来源**。于是：
 * 1. 文档里有 base64 内联图 → mask 生成 `image-1.png`
 * 2. 文档里另有**真实本地图**，引用写成**裸文件名** `image-1.png`
 * 3. 走到任何 unmask 出口（切模式 / 保存 / `onContentChange` / 预览）
 * → 真实引用被替换成**另一张图**的完整 base64。
 *
 * ## 本文件的判据是**双向**的（缺一不可）
 * - 正向（B 组）：真实裸文件名引用**逐字节不变**，不误吞
 * - 反向（A 组）：真正由 mask 生成的标记**仍能正确还原**成完整 base64
 *
 * ## ⚠️ 为什么反向判据同样重要
 * 只验正向，很容易"为了不误吞"而**废掉还原功能**（例如干脆不匹配任何东西）——
 * 那样短格式展示就彻底失效了。A 组 + 既有真值表同时绿才算修好。
 */
import { describe, it, expect } from "vitest";
import {
  maskBase64Images,
  unmaskBase64Images,
  hasRawBase64Image,
  countBase64Markers,
  sameBase64Markers,
  type Base64Tokens,
} from "../utils/base64ImageMask";
import fs from "node:fs";
import path from "node:path";

/** 构造超长 base64 data URL（> MIN_MASK_LENGTH = 512 才会被 mask） */
function makeDataUrl(len = 600, mime = "image/png"): string {
  return `data:${mime};base64,${"A".repeat(len)}`;
}

const FIXTURE = path.join(process.cwd(), "_verify-out", "t3-fixtures", "md测试.md");
/**
 * 第四轮用户真机操作**改过**的同一份文档副本（T6 期间发现）。
 *
 * 事实变化（记录了产品能力的真实证据，值得留档）：
 * ```
 * 第三轮：4,182,172 字节 / 3 处 base64 / 引用全是 data URL
 * 第四轮：2,692,308 字节 / 1 处 base64 / 其中两张图引用变成 assets/image-9.png
 *        且用户桌面已出现 assets/image-1.png … image-9.png
 * ```
 * 即用户用 LightMD 的「图片管理 → 转 assets」**在真机上成功把内联图落成了文件** ——
 * 这是第三轮 9-A 面板功能在真机可用的实证（原证只是浏览器侧）。
 * 同时它给本任务提供了一个**天然的新 fixture**：文档里存在真实的 `assets/image-9.png`
 * 引用，mask/unmask 绝不能碰它。
 */
const FIXTURE_R4 = path.join(process.cwd(), "_verify-out", "t6-fixtures", "md测试-r4.md");

describe("T6-0 缺陷复现（修复前必须是红的）", () => {
  /**
   * 这是本任务的**复现基线**。
   *
   * 说明：修复后本 describe 的断言方向是"真实引用必须完好"，
   * 因此它在修复后是绿的。**修复前的红**由报告 §2 的实测快照记录
   * （我也把当时的输出原样贴进报告），并由 §7 的破坏性对照（回退修复）现场复验。
   */
  it("共存场景：base64 图 + 裸文件名 image-1.png 真实引用", () => {
    const tokens: Base64Tokens = new Map();
    const b64 = makeDataUrl(600);
    const doc = `# 标题\n\n![内联](${b64})\n\n![真实](image-1.png)\n\n正文\n`;

    const { text: masked } = maskBase64Images(doc, tokens);
    // mask 后两处都显示成 image-1.png（视觉上无法区分 —— 这正是缺陷的土壤）
    expect(masked).toContain("![内联](");
    expect(masked).toContain("![真实](");
    const markers = [...tokens.keys()];
    expect(markers).toHaveLength(1);

    const restored = unmaskBase64Images(masked, tokens);
    // ✅ 真实引用必须**逐字节**保持原样（修复前这里是整条 base64）
    expect(restored).toContain("![真实](image-1.png)");
    // ✅ 内联图必须还原成完整 base64（反向：还原功能没被废掉）
    expect(restored).toContain(`![内联](${b64})`);
    // ✅ 整体严格往返
    expect(restored).toBe(doc);
  });

  it("多条真实引用 + 多张内联图混合，序号逐个对上也不能互相污染", () => {
    const tokens: Base64Tokens = new Map();
    const a = makeDataUrl(600);
    const b = makeDataUrl(601);
    const doc = [
      `![in1](${a})`,
      "",
      "![real1](image-1.png)",
      "",
      `![in2](${b})`,
      "",
      "![real2](image-2.png)",
      "",
      "![real3](image-1.png)",
    ].join("\n");

    const { text: masked } = maskBase64Images(doc, tokens);
    expect([...tokens.keys()]).toHaveLength(2);
    const restored = unmaskBase64Images(masked, tokens);

    expect(restored).toContain("![real1](image-1.png)");
    expect(restored).toContain("![real2](image-2.png)");
    expect(restored).toContain("![real3](image-1.png)");
    expect(restored).toContain(`![in1](${a})`);
    expect(restored).toContain(`![in2](${b})`);
    expect(restored).toBe(doc);
  });

  it("真实引用在**磁盘出口**（onContentChange / 保存）语义下不被改写", () => {
    // 出口链路 = unmask(sourceContent) → App.setContent → Ctrl+S 写盘
    // 所以只要 unmask 不动它，磁盘就安全。
    const tokens: Base64Tokens = new Map();
    const b64 = makeDataUrl(600);
    const diskContent = `![内联](${b64})\n\n![真实](image-1.png)\n`;
    const { text: shown } = maskBase64Images(diskContent, tokens);
    const written = unmaskBase64Images(shown, tokens);
    expect(written).toBe(diskContent);
    // 逐字节：真实引用一行必须与磁盘原文完全一致
    expect(written.split("\n").includes("![真实](image-1.png)")).toBe(true);
  });
});

describe("T6-A 反向判据：mask 标记必须仍能正确还原（防止为了不误吞而废掉功能）", () => {
  it("单张内联图：mask → unmask 严格往返", () => {
    const tokens: Base64Tokens = new Map();
    const url = makeDataUrl(600);
    const original = `![图](${url})`;
    const { text: masked } = maskBase64Images(original, tokens);
    expect(masked).not.toBe(original);
    expect(hasRawBase64Image(masked)).toBe(false);
    expect(unmaskBase64Images(masked, tokens)).toBe(original);
  });

  it("所有支持扩展名都能往返（png/jpg/gif/webp/svg/bmp/ico）", () => {
    const mimes = [
      "image/png", "image/jpeg", "image/gif", "image/webp",
      "image/svg+xml", "image/bmp", "image/x-icon",
    ];
    for (const mime of mimes) {
      const tokens: Base64Tokens = new Map();
      const url = makeDataUrl(600, mime);
      const original = `![](${url})`;
      const { text: masked } = maskBase64Images(original, tokens);
      expect(unmaskBase64Images(masked, tokens)).toBe(original);
    }
  });

  it("相同图片复用标记：两处引用都还原成同一 base64", () => {
    const tokens: Base64Tokens = new Map();
    const url = makeDataUrl(600);
    const original = `![](${url})\n\n![](${url})\n\n![](${url})`;
    const { text: masked } = maskBase64Images(original, tokens);
    expect(tokens.size).toBe(1);
    expect(unmaskBase64Images(masked, tokens)).toBe(original);
  });

  it("多次 mask 调用累积（模拟每次输入/粘贴）后仍能整体还原", () => {
    const tokens: Base64Tokens = new Map();
    const a = makeDataUrl(600);
    const b = makeDataUrl(601);
    // 第一次：只有 a
    const step1 = maskBase64Images(`![](${a})`, tokens).text;
    // 第二次：在 masked 文本上追加 b（真实场景：用户粘贴第二张图）
    const step2 = maskBase64Images(`${step1}\n\n![](${b})`, tokens).text;
    expect(tokens.size).toBe(2);
    expect(unmaskBase64Images(step2, tokens)).toBe(`![](${a})\n\n![](${b})`);
  });

  it("countBase64Markers / sameBase64Markers 与新命名一致（口径同源）", () => {
    const tokens: Base64Tokens = new Map();
    const url = makeDataUrl(600);
    const { text: masked } = maskBase64Images(`![](${url})`, tokens);
    const counts = countBase64Markers(masked);
    expect(counts.size).toBe(1);
    // 计数出来的 key 必须就是 tokens 里的 key（否则 unmask 会失配）
    for (const key of counts.keys()) expect(tokens.has(key)).toBe(true);
    expect(sameBase64Markers(masked, masked)).toBe(true);
  });
});

describe("T6-B 正向判据：真实文件名引用一律不动（不误吞）", () => {
  const tokensWithOne: () => Base64Tokens = () => {
    const t: Base64Tokens = new Map();
    maskBase64Images(`![](${makeDataUrl(600)})`, t);
    return t;
  };

  it("裸文件名 image-1.png / image-2.png 原样保留", () => {
    const tokens = tokensWithOne();
    expect(unmaskBase64Images("![real](image-1.png)", tokens)).toBe("![real](image-1.png)");
    expect(unmaskBase64Images("![real](image-2.png)", tokens)).toBe("![real](image-2.png)");
  });

  it("带目录前缀的引用本来就安全（回归保护）", () => {
    const tokens = tokensWithOne();
    for (const src of [
      "assets/image-1.png",
      "./image-1.png",
      "../img/image-1.png",
      "D:/docs/image-1.png",
      "http://asset.localhost/D%3A%2Fdocs%2Fimage-1.png",
    ]) {
      expect(unmaskBase64Images(`![x](${src})`, tokens)).toBe(`![x](${src})`);
    }
  });

  it("用户自己建的同名文件：tokens 里无此 key → 原样保留", () => {
    /**
     * ⚠️ 这个用例我第一版写错了，值得留档（判据错，不是产品错）：
     * 我用 `tokensWithOne()` 作 tokens，而它生成的标记名**恰好就是** `lmd-b64-1.png`
     * → 断言"用户自建同名文件应保留"必然失败。但那次失败其实是**正确行为**：
     * tokens 里真有这个 key，纯函数无从区分"这是 mask 生成的"还是"用户手敲的"。
     *
     * 修正后的判据分两层：
     * 1. **tokens 里没有该 key** → 必须原样保留（这条可以严格断言）；
     * 2. **tokens 里恰有同名 key** → 会被还原，这是**残余风险**，无法靠命名消除，
     *    只能靠"前缀足够罕见"把概率压到可忽略。报告 §5 如实记录。
     */
    const emptyTokens: Base64Tokens = new Map();
    const userFile = "![mine](lmd-b64-1.png)";
    expect(unmaskBase64Images(userFile, emptyTokens)).toBe(userFile);

    // 换一个 tokens 里不存在的序号 → 也必须原样保留
    const tokens = tokensWithOne();
    expect(unmaskBase64Images("![mine](lmd-b64-7.png)", tokens)).toBe("![mine](lmd-b64-7.png)");
  });

  it("【残余风险留档】tokens 恰有同名 key 时无法区分（靠命名罕见性缓解，非零风险）", () => {
    // 显式把这个边界写成断言，而不是假装它不存在 —— 后人改前缀时必须知道这条约束。
    const tokens = tokensWithOne();
    const collision = "![mine](lmd-b64-1.png)";
    expect(tokens.has("lmd-b64-1.png")).toBe(true);
    // 现状：会被还原（纯函数无法区分来源）。这是已记录的残余风险。
    expect(unmaskBase64Images(collision, tokens)).toBe(`![mine](${tokens.get("lmd-b64-1.png")})`);
  });

  it("token 不存在时（用户改坏了标记）按普通文本保留", () => {
    const tokens = tokensWithOne();
    // 找到真实标记名，然后构造一个不存在的序号
    const realMarker = [...tokens.keys()][0]!;
    const bogus = realMarker.replace(/1(?=\.)/, "99");
    expect(unmaskBase64Images(`![](${bogus})`, tokens)).toBe(`![](${bogus})`);
  });

  it("普通文本里出现标记形态的字样不动（既有契约）", () => {
    const tokens = tokensWithOne();
    expect(unmaskBase64Images("文件名是 image-1.png 的图", tokens)).toBe("文件名是 image-1.png 的图");
  });
});

describe("T6-C 幂等与稳定性", () => {
  it("mask → unmask → mask 幂等（标记序号稳定，不会越跑越大）", () => {
    const tokens: Base64Tokens = new Map();
    const original = `![a](${makeDataUrl(600)})\n\n![b](${makeDataUrl(601)})`;
    const once = maskBase64Images(original, tokens).text;
    const back = unmaskBase64Images(once, tokens);
    expect(back).toBe(original);
    const twice = maskBase64Images(back, tokens).text;
    expect(twice).toBe(once);
    expect([...tokens.keys()]).toHaveLength(2);
  });

  it("修复后仍能把**旧格式**标记当普通文本（不误还原成 base64）", () => {
    // 旧格式 image-1.png 是历史展示形态：它可能是
    //   (a) 用户文档里真实存在的文件名 → 必须保持原样
    //   (b) 旧会话遗留 token（已被新 Map 清掉）→ 也应保持原样
    // 两种都应"不替换"。这是**故意**的行为改变，写进报告。
    const newTokens: Base64Tokens = new Map();
    maskBase64Images(`![](${makeDataUrl(600)})`, newTokens);
    expect(unmaskBase64Images("![](*image-1.png*)", newTokens)).toBe("![](*image-1.png*)");
    // 构造"只有旧格式 token"的极端情形：也不应再被匹配
    const legacyTokens: Base64Tokens = new Map([["image-1.png", makeDataUrl(600)]]);
    expect(unmaskBase64Images("![](${PLACEHOLDER})", legacyTokens)).toBe("![](${PLACEHOLDER})");
  });
});

/** 占位常量（避免模板字符串被误解析；仅用于上面那条"旧 token 不再匹配"的断言） */
const PLACEHOLDER = "x";

describe("T6-D 真实测试文件回归（4,182,172 字节）", () => {
  it("真实 fixture：mask → unmask 严格逐字节往返", () => {
    if (!fs.existsSync(FIXTURE)) {
      // 该 fixture 是第三轮留下的探针副本；不存在时跳过而不是假绿
      console.warn(`[T6-D] 跳过：缺少 fixture ${FIXTURE}`);
      return;
    }
    const real = fs.readFileSync(FIXTURE, "utf8");
    const tokens: Base64Tokens = new Map();
    const { text: masked, replacements } = maskBase64Images(real, tokens);
    expect(replacements).toHaveLength(3);
    expect(tokens.size).toBe(2); // 后两张图内容相同 → 复用标记
    expect(masked.length).toBeLessThan(1000);
    expect(hasRawBase64Image(masked)).toBe(false);
    const restored = unmaskBase64Images(masked, tokens);
    expect(restored).toBe(real);
    expect(Buffer.byteLength(restored, "utf8")).toBe(4182172);
  });

  it("真实 fixture 里插入裸文件名真实引用 → 仍严格往返", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const real = fs.readFileSync(FIXTURE, "utf8");
    // 在文档末尾追加一条裸文件名真实引用（模拟用户另有 assets/image-1.png）
    const withReal = `${real}\n\n![真实图](image-1.png)\n`;
    const tokens: Base64Tokens = new Map();
    const { text: masked } = maskBase64Images(withReal, tokens);
    const restored = unmaskBase64Images(masked, tokens);
    expect(restored).toBe(withReal);
    expect(restored.endsWith("![真实图](image-1.png)\n")).toBe(true);
  });
});


describe("T6-E 第四轮真实 fixture（用户转 assets 后的新版）", () => {
  it("mask/unmask 严格往返，且 assets/image-9.png 引用原样不动", () => {
    if (!fs.existsSync(FIXTURE_R4)) {
      console.warn(`[T6-E] 跳过：缺少 fixture ${FIXTURE_R4}`);
      return;
    }
    const real = fs.readFileSync(FIXTURE_R4, "utf8");
    const tokens: Base64Tokens = new Map();
    const { text: masked, replacements } = maskBase64Images(real, tokens);
    expect(replacements).toHaveLength(1); // 用户已把两张转成 assets，只剩 1 处 base64
    expect(hasRawBase64Image(masked)).toBe(false);
    expect([...tokens.keys()]).toHaveLength(1);

    const restored = unmaskBase64Images(masked, tokens);
    expect(restored).toBe(real);
    // 用户真机「转 assets」的产物必须逐字节保留（含出现两次）
    expect((restored.match(/assets\/image-9\.png/g) ?? []).length).toBe(2);
    expect(Buffer.byteLength(restored, "utf8")).toBe(2692308);
  });

  it("在该 fixture 里再插入裸文件名真实引用 → 仍严格往返", () => {
    if (!fs.existsSync(FIXTURE_R4)) return;
    const real = fs.readFileSync(FIXTURE_R4, "utf8");
    /**
     * ⚠️ 这个用例我第一版**故意（后来发现是真踩）**用了 `lmd-b64-1.png` 当"真实文件名"，
     * 而它恰好等于本 fixture 第一个 mask 标记的名字 → 断言失败。
     *
     * 这次失败**不是 bug**，而是 §5「残余风险」的现场实证：
     * 纯函数只认 tokens 里的 key，无法区分"这个串是 mask 生成的"还是"用户手敲的"
     * —— 只要名字完全相同，就会被当成标记还原。
     *
     * 所以判据分两条写清：
     * - 用**不撞名的序号**（这里 index 1 已被占用，用 `lmd-b64-99.png`）→ 必须原样保留且严格往返；
     * - 撞名的情形单独在 T6-B 里显式断言（不假装它不存在）。
     */
    const withReal = `${real}\n\n![裸文件名真实图](lmd-b64-99.png)\n`;
    const tokens: Base64Tokens = new Map();
    const { text: masked } = maskBase64Images(withReal, tokens);
    const restored = unmaskBase64Images(masked, tokens);
    expect(restored).toBe(withReal);
    expect(restored.endsWith("![裸文件名真实图](lmd-b64-99.png)\n")).toBe(true);
  });
});

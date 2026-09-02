/**
 * v0.6.5 P0 回归测试：占位符必须在**发送前**提取（全文翻译只剩末尾段被译出）
 *
 * 缺陷背景（用户实证：README.md 全文翻译只翻出 TO-DO 后面那段）：
 * provider.translate_stream 此前把**未占位符化的原文**发给 LLM，却在收到译文后
 * 才 segment::mask 生成 tokens 用于 validate —— 凡含链接/行内代码/代码围栏/图片的
 * 段落，译文里根本不可能出现 {{N}}，validate 恒 false，该段被判失败并保留原文；
 * 只有完全无占位符的纯文本段（如文档末尾 TO-DO 后那段）才"翻译成功"。
 *
 * 本测试用最小复刻的 mask/unmask/validate 模拟 provider 契约，
 * 端到端跑「切分 → 逐段翻译 → 重组」，双向锁定该行为：
 * - 反例（发送前不 mask）：复现"只剩末尾段被译出"
 * - 正例（发送前 mask）：全部段落译出，且链接 URL / 行内代码原样回填
 */
import { describe, it, expect } from "vitest";
import {
  splitDocumentForTranslation,
  rebuildTranslatedDocument,
  runFullTranslateLoop,
  type TranslateUnit,
} from "../services/fullTranslate";

// ─── provider 契约的最小复刻（与 Rust segment.rs 同序：行内代码 → 链接 URL）───

function maskLikeRust(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  let masked = text.replace(/`[^`\n]+`/g, (m) => {
    tokens.push(m);
    return `{{${tokens.length - 1}}}`;
  });
  masked = masked.replace(/\]\(([^)]*)\)/g, (_m, url: string) => {
    tokens.push(url);
    return `]({{${tokens.length - 1}}})`;
  });
  return { masked, tokens };
}

/** validate：{{0}}..{{N-1}}（含 {N} 变体）每个恰好出现一次 */
function validateLikeRust(text: string, expectedCount: number): boolean {
  if (expectedCount === 0) return true;
  const counts = new Array<number>(expectedCount).fill(0);
  const re = /\{\{\s*(\d+)\s*\}\}|\{\s*(\d+)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1] ?? m[2]);
    if (n < expectedCount) counts[n] += 1;
  }
  return counts.every((c) => c === 1);
}

function unmaskLikeRust(masked: string, tokens: string[]): string {
  let out = masked;
  tokens.forEach((token, n) => {
    out = out.replace(`{{${n}}}`, token);
  });
  return out;
}

/** 模拟 LLM：只翻译自然语言（打"译"标记），占位符与 Markdown 标记原样保留 */
function fakeLlmTranslate(sent: string): string {
  return sent.replace(/([A-Za-z]{4,})/g, "译$1");
}

/** 模拟 provider 一次段翻译：maskBeforeSend=false 即修复前的缺陷行为 */
function fakeTranslateUnit(text: string, maskBeforeSend: boolean) {
  const seg = maskLikeRust(text);
  const sent = maskBeforeSend ? seg.masked : text;
  const llmOutput = fakeLlmTranslate(sent);
  return {
    translated: unmaskLikeRust(llmOutput, seg.tokens),
    placeholdersIntact: validateLikeRust(llmOutput, seg.tokens.length),
    finishReason: "stop",
  };
}

// ─── 测试文档：结构对齐用户 README（前段含链接/代码，末尾 TO-DO 段无占位符）───

const SENTENCE = "This workflow explains how to compose nodes and compare the results in practice. ";
const para = (n: number) => SENTENCE.repeat(n).trim();

const DOC = [
  "# ComfyUI Workflows",
  "",
  `A repository of workflows for [ComfyUI](https://github.com/comfyanonymous/ComfyUI). ${para(20)}`,
  "",
  `The \`experiments\` directory holds advanced examples, see [docs](https://doc.rs/guide). ${para(24)}`,
  "",
  "### TO-DO",
  "",
  "This is a work in progress, be sure to check back if there are any new additions.",
].join("\n");

async function runPipeline(maskBeforeSend: boolean) {
  const units: TranslateUnit[] = splitDocumentForTranslation(DOC);
  const outcome = await runFullTranslateLoop(units, {
    translateUnit: async (text) => fakeTranslateUnit(text, maskBeforeSend),
    onProgress: () => undefined,
    shouldAbort: () => false,
    errorCodeOf: () => "NETWORK",
  });
  return { units, outcome, rebuilt: rebuildTranslatedDocument(DOC, units, outcome.translations) };
}

describe("v0.6.5 全文翻译：占位符发送前提取（P0 回归）", () => {
  it("切分后：前段含占位符，末尾 TO-DO 段无占位符（对齐用户文档结构）", () => {
    const units = splitDocumentForTranslation(DOC);
    expect(units.length).toBeGreaterThanOrEqual(3);
    expect(maskLikeRust(units[0].text).tokens.length).toBeGreaterThan(0); // 链接
    expect(maskLikeRust(units[1].text).tokens.length).toBeGreaterThan(0); // 行内代码 + 链接
    const last = units[units.length - 1];
    expect(maskLikeRust(last.text).tokens.length).toBe(0); // TO-DO 段：无占位符
    expect(last.text).toContain("TO-DO");
  });

  it("反例：发送前未占位符化 → 只有末尾无占位符段被译出（修复前的缺陷现象）", async () => {
    const { outcome, rebuilt } = await runPipeline(false);
    // 含链接/行内代码的段全部校验失败 → 保留原文
    expect(outcome.failedCount).toBe(2);
    expect(outcome.translations[0]).toBeNull();
    expect(outcome.translations[1]).toBeNull();
    // 末尾段（无占位符）"成功"
    expect(outcome.translations[outcome.translations.length - 1]).not.toBeNull();
    // 现象：TO-DO 之前仍是英文原文，只有 TO-DO 之后被译
    expect(rebuilt).toContain("A repository of workflows for [ComfyUI]");
    const beforeTodo = rebuilt.slice(0, rebuilt.indexOf("### TO-DO"));
    expect(beforeTodo).not.toContain("译");
    expect(rebuilt).toContain("译This");
    expect(rebuilt.indexOf("译This")).toBeGreaterThan(rebuilt.indexOf("### TO-DO"));
  });

  it("修复后：发送前占位符化 → 全部段落译出，链接 URL 与行内代码原样回填", async () => {
    const { outcome, rebuilt } = await runPipeline(true);
    expect(outcome.failedCount).toBe(0);
    expect(outcome.translations.every((t) => t !== null && t.length > 0)).toBe(true);
    // 占位符回填：URL / 行内代码 100% 复原
    expect(rebuilt).toContain("https://github.com/comfyanonymous/ComfyUI");
    expect(rebuilt).toContain("https://doc.rs/guide");
    expect(rebuilt).toContain("`experiments`");
    // 全文（含开头段）均已译出
    expect(rebuilt).toContain("译This");
    expect(rebuilt.indexOf("译This")).toBeLessThan(rebuilt.indexOf("### TO-DO"));
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * v0.17.0 V：**"把 div 当 textarea"缺陷类的静态守卫**
 *
 * ## 背景（两次真实崩溃，都在实机暴露、jsdom 全绿）
 *
 * A3 之后 `sourceTextareaRef` 在 CM6 路径下是**中性 div 宿主**
 * （`EditorContainer` 已把它别名到 `sourceHostElRef`，并明确注释：
 * "CM6 路径下本别名为 null，所有使用点必须按『可能为 null』处理"）。
 *
 * 但 "可能为 null" 这个措辞**不够** —— 真正的危险是 "**可能是 div**"：
 * `if (!ta) return` 这类守卫对 div 完全无效（div 非 null），
 * 于是下面这些 textarea 专属成员会在运行时抛异常：
 *
 * | 成员 | div 上的值 | 后果 |
 * |---|---|---|
 * | `ta.setSelectionRange` | `undefined` | `TypeError: not a function` |
 * | `ta.value` | `undefined` | `undefined.substring` / `undefined.slice` 抛异常 |
 * | `ta.selectionStart/End` | `undefined` | 比较/算术得到 NaN，静默错位 |
 *
 * 已修的三处（都在实机复现过）：
 * 1. `SearchReplace.tsx` 搜索定位当前项 → `setSelectionRange` 崩溃
 * 2. `AiAssistPane.tsx` beforeinput 配对 → `isInCodeBlock(undefined)` 崩溃
 * 3. `translateBridge.ts` 翻译锚点 → `textarea.value.slice` 崩溃
 *
 * ## 本测试的作用
 * 不试图理解每个调用点的语义（那会写成脆弱的源码文本断言），
 * 只锁一条**可机器判定**的规则：
 *
 * > 任何在**同一函数体内**读取 `.current` 之后、
 * > 直接调用 textarea 专属成员的地方，必须存在
 * > `typeof ... === "string"` / `"number"` / `"function"` 之类的**类型判定**。
 *
 * 实现方式：扫描已知的高风险文件，检查是否仍存在"裸用"模式。
 * 这是**反向断言**（禁止出现），而不是正向锁定某段代码 ——
 * 前者不会因为无关重命名而误红。
 */
const ROOT = path.resolve(__dirname, "../..");

/** 已知会拿到 `sourceTextareaRef`（或同类"可能是 div"的 ref）的高风险文件 */
const RISKY_FILES = [
  "src/components/editor/SearchReplace.tsx",
  "src/components/editor/panes/aiassistpane/AiAssistPane.tsx",
  "src/components/editor/panes/aichatpane/AiChatPane.tsx",
  "src/components/editor/panes/sourcepane/SourcePane.tsx",
  "src/components/editor/panes/formatmenuhost/FormatMenuHost.tsx",
  "src/components/editor/panes/historyhost/HistoryHost.tsx",
  "src/components/editor/panes/modesync/ModeSync.tsx",
  "src/components/editor/panes/previewpane/PreviewPane.tsx",
  "src/components/editor/EditorContainer.tsx",
  "src/services/translateBridge.ts",
];

/** textarea 专属成员（div 上不存在或为 undefined） */
const TEXTAREA_ONLY_MEMBERS = ["setSelectionRange", "selectionStart", "selectionEnd"];

/**
 * 匹配「对某个标识符**直接**调用 textarea 专属成员」。
 *
 * 只匹配 `xxx.setSelectionRange(` / `xxx.selectionStart` 这类**裸用法**，
 * 且要求该标识符看起来是"从 ref 取出的元素"（ta / textarea / taEl / el 等命名）。
 * 通过可空链 `?.` 访问不算崩溃点（会得到 undefined 而非抛错），但**仍会静默错位**
 * —— 所以也一并报出，由人判断；本测试把它们归为"需显式类型判定"。
 */
function findBareTextareaMemberUsage(source: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  const lines = source.split("\n");

  /**
   * 收集"做过类型判定"的标识符。
   *
   * 判定形式（本仓库既有写法）：
   * - `typeof xxx.setSelectionRange !== "function"` → 提前 return（守卫式）
   * - `typeof maybeTa.value === "string"`           → 分支式
   * - `typeof (ta as unknown as { selectionStart?: unknown }).selectionStart !== "number"`
   *
   * 只要在**同一文件**里对某个标识符做过这类判定，就认为该文件已处理"可能是 div"。
   * 这是刻意的宽松：本测试要抓的是"完全没意识到这个问题"的文件，
   * 不是把已经正确守卫的代码判红（那会让测试变成噪音源）。
   */
  const guardedIdents = new Set<string>();
  /**
   * 额外：本文件若存在 `isRealTextarea` 这类**布尔判定变量**，
   * 且它在某处被用于 `if (!isRealTextarea)` 守卫，则视为整文件已处理该问题。
   * （translateBridge 的写法：先算 `const isRealTextarea = typeof maybeTa.value === ...`，
   *   再 `if (!isRealTextarea) return 退化锚点;`，后半段才安全使用 `textarea`。）
   */
  const hasRealityFlag = /isRealTextarea/.test(source) && /if\s*\(\s*!isRealTextarea\s*\)/.test(source);
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//")) continue;
    /**
     * 匹配这些写法（本仓库实际用到的三种）：
     * - `typeof ta.value === "string"`
     * - `typeof (ta as unknown as { selectionStart?: unknown }).selectionStart !== "number"`
     * - `typeof (textarea as unknown as HTMLTextAreaElement).setSelectionRange !== "function"`
     *
     * 关键点：标识符与成员之间**可能隔着 `as ...` 类型断言**，所以要允许
     * 任意非右括号内容出现在 `标识符` 与 `.成员` 之间。
     */
    const re =
      /typeof\s+\(?\s*([A-Za-z_$][\w$]*)\b[\s\S]{0,80}?\.\s*(?:value|selectionStart|selectionEnd|setSelectionRange)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) guardedIdents.add(m[1]);
    if (hasRealityFlag) {
      // 该文件用 isRealTextarea 守卫 → 其后的 textarea 变量视为已判定
      guardedIdents.add("textarea");
      guardedIdents.add("ta");
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // 跳过注释行：文档里大量提及这些成员名（说明性文字，不是用法）
    const trimmed = raw.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    for (const member of TEXTAREA_ONLY_MEMBERS) {
      // 形如 `foo.setSelectionRange(` 或 `foo.selectionStart`
      const re = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\??\\.${member}\\b`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const ident = m[1];
        /**
         * 只关心"直接从 ref 取出的元素变量"。
         *
         * 排除两类**必然安全**的标识符：
         * - `e.target` / `ev.target`：React 合成事件上的 target，
         *   只有真正的 textarea 才会触发 `onChange`（CM6 不产生 React onChange），
         *   因此不可能是 div —— 这类访问不算风险；
         * - 明确的局部内置对象（document/body/window 等）。
         */
        if (!/^(ta|taEl|textarea|el|elem|element|host|node|ref)$/i.test(ident)) continue;
        // 上一个字符是 `.` → 说明是 `xxx.target` 这类成员访问，不是元素变量本身
        const beforeIdx = m.index - 1;
        if (beforeIdx >= 0 && raw[beforeIdx] === ".") continue;
        // 该标识符已在文件内被类型判定过 → 视为已正确处理
        if (guardedIdents.has(ident)) continue;
        hits.push({ line: i + 1, text: raw.trim().slice(0, 140) });
      }
    }
  }
  return hits;
}

describe("v0.17.0 V：禁止把 div 宿主当 textarea 用（崩溃类守卫）", () => {
  it("高风险文件中不存在对元素变量裸调 textarea 专属成员的写法", () => {
    const offenders: string[] = [];
    for (const rel of RISKY_FILES) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const src = fs.readFileSync(abs, "utf8");
      for (const hit of findBareTextareaMemberUsage(src)) {
        offenders.push(`${rel}:${hit.line}  ${hit.text}`);
      }
    }
    expect(
      offenders,
      '以下位置对「可能是 div」的元素直接使用了 textarea 专属成员，' +
        "运行时会抛异常并让错误边界接管整个界面：\n" +
        offenders.join("\n") +
        "\n修法：调用前加类型判定（typeof x.value === 'string'），" +
        "或改走 SourceSurface 契约（focus/setSelection/setScrollTop）。",
    ).toEqual([]);
  });

  it("SearchReplace 定位当前项必须走 SourceSurface 契约（而非直接操作 DOM）", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/components/editor/SearchReplace.tsx"), "utf8");
    // 正向：必须调用 surface 的 setSelection（这是修复后的正确路径）
    expect(
      /sourceSurface\.setSelection\(/.test(src),
      "SearchReplace 源码模式定位当前项必须调用 sourceSurface.setSelection(...)，" +
        "否则会退回到「直接对 DOM 元素调 setSelectionRange」的崩溃路径。",
    ).toBe(true);
    // 反向：兜底分支必须带类型判定（否则又变成裸用）
    expect(
      /typeof .*setSelectionRange.*=== "function"|setSelectionRange !== "function"/.test(src),
      "兜底分支必须先用 typeof 判定 setSelectionRange 存在（div 上没有该方法）。",
    ).toBe(true);
  });

  it("translateBridge 的锚点函数必须对非 textarea 元素退化而不是崩溃", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/services/translateBridge.ts"), "utf8");
    // 必须存在"是不是真 textarea"的判定
    expect(
      /typeof maybeTa\.value === "string"/.test(src),
      "getTextareaSelectionAnchor 必须先判定传入的是真 textarea（typeof value === 'string'），" +
        "否则 div 上传入会让 textarea.value.slice(...) 抛异常。",
    ).toBe(true);
    // 退化分支必须真的返回锚点（不能 undefined）
    expect(
      /if \(!isRealTextarea\) \{[\s\S]{0,200}return \{ x:/.test(src),
      "非 textarea 分支必须返回退化锚点（{x, y}），不能返回 undefined —— " +
        "否则下游 runTranslate 解构会再报一次。",
    ).toBe(true);
  });
});

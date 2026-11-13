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
const TEXTAREA_ONLY_MEMBERS = [
  "setSelectionRange",
  "selectionStart",
  "selectionEnd",
  /**
   * `value` 也必须纳入（v0.17.0 补）：
   * div 的 `value` 是 **undefined**（不是抛错），所以 `ta ? ta.value : ""`
   * 这类三元**取不到兜底值** → 后续 `.length` / `.substring` 立刻抛
   * `Cannot read properties of undefined`。
   *
   * 这个模式造成过**真实 P0**：`SourcePane` 里
   * ```
   * const beforeText = textarea ? textarea.value : "";   // div → undefined
   * const beforeTextLength = beforeText.length;          // 💥
   * ```
   * 后果是**CM6 下任何撤销/恢复都崩在这一行**（Ctrl+Z 内容完全不变）。
   * 而 221 条 undo 测试全绿 —— 因为 jsdom 恒走 textarea 实现，`value` 有值。
   */
  "value",
];

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

/* ═══════════════════════════════════════════════════════════════════════════
 * 规则②（v0.17.0 P1-3 新增）：**禁止用真值性判断决定「是否走 textarea 专用路径」**
 *
 * ## 为什么必须补这一条（上一轮护栏的盲区，已造成真实 P1）
 *
 * 规则① 扫的是「对可能是 div 的元素**裸调** textarea 专属成员」
 * （`ta.setSelectionRange` / `ta.value.length` …）。但 P1-3 的缺陷写法是：
 *
 * ```ts
 * const source = textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(sourceSurface);
 * //                ^^^^^^^^ 没有任何成员调用，规则①完全扫不到
 * ```
 *
 * `div` 是 **truthy**，所以这个三元**永远走左边**。左边那条路读 `div.value`
 * 得 `undefined` → 返回 null → **专为 CM6 写的那条 fallback 永远不会被调用**。
 * 后果是用户可见的：编辑模式分屏时左右两屏显示**不是同一段正文**
 * （实测文字同源 0/4，短段落最差 31 行 ≈ 932px，超长行最差 72 行）。
 *
 * ## 判据怎么做到「不恒真」（本轮方法论硬要求）
 *
 * 缺陷详报 §3.1 的教训是：**判据在缺陷存在时仍然为真** = 护栏退化成装饰品。
 * 所以这里刻意**不做**"扫全文找关键字"那种模糊匹配，而是做两件可机器判定的事：
 *
 * 1. **正向白名单**：`sourceTextareaRef.current` / 同类 ref 一旦被解出，
 *    只允许用**类型判定**（`typeof ….value === "string"` / `asRealTextarea(…)` /
 *    `sourceGeometry.realTextarea()`）来决定分派；**直接**把它塞进真值性条件
 *    （`x ? … : …` / `if (x)` / `x &&` / `!x ||`）就是违规。
 * 2. **破坏性验证**（由本文件内的两条 `it` 保证）：`findTruthinessDispatch()`
 *    必须在喂入已知违规样本时**报出违规**、喂入已知合规样本时**不报**。
 *    这样"护栏恒真/恒假"在结构上不可能发生 —— 它自己的判据也被断言了。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * textarea **专属**的几何/选区 API。
 *
 * 这些函数内部一律读 `el.value` / `el.selectionStart` / 建 mirror 复刻 textarea 排版，
 * 在 `div` 上**必然空操作或返回 null**（不是抛错，所以没人发现）。
 *
 * 它们是「textarea 专用路径」的可机器识别标志：
 * 一旦它们出现在**真值性判断的某个分支**里，那个判断就是 P1-3 的写法。
 */
const TEXTAREA_ONLY_APIS = [
  "textareaMeasureSource",
  "measureSourceLineAxis",
  "captureTextAnchor",
  "restoreTextAnchor",
  "measureTextareaCursorY",
  "measureTextareaRangeY",
  "measureOffsetViewportY",
  "captureLineAnchor",
  "restoreLineAnchor",
  "setSelectionRange",
];

/**
 * 剥掉注释（块注释 + 行注释）。
 *
 * 必须剥：本仓库在这类位置写了**大量**解释性注释，其中反复出现
 * `textarea ? textareaMeasureSource(textarea) : …` 这类"缺陷原样"。
 * 不剥会把"解释"当成"实现"→ 假红（甚至有人为了让测试绿而去改注释）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => " ".repeat(m.length));
}

/**
 * 检测「用真值性判断决定是否走 textarea 专用路径」的写法。
 *
 * ## 判据（刻意窄，但**不**恒真、**不**假红）
 *
 * 违规 = 同一行里同时出现下面两件事：
 * 1. 一个**文本形态的真值性条件**：`x ? … : …` / `if (x)` / `if (!x)` / `x && …` / `!x || …`；
 * 2. 该行的某个分支调用了 `TEXTAREA_ONLY_APIS` 里的**任意一个** textarea 专属 API。
 *
 * **为什么加第 2 条**：光看"真值性判断"会命中大量合法写法
 *（`if (textarea) targets.push(textarea)` 只是收集元素，没有走 textarea 专属路径）。
 * 只盯"真值性 + textarea 专属 API"这一组合，才精确对应缺陷形态：
 *
 * ```ts
 * const source = textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(sourceSurface);
 * //                ^①                  ^②      ← 只要 div 是 truthy，② 就永远执行、fallback 永不执行
 * ```
 *
 * ## 为什么不要求"标识符来自 sourceTextareaRef"
 * 因为 ref 会被别名、被传参、被解构（`const ta = props.sourceTextareaRef.current`、
 * `function f(textarea)`）。绑定来源追踪会写成脆弱的自造编译器且必然漏。
 * 用「行内是否同时有真值性条件 + textarea 专属 API」这一条**语法事实**，
 * 既不依赖追踪、也不依赖命名。
 *
 * ## 已知放行（**有意的**，不是漏）
 * 若同一行里已出现**类型判定**（`typeof ….value === "string"` / `asRealTextarea(…)`），
 * 说明该分派已经建立在类型结论上 → 放行。这正是正确范式。
 *
 * @returns 违规位置（原始行号 + 原文）；空数组 = 干净
 */
function findTruthinessDispatch(source: string): { line: number; text: string }[] {
  const codeLines = stripComments(source).split("\n");
  const rawLines = source.split("\n");
  const hits: { line: number; text: string }[] = [];

  /** 文本形态的真值性条件（`x` 是任意标识符/成员表达式） */
  const TRUTHY = [
    /\bif\s*\(\s*!?\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\)/, // if (x) / if (!x)
    /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\?[^?:]*:/, // x ? a : b
    /!\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\|\|/, // !x || …
  ];
  /** 已基于类型的结论 → 放行 */
  const TYPED = [
    /typeof\s+[^;]*\.\s*value\s*===\s*"string"/,
    /asRealTextarea\s*\(/,
    /realTextarea\s*\(\s*\)/,
  ];

  /**
   * 收集「已基于类型判定过的变量名」。
   *
   * ## 为什么需要（2026-11-11 修正：本检具第一版有假红）
   *
   * 第一版只做**同行**白名单匹配，于是下面这种**合规**写法被误报：
   * ```ts
   * const ta = asRealTextarea(textarea);   // ← 类型判定在这一行
   * if (ta) restoreTextAnchor(ta, anchor); // ← 本行既无 `asRealTextarea` 也无可放行的模式
   * ```
   * `ta` 是**已经过 `typeof value === "string"` 判定**的真 textarea，
   * `if (ta)` 是合法的空值守卫，不是 P1-3 的"真值性分派"。
   *
   * → 必须先扫一遍全文，把「由类型判定产出的变量」记下来，后续行遇到这些变量直接放行。
   * 这不是放宽判据：它把"判断依据"从「同行文本」升级为「数据流来源」，
   * 而 P1-3 的真实形态（`sourceTextareaRef.current` **直接**进三元）依然会被抓到
   * —— 因为那个标识符从来不是类型判定的产物。
   */
  const typedVars = new Set<string>();
  for (const line of codeLines) {
    // const x = asRealTextarea(...) / realTextarea()
    const m1 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*asRealTextarea\s*\(/.exec(line);
    if (m1) typedVars.add(m1[1]);
    const m2 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*realTextarea\s*\(\s*\)/.exec(line);
    if (m2) typedVars.add(m2[1]);
    // const x = typeof ….value === "string" ? … : null（本行声明的就是类型判定产物）
    const m3 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*typeof\s+[^;]*\.\s*value\s*===\s*"string"/.exec(line);
    if (m3) typedVars.add(m3[1]);
  }
  /**
   * 跨行声明也要认：形如
   * ```ts
   * const textarea =
   *   hostEl && typeof (hostEl as { value?: unknown }).value === "string"
   *     ? (hostEl as HTMLTextAreaElement)
   *     : null;
   * ```
   * 判定在**第二行**、变量名在**第一行** → 需要把「声明头」与「后续 2 行」拼起来看。
   */
  for (let i = 0; i < codeLines.length; i++) {
    const head = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(codeLines[i].trimEnd() + "")
      || /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(codeLines[i]);
    if (!head) continue;
    const window = codeLines.slice(i, i + 4).join(" ");
    if (/typeof\s+[^;]*\.\s*value\s*===\s*"string"/.test(window)) typedVars.add(head[1]);
  }

  /** 本行引用的标识符是否全部是「已类型判定」的 */
  const onlyTypedIdents = (line: string): boolean => {
    if (typedVars.size === 0) return false;
    // 抓出该行所有裸标识符（粗略），若其中出现 typedVars 里的成员，视为安全信号
    let usedTyped = false;
    for (const v of typedVars) {
      if (new RegExp(`\\b${v.replace(/[$]/g, "\\$")}\\b`).test(line)) usedTyped = true;
    }
    return usedTyped;
  };

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i];
    if (!TEXTAREA_ONLY_APIS.some((api) => line.includes(api))) continue;
    if (TYPED.some((re) => re.test(line))) continue;
    // 真值性分支里用的是「已过类型判定的变量」→ 合规的空值守卫
    if (onlyTypedIdents(line)) continue;
    if (!TRUTHY.some((re) => re.test(line))) continue;
    hits.push({ line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 170) });
  }
  return hits;
}

/**
 * 本规则的作用文件（P1-3 修复范围内已清零的文件）。
 *
 * ⚠️ **不要**为了"让它绿"而往这里加新文件 —— 反过来，**新增文件必须加进来**。
 * 当前只覆盖 P1-3 归属的文件（其余 pane 里的同类写法由各自任务的守卫负责，
 * 不在本任务写作用域内 → 本测试不越界判红别人的文件）。
 */
const TRUTHINESS_GUARD_FILES = [
  "src/components/editor/panes/previewpane/PreviewPane.tsx",
  "src/components/editor/panes/historyhost/HistoryHost.tsx",
];

describe("v0.17.0 P1-3：禁止用真值性判断决定「是否走 textarea 专用路径」", () => {
  it("检具自身有效：已知违规样本必须被报出（防「判据恒假 / 恒真」）", () => {
    // 这一条是**方法论要求**（缺陷详报 §3.1：判据在缺陷存在时仍然为真 = 护栏装饰）。
    // 它证明下面的扫描真的能看见 P1-3 的原样写法，而不是"什么都没扫到所以绿"。
    const offending = [
      `const textarea = sourceTextareaRef.current;`,
      `const source = textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(s);`,
    ].join("\n");
    const hits = findTruthinessDispatch(offending);
    expect(hits.length, "检具失效：它看不见 P1-3 的原样缺陷写法").toBeGreaterThan(0);
    expect(hits[0].text).toContain("textarea ?");
  });

  it("检具自身有效：已知合规样本不得被报出（防假红）", () => {
    const clean = [
      `const textarea = sourceTextareaRef.current;`,
      `const isReal = !!textarea && typeof (textarea as unknown as { value?: unknown }).value === "string";`,
      `const source = isReal ? textareaMeasureSource(textarea as HTMLTextAreaElement) : surfaceMeasureSource(surfaceSurface);`,
      `const ta = asRealTextarea(textarea);`,
      `if (ta) restoreTextAnchor(ta, anchor);`,
      `const host = sourceTextareaRef.current;`,
      `if (!host) return;`,
    ].join("\n");
    const hits = findTruthinessDispatch(clean);
    expect(hits, `合规写法被误判为违规：${JSON.stringify(hits)}`).toEqual([]);
  });

  it("业务文件中不存在该写法（正例扫描）", () => {
    const offenders: string[] = [];
    for (const rel of TRUTHINESS_GUARD_FILES) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const src = fs.readFileSync(abs, "utf8");
      for (const hit of findTruthinessDispatch(src)) {
        offenders.push(`${rel}:${hit.line}  ${hit.text}`);
      }
    }
    expect(
      offenders,
      "以下位置用**真值性**判断决定是否走 textarea 专用路径。\n" +
        "CM6 下 `sourceTextareaRef.current` 是 `<div>`（truthy，非 null）→ " +
        "这个判断恒真 → textarea 分支被走、CM6 分支**永远不会执行**：\n" +
        offenders.join("\n") +
        "\n修法：改用类型判定（`typeof el.value === 'string'`，范式见 SourcePane.tsx:454），" +
        "或经 `asRealTextarea()` / `sourceGeometry.realTextarea()` 分派。",
    ).toEqual([]);
  });

  it("PreviewPane 的行轴测量必须能到达 surface 源（P1-3 回归锁定）", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src/components/editor/panes/previewpane/PreviewPane.tsx"),
      "utf8",
    );
    // 正向：必须存在 surfaceMeasureSource 的**可达**调用（不是只在注释里）
    expect(
      /surfaceMeasureSource\s*\(\s*sourceSurface\s*\)/.test(stripComments(src)),
      "PreviewPane 的行轴测量必须调用 surfaceMeasureSource(sourceSurface)，" +
        "否则 CM6 下的 `lineBlockAt` 行轴永远不会被使用 → 分屏对齐退回线性插值。",
    ).toBe(true);
    // 且该调用必须挂在**类型判定之后**（asRealTextarea 的结果），而不是裸三元
    const code = stripComments(src);
    const axisIdx = code.indexOf("surfaceMeasureSource(sourceSurface)");
    const judgeIdx = code.lastIndexOf("asRealTextarea", axisIdx);
    expect(judgeIdx, "surfaceMeasureSource 必须由 asRealTextarea 的类型判定分派到达").toBeGreaterThan(-1);
  });

  it("HistoryHost 的源码块几何测量同样不得用真值性分派（P1-3 同源点）", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src/components/editor/panes/historyhost/HistoryHost.tsx"),
      "utf8",
    );
    const code = stripComments(src);
    // 该文件必须能到达 surfaceMeasureSource（否则 CM6 下块几何恒空）
    expect(
      /surfaceMeasureSource\s*\(\s*sourceSurface\s*\)/.test(code),
      "HistoryHost.measureSourceBlocks 必须在 CM6 下改走 surfaceMeasureSource，" +
        "否则源码块几何缓存永远为空 → 编辑↔阅读切换退回百分比映射（软换行长行偏约 4 倍）。",
    ).toBe(true);
  });
});

/**
 * ═══ 2026-11-11 Lead 补充：**判据精度**的破坏性矩阵 ═══
 *
 * 背景：本守卫第一版有「假红」—— 它把 `if (ta) restoreTextAnchor(ta, …)`
 * （`ta` 来自 `asRealTextarea()`，是**已过类型判定**的真 textarea）误报成违规。
 * 修完假红后必须证明它**没有退化成恒真**：真缺陷仍要被抓到。
 *
 * 下面四条是判据的两端：
 * - 违规侧：标识符**直接来自 ref**（未做类型判定）→ 必须报出
 * - 合规侧：标识符**由类型判定产出**（同行 / 跨行声明）→ 必须不报
 */
describe("v0.17.0 P1-3 守卫：判据精度的破坏性矩阵（防假红 / 防恒真）", () => {
  it("违规：ref 直接进三元分派 → 必须报出", () => {
    const bad = [
      `const textarea = sourceTextareaRef.current;`,
      `const source = textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(s);`,
    ].join("\n");
    expect(findTruthinessDispatch(bad).length, "真缺陷必须被抓到").toBeGreaterThan(0);
  });

  it("违规：if 守卫后直调专属 API（未做类型判定）→ 必须报出", () => {
    const bad = [
      `const ta = sourceTextareaRef.current;`,
      `if (ta) return captureTextAnchor(ta, y);`,
    ].join("\n");
    expect(findTruthinessDispatch(bad).length, "真缺陷必须被抓到").toBeGreaterThan(0);
  });

  it("合规：asRealTextarea 产出的变量做守卫 → 不得报出", () => {
    const clean = [
      `const ta = asRealTextarea(x);`,
      `if (ta) return captureTextAnchor(ta, y);`,
    ].join("\n");
    expect(findTruthinessDispatch(clean), "已过类型判定的变量不该被误报").toEqual([]);
  });

  it("合规：跨行 typeof 声明后三元分派 → 不得报出", () => {
    const clean = [
      `const textarea =`,
      `  hostEl && typeof (hostEl as unknown as { value?: unknown }).value === "string"`,
      `    ? (hostEl as unknown as HTMLTextAreaElement)`,
      `    : null;`,
      `const measured = measureLineAxis(`,
      `  textarea ? textareaMeasureSource(textarea) : surfaceMeasureSource(surface),`,
      `);`,
    ].join("\n");
    expect(findTruthinessDispatch(clean), "跨行类型判定后的分派是合规写法").toEqual([]);
  });
});

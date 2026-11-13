/**
 * v0.17.0 P0-3 —— 归一化白名单。
 *
 * 设计稿 §7.2/§7.4：diff 四分类里的 `normalized` 必须**显式登记**，不能靠
 * "实现自己说自己等价"。所以这里不是"忽略列表"，而是**证据化的等价声明**：
 * 每条写清 (oracle, 差异形态, 为什么语义等价, 最迟何时删除)。
 *
 * 白名单**分两类**（这个区分很重要，混在一起会让审计失真）：
 *
 * 1. `NORMALIZED_WHITELIST`（形态匹配类）：diffShape 里确实出现了某个
 *    **语义属性差异**（如 `break:soft` vs `break:hard`），但该差异属已知等价写法。
 *    用正则匹配 diffShape。
 * 2. `CARRIER_WHITELIST`（纯载体类）：签名**完全相等**（kinds/atoms/attrs 全等），
 *    仅字节不同 —— 纯词法/写法归一化（Setext→ATX、围栏字符、缩进、表格分隔行空格、
 *    CRLF、空行数量、图片后缀写法）。这类不产生任何 diffShape，无法用正则匹配，
 *    只能按 (oracle, feature) 登记。
 *
 * 两类都要求**登记**：未登记的纯载体差异会被单列为 `carrier-unregistered`，
 * 报告里可见（B 线要么补登记、要么修实现），不会被静默吞掉。
 *
 * 三条铁律：
 * 1. 白名单**只允许**收 normalized 类；lossy/corrupt 一律不得进白名单
 *    （设计稿 §7.4 "normalized 白名单管理" 与 R4 "影响数据安全的必修"）。
 * 2. 每条必须能回答「凭什么说等价」——依据写进 `reason`。
 * 3. `expires` 语义为「最迟在哪个里程碑删除」，留给 B 线的是"到期即修"，
 *    不是永久豁免。
 */

export type OracleId = "md-doc-md" | "md-tree-md" | "md-blocks-md";

export type DiffClass = "identical" | "normalized" | "lossy" | "corrupt";

export interface WhitespaceEntry {
  /** 唯一 id（报告里引用它，便于审计） */
  id: string;
  /** 适用的 oracle；"*" = 全部 */
  oracle: OracleId | "*";
  /** 匹配的输入特征（feature id） */
  feature: string;
  /** 差异形态正则（对 diffShape 匹配）。纯载体类用 `@@carrier` 表示"要求无形态差异" */
  pattern: string;
  /** 为什么算语义等价 */
  reason: string;
  /** 最迟删除的里程碑 */
  expires: string;
}

/** 纯载体等价标记：pattern 为此值表示「签名全等、仅字节不同」才适用 */
export const CARRIER_MARK = "@@carrier";

/**
 * 形态匹配类白名单：diffShape 中确实存在语义属性差异，但写法等价。
 */
export const NORMALIZED_WHITELIST: WhitespaceEntry[] = [
  {
    id: "NW-01-break-representation",
    oracle: "*",
    // feature "*"：软/硬换行可出现在任何块容器（段落/引用/列表项/脚注/表格）；
    // 限定 para-hardbreak-spaces 会漏掉 quote/list_item 里的同类差异（实测漏判）。
    feature: "*",
    pattern: "inline:break",
    reason:
      "`  \\n`（两空格硬换行）与 `<br>` 在 GFM 下渲染等价（同出 <br>）。" +
      "序列化只在**顶层段末**用两空格、其余上下文用 <br>（serializer 的 v0.12.3 口径）。" +
      "内容原子（换行**数量**与所在段）仍逐条比对；写法（`\\n` / `  \\n` / `<br>`）归入指纹。",
    expires: "永久（渲染语义等价，非缺陷）",
  },
  {
    id: "NW-02-break-count-diff",
    oracle: "*",
    feature: "*",
    pattern: "inline:break",
    reason:
      "本项目 GFM 口径（settings.paragraphBreaks 默认 gfm）下 softbreak 解析即 hard_break，" +
      "serializer 输出 `  \\n`。签名层二者统一记「一个 break」，只比数量，写法差异不单独计罪。",
    expires: "永久（口径内等价）",
  },
  {
    id: "NW-03-table-cell-html-wrapper",
    oracle: "md-doc-md",
    feature: "table-merged-html",
    pattern: "html:(td|th)",
    reason:
      "合并格用「格内 HTML」表达（`<td colspan=\"2\">M</td>`）。PM 解析（parser 的 extractTdWrapper）" +
      "把跨度转成 table_cell 的 colspan/rowspan；序列化时 **colspan=1 的包裹标签不再回写**" +
      "（colspan=1 与普通单元格语义完全等价），colspan>1 仍会重新写成 `<td colspan>`。" +
      "签名层可见差异只有 html_inline 的 td/th 计数。**单元格内容与列对齐仍逐条比对**" +
      "（由 atoms 与 cell:align 指纹守护）。",
    expires: "B3 出口切换（届时统一由模型层输出）",
  },
  {
    id: "NW-03b-html-sub-sup-to-tilde-caret",
    oracle: "*",
    feature: "html-whitelist",
    pattern: "html:(sub|sup|u|mark)",
    reason:
      "`<sub>/<sup>/<u>/<mark>` 是行内 HTML 白名单（E8 口径），PM 侧映射为 sub/sup/underline/mark 标记，" +
      "序列化按 markdown 语法输出 `~x~`/`^x^`/`==x==`。同一语义的两种写法，" +
      "签名层两者都记格式指纹，差异可解释。**注意**：只解释标签与 markdown 标记的载体差异；" +
      "若标签内容本身丢失，仍由 atoms 缺失判定为 lossy。",
    expires: "B2 序列化收敛（届时统一输出形态）",
  },
];

/**
 * 纯载体类白名单：签名全等（kinds/atoms/attrs 一致）、仅字节不同。
 *
 * 这类差异**理论上零语义影响**，但仍需登记 —— 否则「白名单管理」就退化成
 * 「所有看起来一样的都放过」。
 */
export const CARRIER_WHITELIST: WhitespaceEntry[] = [
  {
    id: "NW-04-setext-to-atx",
    oracle: "md-doc-md",
    feature: "heading-setext",
    pattern: CARRIER_MARK,
    reason:
      "v0.17.0 T4 起 PM 出口（serializer.headingToMarkdown）读 raw.setext 保 Setext 写法，" +
      "不再归一化为 ATX；经 nodeFromJSON 克隆（等价「PM 内编辑过该标题」）后走规范序列化，" +
      "剩余差异仅为**下划线长度按新文字重算**（G5-1 口径 max(3, len)，`===` ↔ `======`）。" +
      "标题级别（h1/h2）与文本完全不变，属**写法**归一化。",
    expires: "B2 序列化收敛",
  },
  {
    id: "NW-05-fence-char-and-length",
    oracle: "*",
    feature: "fence-basic",
    pattern: CARRIER_MARK,
    reason:
      "`` ~~~js ``↔`` ```js ``、围栏长度 3↔5 由 serializer.fenceBlock 按内容动态选择（CommonMark 允许）。" +
      "内容与 info 不变（info 差异不在载体白名单内，会单独判 lossy）。",
    expires: "永久（CommonMark 等价）",
  },
  {
    id: "NW-06-fence-tilde",
    oracle: "*",
    feature: "fence-tilde",
    pattern: CARRIER_MARK,
    reason: "同 NW-05：`~~~` 围栏归一化为 ``` ``` ``（CommonMark 两种围栏等价）。",
    expires: "永久（CommonMark 等价）",
  },
  {
    id: "NW-07-table-separator-padding",
    oracle: "*",
    feature: "table-align",
    pattern: CARRIER_MARK,
    reason:
      "表格分隔行 `|-|-|` ↔ `| --- | --- |` 的空格填充差异；对齐信息（left/center/right）与单元格内容不变。" +
      "GFM 语义等价。",
    expires: "永久（渲染等价）",
  },
  {
    id: "NW-08-list-nested-indent",
    oracle: "md-doc-md",
    feature: "list-nested-2",
    pattern: CARRIER_MARK,
    reason:
      "嵌套列表缩进 2↔4 空格：serializer 统一输出 4 空格（v0.8.0 P11-6 口径），" +
      "解析层级（kinds 序列）不变时缩进无语义影响。",
    expires: "永久（解析等价）",
  },
  {
    id: "NW-09-list-nested-indent-3",
    oracle: "md-doc-md",
    feature: "list-nested-3",
    pattern: CARRIER_MARK,
    reason: "同 NW-08（三层嵌套的缩进归一化）。",
    expires: "永久（解析等价）",
  },
  {
    id: "NW-10-list-marker-char",
    oracle: "md-doc-md",
    feature: "list-bullet",
    pattern: CARRIER_MARK,
    reason:
      "无序列表符号 `*`/`+` 归一化为 `-`（serializer.listToMarkdown 单一输出）。" +
      "解析结构（bullet_list 层级与条目数）不变 —— CommonMark 三种符号语义相同。",
    expires: "永久（解析等价）",
  },
  {
    id: "NW-11-crlf-normalization",
    oracle: "*",
    feature: "crlf",
    pattern: CARRIER_MARK,
    reason:
      "CRLF 在载入侧归一化为 LF（eolPreserve 写盘时还原）。MD 文本在内存层本就应为 LF —— " +
      "v0.16.0 已锁定契约（设计稿 C4/§3.2 A2）。签名层已折叠 \\r\\n，故正常不产生语义差异。",
    expires: "永久（契约）",
  },
  {
    id: "NW-12-blank-line-count",
    oracle: "md-doc-md",
    feature: "blank-gap-multi",
    pattern: CARRIER_MARK,
    reason:
      "块间 2-3 个空行在 PM 侧表达为「空段落」节点，序列化收敛为 1 个空行" +
      "（serializer v0.6.6 问题1 明确口径：空段 = 单个空行，否则往返不收敛）。空行数不承载内容语义。",
    expires: "永久（既有收敛口径）",
  },
  {
    id: "NW-13-blank-head-tail",
    oracle: "md-doc-md",
    feature: "blank-head",
    pattern: CARRIER_MARK,
    reason: "首部空行在 PM 解析后成为空段落/被归并，序列化输出规范化空行数；不影响任何内容或结构。",
    expires: "永久（既有收敛口径）",
  },
  {
    id: "NW-14-image-suffix-writing",
    oracle: "*",
    feature: "image-width-align",
    pattern: CARRIER_MARK,
    reason:
      "`![alt|W|align]` 的 PM 侧解析（parser.ts:1318 内联切分）与渲染侧（renderPipeline.ts:77 尾剥离）" +
      "实现异构但语义同构（设计稿 §2.2 已校准）。签名层只比 image 的 raw content + src，" +
      "故后缀解析差异不伪装成内容差异。",
    expires: "B1 单点化后删除",
  },
  {
    id: "NW-15-table-cell-padding",
    oracle: "*",
    feature: "table-merged-html",
    pattern: CARRIER_MARK,
    reason:
      "表格单元格前后空白与分隔行空格填充的归一化（GFM 语义忽略单元格首尾空白）。" +
      "注意：合并格的 colspan **结构**丢失不在本条目豁免范围（走 BE-02 边界）。",
    expires: "永久（渲染等价）",
  },
];

/** 全量白名单（报告用） */
export const ALL_WHITELIST: WhitespaceEntry[] = [...NORMALIZED_WHITELIST, ...CARRIER_WHITELIST];

/**
 * Blocks 出口（DOCX/LaTeX 的 Block[]）**已声明的能力边界**。
 *
 * 与 normalized 的区别：这些不是"写法归一化"，而是"该出口结构上不承载"。
 * 设计稿 §3.3 B3 要求 Block[] 与 MdNode kind 集合收敛；收敛前，这些形态
 * 在本 oracle 中登记为边界（不计 lossy，但**计入 boundary 并在报告中列出**）。
 */
export interface BoundaryEntry {
  id: string;
  feature: string;
  /** 该边界会导致丢失的块种类（对 kindsOnlyInInput 匹配）；空 = 只丢属性/结构细节 */
  lostKinds: string[];
  reason: string;
  expires: string;
}

export const BLOCKS_EXPORT_BOUNDARIES: BoundaryEntry[] = [
  // ⚠️ 维护规则（Lead 明确要求）：**删除条目必须有依据**。
  // 边界清单必须与实现同步 —— 留过期条目会让"已修好的缺陷"继续被豁免，
  // 而那正是掩盖真缺陷的最隐蔽方式（无条件命中 lostKinds 的条目会遮住别的缺失）。
  //
  // 已删除条目（保留记录，便于审计）：
  // · BE-03-deflist-inner-block：v0.17.0 B3a 把 Block[] 出口切到 UnifiedDoc 树后，
  //   `DefItem.blocks` 真正被填上（dd 内代码块/表格/列表完整保留），边界不再成立 → 删除
  {
    id: "BE-01-footnote-definition-block",
    feature: "footnote-simple",
    lostKinds: ["footnote_block", "footnote"],
    reason:
      "exportBlocks 把 footnote_block/footnote_open 登记为 STRUCTURAL_TOKENS 且**不建 Block**，" +
      "脚注定义正文被摊平成普通段落（见 exportBlocks.ts 的 STRUCTURAL_TOKENS 与 g12 测试）。" +
      "DOCX/LaTeX 出口未实现脚注引用语义 —— 已声明的导出能力边界。",
    expires: "B3 出口切换",
  },
  {
    id: "BE-02-table-merged-html",
    feature: "table-merged-html",
    lostKinds: [],
    reason:
      "合并格以格内 HTML 表达（`<td colspan>`），Block[] 的 table 结构不承载 colspan/rowspan，" +
      "stripTdWrapperText 只剥标签保内容（exportBlocks.ts:150 已声明「不保真项」）。内容不丢，跨度信息丢失。",
    expires: "B3 出口切换",
  },
  {
    id: "BE-04-html-whitelist-tags",
    feature: "html-whitelist",
    lostKinds: [],
    reason:
      "DOCX/LaTeX 实例 html:false，行内白名单标签（u/br/mark/sub/sup）在 Block[] 中只存文本" +
      "（g12 测试确认 `<u>` 等作为字面文本进 runs）。格式信息缺失 —— 已声明能力边界。",
    expires: "B3 出口切换",
  },
  {
    id: "BE-05-image-suffix-in-alt",
    feature: "image-width",
    lostKinds: [],
    reason:
      "图片尺寸/对齐后缀在 DOCX/LaTeX 的 InlineRun 里只剩 imageSrc，宽高对齐不承载（InlineRun 无 width/align 字段）。",
    expires: "B3 出口切换",
  },
  {
    id: "BE-07-doc-edge-blank-lines",
    feature: "blank-head",
    lostKinds: [],
    reason:
      "`Block[]` 是**块的扁平序列**，不承载文档级排版（首个块之前的空行、末尾空行数）。" +
      "重建器只能统一从首个块开始输出 → 头部空行与尾部空行丢失（实测 doc#19/#62/#85 等 13 篇，" +
      "kinds 只缺 paragraph 或什么都不缺，差异仅在空行）。" +
      "这不是解析缺陷：`md-tree-md` 有 `raw.headBlankLines` / `trailingBlankLines` 承载同一信息且**零失败**；" +
      "DOCX/LaTeX 出口按块序列消费，本就不依赖文档级空行。" +
      "若要保真，需给 `Block[]` 增加文档级 raw 字段（超出 B3 范围，且会改导出器消费契约）。",
    expires: "B3 出口切换（若引入文档级 raw）",
  },
  {
    id: "BE-08-doc-tail-blank-lines",
    feature: "blank-tail",
    lostKinds: [],
    reason: "同 BE-07：文档末尾空行数不属于块序列承载的信息。",
    expires: "B3 出口切换（若引入文档级 raw）",
  },
  {
    id: "BE-09-nested-list-depth-precision",
    // feature 用 "*" 系覆盖：嵌套层级差异可出现在任意列表组合里
    // （deep nested 的 bullet/ordered/task 混排都会触发）。
    // 但这样会过宽 → 故配合下方的"必须**无内容差异**"附加条件（见 matchBoundary）。
    feature: "list-nested-3",
    lostKinds: ["bullet_list", "ordered_list", "task_list", "list_item", "paragraph"],
    reason:
      "`Block[]` 的 `ListItem.children` 不承载嵌套层的**缩进宽度**（2/4/6 空格），" +
      "重建器统一用 4 空格。三层以上混合嵌套（如 bullet > bullet > ordered > bullet）时，" +
      "某些层级会被 markdown-it 合并/降级一层 → 内容**完全保真**（missingAtoms/extraAtoms 均为空），" +
      "仅嵌套深度差一层（实测 doc#91：只缺一个 bullet_list@2、零内容差异）。" +
      "B3 若给 ListItem 增加 `indent` 或改用绝对层级表示可消除；" +
      "对 DOCX/LaTeX 出口无影响（它们按树消费，不依赖缩进宽度）。",
    expires: "B3 出口切换（若引入绝对层级）",
  },
  {
    id: "BE-06-footnote-multipara",
    feature: "footnote-multipara",
    lostKinds: ["footnote_block", "footnote"],
    reason: "同 BE-01：多段脚注定义的段落结构随脚注块一起被摊平。",
    expires: "B3 出口切换",
  },
];

/** 匹配形态匹配类白名单 */
export function matchWhitelist(args: {
  oracle: OracleId;
  features: string[];
  diffShape: string;
}): WhitespaceEntry[] {
  return NORMALIZED_WHITELIST.filter((e) => {
    if (e.oracle !== "*" && e.oracle !== args.oracle) return false;
    if (e.feature !== "*" && !args.features.includes(e.feature)) return false;
    try {
      return new RegExp(e.pattern).test(args.diffShape);
    } catch {
      return false;
    }
  });
}

/** 匹配纯载体类白名单（仅在签名全等、仅字节不同时调用） */
export function matchCarrierWhitelist(oracle: OracleId, features: string[]): WhitespaceEntry[] {
  return CARRIER_WHITELIST.filter((e) => {
    if (e.pattern !== CARRIER_MARK) return false;
    if (e.oracle !== "*" && e.oracle !== oracle) return false;
    return features.includes(e.feature);
  });
}

/** 匹配 Blocks 出口边界 */
export function matchBoundary(
  features: string[],
  lostKinds: string[],
  /** 内容差异（missing + extra atoms）。层级精度类边界要求此项为空才可命中 */
  contentDiff: string[] = [],
): BoundaryEntry[] {
  // ⚠️ `lostKinds` 传进来的是签名层的形态：`"footnote_block@0"`（**kind@level**）。
  // 早期直接 `lostKinds.includes("footnote_block")` → 永远不命中，
  // 于是"已声明的脚注边界"被漏判成真 lossy（实测 200 篇里 53 篇全栽在这）。
  // 故这里先剥掉 `@level` 后缀再比。
  const bareKinds = lostKinds.map((k) => k.replace(/@\d+$/, ""));
  return BLOCKS_EXPORT_BOUNDARIES.filter((e) => {
    if (!features.includes(e.feature)) return false;
    // 「任一」而非「全部」：丢一个 footnote_block 会连带丢它内部的 paragraph，
    // 要求全部命中会把本来已声明的边界漏判成结构破坏。
    if (e.lostKinds.length > 0) return e.lostKinds.some((k) => bareKinds.includes(k));
    // ⚠️ `lostKinds` 为空的条目曾"无条件命中" —— 这是**危险的**：
    // 它会遮住同一篇文档里其他真实的结构缺失（实测 doc#65 的 task_list 丢失
    // 就被 BE-03 的无条件命中掩盖了）。现在要求：空 lostKinds 的条目**仅在
    // 没有任何 kinds 缺失时才可命中**（即差异完全落在 attrs/内容层）。
    // 空 lostKinds 的条目也可能伴随「只剩空段落/paragraph 缺失」——
    // 文档级空行在 Block[] 里本就无处承载（见 BE-07），
    // 因此允许"缺失项仅为 paragraph"时命中（否则边界永远不可能生效）。
    if (bareKinds.length === 0) return true;
    if (bareKinds.every((k) => k === "paragraph")) return true;
    // BE-09（嵌套层级精度）：只允许在**无内容差异**时命中 ——
    // 那是"结构层级差一层、内容全在"的量纲限制，不是丢内容。
    // 若同时有内容缺失/凭空增加，则必须落回 lossy/corrupt（不能豁免）。
    if (e.id === "BE-09-nested-list-depth-precision" && contentDiff.length === 0) return true;
    return false;
  });
}

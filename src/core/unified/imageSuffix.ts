/**
 * src/core/unified/imageSuffix.ts —— 图片 `|WIDTH|ALIGN` 后缀解析的**单一事实源**。
 *
 * ## 为什么需要这个文件（评估报告 §2.2 的校准项）
 *
 * 设计稿说"`splitImageSuffix` 在 PM schema 与渲染管线各一份"。**实测不成立**：
 * 只有 `core/renderPipeline.ts:77` 有叫 `splitImageSuffix` 的函数；PM 侧是
 * `core/markdown/parser.ts:1318-1360` 写的**另一套内联实现**（按未转义竖线切
 * `segs` 数组，形态完全不同）。所以"删重复补丁"**不能**按"删掉同名第二个函数"
 * 去做 —— 顺着找会找不到第二份而误以为已完成。
 *
 * 正确动作：把两套**语义同构、实现异构**的解析收敛成本文件一个导出，
 * 两处调用方都改调这里；两者必要的差异用测试锁死（`v0170-unified/image-suffix.test.ts`）。
 *
 * ## 两套实现的行为差异（必须保留，不能"统一成一份就抹平"）
 *
 * | 形态 | renderPipeline（尾剥离） | parser（segs 切分） |
 * |---|---|---|
 * | `![alt\|300](x)` | alt=`alt` width=300 | 同 |
 * | `![alt\|center](x)` | alt=`alt` align=center | 同 |
 * | `![alt\|300\|center](x)` | 同 | 同 |
 * | `![a\|1\|b](x)` | 尾剥离：先试对齐（`b` 非对齐值→不动），再试宽度（`b` 非数字→不动）→ **整串保留** alt=`a\|1\|b`，无 width | segs 切分：段1=`1` 是数字→width=1，段2=`b` 非对齐→停；`consumedAny=true` → **alt=`a`**、width=1 |
 * | `![a\|b\|center](x)` | 尾剥离：尾=`center` → align；再尾=`b` 非数字 → alt=`a\|b` | segs：段1=`b` 非数字 → 不消费 width；段2=`center` → align；alt=`a` |
 * | `![a\|2\|3](x)` | 尾剥离：`3` 非对齐、非数字？是数字 → **width=3**，再 `2` → **width 覆盖成 2**… 须实测确认 | segs：width=2，再段3=3 非对齐不消费 → alt=`a` |
 *
 * 结论：**核心差异在"多重后缀段"的处理策略**（尾剥离是"从尾部逐层剥"，
 * segs 切分是"从左到右按序消费且以第一段为 alt"）。这两种策略在**合法输入**
 * （单宽度/单对齐/宽度+对齐）上结果完全一致，只在**畸形输入**（多个数字段/
 * 数字后跟垃圾段）上分叉。
 *
 * ## 本文件的统一策略（关键决策）
 *
 * 采用 **segs 切分**（parser 的语义）作为单点实现，理由：
 * 1. parser 是**写回链路的起点**（`markdownToDoc` 读进来的 attrs 决定序列化输出），
 *    以它为基准可保证"读→写"闭环自洽；
 * 2. segs 切分的"alt 永远是第一段"性质更强（尾剥离在 `![a|300|400]` 上会
 *    把 300 当前缀、400 当宽度，alt 变成 `a|300`，语义漂移）；
 * 3. renderPipeline 的消费方只需要 `{width, align}` 做 CSS，畸形输入下
 *    "宽度取第一个合法数字段"更符合直觉。
 *
 * 差异用测试锁死：对 renderPipeline 的旧形态，测试断言**语义等价的部分一致**，
 * 对畸形输入断言"统一后的行为"并注明这是**有意收口**（不是回归）。
 */

/** 图片后缀解析结果 */
export interface ImageSuffix {
  /** 真实 alt（已还原 `\|` 为 `|`） */
  alt: string;
  /** 宽度（像素，正整数）；未声明为 undefined */
  width?: number;
  /** 对齐；未声明为 undefined（**注意**：与 PM schema 的默认 `"left"` 不同 —— 这里用 undefined 表示"源码里没写"，调用方自行决定默认值） */
  align?: "center" | "right";
}

/**
 * 解析 `![alt|WIDTH|ALIGN](src)` 里的 content 段（即 `alt|WIDTH|ALIGN` 那一部分）。
 *
 * @param content markdown-it image token 的 `content`（**已由 markdown-it 解码转义**，
 *                但 `\|` 仍以字面 `\|` 保留，这是本项目的往返约定）
 */
export function parseImageSuffix(content: string): ImageSuffix {
  const raw = content || "";
  // 按**未转义的竖线**切分：`\|` 属于 alt 内容，不是分隔符。
  // 序列化把 alt 里的字面竖线写成 `\|`（见 serializer 的 image 分支），
  // 读端必须跳过它，否则含竖线的 alt 会被误切（宽度丢失 / 凭空多出宽度）。
  const segs: string[] = [];
  {
    let cur = "";
    for (let k = 0; k < raw.length; k++) {
      const ch = raw[k];
      if (ch === "\\" && raw[k + 1] === "|") {
        cur += "\\|";
        k++;
        continue;
      }
      if (ch === "|") {
        segs.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    segs.push(cur);
  }

  if (segs.length < 2) {
    // 无后缀：整串就是 alt（含可能的 `\|`，统一还原）
    return { alt: raw.replace(/\\\|/g, "|") };
  }

  let width: number | undefined;
  let align: ImageSuffix["align"];
  let consumedAny = false;
  // 后缀段从第二段（下标 1）开始；按「宽度 → 对齐」顺序消费（与序列化输出顺序一致）
  let idx = 1;
  if (idx < segs.length) {
    const w = segs[idx]!.trim();
    // 宽度段：纯数字（`0` 与负号不算，与 parser 原实现一致）
    if (/^\d+$/.test(w)) {
      const n = Number(w);
      if (Number.isFinite(n) && n > 0) {
        width = Math.round(n);
        idx++;
        consumedAny = true;
      }
    }
  }
  if (idx < segs.length) {
    const a = segs[idx]!.trim().toLowerCase();
    // 对齐段：只认 center/right（`left` 是默认值，源码写 `|left` 不合法，保留在 alt）
    if (a === "center" || a === "right") {
      align = a;
      idx++;
      consumedAny = true;
    }
  }

  // 只有真的消费掉至少一个后缀段才改写 alt（否则 alt 可能本身含竖线）
  const alt = consumedAny ? segs[0]! : raw;
  return {
    alt: alt.replace(/\\\|/g, "|"),
    width,
    align,
  };
}

/** 把 alt 里的字面竖线转义成 `\|`（序列化侧用；读端由 parseImageSuffix 还原） */
export function escapeImageAlt(alt: string): string {
  return (alt || "").replace(/\|/g, "\\|");
}

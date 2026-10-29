// @vitest-environment jsdom
/**
 * v0.15.3 返修（缺陷 A / B 的纯逻辑底层）—— **字符偏移跨文本变更的重映射**。
 *
 * 被测函数（实现位于 `src/utils/textOffsetRemap.ts`，签名以该文件为准）：
 * ```ts
 * export function remapOffsetAcrossTextChange(offset: number, fromText: string, toText: string): number
 * ```
 * 语义（用「公共前缀 P + 公共后缀 S（S 夹到 min(from,to) - P，避免前后缀重叠）」定义
 * 唯一的最小变更区间，全部整数、clamp 到 `[0, toText.length]`）：
 * - `offset <= P` → 原样（变更点之前的内容没动）；
 * - `offset >= fromText.length - S` → `offset - (fromText.length - toText.length)`（尾部整体平移）；
 * - 其余（落在被替换区间内）→ 贴到变更区间起点 `P`。
 *
 * ## 为什么这些用例值得写（而不是"凑数字"）
 * 这个函数是「撤销/恢复后源码面不贴底」的唯一坐标变换：它拿的是 `textarea.value`
 * 里的**字符偏移**（`captureTextAnchor` 的产出），要映射到**目标文本**里的另一偏移，
 * 再交给 `restoreTextAnchor` 把那一行拉回原视口 Y。实机缺陷（打包产物 v0.15.2 /
 * `scripts/v0153-probe-undo-big.mjs`）是：撤销前 `top=21531/max=21948`，撤销后
 * `top=21112/max=21113`（距底 1px，57/61 帧贴底）。根因就是「文本变短后按**像素**
 * 恢复」—— 像素在新文本上指向别处，而浏览器还会把越界值钳到新 max。
 * 所以这里逐条锁死**边界语义**：前缀区不动、尾部平移、被替换区贴边、永不越界。
 *
 * ## 为什么文件头必须是 `// @vitest-environment jsdom`
 * 仓库没有全局 vitest 配置（无 `vitest.config.*`，`package.json` 只有裸 `vitest run`，
 * 默认环境是 `node`）；语义地图 §4-20 记录了这个坑：纯逻辑文件若不带 environment 注释，
 * 一旦将来 import 到 `utils/viewportAnchor`（它读 `getComputedStyle`）就会在 node 环境
 * 里 ReferenceError。带上 jsdom 让本文件与同批测试环境一致、可安全扩展。
 *
 * 纪律：每条断言都写明「为什么这么期望」，不写"看起来差不多"的宽松断言。
 */
import { describe, expect, it } from "vitest";
import {
  clampOffset,
  remapOffsetAcrossTextChange as remap,
} from "../utils/textOffsetRemap";

describe("v0.15.3 · remapOffsetAcrossTextChange：前缀区（offset <= P）原样返回", () => {
  it("等长替换：offset 落在公共前缀内 → 原样返回（变更点之后的字符没动）", () => {
    // "abcdef" → "abXYef"：P=2, S=2，变更区间 [2,4)。
    // offset=1 在前缀"ab"里，它对应的那行文字**逐字节没变** → 必须原地不动。
    expect(remap(1, "abcdef", "abXYef")).toBe(1);
  });

  it("纯插入：offset 正好等于前缀长度 P → 原样（插入点之前的锚点不跟着漂）", () => {
    // "abc" → "abcd"（尾部插 'd'）：P=3、S=0。
    // 视口中央那一行在"前 3 个字符"范围内 → 插入发生在其**后面**，不该被推走。
    expect(remap(2, "abc", "abcd")).toBe(2);
    expect(remap(3, "abc", "abcd")).toBe(3); // offset===P 也走"原样"分支（<= 是闭区间）
  });

  it("前缀不重叠的头部插入（bcd→abcd）：offset=0 → 0（贴住新文本开头）", () => {
    // 头部插入 'a'：P=0（首字符就不等）、S=3。
    // offset=0 <= P=0 → 原样 0；用户在文本最开头，插入后开头仍是同一内容起点。
    expect(remap(0, "bcd", "abcd")).toBe(0);
  });
});

describe("v0.15.3 · remapOffsetAcrossTextChange：尾部未变区整体平移", () => {
  it("纯插入：offset 在旧文本末尾 → 平移 +插入长度（尾部内容整体右移）", () => {
    // "bcd" → "abcd"：P=0、S=3（"bcd" 完全保留在后缀里），尾部整体右移 1。
    // offset=3（旧文本末尾）落在尾部未变区 → 3 + 1 = 4（= 新文本末尾）。
    expect(remap(3, "bcd", "abcd")).toBe(4);
  });

  it("纯删除：offset 在删除区之后 → 平移 -删除长度（尾部内容整体左移，仍指向同一行）", () => {
    // "abcdef" → "abef"：P=2、S=2，删掉 [2,4) 的 "cd"。
    // offset=5（'f'）在尾部未变区 → 5 - (6-4) = 3；新文本 "abef" 里下标 3 正是 'f'。
    expect(remap(5, "abcdef", "abef")).toBe(3);
  });

  it("等长替换：尾部偏移平移量为 0（长度不变 → 同一偏移就是同一内容）", () => {
    // "abcdef" → "abXYef"：长度未变，尾部两个字符不动。
    // offset=5（'f'）→ 5 - 0 = 5；这正是"像素快路径"可用的前提（长度不变语义等价）。
    expect(remap(5, "abcdef", "abXYef")).toBe(5);
  });

  it("CRLF → LF：尾部整体左移 1（`\r` 与被删除的 `\n` 一起算，仍对准同一行）", () => {
    // "line1\r\nline2" → "line1\nline2"：P=5（"line1"）、S=5（"\nline2" 与 "\nline2" 相等 → S 夹到 min(12,11)-5=6，实得 5... 关键：尾部整体左移 1）。
    // offset=6 原本指向 'l'（line2 首字符），映射后 5 → 新文本下标 5 仍是 'l'：同一行字。
    expect(remap(7, "line1\r\nline2", "line1\nline2")).toBe(6);
  });

  it("纯 CJK 删除：尾部偏移按码元平移（与 textarea.selectionStart 同口径）", () => {
    // "中文测试内容" → "中文内容"：P=2（"中文"）、S=2（"内容"），删掉 [2,4) 的"测试"。
    // offset=6（旧文本末尾，越过"内容"）→ 6 - (6-4) = 4 = 新文本末尾。
    expect(remap(6, "中文测试内容", "中文内容")).toBe(4);
  });

  it("base64 长串 → 短标记：尾部偏移平移 -（长度差）", () => {
    // 真实链路：时间线存**真实内容**，textarea 展示层存 mask 后的短标记。
    // 写入后 textarea.value 是 masked（19 字符），锚点 offset 必须映射到它，
    // 否则含图片的文档上偏移会整体错位（实现里专门对 masked 做映射）。
    const real = "![img](data:image/png;base64," + "A".repeat(200) + ")";
    const masked = "![img](image-1.png)";
    expect(real.length).toBe(230);
    expect(masked.length).toBe(19);
    // 偏移 230（真实文本末尾）→ 230 - (230-19) = 19（短标记末尾）。
    expect(remap(230, real, masked)).toBe(19);
    // 反向（masked → real，恢复时可能发生）：尾部从 19 平移到 230。
    expect(remap(19, masked, real)).toBe(230);
  });
});

describe("v0.15.3 · remapOffsetAcrossTextChange：被替换区间内贴到变更起点 P", () => {
  it("两串毫无公共前后缀（abc→xyz）：中段偏移贴到 P=0", () => {
    // 整个文本被换掉时，被替换区间里**没有**可靠的内容对应关系（按比例会凭空造位置）。
    // offset=2 落在 [P, fromLen-S) = [0,3) 内 → 贴到 P=0（离用户眼前内容最近的合法点）。
    expect(remap(2, "abc", "xyz")).toBe(0);
  });

  it("删除区内的偏移贴到 P，而不是「按比例」算出别处", () => {
    // "abcdef" → "abef"：P=2、S=2，被删区间 [2,4)。
    // offset=3（'d'，已被删掉）→ 贴到 P=2，即删除点；用户看到的就是"那一段没了"。
    expect(remap(3, "abcdef", "abef")).toBe(2);
    expect(remap(4, "abcdef", "abef")).toBe(2); // offset===4 仍在被替换区（< fromLen-S=4? 4>=4 属尾部）
  });

  it("base64 长串内部偏移 → 贴到 P（图片被 mask 压缩时锚点落到标记处，不越界）", () => {
    // 真实文本里锚点落在 base64 内部（例如用户在图片那行附近阅读）：
    // 映射到 masked 后只能落在短标记区间起点，绝不能给出 200+ 的越界偏移。
    const real = "![img](data:image/png;base64," + "A".repeat(200) + ")";
    const masked = "![img](image-1.png)";
    expect(remap(100, real, masked)).toBe(7);
  });
});

describe("v0.15.3 · remapOffsetAcrossTextChange：空串 / 越界 / 相同文本等边界", () => {
  it("fromText 为空串：任何 offset 都 clamp 到 [0, toText.length]", () => {
    // 从空文档来的历史条目（如新建文件立刻 Ctrl+Z）没有"旧内容"可锚；
    // 只能夹到目标文本合法范围内，否则 restoreTextAnchor 会因为越界直接跳过恢复。
    expect(remap(0, "", "xyz")).toBe(0);
    expect(remap(5, "", "xyz")).toBe(3); // 越过新文本长度 → 钳到末尾
    expect(remap(-1, "", "xyz")).toBe(0); // 负数 → 0（不产生负坐标）
  });

  it("toText 为空串：一律返回 0（空文档只可能落在 0）", () => {
    // 撤销把整篇内容清空（或历史条目 before=""）时，视口只能贴在 0，这是合法唯一值。
    expect(remap(3, "abc", "")).toBe(0);
    expect(remap(0, "abc", "")).toBe(0);
  });

  it("fromText === toText：原样返回（等价于「没有变更」）", () => {
    // 撤销一个等长替换 / 重映射被重复调用时，禁止任何偏移漂移（幂等性）。
    expect(remap(3, "abc", "abc")).toBe(3);
    expect(remap(0, "", "")).toBe(0);
  });

  it("offset 越界（超过旧文本长度）→ 钳到 fromText.length 后再按尾部规则映射", () => {
    // 历史条目的像素/偏移可能来自更长的旧版本（例如 mask 前后长度不同），
    // 越界必须安全 clamp，而不是算出负数或越界值。
    expect(remap(10, "abcdef", "abXYef")).toBe(6);
    expect(remap(-5, "abcdef", "abXYef")).toBe(0);
  });

  it("前后缀完全重叠（aaaa→aa）→ S 受 min(from,to)-P 夹住，不反算", () => {
    // 这是最容易写错的形状：from="aaaa" 与 to="aa" 的公共前缀 P=2 已经等于 to 全长，
    // 若不把 S 夹到 `min(from,to) - P = 0`，就会算出 S=2、把"变更区间"算反 →
    // offset 在 [2,2) 空区间里，结果不可预测。夹住后：offset<=2 → 原样，其余贴 P。
    expect(remap(0, "aaaa", "aa")).toBe(0);
    expect(remap(2, "aaaa", "aa")).toBe(2);
    expect(remap(3, "aaaa", "aa")).toBe(2); // 落在被替换区间（尾部两个 'a' 被删）→ 贴 P=2
    expect(remap(4, "aaaa", "aa")).toBe(2);
  });

  it("非有限数 / 小数 offset → 按 0 / 向下取整（不产生 NaN 坐标）", () => {
    // 调用方的测量函数可能返回 Infinity（focus-paragraph 的 measure 失败时就是 -Infinity），
    // 任何 NaN 传进 scrollTop 都会让浏览器忽略整次写入 → 静默丢恢复。
    expect(remap(NaN, "abc", "abcd")).toBe(0);
    expect(remap(2.9, "abcdef", "abcXYZdef")).toBe(2);
  });
});

describe("v0.15.3 · remapOffsetAcrossTextChange：CJK / CRLF 逐码元口径", () => {
  it("纯 CJK 删除：被删区间内的偏移贴 P（中文段落删掉一个词）", () => {
    // "中文测试内容" → "中文内容"：P=2、S=2。offset=2（"测"处）落在被删区间 → 贴 P=2。
    expect(remap(2, "中文测试内容", "中文内容")).toBe(2);
    expect(remap(4, "中文测试内容", "中文内容")).toBe(2); // offset=4 是被删区间的右端（不含）→ 贴 P
  });

  it("CRLF 的 \\r 与 \\n 各算 1 个码元（不得按「视觉行」折算）", () => {
    // textarea.selectionStart / value.length 都是**码元**口径（JS 字符串）：\r 也占 1。
    // 若按"行"或"字符"折算，锚点会系统性偏移 1 位 → 每撤销一次就错一行。
    // "line1\r\nline2" → "line1\nline2"：P=5、S 最多 = min(12,11)-5 = 6，实得 5。
    // offset=6 落在尾部未变区（>= fromLen-S=7? 6<7 → 落在被替换的 \r 上！）→ 贴 P=5。
    expect(remap(5, "line1\r\nline2", "line1\nline2")).toBe(5); // offset===P → 原样
    expect(remap(6, "line1\r\nline2", "line1\nline2")).toBe(5); // 落在 \r 上 → 贴 P
  });
});

describe("v0.15.3 · remapOffsetAcrossTextChange：全量不变式（任意输入都安全）", () => {
  it("大量随机文本对：返回值恒为整数且落在 [0, toText.length]（这是 restoreTextAnchor 的前置）", () => {
    // restoreTextAnchor 对 `anchor.offset >= text.length` 会**直接 return**（放弃恢复）：
    // 一旦重映射越界，用户看到的就是"撤销后不恢复滚动" = 贴底缺陷复现。
    // 所以"永不越界"是本函数最硬的不变式，比任何单点期望值都重要。
    const alphabet = ["a", "中", "\n", "\r", "😀", "x"];
    let s = 20261029;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const mk = (n: number) => {
      let out = "";
      for (let i = 0; i < n; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
      return out;
    };
    for (let i = 0; i < 400; i++) {
      const from = mk(Math.floor(rand() * 30));
      const to = rand() < 0.5 ? mk(Math.floor(rand() * 30)) : from;
      const offset = Math.floor(rand() * (from.length + 6)) - 3;
      const got = remap(offset, from, to);
      expect(Number.isInteger(got), `第 ${i} 例必须返回整数（实际 ${got}）`).toBe(true);
      expect(got, `第 ${i} 例 ${JSON.stringify({ offset, from, to })} 不得为负`).toBeGreaterThanOrEqual(0);
      expect(
        got,
        `第 ${i} 例 ${JSON.stringify({ offset, from, to })} 不得越过 toText.length=${to.length}`,
      ).toBeLessThanOrEqual(to.length);
    }
  });

  it("幂等性：把映射结果喂回「同一个变更」不会继续漂移（撤销链路会重复应用）", () => {
    // 实现里 0/60/160ms 三段校正用的是**同一锚点**（幂等），任何"再映射一次会漂"的实现
    // 都会让用户看到"滚一下又滑走"的抖动。
    const from = "abcdef";
    const to = "abef";
    const first = remap(5, from, to);
    expect(first).toBe(3);
    // 再对 (first, to, to) 映射（文本已到位，等价于"没有变更"）→ 不变
    expect(remap(first, to, to)).toBe(first);
  });

  it("clampOffset 与主函数边界一致（共享夹取口径，避免两套 clamp 漂移）", () => {
    // 实现里这两个函数共用同一夹取语义；单独锁住它，防止有人改其中一个而漏另一个。
    expect(clampOffset(-3, 10)).toBe(0);
    expect(clampOffset(30, 10)).toBe(10);
    expect(clampOffset(NaN, 10)).toBe(0);
    expect(clampOffset(3.7, 10)).toBe(3); // 向下取整（码元偏移必须是整数）
    expect(clampOffset(5, 0)).toBe(0); // 空文本：合法上限是 0
  });
});

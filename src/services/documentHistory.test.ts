/**
 * `documentHistory` 强制 Proof 门禁（v0.15.0 WP-B1 阶段 1）
 *
 * 设计文档 §1.5 要求：proof 不过 → **停止 UI 接线**。因此本文件的断言必须是
 * **精确文本序列**，不能用「差不多对」的宽松断言糊过去（也不允许为了变绿放宽阈值）。
 *
 * 覆盖：
 * 1. 主 proof：`begin("A") → src a→ab → pm ab→abc → src abc→abcd`，
 *    undo×3 文本序列精确 = ["abc","ab","A"]，redo×3 = ["ab","abc","abcd"]；
 * 2. CRLF 文档（逐字节往返，不归一化换行）；
 * 3. 含 base64 内联图片（journal 存真实 data URL，绝不存 mask 后的 `image-1.png`）；
 * 4. redo 截断：撤销后新编辑 → 旧 redo 分支失效、游标归位；
 * 5. 预算淘汰：丢最旧但**保留检查点**，仍能 undo 到检查点；
 * 6. 多文档 LRU 40（测试用 maxDocs=3 等价验证口径）；
 * 7. 成组合并（IME / 连续 typing 同一 groupId = 一步）；
 * 8. 失配拒绝（绝不把基于旧文本的条目接在新文本后面 → 绝不覆盖用户编辑）；
 * 9. 跨文件 origin="cross-file" 条目记到未激活文档；
 * 10. `drop` 定点丢弃（跨文件护栏不通过时的动作）不破坏后续 commit。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CHARS,
  MAX_DOCS,
  MAX_STEPS,
  __activeDocKeyForTest,
  __baseTextForTest,
  __charUsageForTest,
  __configureDocumentHistoryForTest,
  __docCountForTest,
  __resetDocumentHistoryForTest,
  begin,
  canRedo,
  canUndo,
  commit,
  currentText,
  drop,
  forget,
  peekRedo,
  peekUndo,
  redo,
  snapshotForTest,
  undo,
} from "./documentHistory";

/** 一步撤销并返回「撤销后宿主应有的文本」（即 entry.before） */
function undoText(docKey?: string): string | null {
  const e = undo(docKey);
  return e ? e.before : null;
}

/** 一步恢复并返回「恢复后宿主应有的文本」（即 entry.after） */
function redoText(docKey?: string): string | null {
  const e = redo(docKey);
  return e ? e.after : null;
}

beforeEach(() => {
  __resetDocumentHistoryForTest();
});

// ─────────────────────────────────────────────────────────────
// 1. 主 proof（设计文档 §1.5 字面要求）
// ─────────────────────────────────────────────────────────────
describe("proof：跨模式统一时间线精确往返", () => {
  it('begin("A") → src a→ab → pm ab→abc → src abc→abcd；undo×3 = ["abc","ab","A"]；redo×3 = ["ab","abc","abcd"]', () => {
    begin("doc-1", "A");
    expect(currentText()).toBe("A");

    // commit 省略 before：由时间线已知宿主文本推出（等价于 adapter 显式传 before）
    const e1 = commit({ after: "ab", origin: "source" });
    const e2 = commit({ after: "abc", origin: "pm" });
    const e3 = commit({ after: "abcd", origin: "source" });

    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(e3).not.toBeNull();
    // before 链必须逐字节衔接
    expect(e1!.before).toBe("A");
    expect(e2!.before).toBe("ab");
    expect(e3!.before).toBe("abc");
    // 时间线当前文本 = 最后一条 after
    expect(currentText()).toBe("abcd");

    // 三条条目按时间升序、游标在末尾
    const snap = snapshotForTest("doc-1")!;
    expect(snap.entries.map((e) => e.after)).toEqual(["ab", "abc", "abcd"]);
    expect(snap.cursor).toBe(3);

    // undo×3：文本序列精确
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
    expect(undoText()).toBe("abc");
    expect(currentText()).toBe("abc");
    expect(undoText()).toBe("ab");
    expect(currentText()).toBe("ab");
    expect(undoText()).toBe("A");
    expect(currentText()).toBe("A");
    expect([undoText(), undoText(), undoText()]).toEqual([null, null, null]);
    expect(canUndo()).toBe(false);

    // redo×3：文本序列精确
    expect(canRedo()).toBe(true);
    expect(redoText()).toBe("ab");
    expect(currentText()).toBe("ab");
    expect(redoText()).toBe("abc");
    expect(currentText()).toBe("abc");
    expect(redoText()).toBe("abcd");
    expect(currentText()).toBe("abcd");
    expect([redoText(), redoText()]).toEqual([null, null]);
    expect(canRedo()).toBe(false);
    expect(canUndo()).toBe(true);
  });

  it("跨模式交替 ≥3 次（src/pm/src/pm/src）—— 一条时间线，undo 到底、redo 到顶", () => {
    begin("doc-x", "0");
    const seq: Array<[string, "source" | "pm"]> = [
      ["1", "source"],
      ["12", "pm"],
      ["123", "source"],
      ["1234", "pm"],
      ["12345", "source"],
    ];
    for (const [after, origin] of seq) {
      expect(commit({ after, origin })).not.toBeNull();
    }
    const snap = snapshotForTest("doc-x")!;
    expect(snap.entries.length).toBe(5);

    const undone: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = undoText();
      expect(t).not.toBeNull();
      undone.push(t!);
    }
    expect(undone).toEqual(["1234", "123", "12", "1", "0"]);

    const redone: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = redoText();
      expect(t).not.toBeNull();
      redone.push(t!);
    }
    expect(redone).toEqual(["1", "12", "123", "1234", "12345"]);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. CRLF 文档
// ─────────────────────────────────────────────────────────────
describe("CRLF 文档：逐字节往返，绝不归一化换行", () => {
  it("CRLF 内容原样进出（\\r\\n 不被吞、不被改写）", () => {
    const crlf1 = "# 标题\r\n\r\n第一段\r\n";
    const crlf2 = "# 标题\r\n\r\n第一段\r\n第二段\r\n";
    const crlf3 = "# 标题\r\n\r\n第一段\r\n第二段\r\n第三段\r\n";
    begin("crlf.md", crlf1);

    expect(commit({ after: crlf2, origin: "source" })!.before).toBe(crlf1);
    expect(commit({ after: crlf3, origin: "pm" })!.before).toBe(crlf2);
    expect(currentText()).toBe(crlf3);

    // 撤销回来的文本必须**含 \r\n 且一个都不少**（crlf2 恰有 4 个换行）
    const u1 = undoText()!;
    expect(u1).toBe(crlf2);
    expect(u1.match(/\r\n/g)?.length).toBe(4);
    // 逐字节相等已保证不是 LF（否则 toBe 就失败了）；这里再显式断言一次
    expect(u1.includes("\n\n")).toBe(false);
    expect(u1.includes("\r\n\r\n")).toBe(true);
    expect(crlf2.length - u1.replace(/\r\n/g, "").length).toBe(8); // 4×"\r\n"

    const u2 = undoText()!;
    expect(u2).toBe(crlf1);
    expect(u2.includes("\n")).toBe(true);
    expect(u2.includes("\r\n")).toBe(true);

    // redo 回到 CRLF 原文
    expect(redoText()).toBe(crlf2);
    expect(redoText()).toBe(crlf3);
    expect(currentText()).toBe(crlf3);
  });

  it("切回标签：begin 传当前内容时保留历史；传旧内容时重置（位置语义已失效）", () => {
    const crlf = "a\r\nb\r\n";
    begin("c.md", crlf);
    const edited = "a\r\nb\r\nc\r\n";
    commit({ after: edited, origin: "source" });
    // 切标签回来：标签此刻的内容就是 edited → 历史保留
    begin("c.md", edited);
    expect(canUndo("c.md")).toBe(true);
    expect(snapshotForTest("c.md")!.entries.length).toBe(1);
    // 外部重载成另一份内容 → 历史必须丢弃（旧条目位置语义失效）
    begin("c.md", crlf);
    expect(canUndo("c.md")).toBe(false);
    expect(snapshotForTest("c.md")!.entries.length).toBe(0);
    expect(currentText("c.md")).toBe(crlf);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. 含 base64 内联图片：存真实内容，绝不存 mask 后文本
// ─────────────────────────────────────────────────────────────
const DATA_URL_PNG =
  "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUg".repeat(30) + "==";
const MD_WITH_B64 = `# 图\n\n![截图](${DATA_URL_PNG})\n`;
const MD_WITH_B64_EDITED = `# 图\n\n![截图](${DATA_URL_PNG})\n\n补充一行\n`;

describe("含 base64 图片：journal 存真实内容（不得是 image-1.png 短标记）", () => {
  it("before/after 均是完整 data URL，撤销回来的文本可直接写盘", () => {
    // 前置：这份内容 >= 512 字符阈值，正是会被 maskBase64Images 换短的形态
    expect(MD_WITH_B64.length).toBeGreaterThan(512);
    begin("img.md", MD_WITH_B64);
    const e = commit({ after: MD_WITH_B64_EDITED, origin: "source" })!;

    // journal 里必须是真实内容
    expect(e.before).toBe(MD_WITH_B64);
    expect(e.after).toBe(MD_WITH_B64_EDITED);
    expect(e.before.includes(DATA_URL_PNG)).toBe(true);
    expect(e.after.includes(DATA_URL_PNG)).toBe(true);
    // 绝不出现 mask 后的短标记形态
    expect(e.before.includes("](image-1.png)")).toBe(false);
    expect(e.after.includes("](image-1.png)")).toBe(false);
    expect(snapshotForTest("img.md")!.entries[0].before.includes("base64,")).toBe(true);

    // 撤销 → 文本仍是完整 data URL（否则写盘会把图片永久换成短标记 = 数据损坏）
    const back = undoText()!;
    expect(back).toBe(MD_WITH_B64);
    expect(back.includes(DATA_URL_PNG)).toBe(true);
    expect(back.includes("](image-1.png)")).toBe(false);

    // redo 同样完整
    const fwd = redoText()!;
    expect(fwd).toBe(MD_WITH_B64_EDITED);
    expect(fwd.includes(DATA_URL_PNG)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. redo 截断
// ─────────────────────────────────────────────────────────────
describe("redo 截断：撤销后的新编辑立即清空 redo 分支", () => {
  it("undo 后新 commit → canRedo=false，且旧 redo 分支不再可用", () => {
    begin("t.md", "A");
    commit({ after: "ab", origin: "source" });
    commit({ after: "abc", origin: "pm" });
    commit({ after: "abcd", origin: "source" });

    // 撤销两步 → 当前 "ab"，redo 分支 = ["abc","abcd"]
    expect(undoText()).toBe("abc");
    expect(undoText()).toBe("ab");
    expect(canRedo()).toBe(true);
    expect(peekRedo()!.after).toBe("abc");

    // 新编辑（与旧分支完全不同的内容）→ 截断
    const e = commit({ after: "aZ", origin: "source" })!;
    expect(e.before).toBe("ab");
    expect(canRedo()).toBe(false);
    expect(peekRedo()).toBeNull();
    expect(redoText()).toBeNull();

    const snap = snapshotForTest("t.md")!;
    expect(snap.entries.map((x) => x.after)).toEqual(["ab", "aZ"]);
    expect(snap.cursor).toBe(2);

    // 时间线仍可正常撤销回初值
    expect(undoText()).toBe("ab");
    expect(undoText()).toBe("A");
    expect(undoText()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 5. 预算淘汰：丢最旧 + 保留检查点
// ─────────────────────────────────────────────────────────────
describe("预算淘汰：超限丢最旧，但保留检查点（仍能 undo 到检查点）", () => {
  it("步数预算：MAX_STEPS 超限后仍可 undo，最低只能回到检查点", () => {
    // 造 5 条，预算 3 → 前 2 条被淘汰
    __configureDocumentHistoryForTest({ maxSteps: 3 });
    begin("s.md", "v0");
    for (let i = 1; i <= 5; i++) {
      expect(commit({ after: `v${i}`, origin: "source" })).not.toBeNull();
    }
    const snap = snapshotForTest("s.md")!;
    expect(snap.entries.length).toBe(3);
    expect(snap.entries.map((e) => e.before)).toEqual(["v2", "v3", "v4"]);
    expect(snap.entries.map((e) => e.after)).toEqual(["v3", "v4", "v5"]);
    // 检查点前移到被淘汰最旧条目的 after
    expect(__baseTextForTest("s.md")).toBe("v2");

    const undone: string[] = [];
    for (let i = 0; i < 3; i++) undone.push(undoText()!);
    expect(undone).toEqual(["v4", "v3", "v2"]);
    // 撤到底：不能越过检查点（旧条目已丢弃），但**确实**能撤到检查点
    expect(undoText()).toBeNull();
    expect(canUndo()).toBe(false);
    // 从检查点 redo 仍完整
    expect(redoText()).toBe("v3");
    expect(redoText()).toBe("v4");
    expect(redoText()).toBe("v5");
  });

  it("字符预算：MAX_CHARS 超限时丢最旧条目，占用回落到预算内且至少留一条", () => {
    // 每条 400 字符左右，预算 2500 → 稳定只保留约 2~3 条
    __configureDocumentHistoryForTest({ maxChars: 2500 });
    const chunk = "x".repeat(400);
    begin("big.md", "");
    for (let i = 1; i <= 8; i++) {
      commit({ after: chunk + i, origin: "source" });
    }
    const snap = snapshotForTest("big.md")!;
    expect(snap.entries.length).toBeGreaterThanOrEqual(1);
    expect(snap.entries.length).toBeLessThan(8);
    // 淘汰生效后实际占用必须真的回落到预算内（不是"反正没测出来"）
    expect(__charUsageForTest("big.md")).toBeLessThanOrEqual(2500);
    expect(canUndo()).toBe(true);

    // 淘汰后仍能一路 undo 到检查点（检查点 = 被淘汰最旧条目的 after）
    const reached: string[] = [];
    for (;;) {
      const t = undoText();
      if (t === null) break;
      reached.push(t);
    }
    expect(reached.length).toBe(snap.entries.length);
    expect(reached[reached.length - 1]).toBe(__baseTextForTest("big.md"));
    // 从检查点仍可完整 redo 回终值
    for (let i = 0; i < snap.entries.length; i++) expect(redoText()).not.toBeNull();
    expect(currentText()).toBe(chunk + "8");
  });

  it("真实上限常量与设计文档一致（200 步 / 32MB / 40 文档）", () => {
    expect(MAX_STEPS).toBe(200);
    expect(MAX_CHARS).toBe(32 * 1024 * 1024);
    expect(MAX_DOCS).toBe(40);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. 多文档 LRU
// ─────────────────────────────────────────────────────────────
describe("多文档 LRU：上限 40，超限丢最久未使用（测试用 maxDocs 等价验证）", () => {
  it("超限丢最旧整份历史；被丢弃文档的 undo 返回 null（绝不跨文档误撤）", () => {
    __configureDocumentHistoryForTest({ maxDocs: 3 });
    for (const k of ["d1", "d2", "d3", "d4"]) {
      begin(k, `${k}-init`);
      commit({ after: `${k}-edit`, origin: "source" });
    }
    expect(__docCountForTest()).toBe(3);
    // d1 最久未使用 → 被整份淘汰
    expect(snapshotForTest("d1")).toBeNull();
    expect(undo("d1")).toBeNull();
    // 其余都还在，且历史完整
    for (const k of ["d2", "d3", "d4"]) {
      expect(canUndo(k)).toBe(true);
    }
    // 顺序是 d2,d3,d4（d2 最旧）
    begin("d5", "d5-init");
    expect(snapshotForTest("d2")).toBeNull();
    expect(snapshotForTest("d3")).not.toBeNull();
  });

  it("文档之间完全隔离：A 的 undo 不会动到 B 的内容", () => {
    begin("A", "A0");
    commit({ after: "A1", origin: "source" });
    begin("B", "B0");
    commit({ after: "B1", origin: "pm" });
    // 当前活跃是 B
    expect(undoText()).toBe("B0");
    expect(currentText("B")).toBe("B0");
    // A 完全不受影响
    expect(currentText("A")).toBe("A1");
    expect(peekUndo("A")!.after).toBe("A1");
    // 切回 A，用显式 docKey 撤销
    expect(undoText("A")).toBe("A0");
    expect(currentText("A")).toBe("A0");
    expect(currentText("B")).toBe("B0");
  });

  it("forget 丢弃整份历史（关闭标签）", () => {
    begin("f.md", "x");
    commit({ after: "xy", origin: "source" });
    expect(canUndo("f.md")).toBe(true);
    forget("f.md");
    expect(snapshotForTest("f.md")).toBeNull();
    expect(canUndo("f.md")).toBe(false);
    expect(currentText("f.md")).toBeNull();
    expect(__activeDocKeyForTest()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 7. 成组合并（IME / 连续 typing）
// ─────────────────────────────────────────────────────────────
describe("归并：同 groupId 相邻条目合成一步（IME / 连续 typing）", () => {
  it("同一 groupId 的三次键入 = 一步；undo 一次回到本组起点", () => {
    begin("g.md", "a");
    const g1 = commit({ after: "ab", origin: "source", groupId: "typing-1" })!;
    const g2 = commit({ after: "abc", origin: "source", groupId: "typing-1" })!;
    const g3 = commit({ after: "abcd", origin: "source", groupId: "typing-1" })!;
    // 合并返回同一条目（id 不变）
    expect(g1.id).toBe(g2.id);
    expect(g2.id).toBe(g3.id);
    expect(g1.before).toBe("a");
    expect(g3.after).toBe("abcd");

    const snap = snapshotForTest("g.md")!;
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0].before).toBe("a");
    expect(snap.entries[0].after).toBe("abcd");

    expect(undoText()).toBe("a");
    expect(undoText()).toBeNull();
    expect(redoText()).toBe("abcd");
  });

  it("不同 groupId / 不同 origin 不合并", () => {
    begin("g2.md", "a");
    commit({ after: "ab", origin: "source", groupId: "typing-1" });
    commit({ after: "abc", origin: "source", groupId: "typing-2" });
    commit({ after: "abcd", origin: "pm", groupId: "typing-2" });
    expect(snapshotForTest("g2.md")!.entries.length).toBe(3);
  });

  it("撤销后同 groupId 的新输入**不得**与已撤销的旧组合并（否则 redo 会多吐内容）", () => {
    begin("g3.md", "a");
    commit({ after: "ab", origin: "source", groupId: "t1" });
    commit({ after: "abc", origin: "source", groupId: "t1" });
    expect(undoText()).toBe("a"); // 撤销整组
    // 与已撤销组同 groupId 的新输入
    commit({ after: "aX", origin: "source", groupId: "t1" });
    const snap = snapshotForTest("g3.md")!;
    expect(snap.entries.map((e) => e.after)).toEqual(["aX"]);
    expect(snap.entries[0].after).toBe("aX");
  });
});

// ─────────────────────────────────────────────────────────────
// 8. 失配拒绝
// ─────────────────────────────────────────────────────────────
describe("一致性格栏：文本失配一律拒绝入库（绝不覆盖用户编辑）", () => {
  it("显式 before 与时间线已知文本不一致 → 返回 null 且时间线不变", () => {
    begin("m.md", "A");
    commit({ after: "ab", origin: "source" });
    // 时间线已知文本是 "ab"，却声称 before 是 "NOPE"
    const r = commit({ before: "NOPE", after: "abc", origin: "source" });
    expect(r).toBeNull();
    expect(currentText()).toBe("ab");
    expect(snapshotForTest("m.md")!.entries.length).toBe(1);

    // 重新 begin 同步后即可正常入库（阶段 2 coordinator 的恢复动作）
    begin("m.md", "ab");
    expect(commit({ before: "ab", after: "abc", origin: "source" })).not.toBeNull();
    expect(currentText()).toBe("abc");
  });

  it("before === after（无变化）不产生历史条目", () => {
    begin("n.md", "A");
    expect(commit({ after: "A", origin: "source" })).toBeNull();
    expect(snapshotForTest("n.md")!.entries.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 9. 跨文件 origin="cross-file"
// ─────────────────────────────────────────────────────────────
describe("跨文件替换：作为目标文档时间线上的普通条目", () => {
  it("往**未激活**文档记 cross-file 条目，undo 时返回 before 供护栏校验", () => {
    begin("cur.md", "cur0");
    begin("other.md", "hello cat\n");
    // 现在活跃的是 other.md；模拟切回 cur.md
    begin("cur.md", "cur0");
    expect(__activeDocKeyForTest()).toBe("cur.md");

    // 跨文件替换：目标 other.md（未激活）
    const e = commit(
      { before: "hello cat\n", after: "hello DOG\n", origin: "cross-file" },
      "other.md",
    )!;
    expect(e.origin).toBe("cross-file");
    expect(currentText("cur.md")).toBe("cur0");
    expect(currentText("other.md")).toBe("hello DOG\n");

    // 用户切到 other.md 按 Ctrl+Z：peek 出 after 用于护栏比对，再 undo
    const peeked = peekUndo("other.md")!;
    expect(peeked.after).toBe("hello DOG\n"); // 护栏基准
    expect(currentText("other.md")).toBe("hello DOG\n"); // 与宿主逐字节一致 → 可安全应用
    const applied = undo("other.md")!;
    expect(applied.before).toBe("hello cat\n");
    expect(currentText("other.md")).toBe("hello cat\n");
    // redo 回到替换后
    expect(redo("other.md")!.after).toBe("hello DOG\n");
  });

  it("护栏不通过（替换后用户手改过）→ drop 丢弃该条目，绝不覆盖，时间线仍可用", () => {
    begin("o.md", "base");
    const e = commit({ before: "base", after: "replaced", origin: "cross-file" })!;

    // 模拟用户手改：宿主文本已变成 "replaced + 我的手改"
    const hostNow = "replaced + 我的手改";
    const peeked = peekUndo("o.md")!;
    expect(peeked.after !== hostNow).toBe(true); // 护栏判据：不一致 → 丢弃

    expect(drop("o.md", e.id)).toBe(true);
    // 条目已丢弃
    expect(peekUndo("o.md")).toBeNull();
    expect(canUndo("o.md")).toBe(false);
    // 绝不覆盖：knownText 未变成条目里的文本
    expect(currentText("o.md")).toBe("replaced");
    // 丢弃后仍能继续记新编辑（knownText 由 begin 同步）
    begin("o.md", hostNow);
    expect(commit({ before: hostNow, after: hostNow + "!", origin: "source" })).not.toBeNull();
    expect(undo("o.md")!.before).toBe(hostNow);
  });
});

// ─────────────────────────────────────────────────────────────
// 10. 快照 / 诊断
// ─────────────────────────────────────────────────────────────
describe("snapshotForTest：返回快照而非内部引用（测试不被原地修改污染）", () => {
  it("改快照不影响内部时间线", () => {
    begin("s1.md", "A");
    commit({ after: "ab", origin: "source" });
    const snap = snapshotForTest("s1.md")!;
    snap.entries[0].after = "TAMPERED";
    snap.cursor = 0;
    const again = snapshotForTest("s1.md")!;
    expect(again.entries[0].after).toBe("ab");
    expect(again.cursor).toBe(1);
    expect(currentText("s1.md")).toBe("ab");
  });

  it("未知 docKey 的 snapshot 为 null", () => {
    expect(snapshotForTest("不存在.md")).toBeNull();
  });
});

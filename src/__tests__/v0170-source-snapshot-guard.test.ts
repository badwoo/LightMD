/**
 * src/__tests__/v0170-source-snapshot-guard.test.ts —— 快照新鲜度守卫
 *
 * ## 这条测试存在的唯一理由
 *
 * v0.17.0 P0-1 拆分后，36 个既有测试改读 `EditorContainerSource.ts.txt`
 * （容器 + 8 个 pane 的源码文本联合体），以免 111 条**形态断言**因为文本搬走而失效。
 *
 * 但这引入了新的失效模式 —— 比"断言失效"更隐蔽：
 * 如果快照是**手抄的静态副本**，那么有人改了 `SourcePane.tsx` 里的逻辑时，
 * 快照不会跟着变，那 111 条断言仍然 `toContain` 通过 → **永久假绿**，
 * 回归护栏退化成装饰品。
 *
 * 因此这里把"快照必须反映**当前**源码"变成一条**会红的断言**：
 * 当场重新拼接一遍，与仓库里的快照逐字节比对，不等就失败。
 * 于是「改了 pane 忘了重生快照」是一个失败，而不是一个沉默的假绿。
 *
 * ## 修复方式（失败信息里也会打印）
 *
 * ```bash
 * cd lightmd && pnpm gen:snapshot
 * ```
 *
 * ## 为什么用 node 脚本而不是在测试里重复拼接逻辑
 *
 * 拼接规则必须**单源**：如果测试自己再实现一遍拼接，两者就可能漂移
 * （生成器改了顺序、测试没改 → 永远红或永远绿）。所以测试直接 import
 * 生成器的 `buildSnapshot()`，与 `pnpm gen:snapshot` 使用**同一份代码**。
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error —— 生成器是 .mjs（给 node CLI 与测试共用同一份拼接逻辑），无类型声明
import { buildSnapshot } from "../../scripts/v0170-gen-source-snapshot.mjs";

const REPO_ROOT = join(__dirname, "..", "..");
const SNAPSHOT_PATH = join(
  REPO_ROOT,
  "src",
  "components",
  "editor",
  "EditorContainerSource.ts.txt",
);

const normalize = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

describe("v0.17.0 P0-1：源码文本快照必须与当前源码一致（防化石假绿）", () => {
  it("快照文件存在", () => {
    expect(existsSync(SNAPSHOT_PATH), `快照文件缺失：${SNAPSHOT_PATH}`).toBe(true);
  });

  it("快照内容 == 当场重新拼接的结果（不等则说明忘了重生）", () => {
    const actual = normalize(readFileSync(SNAPSHOT_PATH, "utf-8"));
    const expected = normalize(buildSnapshot() as string);

    if (actual !== expected) {
      // 给出可定位的差异行，而不是一句 "expected !== received"
      const a = actual.split("\n");
      const b = expected.split("\n");
      const at = a.findIndex((line, i) => line !== b[i]);
      const lineNo = at === -1 ? Math.min(a.length, b.length) : at;
      throw new Error(
        [
          "src/components/editor/EditorContainerSource.ts.txt 已过期 —— 它没有反映当前源码。",
          "",
          "这个文件是 36 个既有测试（111 条形态断言）读取的「源码文本」，",
          "它必须由生成器产出、不能手改。你现在改动了 EditorContainer.tsx 或某个 pane，",
          "但没有重新生成快照，所以那些断言会对着旧文本通过（假绿）。",
          "",
          "修复：",
          "  cd lightmd && pnpm gen:snapshot",
          "",
          `首个差异行：第 ${lineNo + 1} 行`,
          `  快照： ${JSON.stringify((a[lineNo] ?? "<EOF>").slice(0, 120))} `,
          `  应为： ${JSON.stringify((b[lineNo] ?? "<EOF>").slice(0, 120))} `,
        ].join("\n"),
      );
    }
    expect(actual).toBe(expected);
  });

  it("快照头部带「禁止手改 + 生成器」标记（防止有人以为是手写文件而去编辑它）", () => {
    const text = readFileSync(SNAPSHOT_PATH, "utf-8");
    expect(text.slice(0, 600)).toContain("禁止手改");
    expect(text.slice(0, 600)).toContain("v0170-gen-source-snapshot.mjs");
  });

  it("快照收录了全部 8 个 pane 的源码（漏一个就会让该 pane 的断言假绿）", () => {
    const text = normalize(readFileSync(SNAPSHOT_PATH, "utf-8"));
    const panes = [
      "historyhost/HistoryHost.tsx",
      "modesync/ModeSync.tsx",
      "sourcepane/SourcePane.tsx",
      "aiassistpane/AiAssistPane.tsx",
      "searchhost/SearchHost.tsx",
      "aichatpane/AiChatPane.tsx",
      "formatmenuhost/FormatMenuHost.tsx",
      "previewpane/PreviewPane.tsx",
    ];
    for (const p of panes) {
      expect(text, `快照缺少 pane：${p}`).toContain(
        `src/components/editor/panes/${p}`,
      );
    }
  });
});

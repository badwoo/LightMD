/**
 * v0.8.4 需求6：文件树展开/收起动画方向垂直化——防回退断言。
 * 读取 FileTree.css 源文本，断言子节点 keyframes 不再包含水平位移（translateX），
 * 改为垂直位移（translateY 轻微下沉/上浮）+ 淡入淡出。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cssPath = join(__dirname, "..", "components", "sidebar", "FileTree.css");
const css = readFileSync(cssPath, "utf-8");

/** 截取指定 keyframes 块源文本（从 @keyframes 名称到配对大括号结束） */
function extractKeyframes(name: string): string {
  const marker = `@keyframes ${name}`;
  const start = css.indexOf(marker);
  expect(start, `FileTree.css 中应存在 ${marker}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = start;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return css.slice(start, end);
}

describe("v0.8.4 需求6：文件树展开/收起动画垂直化", () => {
  it("tree-node-slide-in 不含 translateX，含 translateY(4px) 下沉入场", () => {
    const block = extractKeyframes("tree-node-slide-in");
    expect(block).not.toContain("translateX");
    expect(block).toContain("translateY(4px)");
    expect(block).toContain("opacity: 0");
  });

  it("tree-node-slide-out 不含 translateX，含 translateY(-4px) 上浮离场", () => {
    const block = extractKeyframes("tree-node-slide-out");
    expect(block).not.toContain("translateX");
    expect(block).toContain("translateY(-4px)");
    expect(block).toContain("opacity: 0");
  });
});

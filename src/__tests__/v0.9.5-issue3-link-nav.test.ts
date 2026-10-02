/**
 * v0.9.5 问题3:文档内链接点击导航——resolveLinkAction 纯函数用例
 */
import { describe, it, expect } from "vitest";
import { resolveLinkAction, anchorMatchesHeading } from "../utils/linkNav";

describe("v0.9.5 问题3 resolveLinkAction", () => {
  it("相对路径基于当前文档所在目录解析", () => {
    const a = resolveLinkAction("./notes/b.md", "D:/docs/index.md");
    expect(a).toEqual({ kind: "open-internal", path: "D:/docs/notes/b.md" });
    const b = resolveLinkAction("b.md", "D:/docs/index.md");
    expect(b).toEqual({ kind: "open-internal", path: "D:/docs/b.md" });
  });

  it("../ 上级目录解析", () => {
    expect(resolveLinkAction("../shared/x.md", "D:/docs/sub/a.md")).toEqual({
      kind: "open-internal",
      path: "D:/docs/shared/x.md",
    });
  });

  it("Windows 反斜杠绝对路径直接打开", () => {
    const a = resolveLinkAction("D:\\notes\\b.md", "D:/docs/index.md");
    expect(a).toEqual({ kind: "open-internal", path: "D:/notes/b.md" });
  });

  it("POSIX 绝对路径直接打开", () => {
    expect(resolveLinkAction("/home/u/b.md", "/home/u/a.md")).toEqual({
      kind: "open-internal",
      path: "/home/u/b.md",
    });
  });

  it("锚点返回 scroll-anchor(解码 URI)", () => {
    expect(resolveLinkAction("#%E6%A0%87%E9%A2%98", "D:/docs/a.md")).toEqual({
      kind: "scroll-anchor",
      anchor: "标题",
    });
    expect(resolveLinkAction("#section-1", "D:/docs/a.md")).toEqual({
      kind: "scroll-anchor",
      anchor: "section-1",
    });
  });

  it("http/https/mailto 返回外部打开", () => {
    expect(resolveLinkAction("https://example.com", "D:/a.md")).toEqual({
      kind: "open-external",
      href: "https://example.com",
    });
    expect(resolveLinkAction("mailto:a@b.com", "D:/a.md").kind).toBe("open-external");
  });

  it("危险/未知协议不动作", () => {
    expect(resolveLinkAction("javascript:alert(1)", "D:/a.md").kind).toBe("none");
    expect(resolveLinkAction("file:///C:/x", "D:/a.md").kind).toBe("none");
    expect(resolveLinkAction("data:text/html,x", "D:/a.md").kind).toBe("none");
  });

  it("临时文件(无路径)的相对链接不动作;空 href 不动作", () => {
    expect(resolveLinkAction("b.md", "").kind).toBe("none");
    expect(resolveLinkAction("", "D:/a.md").kind).toBe("none");
    expect(resolveLinkAction("   ", "D:/a.md").kind).toBe("none");
  });
});

describe("v0.9.5 问题3 anchorMatchesHeading", () => {
  it("slug 规则与渲染层 slugify 一致(中文保留,大小写归一)", () => {
    expect(anchorMatchesHeading("快速开始", "快速开始")).toBe(true);
    expect(anchorMatchesHeading("Quick Start", "quick start")).toBe(true);
    expect(anchorMatchesHeading("section-1", "Section 1")).toBe(true);
    expect(anchorMatchesHeading("nope", "标题")).toBe(false);
  });
});

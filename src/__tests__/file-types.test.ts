/**
 * 文件类型判断和语言识别测试
 */
import { describe, it, expect } from "vitest";
import {
  isMarkdownFile,
  isSupportedTextFile,
  getFileLanguage,
  MARKDOWN_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "../utils/constants";

describe("isMarkdownFile", () => {
  it("识别 .md 文件", () => {
    expect(isMarkdownFile("test.md")).toBe(true);
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("path/to/file.md")).toBe(true);
  });

  it("识别 .markdown 文件", () => {
    expect(isMarkdownFile("test.markdown")).toBe(true);
  });

  it("识别 .mdown 文件", () => {
    expect(isMarkdownFile("test.mdown")).toBe(true);
  });

  it("识别 .mkd 文件", () => {
    expect(isMarkdownFile("test.mkd")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(isMarkdownFile("TEST.MD")).toBe(true);
    expect(isMarkdownFile("Test.Md")).toBe(true);
  });

  it("拒绝非 Markdown 文件", () => {
    expect(isMarkdownFile("test.txt")).toBe(false);
    expect(isMarkdownFile("test.js")).toBe(false);
    expect(isMarkdownFile("test.html")).toBe(false);
    expect(isMarkdownFile("test")).toBe(false);
  });
});

describe("isSupportedTextFile", () => {
  it("识别 Markdown 文件", () => {
    expect(isSupportedTextFile("test.md")).toBe(true);
    expect(isSupportedTextFile("test.markdown")).toBe(true);
  });

  it("识别文本文件", () => {
    expect(isSupportedTextFile("test.txt")).toBe(true);
    expect(isSupportedTextFile("test.log")).toBe(true);
    expect(isSupportedTextFile("test.csv")).toBe(true);
  });

  it("识别代码文件", () => {
    expect(isSupportedTextFile("test.js")).toBe(true);
    expect(isSupportedTextFile("test.ts")).toBe(true);
    expect(isSupportedTextFile("test.py")).toBe(true);
    expect(isSupportedTextFile("test.rs")).toBe(true);
    expect(isSupportedTextFile("test.go")).toBe(true);
    expect(isSupportedTextFile("test.java")).toBe(true);
    expect(isSupportedTextFile("test.cpp")).toBe(true);
    expect(isSupportedTextFile("test.html")).toBe(true);
    expect(isSupportedTextFile("test.css")).toBe(true);
    expect(isSupportedTextFile("test.json")).toBe(true);
    expect(isSupportedTextFile("test.yml")).toBe(true);
    expect(isSupportedTextFile("test.sql")).toBe(true);
  });

  it("识别无扩展名的常见文件名", () => {
    expect(isSupportedTextFile("Makefile")).toBe(true);
    expect(isSupportedTextFile("Dockerfile")).toBe(true);
    expect(isSupportedTextFile("LICENSE")).toBe(true);
    expect(isSupportedTextFile("README")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(isSupportedTextFile("TEST.JS")).toBe(true);
    expect(isSupportedTextFile("Test.TS")).toBe(true);
  });

  it("拒绝不支持的文件类型", () => {
    expect(isSupportedTextFile("test.exe")).toBe(false);
    expect(isSupportedTextFile("test.png")).toBe(false);
    expect(isSupportedTextFile("test.jpg")).toBe(false);
    expect(isSupportedTextFile("test.pdf")).toBe(false);
    expect(isSupportedTextFile("test.zip")).toBe(false);
  });

  it("支持 Windows 路径", () => {
    expect(isSupportedTextFile("C:\\Users\\test\\file.md")).toBe(true);
    expect(isSupportedTextFile("C:\\Users\\test\\script.js")).toBe(true);
  });
});

describe("getFileLanguage", () => {
  it("识别 JavaScript", () => {
    expect(getFileLanguage("test.js")).toBe("javascript");
    expect(getFileLanguage("test.mjs")).toBe("javascript");
    expect(getFileLanguage("test.cjs")).toBe("javascript");
  });

  it("识别 TypeScript", () => {
    expect(getFileLanguage("test.ts")).toBe("typescript");
    expect(getFileLanguage("test.tsx")).toBe("tsx");
    expect(getFileLanguage("test.jsx")).toBe("jsx");
  });

  it("识别 Python", () => {
    expect(getFileLanguage("test.py")).toBe("python");
  });

  it("识别 Rust", () => {
    expect(getFileLanguage("test.rs")).toBe("rust");
  });

  it("识别 HTML/XML", () => {
    expect(getFileLanguage("test.html")).toBe("markup");
    expect(getFileLanguage("test.xml")).toBe("markup");
    expect(getFileLanguage("test.svg")).toBe("markup");
  });

  it("识别 CSS", () => {
    expect(getFileLanguage("test.css")).toBe("css");
  });

  it("识别 JSON", () => {
    expect(getFileLanguage("test.json")).toBe("json");
  });

  it("识别 YAML", () => {
    expect(getFileLanguage("test.yml")).toBe("yaml");
    expect(getFileLanguage("test.yaml")).toBe("yaml");
  });

  it("识别 SQL", () => {
    expect(getFileLanguage("test.sql")).toBe("sql");
  });

  it("识别 Markdown", () => {
    expect(getFileLanguage("test.md")).toBe("markdown");
    expect(getFileLanguage("test.markdown")).toBe("markdown");
  });

  it("识别无扩展名文件", () => {
    expect(getFileLanguage("Makefile")).toBe("makefile");
    expect(getFileLanguage("Dockerfile")).toBe("dockerfile");
  });

  it("未知扩展名返回 plaintext", () => {
    expect(getFileLanguage("test.unknown")).toBe("plaintext");
    expect(getFileLanguage("test.xyz123")).toBe("plaintext");
  });
});

describe("扩展名常量", () => {
  it("MARKDOWN_EXTENSIONS 包含基本扩展名", () => {
    expect(MARKDOWN_EXTENSIONS).toContain(".md");
    expect(MARKDOWN_EXTENSIONS).toContain(".markdown");
    expect(MARKDOWN_EXTENSIONS).toContain(".mdown");
    expect(MARKDOWN_EXTENSIONS).toContain(".mkd");
  });

  it("TEXT_EXTENSIONS 包含常见代码扩展名", () => {
    expect(TEXT_EXTENSIONS).toContain(".js");
    expect(TEXT_EXTENSIONS).toContain(".ts");
    expect(TEXT_EXTENSIONS).toContain(".py");
    expect(TEXT_EXTENSIONS).toContain(".json");
    expect(TEXT_EXTENSIONS).toContain(".html");
    expect(TEXT_EXTENSIONS).toContain(".css");
  });

  it("TEXT_EXTENSIONS 不包含 Markdown 扩展名", () => {
    expect(TEXT_EXTENSIONS).not.toContain(".md");
    expect(TEXT_EXTENSIONS).not.toContain(".markdown");
  });
});

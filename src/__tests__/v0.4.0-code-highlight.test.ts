/**
 * v0.4.0 功能2：非 md 代码文件语法高亮测试
 * 覆盖：
 * 1. getFileLanguage 补全的扩展名映射
 * 2. isSupportedTextFile 对各种代码文件返回 true
 * 3. renderCodeFilePreview 输出含 language-xxx class 和高亮 token
 * 4. useEditorStore 的 currentLanguage 默认值和 setCurrentLanguage
 * 5. highlightCode 对新增语言返回非空 HTML
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getFileLanguage,
  isSupportedTextFile,
} from "../utils/constants";
import { highlightCode, renderCodeFilePreview } from "../utils/highlight";
import { useEditorStore } from "../stores/useEditorStore";

describe("getFileLanguage - v0.4.0 补全映射", () => {
  it("识别 Vue 单文件组件", () => {
    expect(getFileLanguage("App.vue")).toBe("markup");
  });

  it("识别 Svelte 文件", () => {
    expect(getFileLanguage("Counter.svelte")).toBe("markup");
  });

  it("识别 PHP", () => {
    expect(getFileLanguage("index.php")).toBe("php");
  });

  it("识别 Ruby", () => {
    expect(getFileLanguage("Gemfile.rb")).toBe("ruby");
  });

  it("识别 Swift", () => {
    expect(getFileLanguage("main.swift")).toBe("swift");
  });

  it("识别 Kotlin", () => {
    expect(getFileLanguage("Main.kt")).toBe("kotlin");
    expect(getFileLanguage("script.kts")).toBe("kotlin");
  });

  it("识别 Dart", () => {
    expect(getFileLanguage("main.dart")).toBe("dart");
  });

  it("识别 Lua", () => {
    expect(getFileLanguage("init.lua")).toBe("lua");
  });

  it("识别 R", () => {
    expect(getFileLanguage("analysis.r")).toBe("r");
  });

  it("识别 Scala", () => {
    expect(getFileLanguage("App.scala")).toBe("scala");
  });

  it("识别 Perl", () => {
    expect(getFileLanguage("script.pl")).toBe("perl");
  });

  it("识别 PowerShell", () => {
    expect(getFileLanguage("setup.ps1")).toBe("powershell");
  });

  it("识别配置文件", () => {
    expect(getFileLanguage("Cargo.toml")).toBe("toml");
    expect(getFileLanguage("config.ini")).toBe("ini");
    expect(getFileLanguage("app.conf")).toBe("ini");
    expect(getFileLanguage("app.properties")).toBe("properties");
  });

  it("识别文本文件", () => {
    expect(getFileLanguage("notes.txt")).toBe("plaintext");
    expect(getFileLanguage("debug.log")).toBe("plaintext");
    expect(getFileLanguage("data.csv")).toBe("plaintext");
  });

  it("识别样式预处理语言", () => {
    expect(getFileLanguage("style.scss")).toBe("css");
    expect(getFileLanguage("style.sass")).toBe("css");
    expect(getFileLanguage("style.less")).toBe("css");
  });

  it("识别 Markdown 扩展名", () => {
    expect(getFileLanguage("test.mdown")).toBe("markdown");
    expect(getFileLanguage("test.mkd")).toBe("markdown");
  });
});

describe("isSupportedTextFile - v0.4.0 代码文件支持", () => {
  it("识别前端代码文件", () => {
    expect(isSupportedTextFile("app.js")).toBe(true);
    expect(isSupportedTextFile("app.mjs")).toBe(true);
    expect(isSupportedTextFile("app.cjs")).toBe(true);
    expect(isSupportedTextFile("app.ts")).toBe(true);
    expect(isSupportedTextFile("app.jsx")).toBe(true);
    expect(isSupportedTextFile("app.tsx")).toBe(true);
    expect(isSupportedTextFile("app.vue")).toBe(true);
    expect(isSupportedTextFile("app.svelte")).toBe(true);
  });

  it("识别后端代码文件", () => {
    expect(isSupportedTextFile("app.py")).toBe(true);
    expect(isSupportedTextFile("app.rs")).toBe(true);
    expect(isSupportedTextFile("app.go")).toBe(true);
    expect(isSupportedTextFile("App.java")).toBe(true);
    expect(isSupportedTextFile("app.php")).toBe(true);
    expect(isSupportedTextFile("app.rb")).toBe(true);
    expect(isSupportedTextFile("app.swift")).toBe(true);
    expect(isSupportedTextFile("app.kt")).toBe(true);
    expect(isSupportedTextFile("app.kts")).toBe(true);
    expect(isSupportedTextFile("app.dart")).toBe(true);
    expect(isSupportedTextFile("app.lua")).toBe(true);
    expect(isSupportedTextFile("app.r")).toBe(true);
    expect(isSupportedTextFile("app.scala")).toBe(true);
    expect(isSupportedTextFile("app.pl")).toBe(true);
  });

  it("识别 C/C++ 文件", () => {
    expect(isSupportedTextFile("main.c")).toBe(true);
    expect(isSupportedTextFile("main.cpp")).toBe(true);
    expect(isSupportedTextFile("main.cc")).toBe(true);
    expect(isSupportedTextFile("header.h")).toBe(true);
    expect(isSupportedTextFile("header.hpp")).toBe(true);
  });

  it("识别脚本文件", () => {
    expect(isSupportedTextFile("deploy.sh")).toBe(true);
    expect(isSupportedTextFile("deploy.bash")).toBe(true);
    expect(isSupportedTextFile("deploy.zsh")).toBe(true);
    expect(isSupportedTextFile("deploy.bat")).toBe(true);
    expect(isSupportedTextFile("deploy.cmd")).toBe(true);
    expect(isSupportedTextFile("deploy.ps1")).toBe(true);
  });

  it("识别配置和标记文件", () => {
    expect(isSupportedTextFile("package.json")).toBe(true);
    expect(isSupportedTextFile("index.html")).toBe(true);
    expect(isSupportedTextFile("style.css")).toBe(true);
    expect(isSupportedTextFile("style.scss")).toBe(true);
    expect(isSupportedTextFile("style.less")).toBe(true);
    expect(isSupportedTextFile("config.yml")).toBe(true);
    expect(isSupportedTextFile("config.yaml")).toBe(true);
    expect(isSupportedTextFile("Cargo.toml")).toBe(true);
    expect(isSupportedTextFile("app.ini")).toBe(true);
    expect(isSupportedTextFile("app.conf")).toBe(true);
    expect(isSupportedTextFile("data.sql")).toBe(true);
    expect(isSupportedTextFile("data.xml")).toBe(true);
    expect(isSupportedTextFile("logo.svg")).toBe(true);
  });
});

describe("renderCodeFilePreview", () => {
  it("生成包含 code-file-preview 类的 pre 容器", () => {
    const html = renderCodeFilePreview("const x = 1;", "javascript");
    expect(html).toContain('class="code-file-preview"');
    expect(html).toContain("<pre");
    expect(html).toContain("</pre>");
  });

  it("code 元素包含 language-xxx 类", () => {
    const html = renderCodeFilePreview("print('hi')", "python");
    expect(html).toContain('class="language-python"');
  });

  it("JavaScript 代码生成高亮 token", () => {
    const html = renderCodeFilePreview("const x = 1;", "javascript");
    expect(html).toContain("token");
    expect(html).toContain("keyword");
  });

  it("Python 代码生成高亮 token", () => {
    const html = renderCodeFilePreview("def hello():\n  pass", "python");
    expect(html).toContain("token");
    expect(html).toContain("keyword");
  });

  it("未知语言回退到纯文本（转义 HTML）", () => {
    const html = renderCodeFilePreview("<div>hi</div>", "unknownlang");
    // 未知语言时 highlightCode 返回转义文本，但仍包裹在 pre/code 中
    expect(html).toContain('class="code-file-preview"');
    expect(html).toContain('class="language-unknownlang"');
    expect(html).toContain("&lt;div&gt;");
  });

  it("空内容也能正常生成结构", () => {
    const html = renderCodeFilePreview("", "javascript");
    expect(html).toContain('class="code-file-preview"');
    expect(html).toContain('class="language-javascript"');
  });
});

describe("highlightCode - v0.4.0 新增语言", () => {
  it("高亮 PHP 代码", () => {
    const result = highlightCode("<?php echo 'hi'; ?>", "php");
    expect(result).toContain("token");
  });

  it("高亮 Ruby 代码", () => {
    const result = highlightCode("puts 'hello'", "ruby");
    expect(result).toContain("token");
  });

  it("高亮 Swift 代码", () => {
    const result = highlightCode("let x = 1", "swift");
    expect(result).toContain("token");
  });

  it("高亮 Kotlin 代码", () => {
    const result = highlightCode("val x = 1", "kotlin");
    expect(result).toContain("token");
  });

  it("高亮 Dart 代码", () => {
    const result = highlightCode("var x = 1;", "dart");
    expect(result).toContain("token");
  });

  it("高亮 Lua 代码", () => {
    const result = highlightCode("local x = 1", "lua");
    expect(result).toContain("token");
  });

  it("高亮 R 代码", () => {
    const result = highlightCode("x <- 1", "r");
    expect(result).toContain("token");
  });

  it("高亮 Scala 代码", () => {
    const result = highlightCode("val x = 1", "scala");
    expect(result).toContain("token");
  });

  it("高亮 Perl 代码", () => {
    const result = highlightCode("my $x = 1;", "perl");
    expect(result).toContain("token");
  });

  it("高亮 PowerShell 代码", () => {
    const result = highlightCode("$x = 1", "powershell");
    expect(result).toContain("token");
  });

  it("配置文件语言回退到 plaintext（返回转义文本）", () => {
    // toml/ini/properties 未在 PrismJS 中 import，resolveLanguage 回退到 plaintext
    const tomlResult = highlightCode("key = 'value'", "toml");
    expect(tomlResult).toBe("key = 'value'");
    const iniResult = highlightCode("[section]", "ini");
    expect(iniResult).toBe("[section]");
  });
});

describe("useEditorStore - currentLanguage", () => {
  beforeEach(() => {
    // 每个测试前重置为默认值
    useEditorStore.getState().setCurrentLanguage("markdown");
  });

  it("默认值为 markdown", () => {
    expect(useEditorStore.getState().currentLanguage).toBe("markdown");
  });

  it("setCurrentLanguage 生效", () => {
    useEditorStore.getState().setCurrentLanguage("javascript");
    expect(useEditorStore.getState().currentLanguage).toBe("javascript");
  });

  it("setCurrentLanguage 可切换为各种语言", () => {
    useEditorStore.getState().setCurrentLanguage("python");
    expect(useEditorStore.getState().currentLanguage).toBe("python");
    useEditorStore.getState().setCurrentLanguage("rust");
    expect(useEditorStore.getState().currentLanguage).toBe("rust");
  });

  it("openFile 不改变 currentLanguage（由 App.tsx 设置）", () => {
    useEditorStore.getState().setCurrentLanguage("javascript");
    useEditorStore.getState().openFile("/some/path.js");
    // openFile 只设置 filePath，不改变 currentLanguage
    expect(useEditorStore.getState().currentLanguage).toBe("javascript");
    expect(useEditorStore.getState().filePath).toBe("/some/path.js");
  });
});

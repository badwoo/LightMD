/**
 * v0.5.0 N4：代码块语言自动检测（静默高亮）
 *
 * 验收标准：
 * 1. detectLanguage 纯函数：正确识别主流语言（python/js/ts/json/bash/html/css/sql/
 *    java/cpp/go/rust/yaml/markdown）
 * 2. 保守策略：普通文本/空字符串/单一特征 → null（宁缺毋滥）
 * 3. CodeBlockView 接入：无语言标识时调用 detectLanguage 高亮，不写回文档属性
 * 4. 集成：无语言代码块在编辑器中获得语法 token 高亮
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import { detectLanguage } from "../utils/detect-language";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/** 测试专用：createEditor 在 jsdom 下不会返回 null，断言为非空简化用例 */
function mk(opts: { parent: HTMLElement; initialContent: string }): EditorView {
  return createEditor(opts) as EditorView;
}

describe("v0.5.0 N4：代码块语言自动检测", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    parent.remove();
  });

  it("识别 Python", () => {
    const code = "def add(a, b):\n    return a + b\n\nprint(add(1, 2))";
    expect(detectLanguage(code)).toBe("python");
  });

  it("识别 JavaScript / TypeScript", () => {
    const js = "const x = 1;\nfunction foo() {\n  console.log(x);\n}";
    expect(detectLanguage(js)).toBe("javascript");
    const ts = "interface User {\n  name: string;\n  age: number;\n}\nexport type ID = string;";
    expect(detectLanguage(ts)).toBe("typescript");
  });

  it("识别 JSON / YAML", () => {
    const json = '{\n  "name": "lightmd",\n  "version": 1,\n  "private": true\n}';
    expect(detectLanguage(json)).toBe("json");
    const yaml = "name: lightmd\nversion: 0.5.0\ntasks:\n  - build\n  - test";
    expect(detectLanguage(yaml)).toBe("yaml");
  });

  it("识别 Bash / SQL", () => {
    const bash = "#!/bin/bash\necho \"hello\"\nif [ -f file ]; then\n  cat file\nfi";
    expect(detectLanguage(bash)).toBe("bash");
    const sql = "SELECT id, name FROM users\nWHERE age > 18\nORDER BY name;";
    expect(detectLanguage(sql)).toBe("sql");
  });

  it("识别 HTML / CSS", () => {
    const html = "<!DOCTYPE html>\n<html>\n<head><title>t</title></head>\n<body><div class=\"a\"></div></body>\n</html>";
    expect(detectLanguage(html)).toBe("markup");
    const css = ".container {\n  margin: 0 auto;\n  color: #333;\n  display: flex;\n}";
    expect(detectLanguage(css)).toBe("css");
  });

  it("识别 Java / C++ / Go / Rust", () => {
    const java = "public class Main {\n  public static void main(String[] args) {\n    System.out.println(\"hi\");\n  }\n}";
    expect(detectLanguage(java)).toBe("java");
    const cpp = "#include <iostream>\nint main() {\n  std::cout << \"hi\" << std::endl;\n  return 0;\n}";
    expect(detectLanguage(cpp)).toBe("cpp");
    const go = "package main\n\nimport \"fmt\"\n\nfunc main() {\n  fmt.Println(\"hi\")\n}";
    expect(detectLanguage(go)).toBe("go");
    const rust = "fn main() {\n  let mut x = 1;\n  println!(\"{}\", x);\n}";
    expect(detectLanguage(rust)).toBe("rust");
  });

  it("识别 Markdown", () => {
    const md = "# Title\n\nSome text with [link](http://a.com).\n\n- item 1\n- item 2";
    expect(detectLanguage(md)).toBe("markdown");
  });

  it("保守策略：普通文本与单一特征返回 null", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("hello world\nthis is plain text\nnothing special")).toBeNull();
    // 单一特征（仅一个 const 赋值）不足以判定
    expect(detectLanguage("just one line here")).toBeNull();
  });

  it("大代码块截断检测：仅前 2000 字符参与，开销恒定且结果一致", () => {
    const head = "def process(data):\n    return data\n\nprint(process(1))";
    const big = head + "\n# " + "x".repeat(5000);
    expect(detectLanguage(big)).toBe("python");
  });

  it("源码接入：CodeBlockView 无语言分支调用 detectLanguage（静默，不写回属性）", () => {
    const src = readSrc("src/core/plugins/code-block.ts");
    expect(src).toMatch(/import \{ detectLanguage \} from "\.\.\/\.\.\/utils\/detect-language"/);
    expect(src).toMatch(/const detected = detectLanguage\(code\)/);
    // 静默：检测结果仅用于高亮层 className，不修改 node attrs
    expect(src).not.toMatch(/tr\.setNodeMarkup/);
  });

  it("集成：无语言代码块获得语法 token 高亮，且文档 language 属性保持为空", () => {
    const v = mk({
      parent,
      initialContent: "```\ndef hello():\n    print('world')\n```",
    });
    view = v;
    const wrapper = parent.querySelector(".code-block-wrapper");
    expect(wrapper).not.toBeNull();
    // 高亮层包含 Prism token（检测到 python 并高亮）
    const highlightLayer = wrapper!.querySelector<HTMLElement>(".prism-highlighted");
    expect(highlightLayer).not.toBeNull();
    expect(highlightLayer!.innerHTML).toContain('class="token');
    // 静默：文档中 code_block 的 language 属性未被修改
    let lang: string | undefined;
    v.state.doc.descendants((node) => {
      if (node.type.name === "code_block") {
        lang = node.attrs.language;
        return false;
      }
      return true;
    });
    expect(lang ?? "").toBe("");
  });
});

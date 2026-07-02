/**
 * 扩展语言（P14）高亮输出测试
 * 验证 PrismJS 新增语言（PHP/Swift/Kotlin/Dart/Lua/Ruby/R/Scala/Perl/PowerShell）
 * 以及对应别名解析与 HTML 代码块高亮。
 */
import { describe, it, expect } from "vitest";
import {
  highlightCode,
  highlightCodeBlocksInHtml,
  resolveLanguage,
} from "../utils/highlight";

// 每种新增语言的代表性代码片段
const NEW_LANG_SAMPLES: Array<{ lang: string; code: string; desc: string }> = [
  { lang: "php", code: '<?php echo "hello"; $x = 1; ?>', desc: "PHP" },
  { lang: "swift", code: 'let x: Int = 42\nprint("hi")', desc: "Swift" },
  { lang: "kotlin", code: 'fun main() { println("hi") }', desc: "Kotlin" },
  { lang: "dart", code: 'void main() { print("hi"); }', desc: "Dart" },
  { lang: "lua", code: 'local x = 10\nprint(x)', desc: "Lua" },
  { lang: "ruby", code: 'def hello\n  puts "hi"\nend', desc: "Ruby" },
  { lang: "r", code: "x <- c(1, 2, 3)\nprint(x)", desc: "R" },
  { lang: "scala", code: 'object Main { def main() = 1 }', desc: "Scala" },
  { lang: "perl", code: 'my $x = 1;\nprint "hi";', desc: "Perl" },
  { lang: "powershell", code: 'Write-Host "hello"', desc: "PowerShell" },
];

describe("扩展语言高亮输出", () => {
  for (const { lang, code, desc } of NEW_LANG_SAMPLES) {
    it(`高亮 ${desc} 代码`, () => {
      const result = highlightCode(code, lang);
      expect(result).toContain("token");
      expect(result).not.toBe(escapeBaseline(code));
    });
  }

  it("未知语言仍回退为纯文本", () => {
    const result = highlightCode("const x = 1;", "totally-unknown-lang-xyz");
    expect(result).toBe("const x = 1;");
  });
});

describe("扩展语言别名解析", () => {
  const ALIAS_CASES: Array<{ alias: string; expected: string; desc: string }> = [
    { alias: "kt", expected: "kotlin", desc: "kt -> kotlin" },
    { alias: "kts", expected: "kotlin", desc: "kts -> kotlin" },
    { alias: "rb", expected: "ruby", desc: "rb -> ruby" },
    { alias: "pl", expected: "perl", desc: "pl -> perl" },
    { alias: "pm", expected: "perl", desc: "pm -> perl" },
    { alias: "ps1", expected: "powershell", desc: "ps1 -> powershell" },
    { alias: "pwsh", expected: "powershell", desc: "pwsh -> powershell" },
    { alias: "rlang", expected: "r", desc: "rlang -> r" },
  ];

  for (const { alias, expected, desc } of ALIAS_CASES) {
    it(`别名 ${desc}`, () => {
      expect(resolveLanguage(alias)).toBe(expected);
    });
  }

  it("扩展语言原名直接解析", () => {
    for (const { lang } of NEW_LANG_SAMPLES) {
      expect(resolveLanguage(lang)).toBe(lang);
    }
  });

  it("未注册语言解析为 plaintext", () => {
    expect(resolveLanguage("totally-unknown-lang-xyz")).toBe("plaintext");
  });
});

describe("HTML 中扩展语言代码块高亮", () => {
  it("高亮 PHP 代码块", () => {
    const html =
      '<pre><code class="language-php">&lt;?php echo "hi"; ?&gt;</code></pre>';
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toContain("token");
    expect(result).toContain('language-php');
  });

  it("高亮 Kotlin 代码块（别名 kt）", () => {
    const html =
      '<pre><code class="language-kt">fun main() {}</code></pre>';
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toContain("token");
  });

  it("高亮多个扩展语言代码块", () => {
    const html =
      '<pre><code class="language-swift">let x = 1</code></pre>' +
      '<pre><code class="language-ruby">puts "hi"</code></pre>' +
      '<pre><code class="language-go">func main() {}</code></pre>';
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toContain("token");
    expect(result.match(/token/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("扩展语言代码块保留外层结构", () => {
    const html =
      '<p>intro</p><pre><code class="language-dart">void main() {}</code></pre><p>end</p>';
    const result = highlightCodeBlocksInHtml(html);
    expect(result).toContain("<p>intro</p>");
    expect(result).toContain("<p>end</p>");
    expect(result).toContain("token");
  });
});

function escapeBaseline(code: string): string {
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
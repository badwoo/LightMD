/**
 * detect-language —— N4 代码块语言自动检测（v0.5.0，静默）
 *
 * 设计：
 * - 纯函数启发式打分：每条规则一组特征正则，命中计数为得分
 * - 得分 >= 2 才返回语言（宁缺毋滥，避免误判）
 * - 同分取规则表中靠前者（如 typescript 优先于 javascript）
 * - 检测样本截断到前 2000 字符，保证大代码块检测开销恒定
 * - 仅用于高亮层显示，不写回文档属性（静默，不打扰用户）
 *
 * 返回值为 Prism 支持的语言名（如 "python"、"markup"），
 * 未知回退由 highlightCode 的 resolveLanguage 处理。
 */

interface LangRule {
  lang: string;
  patterns: RegExp[];
}

/** 语言检测规则表（顺序即同分优先级） */
const LANG_RULES: LangRule[] = [
  {
    lang: "typescript",
    patterns: [
      /\binterface\s+\w+\s*\{/,
      /\btype\s+\w+\s*=/,
      /:\s*(string|number|boolean|void)\b/,
      /\benum\s+\w+\s*\{/,
      /\bas\s+const\b/,
    ],
  },
  {
    lang: "javascript",
    patterns: [
      /\b(const|let|var)\s+\w+\s*=/,
      /\bfunction\s+\w*\s*\(/,
      /=>/,
      /\bconsole\.log\(/,
      /\bdocument\.\w/,
      /\brequire\(/,
      /\bexport\s+(default|const|function|class)\b/,
      /\basync\s+function\b/,
    ],
  },
  {
    lang: "python",
    patterns: [
      /^\s*def\s+\w+\s*\(/m,
      /^\s*from\s+\w+\s+import/m,
      /^\s*import\s+\w+/m,
      /\bprint\(/,
      /"""/,
      /^\s*class\s+\w+\s*[(:]/m,
      /^\s*if\s+__name__\s*==/m,
    ],
  },
  {
    lang: "markup",
    patterns: [
      /<!DOCTYPE/i,
      /<\/(div|span|html|head|body|p|a|ul|li|table|script|style|h[1-6])>/,
      /<(div|span|p|a|body|html|head|meta|link|script|style|h[1-6]|ul|ol|li)(\s[^>]*)?>/,
      /\s(href|src|class|id)=["'][^"']*["']/,
    ],
  },
  {
    lang: "css",
    patterns: [
      /^[.#@:a-zA-Z][^{;\n]*\{/m,
      /[.#]\w+\s*\{/,
      /:\s*#[0-9a-fA-F]{3,8}\b/,
      /\b(margin|padding|color|font|display|flex|grid|border)\s*:\s*[^;]+;/,
      /@media\s/,
    ],
  },
  {
    lang: "json",
    patterns: [
      /^\s*[{[]/m,
      /"\w+"\s*:/,
      /\b(true|false|null)\b/,
      /:\s*(\d+|"[^"]*")\s*[,}\]]/,
    ],
  },
  {
    lang: "yaml",
    patterns: [
      /^[a-zA-Z_][\w.-]*:\s*(\S|$)/m,
      /^\s*-\s+\S/m,
      /^---\s*$/m,
    ],
  },
  {
    lang: "bash",
    patterns: [
      /^#!.*\b(ba|z)?sh\b/m,
      /^\s*(echo|export|cd|ls|mkdir|rm|cp|mv|grep|sed|awk|curl|wget|sudo|apt|yum|chmod)\b/m,
      /\$\{?\w+\}?/,
      /\bif\s*\[.*\];\s*then\b/,
      /\s&&\s/,
    ],
  },
  {
    lang: "sql",
    patterns: [
      /\bSELECT\b[\s\S]*\bFROM\b/,
      /\bCREATE\s+TABLE\b/,
      /\bINSERT\s+INTO\b/,
      /\b(LEFT|INNER|RIGHT)\s+JOIN\b/,
      /\bGROUP\s+BY\b|\bORDER\s+BY\b/,
    ],
  },
  {
    lang: "java",
    patterns: [
      /\bpublic\s+(abstract\s+)?class\s+\w+/,
      /\bpublic\s+static\s+void\s+main\b/,
      /System\.out\.print/,
      /\bimport\s+java\.\w+/,
    ],
  },
  {
    lang: "cpp",
    patterns: [
      /#include\s*<(iostream|vector|string|map|memory)>/,
      /\bstd::\w+/,
      /\btemplate\s*</,
      /\bcout\s*<</,
    ],
  },
  {
    lang: "c",
    patterns: [
      /#include\s*<\w+\.h>/,
      /\bint\s+main\s*\(/,
      /\bprintf\s*\(/,
      /\bscanf\s*\(/,
      /\bstruct\s+\w+\s*\{/,
    ],
  },
  {
    lang: "go",
    patterns: [
      /\bpackage\s+\w+/,
      /\bfunc\s+\w*\s*\(/,
      /\bfmt\.\w+\(/,
      /^\s*import\s*\(/m,
      /\bif\s+err\s*!=\s*nil\b/,
    ],
  },
  {
    lang: "rust",
    patterns: [
      /\bfn\s+\w+\s*\(/,
      /\blet\s+(mut\s+)?\w+\s*=/,
      /\bprintln!\(/,
      /\buse\s+\w+::/,
      /\bimpl\s+\w+/,
    ],
  },
  {
    lang: "php",
    patterns: [
      /<\?php/,
      /\$_(GET|POST|SESSION|SERVER)/,
      /\$\w+\s*->\s*\w+/,
    ],
  },
  {
    lang: "markdown",
    patterns: [
      /^#{1,6}\s+\S/m,
      /^[-*+]\s+\S/m,
      /\[.+?\]\(.+?\)/,
    ],
  },
];

/** 检测样本截断长度：超过部分不参与检测，保证大代码块检测开销恒定 */
const DETECT_SAMPLE_LIMIT = 2000;

/** 最低得分阈值：命中特征数不足 2 个视为不可识别（宁缺毋滥） */
const MIN_SCORE = 2;

/**
 * 检测代码文本的语言，返回 Prism 语言名；无法识别时返回 null
 */
export function detectLanguage(code: string): string | null {
  if (!code) return null;
  const sample =
    code.length > DETECT_SAMPLE_LIMIT ? code.slice(0, DETECT_SAMPLE_LIMIT) : code;

  let best: string | null = null;
  let bestScore = 0;
  for (const rule of LANG_RULES) {
    let score = 0;
    for (const re of rule.patterns) {
      if (re.test(sample)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = rule.lang;
    }
  }
  return bestScore >= MIN_SCORE ? best : null;
}

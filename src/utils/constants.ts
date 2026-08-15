export const APP_NAME = "LightMD";
export const DEFAULT_FILE_NAME = "无标题.md";
export const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];
export const MAX_RECENT_FILES = 20;
export const AUTO_SAVE_DEBOUNCE_MS = 1000;
export const LARGE_CODE_BLOCK_THRESHOLD = 500;

/**
 * 大文件阈值（字节）
 * 超过此值的文件将禁用 Markdown 渲染和 ProseMirror，仅支持纯文本编辑
 * 1MB 以上：禁用阅读模式自动渲染，增加防抖时间
 * 5MB 以上：强制编辑模式，禁用所有渲染
 */
export const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024; // 1MB
export const HUGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB

/**
 * 支持的文本/代码文件扩展名（除 Markdown 外）
 * 用于文件打开容错，方便其他文件简单预览或编辑
 */
export const TEXT_EXTENSIONS = [
  ".txt", ".log", ".csv", ".ini", ".conf", ".toml", ".properties",
  ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx",
  ".json", ".html", ".htm", ".css", ".scss", ".less", ".sass",
  ".xml", ".svg",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1",
  ".yml", ".yaml",
  ".sql",
  ".vue", ".svelte",
  ".php", ".rb", ".swift", ".kt", ".kts", ".dart", ".lua", ".r", ".scala", ".pl",
  ".makefile", ".mk", ".gradle", ".gemspec",
  ".gitignore", ".dockerignore", ".editorconfig", ".env",
];

/** 所有支持的文件扩展名（Markdown + 文本/代码） */
export const ALL_SUPPORTED_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ...TEXT_EXTENSIONS];

/** 判断文件名是否为 Markdown 文件 */
export function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 判断文件名是否为支持的文本/代码文件（包括 Markdown） */
export function isSupportedTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  // 特殊处理无扩展名的常见文件名
  const basename = lower.replace(/\\/g, "/").split("/").pop() || "";
  if (["makefile", "dockerfile", "rakefile", "gemfile", "license", "readme"].includes(basename)) {
    return true;
  }
  return ALL_SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 获取文件的语言标识（用于语法高亮） */
export function getFileLanguage(name: string): string {
  const lower = name.toLowerCase();
  const basename = lower.replace(/\\/g, "/").split("/").pop() || "";
  // 无扩展名文件
  if (basename === "makefile" || basename === "dockerfile") return basename.toLowerCase();
  // 有扩展名文件
  const ext = "." + basename.split(".").pop();
  // v0.4.0：补全常见代码文件扩展名映射
  // 注意：未在 PrismJS 中 import 的语言（如 toml/ini/properties）会由 resolveLanguage 回退到 plaintext，安全
  const extLangMap: Record<string, string> = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".jsx": "jsx", ".tsx": "tsx",
    ".json": "json", ".html": "markup", ".htm": "markup", ".css": "css",
    ".xml": "markup", ".svg": "markup",
    ".vue": "markup", ".svelte": "markup", // 模板文件用 markup 高亮（含标签）
    ".py": "python", ".rs": "rust", ".go": "go",
    ".java": "java", ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".bat": "batch", ".cmd": "batch", ".ps1": "powershell",
    ".yml": "yaml", ".yaml": "yaml",
    ".sql": "sql",
    ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown", ".mkd": "markdown",
    // v0.4.0 新增映射
    ".php": "php", ".rb": "ruby", ".swift": "swift",
    ".kt": "kotlin", ".kts": "kotlin", ".dart": "dart",
    ".lua": "lua", ".r": "r", ".scala": "scala", ".pl": "perl",
    // 配置/文本文件：PrismJS 无专门语法，保留语言标识由 resolveLanguage 回退到 plaintext
    ".toml": "toml", ".ini": "ini", ".conf": "ini",
    ".properties": "properties", ".csv": "plaintext",
    ".log": "plaintext", ".txt": "plaintext",
    // 样式预处理：PrismJS 未单独 import scss/sass/less 组件，复用 css 高亮以获得部分着色
    ".scss": "css", ".sass": "css", ".less": "css",
  };
  return extLangMap[ext] || "plaintext";
}

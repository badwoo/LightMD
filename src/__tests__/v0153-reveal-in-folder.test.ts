/**
 * v0.15.3 回归：左侧栏文件树右键「打开文件所在目录」失效
 *
 * ## 真因（已用实机证据锁定，勿回退）
 * Windows 上 `explorer.exe` 的 `/select,` 后面**必须紧跟一个带引号的路径**
 * （`/select,"<path>"`，引号只包住路径本身）。旧实现：
 *
 *    Command::new("explorer").arg(format!("/select,{}", path.display()))
 *
 * `std::process::Command::arg()` 在 Windows 上按 MSVCRT 引用规则，**整串含空格就整串加引号**，
 * explorer 收到的是 `"/select,C:\...\a.md"` —— 引号把 `/select,` 也包进去了：
 * explorer 于是把整个字符串当成**一个路径**（既不是选项也不是真实路径），
 * **静默失败**：spawn 返回 Ok、无错误提示、资源管理器什么都不做。
 * 用户看到的就是「点了没反应」。
 *
 * 修复：改用 `CommandExt::raw_arg()` 传 `/select,"<path>"`，不做任何自动引用。
 *
 * ## 本测试锁住的契约
 * 1. Rust 侧必须用 `raw_arg` + `/select,"<path>"` 形态；**不得**改回单 arg 拼 `format!("/select,{}")`
 * 2. Rust 侧存在对**含空格路径**的显式处理与注释契约（防止后续"简化"回旧写法）
 * 3. 前端 `fileService.revealInFolder` 失败时**必须** `notifyError`（不得静默吞掉）
 * 4. 文件树入口的 `node.path` 必须是持绝对路径契约（`list_dir` 返回、不允许 `..` 相对拼接）
 * 5. 三个入口（文件树 / 标签页 / 最近打开）都在用同一个统一实现
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/** 截取 reveal_in_folder 命令实现段落（从函数签名到下一个顶层 item 之前） */
function revealFnBody(fileOps: string): string {
  const start = fileOps.indexOf("pub async fn reveal_in_folder");
  expect(start, "file_ops.rs 必须有 reveal_in_folder 命令").toBeGreaterThan(-1);
  const rest = fileOps.slice(start);
  // 该函数在 FileEntry struct 之前结束，截到 `#[derive(serde::Serialize` 或下一个 `#[tauri::command]`
  const endCandidates = [
    rest.indexOf("#[derive(serde::Serialize"),
    rest.indexOf("#[tauri::command]"),
    rest.indexOf("\n#[cfg(test)]"),
  ].filter((i) => i > 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : rest.length;
  return rest.slice(0, end);
}

/** 去掉 `//` 行注释（注释里可以提到旧 bug 的写法，不应算作"代码里还在用"） */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("v0.15.3 修复：打开文件所在目录", () => {
  describe("Rust：explorer /select 参数形态", () => {
    it("必须用 raw_arg 且形如 /select,\"<path>\"（引号只包路径）", () => {
      const fileOps = readSrc("src-tauri/src/commands/file_ops.rs");
      const body = revealFnBody(fileOps);

      // 修复后的调用形态
      expect(body).toMatch(/raw_arg/);
      expect(body).toMatch(/explorer_select_arg/);

      // 构造器必须是 /select,"<path>" —— 用转义后再匹配，兼容源码里的两种写法
      expect(fileOps).toMatch(/format!\(\s*"\/select,\\"\{\}\\""/);

      // 必须有 CommandExt 导入，否则 raw_arg 不可用
      expect(body).toMatch(/std::os::windows::process::CommandExt/);
    });

    it("不得改回单 arg 拼 format!(\"/select,{}\") 的错误形态", () => {
      const fileOps = readSrc("src-tauri/src/commands/file_ops.rs");
      // 只看**代码行**（去注释）：注释里允许记录旧 bug 的写法
      const body = stripLineComments(revealFnBody(fileOps));

      // 旧 bug 的精确形态：.arg(format!("/select,{}", path.display())) —— 必须不存在。
      // 注意用字符串拼接构造模式，避免 `/select,` 里的斜杠被当成正则字面量的结束符。
      const badSingleArg =
        "\\.arg\\(\\s*format!\\(\\s*\"" + "/select," + "{}" + "\"\\s*,\\s*path\\.display\\(\\)\\s*\\)\\s*\\)";
      expect(body).not.toMatch(new RegExp(badSingleArg));

      // 任何把 /select, 与路径直接拼成单参数的 .arg(format!(...)) 写法都不允许
      const anyArgSelect = "\\.arg\\(\\s*format!\\(\\s*\"" + "/select,";
      expect(body).not.toMatch(new RegExp(anyArgSelect));

      // .arg("/select,") 独立字面量参数也不允许（explorer 不接受分开两参）
      expect(body).not.toMatch(new RegExp("\\.arg\\(\\s*\"" + "/select," + "\"\\s*\\)"));
    });

    it("对含空格路径有显式处理/注释契约", () => {
      const fileOps = readSrc("src-tauri/src/commands/file_ops.rs");
      // 注释必须记录「空格 / 引号」这一关键契约（防后续简化回旧写法）
      const mentionsSpace = /含空格/.test(fileOps) || /空格/.test(fileOps);
      const mentionsQuote = /引号/.test(fileOps);
      expect(mentionsSpace, "注释必须写明含空格路径的契约").toBe(true);
      expect(mentionsQuote, "注释必须写明引号语义的契约").toBe(true);

      // 并且要有针对含空格路径的 Rust 单测（explorer_select_arg_quotes_only_the_path）
      expect(fileOps).toMatch(/fn explorer_select_arg_quotes_only_the_path/);
      const testBody = fileOps.slice(fileOps.indexOf("fn explorer_select_arg_quotes_only_the_path"));
      expect(testBody.slice(0, 900)).toMatch(/LightMD 测试 目录/);
      expect(testBody.slice(0, 900)).toMatch(/中文 文件\.md/);
    });
  });

  describe("前端：失败必须提示，不得静默吞掉", () => {
    it("fileService.revealInFolder 失败时调用 notifyError 并抛出", () => {
      const svc = readSrc("src/services/fileService.ts");
      const start = svc.indexOf("async revealInFolder");
      expect(start).toBeGreaterThan(-1);
      const end = svc.indexOf("};", start) >= 0 ? svc.indexOf("};", start) : svc.length;
      const body = svc.slice(start, end);

      // 统一实现：invoke("reveal_in_folder", { path })
      expect(body).toMatch(/invoke\("reveal_in_folder",\s*\{\s*path\s*\}\)/);
      // 失败必须 notifyError（不能 catch 后静默返回）
      expect(body).toMatch(/catch\s*\(err\)/);
      expect(body).toMatch(/notifyError\(/);
      // 且错误需要抛出（便于调用方感知，而不是彻底静默）
      expect(body).toMatch(/throw new Error\(/);
    });

    it("三个入口都复用统一实现 fileService.revealInFolder", () => {
      // 文件树（用户报的这个）
      expect(readSrc("src/components/sidebar/FileNode.tsx")).toMatch(
        /fileService\.revealInFolder\(node\.path\)/
      );
      // 标签页
      expect(readSrc("src/components/layout/TabBar.tsx")).toMatch(
        /fileService\.revealInFolder\(ctxMenu\.tab\.path\)/
      );
      // 最近打开
      expect(readSrc("src/components/sidebar/RecentFiles.tsx")).toMatch(
        /fileService\.revealInFolder\(contextMenu\.path\)/
      );
    });
  });

  describe("文件树入口：node.path 必须是绝对路径契约", () => {
    it("FileNode 用 node.path 传入（不透传别的相对形态）", () => {
      const fileNode = readSrc("src/components/sidebar/FileNode.tsx");
      expect(fileNode).toMatch(/revealInFolder\(node\.path\)/);
      // 不得出现对 node.path 做 .. 相对拼接后传给 reveal
      expect(fileNode).not.toMatch(/revealInFolder\(node\.path\.replace/);
    });

    it("FileTree 的 path 由 list_dir 返回（mapToFileNode 原样透传 entry.path，不做相对拼接）", () => {
      const tree = readSrc("src/components/sidebar/FileTree.tsx");
      // mapToFileNode: path: entry.path —— 绝对路径由 Rust list_dir 给出
      expect(tree).toMatch(/function mapToFileNode\(entry:\s*FileEntry\)/);
      const mapStart = tree.indexOf("function mapToFileNode");
      const mapBody = tree.slice(mapStart, tree.indexOf("\n}", mapStart));
      expect(mapBody).toMatch(/path:\s*entry\.path/);
      // 不允许把 path 拼成 ".." 相对形态
      expect(mapBody).not.toMatch(/\.\./);
      // path 不得经过 joinPath / ".." 之类的相对拼接
      expect(mapBody).not.toMatch(/joinPath\(/);
    });

    it("Rust list_dir 返回绝对路径（entry.path() 来自 read_dir，且归一为 /）", () => {
      const fileOps = readSrc("src-tauri/src/commands/file_ops.rs");
      const start = fileOps.indexOf("fn list_dir_entries");
      expect(start).toBeGreaterThan(-1);
      const body = fileOps.slice(start, start + 2000);
      // entry.path() = read_dir 给出的绝对路径（含父目录前缀），并把 \ 归一为 /
      expect(body).toContain("path: entry.path().to_string_lossy().to_string().replace('\\\\', \"/\")");
      // 不得用 current_dir().join 拼相对路径
      expect(body).not.toContain("current_dir()");
    });
  });
});

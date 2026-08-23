/**
 * v0.5.0 N5：右键菜单"打开文件所在目录"
 *
 * 验收标准：
 * 1. Rust 端提供 reveal_in_folder 命令并注册到 invoke_handler
 * 2. 前端 fileService.revealInFolder 调用 invoke("reveal_in_folder", { path })
 * 3. 4 处右键菜单入口：TabBar（标签页）、FileNode（文件树）、FileTree（临时文件）、RecentFiles（最近打开）
 * 4. i18n 提供 common.revealInFolder 文案（zh/en）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

describe("v0.5.0 N5：打开文件所在目录", () => {
  it("Rust 端定义 reveal_in_folder 命令并注册到 invoke_handler", () => {
    const fileOps = readSrc("src-tauri/src/commands/file_ops.rs");
    expect(fileOps).toMatch(/pub async fn reveal_in_folder/);
    expect(fileOps).toMatch(/explorer.*\/select/);
    const lib = readSrc("src-tauri/src/lib.rs");
    expect(lib).toMatch(/file_ops::reveal_in_folder/);
  });

  it("fileService 提供 revealInFolder，调用 invoke reveal_in_folder", () => {
    const svc = readSrc("src/services/fileService.ts");
    expect(svc).toMatch(/revealInFolder/);
    expect(svc).toMatch(/invoke\("reveal_in_folder", \{ path \}\)/);
  });

  it("4 处右键菜单均包含打开文件所在目录入口", () => {
    // 标签页右键菜单
    expect(readSrc("src/components/layout/TabBar.tsx")).toMatch(
      /revealInFolder\(ctxMenu\.tab\.path\)/
    );
    // 文件树节点右键菜单
    expect(readSrc("src/components/sidebar/FileNode.tsx")).toMatch(
      /revealInFolder\(node\.path\)/
    );
    // 临时文件右键菜单
    expect(readSrc("src/components/sidebar/FileTree.tsx")).toMatch(
      /revealInFolder\(tempContextMenu\.file\.path\)/
    );
    // 最近打开右键菜单
    expect(readSrc("src/components/sidebar/RecentFiles.tsx")).toMatch(
      /revealInFolder\(contextMenu\.path\)/
    );
  });

  it("i18n 提供 common.revealInFolder 文案（zh/en）", () => {
    expect(readSrc("src/i18n/locales/zh-CN.ts")).toMatch(
      /"common\.revealInFolder":\s*"打开文件所在目录"/
    );
    expect(readSrc("src/i18n/locales/en-US.ts")).toMatch(
      /"common\.revealInFolder":\s*"Reveal in Folder"/
    );
  });

  it("F2：tauri.conf.json 不再注册 Script 文件关联（bat/cmd/ps1/sh 等）", () => {
    const conf = readSrc("src-tauri/tauri.conf.json");
    expect(conf).not.toMatch(/"bat"/);
    expect(conf).not.toMatch(/"ps1"/);
    expect(conf).not.toMatch(/"Script"/);
    // NSIS 安装钩子已配置（清理旧版残留）
    expect(conf).toMatch(/"installerHooks":\s*"installer-hooks\.nsh"/);
  });
});

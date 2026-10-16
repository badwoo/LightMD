/**
 * v0.13.0 第三轮返修：图片管理面板 ⑩⑪⑫⑬ 回归测试
 *
 * 背景：第二轮修完"纯函数单测全绿、真实链路不可用"后，用户在实机上又报了 4 个
 * 图片管理面板的问题。本文件全部为**行为级**断言（真值表 + 真实渲染），
 * 每条都对应一个能在旧实现上复现的失败。
 *
 * ⑩ 逐图自动判定引用形态（内联 base64 / 本地文件 / 远程），并给出**相反方向**
 *    的转换按钮；同时 Tauri 的 `asset.localhost` URL（百分号编码的本地绝对路径）
 *    必须解码回本地文件——旧实现按 `http:` 前缀判为远程，于是用户文档里
 *    「http://asset.localhost/D%3A%2F10254%2F...%2Fimage-3.png」这张**本地图**
 *    在面板上重命名/转存/转 base64 全部拿不到磁盘路径而失败。
 * ⑪ 列表顺序必须是**文档顺序**。
 * ⑫ 一次出现一行：用户的文档里有 5 处图片引用（其中 `./assets/image-4.png`
 *    出现 2 次），旧实现按 src 合并 → 只列出 3 行，用户数不出自己的图片。
 * ⑬ 重命名输入框只显示/编辑**主名**，扩展名保持原样（旧实现把 `a.png` 整个
 *    放进输入框，用户漏打后缀就得到无扩展名文件 → 编辑器直接裂图）。
 *
 * 注：本文件用 createElement 而非 JSX，以便保持交付要求的 `.test.ts` 后缀
 * （`.ts` 不接受 JSX 语法）。
 */
// @vitest-environment jsdom
import { createElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";

// ─── Tauri mock（与 v0130-image-manager-dialog.test.tsx 同型）──────────────
const mockListDir = vi.hoisted(() => vi.fn());
const mockCopyFile = vi.hoisted(() => vi.fn());
const mockRenameFile = vi.hoisted(() => vi.fn());
const mockDeleteFile = vi.hoisted(() => vi.fn());
const mockExists = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());

vi.mock("../services/fileService", () => ({
  fileService: {
    listDir: mockListDir,
    copyFile: mockCopyFile,
    renameFile: mockRenameFile,
    deleteFile: mockDeleteFile,
  },
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: mockExists,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

const mockJoin = vi.hoisted(() => vi.fn((...parts: string[]) => parts.join("/").replace(/\/+/g, "/")));
const mockDirname = vi.hoisted(() => vi.fn((p: string) => p.replace(/[\\/][^\\/]*$/, "")));
vi.mock("@tauri-apps/api/path", () => ({
  join: mockJoin,
  dirname: mockDirname,
}));

import { ImageManagerDialog } from "../components/dialogs/ImageManagerDialog";
import { markdownToDoc } from "../core/markdown/parser";
import {
  base64ToBytes,
  bytesToBase64,
  collectDocImageOccurrences,
  collectDocImages,
  countRefsOf,
  decodeAssetLocalhostSrc,
  extensionForMime,
  findUnreferenced,
  imageBaseNameOf,
  imageExtNameOf,
  imageFileNameOf,
  imageSourceKind,
  isExternalImageSrc,
  livesInAssetsDir,
  mimeForFileName,
  oppositeConversionOf,
  parseDataUrl,
  planAssetsMigration,
  planConvertToAssets,
  planConvertToBase64,
  planRename,
  planRenameBaseName,
  resolveImageAbsPath,
  suggestedFileNameForSrc,
} from "../utils/imageManager";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";

/** 用户实机文档里的 asset.localhost 引用（Tauri convertFileSrc 的产物） */
const ASSET_SRC =
  "http://asset.localhost/D%3A%2F10254%2F%E6%A1%8C%E9%9D%A2%2Fassets%2Fimage-3.png";
const ASSET_DECODED = "D:/10254/桌面/assets/image-3.png";

/** 忠实复刻用户文档 `D:\10254\桌面\md测试.md` 的图片结构（按文档顺序） */
const USER_DOC_MD =
  `![image.png](${ASSET_SRC})\n\n` +
  "kkkkkkkkkkkkk\n\n" +
  `![image.png](${ASSET_SRC})\n\n` +
  "![image.png](./assets/image-4.png)\n\n" +
  "![image.png](./assets/image-4.png)\n\n" +
  "![xx](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==)\n";

const DOC_PATH = "D:/docs/readme.md";

function renderPanel(overrides?: {
  markdown?: string;
  docPath?: string | null;
  onRewriteRefs?: (ops: Array<{ oldSrc: string; newSrc: string }>) => void;
}) {
  const md = overrides?.markdown ?? USER_DOC_MD;
  const doc = markdownToDoc(md);
  const onRewriteRefs = overrides?.onRewriteRefs ?? vi.fn();
  const utils = render(
    createElement(ImageManagerDialog, {
      open: true,
      doc,
      docPath: overrides?.docPath === undefined ? DOC_PATH : overrides.docPath,
      onRewriteRefs,
      onClose: vi.fn(),
    }),
  );
  return { ...utils, onRewriteRefs };
}

beforeEach(() => {
  cleanup();
  for (const m of [
    mockListDir,
    mockCopyFile,
    mockRenameFile,
    mockDeleteFile,
    mockExists,
    mockReadFile,
    mockWriteFile,
  ]) {
    m.mockReset();
  }
  mockListDir.mockResolvedValue([]);
  mockExists.mockResolvedValue(false);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = true;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

// ═════════ ⑩ asset.localhost 解码（纯函数真值表）═════════

describe("⑩ decodeAssetLocalhostSrc：Tauri asset URL → 本地绝对路径", () => {
  it("%3A → ':'、%2F → '/'，中文目录名一并还原", () => {
    expect(decodeAssetLocalhostSrc(ASSET_SRC)).toBe(ASSET_DECODED);
    expect(decodeAssetLocalhostSrc("http://asset.localhost/D%3A%2Fx.png")).toBe("D:/x.png");
    expect(decodeAssetLocalhostSrc("http://asset.localhost/C%3A%2Fa%2Fb%2Fc.png")).toBe(
      "C:/a/b/c.png",
    );
  });

  it("https 域名 / 普通 http 图片保持 null（仍是远程，不得被当成本地文件）", () => {
    expect(decodeAssetLocalhostSrc("https://a.com/x.png")).toBeNull();
    expect(decodeAssetLocalhostSrc("http://a.com/x.png")).toBeNull();
    expect(decodeAssetLocalhostSrc("https://asset.localhost.evil.com/x.png")).toBeNull();
    expect(decodeAssetLocalhostSrc("asset://cdn.example.com/x.png")).toBeNull();
  });

  it("asset://localhost/ 形态（无 http 前缀）同样解码", () => {
    expect(decodeAssetLocalhostSrc("asset://localhost/D%3A%2Fx.png")).toBe("D:/x.png");
  });

  it("空串 / 普通路径 / data URL → null", () => {
    expect(decodeAssetLocalhostSrc("")).toBeNull();
    expect(decodeAssetLocalhostSrc("./assets/a.png")).toBeNull();
    expect(decodeAssetLocalhostSrc("D:/pic/a.png")).toBeNull();
    expect(decodeAssetLocalhostSrc("data:image/png;base64,AA")).toBeNull();
  });

  it("非法百分号序列不抛异常（畸形 URL 不能让整个面板崩掉）", () => {
    expect(() => decodeAssetLocalhostSrc("http://asset.localhost/D%3A%2F%ZZ.png")).not.toThrow();
    expect(decodeAssetLocalhostSrc("http://asset.localhost/D%3A%2F%ZZ.png")).toBe("D:/%ZZ.png");
  });

  it("query / hash 被剥掉（路径不会带 ?v=1）", () => {
    expect(decodeAssetLocalhostSrc("http://asset.localhost/D%3A%2Fx.png?v=1")).toBe("D:/x.png");
  });
});

describe("⑩ imageSourceKind：逐图判定引用形态", () => {
  it("真值表", () => {
    const cases: Array<[string, string]> = [
      ["data:image/png;base64,iVBORw0KGgo=", "base64"],
      ["data:image/svg+xml,<svg/>", "base64"],
      ["./assets/a.png", "file"],
      ["../pic/a.png", "file"],
      ["a.png", "file"],
      ["D:/pic/a.png", "file"],
      ["D:\\pic\\a.png", "file"],
      // ⑩ 关键：asset.localhost 是**本地文件**，不是远程
      [ASSET_SRC, "file"],
      ["asset://localhost/D%3A%2Fx.png", "file"],
      ["https://a.com/x.png", "remote"],
      ["http://a.com/x.png", "remote"],
      ["blob:http://localhost/abc", "remote"],
    ];
    for (const [src, expected] of cases) {
      expect(imageSourceKind(src), src).toBe(expected);
    }
  });

  it("⑩ asset.localhost 不再被 http: 前缀误判为外部图（旧实现 isExternalImageSrc=true）", () => {
    expect(isExternalImageSrc(ASSET_SRC)).toBe(false);
    expect(isExternalImageSrc("asset://localhost/D%3A%2Fx.png")).toBe(false);
    // 真远程行为不变（回归锁）
    expect(isExternalImageSrc("https://a.com/x.png")).toBe(true);
    expect(isExternalImageSrc("http://a.com/x.png")).toBe(true);
    expect(isExternalImageSrc("data:image/png;base64,AA")).toBe(true);
    expect(isExternalImageSrc("D:/pic/a.png")).toBe(true);
    expect(isExternalImageSrc("./assets/a.png")).toBe(false);
  });

  it("imageFileNameOf 先解码再取末段（旧实现拿到百分号编码串）", () => {
    expect(imageFileNameOf(ASSET_SRC)).toBe("image-3.png");
    expect(imageFileNameOf("asset://localhost/D%3A%2Fp%2Fb%20c.png")).toBe("b c.png");
    // 既有行为不变
    expect(imageFileNameOf("./assets/a.png")).toBe("a.png");
    expect(imageFileNameOf("https://a.com/d.png?x=1#y")).toBe("d.png");
    expect(imageFileNameOf("data:image/png;base64,AA")).toBe("");
  });
});

describe("⑩ oppositeConversionOf：给出的必须是相反方向", () => {
  it("本地文件 → 转 base64；base64 / 远程 → 转 assets", () => {
    expect(oppositeConversionOf("./assets/a.png")).toBe("toBase64");
    expect(oppositeConversionOf("D:/pic/a.png")).toBe("toBase64");
    expect(oppositeConversionOf(ASSET_SRC)).toBe("toBase64");
    expect(oppositeConversionOf("data:image/png;base64,AA")).toBe("toAssets");
    expect(oppositeConversionOf("https://a.com/x.png")).toBe("toAssets");
  });
});

describe("⑩ assets/ 归属判定", () => {
  it("livesInAssetsDir：解码后看目录末段（asset.localhost / 绝对路径都算）", () => {
    expect(livesInAssetsDir("./assets/a.png")).toBe(true);
    expect(livesInAssetsDir("assets/a.png")).toBe(true);
    expect(livesInAssetsDir("D:/docs/assets/a.png")).toBe(true);
    // ⑩ 用户文档那张本地图：解码后就在 assets/ 里
    expect(livesInAssetsDir(ASSET_SRC)).toBe(true);
    expect(livesInAssetsDir("./pic/a.png")).toBe(false);
    expect(livesInAssetsDir("D:/pic/a.png")).toBe(false);
    expect(livesInAssetsDir("data:image/png;base64,AA")).toBe(false);
    expect(livesInAssetsDir("https://a.com/assets/a.png")).toBe(false);
  });
});

// ═════════ ⑩ 转换计划（两个方向）═════════

describe("⑩ 转 assets 计划", () => {
  it("planAssetsMigration 对真远程 URL 仍照常产出（回归锁）", () => {
    expect(planAssetsMigration({ src: "https://a.com/pic/x.png" }, [])).toEqual({
      newSrc: "assets/x.png",
      fileName: "x.png",
      needsCopy: true,
    });
  });

  it("planAssetsMigration 对 asset.localhost 现在也能取到文件名", () => {
    const plan = planAssetsMigration({ src: ASSET_SRC }, []);
    expect(plan).toEqual({
      newSrc: "assets/image-3.png",
      fileName: "image-3.png",
      needsCopy: false,
    });
  });

  it("planConvertToAssets：data URL 按 mime 合成 image.png（旧实现直接失败）", () => {
    expect(planConvertToAssets("data:image/png;base64,iVBORw0KGgo=", [])).toEqual({
      newSrc: "assets/image.png",
      fileName: "image.png",
      needsCopy: true,
    });
    expect(planConvertToAssets("data:image/jpeg;base64,AAAA", [])?.fileName).toBe("image.jpg");
    expect(planConvertToAssets("data:image/webp;base64,AAAA", [])?.fileName).toBe("image.webp");
  });

  it("planConvertToAssets：asset.localhost 是本地文件 → 只改引用不复制（避免自我复制）", () => {
    const plan = planConvertToAssets(ASSET_SRC, []);
    expect(plan).toEqual({
      newSrc: "assets/image-3.png",
      fileName: "image-3.png",
      needsCopy: false,
    });
  });

  it("planConvertToAssets：相对路径 → 不复制；绝对路径 → 复制；冲突加序号", () => {
    expect(planConvertToAssets("./pic/a.png", [])?.needsCopy).toBe(false);
    expect(planConvertToAssets("D:/pic/a.png", [])?.needsCopy).toBe(true);
    expect(planConvertToAssets("./pic/a.png", ["a.png", "a-1.png"])?.fileName).toBe("a-2.png");
  });

  it("suggestedFileNameForSrc：普通引用取原名，data URL 合成，取不到则空串", () => {
    expect(suggestedFileNameForSrc("./assets/a.png")).toBe("a.png");
    expect(suggestedFileNameForSrc(ASSET_SRC)).toBe("image-3.png");
    expect(suggestedFileNameForSrc("data:image/png;base64,AA")).toBe("image.png");
    expect(suggestedFileNameForSrc("")).toBe("");
  });
});

describe("⑩ 转 base64 计划", () => {
  it("png/jpeg/svg 的 mime 按扩展名推断，载荷是标准 base64", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const png = planConvertToBase64("./assets/a.png", bytes);
    expect(png?.newSrc).toBe(`data:image/png;base64,${bytesToBase64(bytes)}`);
    expect(png?.mime).toBe("image/png");
    expect(png?.oldSrc).toBe("./assets/a.png");
    expect(planConvertToBase64("./assets/a.jpg", bytes)?.mime).toBe("image/jpeg");
    expect(planConvertToBase64("./assets/a.jpeg", bytes)?.mime).toBe("image/jpeg");
    expect(planConvertToBase64("./assets/a.svg", bytes)?.mime).toBe("image/svg+xml");
    expect(planConvertToBase64("./assets/a.webp", bytes)?.mime).toBe("image/webp");
    // 未知扩展名回落 image/png（保证总能产出可用的 data URL）
    expect(planConvertToBase64("./assets/a.unknown", bytes)?.mime).toBe("image/png");
  });

  it("asset.localhost 引用也能内联（⑩ 的核心：解码后的本地图可转 base64）", () => {
    const plan = planConvertToBase64(ASSET_SRC, new Uint8Array([9, 9]));
    expect(plan?.oldSrc).toBe(ASSET_SRC);
    expect(plan?.fileName).toBe("image-3.png");
    expect(plan?.newSrc.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("无文件名 / 空内容 → null（调用方据此提示失败）", () => {
    expect(planConvertToBase64("data:image/png;base64,AA", new Uint8Array([1]))).toBeNull();
    expect(planConvertToBase64("./assets/", new Uint8Array([1]))).toBeNull();
    expect(planConvertToBase64("./assets/a.png", new Uint8Array(0))).toBeNull();
  });
});

describe("⑩ base64 编解码互逆", () => {
  it("任意字节串往返一致（含需要补 = 的余数长度）", () => {
    for (const len of [1, 2, 3, 4, 5, 6, 7, 100, 257]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) bytes[i] = (i * 37) % 256;
      const b64 = bytesToBase64(bytes);
      expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
  });

  it("已知向量（与 btoa 语义一致）", () => {
    expect(bytesToBase64(new Uint8Array([77, 97, 110]))).toBe("TWFu");
    expect(bytesToBase64(new Uint8Array([77, 97]))).toBe("TWE=");
    expect(bytesToBase64(new Uint8Array([77]))).toBe("TQ==");
    expect(Array.from(base64ToBytes("TWFu"))).toEqual([77, 97, 110]);
  });

  it("容忍换行 / 空白（有些工具会折行输出）", () => {
    expect(Array.from(base64ToBytes("TWFu\n"))).toEqual([77, 97, 110]);
    expect(Array.from(base64ToBytes(" TW Fu "))).toEqual([77, 97, 110]);
  });
});

describe("⑩ parseDataUrl / mime 映射", () => {
  it("解析 mime、载荷与是否 base64", () => {
    expect(parseDataUrl("data:image/png;base64,AAAA")).toEqual({
      mime: "image/png",
      payload: "AAAA",
      isBase64: true,
    });
    expect(parseDataUrl("data:image/svg+xml,<svg/>")).toEqual({
      mime: "image/svg+xml",
      payload: "<svg/>",
      isBase64: false,
    });
    // 无 mime → 默认 image/png
    expect(parseDataUrl("data:,hello")?.mime).toBe("image/png");
    expect(parseDataUrl("./a.png")).toBeNull();
  });

  it("mime ↔ 扩展名双向映射", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(extensionForMime("image/unknown")).toBe("png");
    expect(mimeForFileName("a.PNG")).toBe("image/png");
    expect(mimeForFileName("a.jpeg")).toBe("image/jpeg");
    expect(mimeForFileName("noext")).toBe("image/png");
  });
});

describe("⑩ resolveImageAbsPath：引用 → 磁盘绝对路径", () => {
  it("asset.localhost 解码后直接就是绝对路径（不拼 docDir）", () => {
    expect(resolveImageAbsPath(ASSET_SRC, "D:/docs")).toBe(ASSET_DECODED);
  });

  it("相对路径基于 docDir 解析，处理 ./ 与 ../", () => {
    expect(resolveImageAbsPath("./assets/a.png", "D:/docs")).toBe("D:/docs/assets/a.png");
    expect(resolveImageAbsPath("../pic/a.png", "D:/docs/sub")).toBe("D:/docs/pic/a.png");
    expect(resolveImageAbsPath("assets/a.png", "D:/docs")).toBe("D:/docs/assets/a.png");
  });

  it("绝对路径归一化为正斜杠", () => {
    expect(resolveImageAbsPath("D:\\pic\\a.png", "D:/docs")).toBe("D:/pic/a.png");
    expect(resolveImageAbsPath("/home/u/a.png", "D:/docs")).toBe("/home/u/a.png");
  });

  it("data URL / 真远程 / 无 docDir 的相对路径 → null（据此禁用按钮）", () => {
    expect(resolveImageAbsPath("data:image/png;base64,AA", "D:/docs")).toBeNull();
    expect(resolveImageAbsPath("https://a.com/x.png", "D:/docs")).toBeNull();
    expect(resolveImageAbsPath("blob:http://x/y", "D:/docs")).toBeNull();
    expect(resolveImageAbsPath("./assets/a.png", null)).toBeNull();
    expect(resolveImageAbsPath("", "D:/docs")).toBeNull();
  });
});

// ═════════ ⑪⑫ 一次出现一行 + 文档顺序 ═════════

describe("⑫ collectDocImageOccurrences：一次出现一行", () => {
  it("用户文档：5 处引用 → 5 行（旧实现按 src 合并只剩 3 行）", () => {
    const rows = collectDocImageOccurrences(markdownToDoc(USER_DOC_MD));
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.src)).toEqual([
      ASSET_SRC,
      ASSET_SRC,
      "./assets/image-4.png",
      "./assets/image-4.png",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    ]);
  });

  it("稳定文档序号 0..n-1，同一 src 的两行序号不同", () => {
    const rows = collectDocImageOccurrences(markdownToDoc(USER_DOC_MD));
    expect(rows.map((r) => r.docIndex)).toEqual([0, 1, 2, 3, 4]);
    const dup = rows.filter((r) => r.src === "./assets/image-4.png");
    expect(dup).toHaveLength(2);
    expect(new Set(dup.map((r) => r.docIndex)).size).toBe(2);
  });

  it("count 仍是该 src 的**全文出现次数**（操作要作用于全部出现）", () => {
    const rows = collectDocImageOccurrences(markdownToDoc(USER_DOC_MD));
    expect(countRefsOf(rows, ASSET_SRC)).toBe(2);
    expect(countRefsOf(rows, "./assets/image-4.png")).toBe(2);
    expect(countRefsOf(rows, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")).toBe(1);
    for (const row of rows.filter((r) => r.src === "./assets/image-4.png")) {
      expect(row.count).toBe(2);
      expect(row.nodeCount).toBe(2);
    }
  });

  it("⑪ 严格按文档顺序（不得按字母序/哈希序重排）", () => {
    const md = "![b](./assets/zzz.png)\n\n![a](./assets/aaa.png)\n\n![b2](./assets/zzz.png)\n";
    const rows = collectDocImageOccurrences(markdownToDoc(md));
    expect(rows.map((r) => r.src)).toEqual([
      "./assets/zzz.png",
      "./assets/aaa.png",
      "./assets/zzz.png",
    ]);
  });

  it("alt / width / align 逐行独立保留（同一 src 的两行各用各自属性）", () => {
    const md = "![甲|300|center](./assets/a.png)\n\n![乙](./assets/a.png)\n";
    const rows = collectDocImageOccurrences(markdownToDoc(md));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ alt: "甲", width: 300, align: "center" });
    expect(rows[1]).toMatchObject({ alt: "乙", width: null, align: "left" });
  });

  it("空文档 / 无图 → 空数组；空 src 被跳过", () => {
    expect(collectDocImageOccurrences(markdownToDoc("纯文本\n"))).toEqual([]);
    expect(collectDocImageOccurrences(markdownToDoc("![](  )\n"))).toEqual([]);
  });

  it("既有 collectDocImages 仍按 src 合并（老接口回归锁）", () => {
    const merged = collectDocImages(markdownToDoc(USER_DOC_MD));
    expect(merged).toHaveLength(3);
    expect(merged[0].count).toBe(2);
    expect(merged[0].docIndex).toBe(0);
  });
});

describe("⑫ findUnreferenced 在“一次出现一行”下仍然正确", () => {
  it("重复引用去重后不把已引用的文件误判为未引用", () => {
    const rows = collectDocImageOccurrences(
      markdownToDoc("![a](./assets/a.png)\n\n![a2](./assets/a.png)\n\n![b](./assets/b.png)\n"),
    );
    expect(findUnreferenced(["a.png", "b.png", "c.png", "d.png"], rows)).toEqual([
      "c.png",
      "d.png",
    ]);
  });

  it("asset.localhost 引用的文件也算已引用（解码后取文件名）", () => {
    const rows = collectDocImageOccurrences(markdownToDoc(`![x](${ASSET_SRC})\n`));
    expect(findUnreferenced(["image-3.png", "ghost.png"], rows)).toEqual(["ghost.png"]);
  });
});

// ═════════ ⑬ 只改主名，扩展名保持原样 ═════════

describe("⑬ planRenameBaseName：扩展名自动保留", () => {
  it("只给主名 → 后缀沿用原名", () => {
    expect(planRenameBaseName("./assets/a.png", "b")).toEqual({
      oldSrc: "./assets/a.png",
      newSrc: "./assets/b.png",
      fileName: "b.png",
    });
    expect(planRenameBaseName("assets/a.jpg", "b")?.newSrc).toBe("assets/b.jpg");
    expect(planRenameBaseName("D:/pic/a.webp", "b")?.newSrc).toBe("D:/pic/b.webp");
  });

  it("无扩展名文件保持无扩展名", () => {
    expect(planRenameBaseName("./assets/img", "other")?.fileName).toBe("other");
  });

  it("用户顺手把后缀也打进来 → 剥掉，不会产出 b.png.png", () => {
    expect(planRenameBaseName("./assets/a.png", "b.png")?.fileName).toBe("b.png");
    expect(planRenameBaseName("./assets/a.png", "b.jpg")?.fileName).toBe("b.png");
    expect(planRenameBaseName("./assets/a.png", "  b.PNG  ")?.fileName).toBe("b.png");
  });

  it("主名里的点号（非图片后缀）不当后缀剥", () => {
    expect(planRenameBaseName("./assets/a.png", "v1.2")?.fileName).toBe("v1.2.png");
    expect(planRenameBaseName("./assets/a.png", "my.file")?.fileName).toBe("my.file.png");
  });

  it("主名没变 → null（无意义的重命名）", () => {
    expect(planRenameBaseName("./assets/a.png", "a")).toBeNull();
    // 打全名也一样（剥掉后缀后主名没变）
    expect(planRenameBaseName("./assets/a.png", "a.png")).toBeNull();
  });

  it("空 / 只有空白 / 只有后缀 → null", () => {
    expect(planRenameBaseName("./assets/a.png", "")).toBeNull();
    expect(planRenameBaseName("./assets/a.png", "   ")).toBeNull();
    expect(planRenameBaseName("./assets/a.png", ".png")).toBeNull();
  });

  it("与其它文件重名（大小写不敏感）→ null；忽略自身", () => {
    expect(planRenameBaseName("./assets/a.png", "b", ["a.png", "b.png"])).toBeNull();
    expect(planRenameBaseName("./assets/a.png", "B", ["b.png"])).toBeNull();
    expect(planRenameBaseName("./assets/a.png", "b", ["a.png"])?.fileName).toBe("b.png");
  });

  it("asset.localhost 引用：保留原始 URL 前缀，只换文件名（且文件名编码正确）", () => {
    const plan = planRenameBaseName(ASSET_SRC, "renamed");
    expect(plan?.newSrc).toBe(
      "http://asset.localhost/D%3A%2F10254%2F%E6%A1%8C%E9%9D%A2%2Fassets%2Frenamed.png",
    );
    expect(plan?.fileName).toBe("renamed.png");
  });

  it("⑬ 面板用的主名/后缀取值与输入框展示一致", () => {
    expect(imageBaseNameOf("./assets/a.png")).toBe("a");
    expect(imageExtNameOf("./assets/a.png")).toBe(".png");
    expect(imageBaseNameOf(ASSET_SRC)).toBe("image-3");
    expect(imageExtNameOf(ASSET_SRC)).toBe(".png");
    expect(imageBaseNameOf("./assets/noext")).toBe("noext");
    expect(imageExtNameOf("./assets/noext")).toBe("");
  });

  it("planRename 语义不变（第二轮测试的契约不能被我改坏）", () => {
    expect(planRename("./assets/a.png", "b.png", ["a.png", "b.png"])).toBeNull();
    expect(planRename("./assets/a.png", "a.png", ["a.png"])).toBeNull();
    expect(planRename("./assets/a.png", "c.png", ["a.png", "b.png"])).toEqual({
      oldSrc: "./assets/a.png",
      newSrc: "./assets/c.png",
      fileName: "c.png",
    });
  });
});

// ═════════ i18n：双语 key 集合一致 ═════════

describe("i18n：新增图片管理 key 双语齐备", () => {
  const NEW_KEYS = [
    "imageManager.colKind",
    "imageManager.kindBase64",
    "imageManager.kindFile",
    "imageManager.kindRemote",
    "imageManager.inline",
    "imageManager.inlineTip",
    "imageManager.inlined",
    "imageManager.inlineFailed",
    "imageManager.remoteUnsupported",
    "imageManager.renameUnavailable",
    "imageManager.renameBaseTip",
  ];

  it("每个新 key 在 zh-CN 与 en-US 都有非空文案", () => {
    for (const key of NEW_KEYS) {
      expect(zhCN[key], `zh-CN 缺 ${key}`).toBeTruthy();
      expect(enUS[key], `en-US 缺 ${key}`).toBeTruthy();
    }
  });

  it("整体 key 集合完全一致（项目规则）", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(enUS).sort());
  });

  it("renameBaseTip 的 {ext} 占位符两种语言都有", () => {
    expect(zhCN["imageManager.renameBaseTip"]).toContain("{ext}");
    expect(enUS["imageManager.renameBaseTip"]).toContain("{ext}");
  });
});

// ═════════ 组件：⑩⑪⑫⑬ 的端到端行为 ═════════

function bodyRows(): HTMLElement[] {
  return Array.from(
    screen.getByTestId("image-manager").querySelectorAll("tbody tr"),
  ) as HTMLElement[];
}

function srcOf(row: HTMLElement): string {
  return (row.querySelector(".image-mgr-src") as HTMLElement).textContent ?? "";
}

function migrateBtn(row: HTMLElement): HTMLButtonElement {
  return row.querySelector<HTMLButtonElement>('button[title^="复制到文档同级"]')!;
}

function inlineBtn(row: HTMLElement): HTMLButtonElement {
  return row.querySelector<HTMLButtonElement>('button[title^="读取该文件"]')!;
}

describe("面板 ⑫：用户文档列出 5 行（一次出现一行）", () => {
  it("页签计数与表格行数都是 5（旧实现只有 3）", () => {
    renderPanel();
    expect(screen.getByText("文档图片（5）")).toBeTruthy();
    expect(bodyRows()).toHaveLength(5);
  });

  it("⑪ 行顺序 = 文档顺序（两个 image-4 相邻，base64 在最后）", () => {
    renderPanel();
    const rows = bodyRows();
    expect(srcOf(rows[0])).toBe(ASSET_SRC);
    expect(srcOf(rows[1])).toBe(ASSET_SRC);
    expect(srcOf(rows[2])).toBe("./assets/image-4.png");
    expect(srcOf(rows[3])).toBe("./assets/image-4.png");
    expect(srcOf(rows[4])).toContain("data:image/png;base64,");
  });

  it("引用计数列：重复引用的两张各显示 2", () => {
    renderPanel();
    const counts = Array.from(
      screen.getByTestId("image-manager").querySelectorAll(".image-mgr-count"),
    ).map((el) => el.textContent);
    expect(counts).toEqual(["2", "2", "2", "2", "1"]);
  });
});

describe("面板 ⑩：逐图形态徽标 + 相反方向按钮", () => {
  it("三类徽标各自出现，且只有相反方向的按钮可用", () => {
    renderPanel();
    const rows = bodyRows();

    // asset.localhost（本地文件，已在 assets/ 里）→ 转 base64 可用、转 assets 无意义
    expect(rows[0].querySelector(".image-mgr-badge")?.className).toContain("file");
    expect(inlineBtn(rows[0]).disabled).toBe(false);
    expect(migrateBtn(rows[0]).disabled).toBe(true);

    // ./assets/image-4.png（本地文件）→ 转 base64 可用
    expect(inlineBtn(rows[2]).disabled).toBe(false);

    // data URL（内联 base64）→ 转 assets 可用、转 base64 无意义
    expect(rows[4].querySelector(".image-mgr-badge")?.className).toContain("base64");
    expect(migrateBtn(rows[4]).disabled).toBe(false);
    expect(inlineBtn(rows[4]).disabled).toBe(true);
  });

  it("⑩ asset.localhost 行点「转 base64」→ 用**解码后的绝对路径**读盘并内联", async () => {
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const { onRewriteRefs } = renderPanel({ markdown: `![x](${ASSET_SRC})\n` });
    fireEvent.click(screen.getByTitle(/读取该文件/));

    await waitFor(() => expect(mockReadFile).toHaveBeenCalledTimes(1));
    // 旧实现会拼出 D:/docs/http://asset.localhost/... 这样的垃圾路径
    expect(mockReadFile).toHaveBeenCalledWith(ASSET_DECODED);
    await waitFor(() => expect(onRewriteRefs).toHaveBeenCalledTimes(1));
    const ops = (onRewriteRefs as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{
      oldSrc: string;
      newSrc: string;
    }>;
    expect(ops[0].oldSrc).toBe(ASSET_SRC);
    expect(ops[0].newSrc).toBe("data:image/png;base64,AQID");
    expect(screen.getByText(/已内联为 base64/)).toBeTruthy();
  });

  it("⑩ data URL 行点「转 assets」→ 解码载荷写盘（旧实现提示转存失败）", async () => {
    mockExists.mockResolvedValue(true);
    mockListDir.mockResolvedValue([]);
    mockWriteFile.mockResolvedValue(undefined);
    const { onRewriteRefs } = renderPanel({
      markdown: "![x](data:image/png;base64,AQID)\n",
    });
    fireEvent.click(screen.getByTitle(/复制到文档同级/));

    await waitFor(() => expect(mockWriteFile).toHaveBeenCalledTimes(1));
    // AQID = 字节 [1,2,3]
    expect(mockWriteFile).toHaveBeenCalledWith(
      "D:/docs/assets/image.png",
      new Uint8Array([1, 2, 3]),
    );
    await waitFor(() => expect(onRewriteRefs).toHaveBeenCalledTimes(1));
    expect(onRewriteRefs).toHaveBeenCalledWith([
      { oldSrc: "data:image/png;base64,AQID", newSrc: "assets/image.png" },
    ]);
  });

  it("⑩ 真远程图：两个转换按钮都不可用（面板不联网抓图）", () => {
    renderPanel({ markdown: "![x](https://a.com/pic/x.png)\n" });
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".image-mgr-badge")?.className).toContain("remote");
    expect(migrateBtn(rows[0]).disabled).toBe(true);
    expect(inlineBtn(rows[0]).disabled).toBe(true);
    // 远程行仍然列出（用户要能看到它）
    expect(srcOf(rows[0])).toBe("https://a.com/pic/x.png");
  });
});

describe("面板 ⑬：重命名输入框只编辑主名", () => {
  it("输入框值为空、placeholder 是主名、后缀以固定文本显示", () => {
    renderPanel({ markdown: "![图](./assets/a.png)\n" });
    const input = screen.getByPlaceholderText("a") as HTMLInputElement;
    expect(input.value).toBe("");
    // 后缀作为固定文本，不进入输入框
    expect(screen.getByText(".png")).toBeTruthy();
    // 整个文件名不再出现在输入框里
    expect(screen.queryByPlaceholderText("a.png")).toBeNull();
  });

  it("输入主名 → rename_file 到同目录、后缀自动补上、引用同步改写", async () => {
    mockRenameFile.mockResolvedValue(undefined);
    const { onRewriteRefs } = renderPanel({ markdown: "![图](./assets/a.png)\n" });
    fireEvent.change(screen.getByPlaceholderText("a"), { target: { value: "b" } });
    fireEvent.click(screen.getByTitle(/重命名文件/));

    await waitFor(() => expect(mockRenameFile).toHaveBeenCalledTimes(1));
    expect(mockRenameFile).toHaveBeenCalledWith("D:/docs/assets/a.png", "D:/docs/assets/b.png");
    expect(onRewriteRefs).toHaveBeenCalledWith([
      { oldSrc: "./assets/a.png", newSrc: "./assets/b.png" },
    ]);
    expect(screen.getByText(/已重命名为 b\.png/)).toBeTruthy();
  });

  it("用户把后缀也打进来 → 不会变成 b.png.png", async () => {
    mockRenameFile.mockResolvedValue(undefined);
    const { onRewriteRefs } = renderPanel({ markdown: "![图](./assets/a.png)\n" });
    fireEvent.change(screen.getByPlaceholderText("a"), { target: { value: "b.png" } });
    fireEvent.click(screen.getByTitle(/重命名文件/));
    await waitFor(() => expect(mockRenameFile).toHaveBeenCalledTimes(1));
    expect(onRewriteRefs).toHaveBeenCalledWith([
      { oldSrc: "./assets/a.png", newSrc: "./assets/b.png" },
    ]);
  });

  it("asset.localhost 行重命名：读的是解码后的绝对路径，引用前缀保持 asset URL", async () => {
    mockRenameFile.mockResolvedValue(undefined);
    const { onRewriteRefs } = renderPanel({ markdown: `![x](${ASSET_SRC})\n` });
    fireEvent.change(screen.getByPlaceholderText("image-3"), { target: { value: "renamed" } });
    fireEvent.click(screen.getByTitle(/重命名文件/));

    await waitFor(() => expect(mockRenameFile).toHaveBeenCalledTimes(1));
    expect(mockRenameFile).toHaveBeenCalledWith(ASSET_DECODED, "D:/10254/桌面/assets/renamed.png");
    expect(onRewriteRefs).toHaveBeenCalledWith([
      {
        oldSrc: ASSET_SRC,
        newSrc: "http://asset.localhost/D%3A%2F10254%2F%E6%A1%8C%E9%9D%A2%2Fassets%2Frenamed.png",
      },
    ]);
  });

  it("同一 src 的两行共享同一份草稿（同一个文件，不能给出互相冲突的新名）", () => {
    renderPanel({ markdown: "![a](./assets/a.png)\n\n![b](./assets/a.png)\n" });
    const inputs = screen.getAllByPlaceholderText("a") as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0], { target: { value: "z" } });
    const after = screen.getAllByPlaceholderText("a") as HTMLInputElement[];
    expect(after[0].value).toBe("z");
    expect(after[1].value).toBe("z");
  });
});

// ═════════ 真实用户文档（存在时才跑，避免机器依赖）═════════

const REAL_DOC = "D:/10254/桌面/md测试.md";
const realDocExists = existsSync(REAL_DOC);

describe.skipIf(!realDocExists)("实机文档回归锁：D:/10254/桌面/md测试.md", () => {
  /**
   * v0.13.1：这两条原本把**用户机器上那份活文档的内容**写死在断言里
   * （"5 处引用 / 4 个可转 base64 / 1 个可转 assets"）。但 `md测试.md` 是用户的
   * 普通文档，随时会被编辑 —— 实测该文件在 2026-10-16 15:12 已变成
   * **3 处引用、0 个 asset.localhost**，于是这两条在**本轮任何代码改动之前就已经是红的**
   * （属环境性失败，不是代码回归）。
   *
   * 修正原则：**保留回归价值，去掉写死的数字**。
   * 第三轮的真实缺陷是"文档里 5 处引用，面板却只显示 3 行"，
   * 因此核心锁是 —— **面板行数必须等于解析出的引用处数**，且每种 src 形态都要判对类型。
   * 期望值全部由夹具推导，文档再怎么改都能跑，而锁依然有效。
   */
  it("解析出的每一处引用都判对类型（asset.localhost / 相对路径 → 本地文件）", () => {
    const raw = readFileSync(REAL_DOC, "utf8");
    const rows = collectDocImageOccurrences(markdownToDoc(raw));
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const kind = imageSourceKind(row.src);
      if (row.src.startsWith("data:")) {
        expect(kind).toBe("base64");
      } else if (/^https?:\/\//i.test(row.src) && !row.src.includes("asset.localhost")) {
        expect(kind).toBe("remote");
      } else {
        // asset.localhost / 相对路径 / 绝对路径 —— 都是磁盘上的本地文件
        expect(kind).toBe("file");
        expect(isExternalImageSrc(row.src)).toBe(false);
        expect(resolveImageAbsPath(row.src, "D:/10254/桌面")).toBeTruthy();
      }
    }

    // 只要文档里存在 asset.localhost 形态，就必须能解码回真实绝对路径（第三轮 ⑩ 缺陷）
    const assetRow = rows.find((r) => r.src.includes("asset.localhost"));
    if (assetRow) {
      const decoded = resolveImageAbsPath(assetRow.src, "D:/10254/桌面");
      expect(decoded).toBeTruthy();
      expect(decoded).toContain("/assets/");
      expect(decoded).not.toContain("%3A");
      expect(imageFileNameOf(assetRow.src)).toMatch(/\.png$/i);
    }
  });

  it("面板行数 == 解析出的引用处数（第三轮「5 处只显示 3 行」的回归锁）", () => {
    const raw = readFileSync(REAL_DOC, "utf8");
    const rows = collectDocImageOccurrences(markdownToDoc(raw));
    renderPanel({ markdown: raw });

    // ① 标签计数与表格行数都必须等于**真实处数**（同一 src 出现两次 = 两行）
    expect(screen.getByText(`文档图片（${rows.length}）`)).toBeTruthy();
    expect(bodyRows()).toHaveLength(rows.length);

    // ② 按钮可用性由纯函数推导（与面板内 migrateApplicable / inlineApplicable 同源，
    //    见 ImageManagerDialog.tsx：conversion = oppositeConversionOf(img.src)、
    //    migrateApplicable = kind !== "remote" && !livesInAssetsDir(img.src)）
    const expectedInline = rows.filter((r) => oppositeConversionOf(r.src) === "toBase64").length;
    const expectedMigrate = rows.filter(
      (r) => imageSourceKind(r.src) !== "remote" && !livesInAssetsDir(r.src),
    ).length;
    const enabledInline = screen
      .getAllByTitle(/读取该文件/)
      .filter((b) => !(b as HTMLButtonElement).disabled);
    const enabledMigrate = screen
      .getAllByTitle(/复制到文档同级/)
      .filter((b) => !(b as HTMLButtonElement).disabled);
    expect(enabledInline).toHaveLength(expectedInline);
    expect(enabledMigrate).toHaveLength(expectedMigrate);
  });
});

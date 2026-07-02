/**
 * ImagePasteDialog —— 图片保存到 assets/ 模式测试
 *
 * 覆盖：
 * - 纯函数：getExtFromMime、getExtFromName、generateUniqueFileName、getRelativeAssetsPath
 * - saveImageToAssets 完整流程：单文件无冲突、单文件冲突加序号、无扩展名用 MIME 推断、
 *   多文件同批次去重、目录自动创建、二进制写入
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 在模块加载前注册 mock，使用 vi.hoisted 保证引用稳定
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockExists = vi.hoisted(() => vi.fn());
const mockReadDir = vi.hoisted(() => vi.fn());
const mockDirname = vi.hoisted(() => vi.fn());
const mockJoin = vi.hoisted(() => vi.fn());
const mockNotifyWarning = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  exists: mockExists,
  readDir: mockReadDir,
}));

vi.mock("@tauri-apps/api/path", () => ({
  dirname: mockDirname,
  join: mockJoin,
}));

vi.mock("../../services/notificationService", () => ({
  notifyWarning: mockNotifyWarning,
}));

vi.mock("../../services/fileService", () => ({
  isTauri: () => true,
}));

import {
  getExtFromMime,
  getExtFromName,
  generateUniqueFileName,
  getRelativeAssetsPath,
  saveImageToAssets,
} from "../components/dialogs/ImagePasteDialog";

// PNG 文件头 8 字节
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 构造一个简易 File 对象 */
function makeFile(name: string, type: string, bytes: Uint8Array = PNG_BYTES): File {
  return new File([bytes], name, { type });
}

beforeEach(() => {
  mockWriteFile.mockReset();
  mockMkdir.mockReset();
  mockExists.mockReset();
  mockReadDir.mockReset();
  mockDirname.mockReset();
  mockJoin.mockReset();
  mockNotifyWarning.mockReset();

  // 默认模拟路径拼接：dirname 返回父目录，join 用 / 连接
  mockDirname.mockImplementation(async (p: string) => p.split("/").slice(0, -1).join("/") || "/");
  mockJoin.mockImplementation(async (...segs: string[]) => segs.join("/"));
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockExists.mockResolvedValue(false);
  mockReadDir.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 纯函数：getExtFromMime ──────────────────────────────

describe("getExtFromMime - MIME 类型到扩展名", () => {
  it("image/png → png", () => {
    expect(getExtFromMime("image/png")).toBe("png");
  });

  it("image/jpeg → jpg", () => {
    expect(getExtFromMime("image/jpeg")).toBe("jpg");
  });

  it("image/gif → gif", () => {
    expect(getExtFromMime("image/gif")).toBe("gif");
  });

  it("image/svg+xml → svg", () => {
    expect(getExtFromMime("image/svg+xml")).toBe("svg");
  });

  it("未知 MIME 类型默认返回 png", () => {
    expect(getExtFromMime("image/unknown")).toBe("png");
  });

  it("空字符串默认返回 png", () => {
    expect(getExtFromMime("")).toBe("png");
  });
});

// ─── 纯函数：getExtFromName ──────────────────────────────

describe("getExtFromName - 文件名提取扩展名", () => {
  it("image.png → png", () => {
    expect(getExtFromName("image.png")).toBe("png");
  });

  it("photo.JPG → jpg（小写化）", () => {
    expect(getExtFromName("photo.JPG")).toBe("jpg");
  });

  it("a.b.PNG → png（多段取最后一段）", () => {
    expect(getExtFromName("a.b.PNG")).toBe("png");
  });

  it("无扩展名返回空串", () => {
    expect(getExtFromName("README")).toBe("");
  });

  it("以点开头的隐藏文件返回空串（如 .gitignore）", () => {
    expect(getExtFromName(".gitignore")).toBe("");
  });

  it("空字符串返回空串", () => {
    expect(getExtFromName("")).toBe("");
  });
});

// ─── 纯函数：generateUniqueFileName ──────────────────────

describe("generateUniqueFileName - 唯一文件名生成", () => {
  it("无冲突时直接使用原文件名", () => {
    const existing = new Set<string>(["other.png"]);
    expect(generateUniqueFileName(existing, "image.png")).toBe("image.png");
  });

  it("空集合时直接使用原文件名", () => {
    const existing = new Set<string>();
    expect(generateUniqueFileName(existing, "image.png")).toBe("image.png");
  });

  it("冲突时追加 -1 序号", () => {
    const existing = new Set<string>(["image.png"]);
    expect(generateUniqueFileName(existing, "image.png")).toBe("image-1.png");
  });

  it("多次冲突依次追加 -1, -2, -3", () => {
    const existing = new Set<string>(["image.png", "image-1.png", "image-2.png"]);
    expect(generateUniqueFileName(existing, "image.png")).toBe("image-3.png");
  });

  it("无扩展名文件冲突时序号追加在末尾", () => {
    const existing = new Set<string>(["README", "README-1"]);
    expect(generateUniqueFileName(existing, "README")).toBe("README-2");
  });

  it("多扩展名文件保留全部扩展名", () => {
    const existing = new Set<string>(["archive.tar.gz"]);
    expect(generateUniqueFileName(existing, "archive.tar.gz")).toBe("archive.tar-1.gz");
  });
});

// ─── 纯函数：getRelativeAssetsPath ────────────────────────

describe("getRelativeAssetsPath - 生成相对路径引用", () => {
  it("image.png → ./assets/image.png", () => {
    expect(getRelativeAssetsPath("image.png")).toBe("./assets/image.png");
  });

  it("sub/dir/img.jpg → ./assets/sub/dir/img.jpg", () => {
    expect(getRelativeAssetsPath("sub/dir/img.jpg")).toBe("./assets/sub/dir/img.jpg");
  });
});

// ─── saveImageToAssets 完整流程 ──────────────────────────

describe("saveImageToAssets - 保存图片到 assets 目录", () => {
  it("单文件无冲突：写入文件并返回相对路径", async () => {
    const file = makeFile("image.png", "image/png");
    const existing = new Set<string>();

    const result = await saveImageToAssets(file, "/docs/readme.md", existing);

    expect(result).toBe("./assets/image.png");
    // 应创建 assets 目录
    expect(mockMkdir).toHaveBeenCalledTimes(1);
    expect(mockMkdir).toHaveBeenCalledWith("/docs/assets", { recursive: true });
    // 应写入文件
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [targetPath, data] = mockWriteFile.mock.calls[0];
    expect(targetPath).toBe("/docs/assets/image.png");
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data as Uint8Array)).toEqual(Array.from(PNG_BYTES));
    // 应将最终文件名加入集合
    expect(existing.has("image.png")).toBe(true);
  });

  it("文件名冲突时自动追加序号", async () => {
    const file = makeFile("image.png", "image/png");
    const existing = new Set<string>(["image.png"]);

    const result = await saveImageToAssets(file, "/docs/readme.md", existing);

    expect(result).toBe("./assets/image-1.png");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [targetPath] = mockWriteFile.mock.calls[0];
    expect(targetPath).toBe("/docs/assets/image-1.png");
    expect(existing.has("image-1.png")).toBe(true);
  });

  it("无扩展名文件用 MIME 类型推断扩展名", async () => {
    const file = makeFile("screenshot", "image/png");
    const existing = new Set<string>();

    const result = await saveImageToAssets(file, "/docs/readme.md", existing);

    expect(result).toBe("./assets/screenshot.png");
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [targetPath] = mockWriteFile.mock.calls[0];
    expect(targetPath).toBe("/docs/assets/screenshot.png");
  });

  it("JPEG 文件推断为 jpg 扩展名", async () => {
    const file = makeFile("photo", "image/jpeg");
    const existing = new Set<string>();

    const result = await saveImageToAssets(file, "/docs/readme.md", existing);

    expect(result).toBe("./assets/photo.jpg");
  });

  it("多文件同批次去重：第二个同名文件追加序号", async () => {
    const file1 = makeFile("image.png", "image/png");
    const file2 = makeFile("image.png", "image/png");
    const existing = new Set<string>();

    const result1 = await saveImageToAssets(file1, "/docs/readme.md", existing);
    const result2 = await saveImageToAssets(file2, "/docs/readme.md", existing);

    expect(result1).toBe("./assets/image.png");
    expect(result2).toBe("./assets/image-1.png");
    // 两次写入，路径不同
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile.mock.calls[0][0]).toBe("/docs/assets/image.png");
    expect(mockWriteFile.mock.calls[1][0]).toBe("/docs/assets/image-1.png");
  });

  it("目录已存在时仍调用 mkdir（recursive 不报错）", async () => {
    mockMkdir.mockResolvedValue(undefined);
    const file = makeFile("image.png", "image/png");
    const existing = new Set<string>();

    await saveImageToAssets(file, "/docs/readme.md", existing);

    expect(mockMkdir).toHaveBeenCalledTimes(1);
    expect(mockMkdir).toHaveBeenCalledWith("/docs/assets", { recursive: true });
  });

  it("使用二进制数据写入（避免 Base64 编码开销）", async () => {
    const customBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const file = makeFile("image.png", "image/png", customBytes);
    const existing = new Set<string>();

    await saveImageToAssets(file, "/docs/readme.md", existing);

    const [, data] = mockWriteFile.mock.calls[0];
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it("空文件名时使用默认名 image-{timestamp}", async () => {
    const file = makeFile("", "image/png");
    const existing = new Set<string>();

    const result = await saveImageToAssets(file, "/docs/readme.md", existing);

    // 文件名以 image- 开头，扩展名为 .png
    expect(result).toMatch(/^\.\/assets\/image-\d+\.png$/);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it("路径拼接正确：使用 dirname 和 join", async () => {
    const file = makeFile("image.png", "image/png");
    const existing = new Set<string>();

    await saveImageToAssets(file, "/a/b/c/readme.md", existing);

    expect(mockDirname).toHaveBeenCalledWith("/a/b/c/readme.md");
    expect(mockJoin).toHaveBeenNthCalledWith(1, "/a/b/c", "assets");
    expect(mockJoin).toHaveBeenNthCalledWith(2, "/a/b/c/assets", "image.png");
  });
});

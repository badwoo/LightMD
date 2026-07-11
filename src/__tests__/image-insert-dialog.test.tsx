/**
 * ImageInsertDialog 组件测试
 *
 * 覆盖：
 * - buildImageMarkdown 纯函数
 * - 组件渲染、选择文件、预览、插入（mock Tauri dialog/fs API）
 * - Base64 内联模式与「复制到 assets」模式
 * - 大图警告、不支持格式错误提示
 * - Esc 取消、资源清理
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { useEditorStore } from "../stores/useEditorStore";

// 在模块加载前注册 mock，使用 vi.hoisted 保证引用稳定
const mockOpen = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockCopyFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockExists = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpen,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: mockReadFile,
  copyFile: mockCopyFile,
  mkdir: mockMkdir,
  exists: mockExists,
}));

// 组件在文件顶部 import，mock 需在 import 之前生效（vitest 自动 hoist vi.mock）
import { ImageInsertDialog, buildImageMarkdown } from "../components/dialogs/ImageInsertDialog";

// PNG 文件头 8 字节
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG_BYTES 的 base64 表示
const PNG_BASE64 = "iVBORw0KGgo=";

beforeEach(() => {
  cleanup();
  mockOpen.mockReset();
  mockReadFile.mockReset();
  mockCopyFile.mockReset();
  mockMkdir.mockReset();
  mockExists.mockReset();
  // 模拟 Tauri 运行环境，使 isTauri() 返回 true
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = true;
  useEditorStore.setState({ filePath: "/docs/readme.md" });
});

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  useEditorStore.setState({ filePath: null });
});

describe("buildImageMarkdown", () => {
  it("有 title 生成 ![alt](src \"title\")", () => {
    expect(buildImageMarkdown("alt", "src.png", "提示")).toBe('![alt](src.png "提示")');
  });

  it("无 title 生成 ![alt](src)", () => {
    expect(buildImageMarkdown("alt", "src.png", "")).toBe("![alt](src.png)");
  });

  it("src 为空返回空串", () => {
    expect(buildImageMarkdown("alt", "", "t")).toBe("");
  });
});

describe("<ImageInsertDialog />", () => {
  it("open=false 时不渲染", () => {
    const { container } = render(
      <ImageInsertDialog open={false} onInsert={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("open=true 渲染选择按钮与字段", () => {
    render(<ImageInsertDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/选择图片文件/)).toBeTruthy();
    expect(screen.getByPlaceholderText("图片的替代文字")).toBeTruthy();
  });

  it("点击选择按钮调用 Tauri dialog.open", async () => {
    mockOpen.mockResolvedValue("/path/to/img.png");
    mockReadFile.mockResolvedValue(PNG_BYTES);
    render(<ImageInsertDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择图片文件/));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    // open 应配置图片过滤器
    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }],
    });
  });

  it("选择 PNG 后预览图与文件信息出现", async () => {
    mockOpen.mockResolvedValue("/path/to/img.png");
    mockReadFile.mockResolvedValue(PNG_BYTES);
    const { container } = render(
      <ImageInsertDialog open onInsert={vi.fn()} onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByText(/选择图片文件/));
    await waitFor(() => {
      // 默认 assets 模式下 preview code 也含 "img.png"，需用 selector 限定到 file-info span
      expect(screen.getByText(/img\.png/, { selector: ".image-insert-file-info" })).toBeTruthy();
    });
    // alt 为空时 img 的可访问角色变为 presentation，故用 querySelector
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toContain("data:image/png;base64,");
  });

  it("Base64 模式插入回调 data URL", async () => {
    const onInsert = vi.fn();
    mockOpen.mockResolvedValue("/path/to/img.png");
    mockReadFile.mockResolvedValue(PNG_BYTES);
    render(<ImageInsertDialog open onInsert={onInsert} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择图片文件/));
    await waitFor(() =>
      // 默认 assets 模式下 preview code 也含 "img.png"，需用 selector 限定到 file-info span
      expect(screen.getByText(/img\.png/, { selector: ".image-insert-file-info" })).toBeTruthy(),
    );

    // Tauri 环境默认 assets 模式，显式切换到 Base64 模式
    fireEvent.click(screen.getByText(/Base64 内联/));

    fireEvent.change(screen.getByPlaceholderText("图片的替代文字"), {
      target: { value: "图片" },
    });
    fireEvent.change(screen.getByPlaceholderText("鼠标悬停提示"), {
      target: { value: "提示" },
    });
    fireEvent.click(screen.getByRole("button", { name: /插入/ }));

    await waitFor(() => expect(onInsert).toHaveBeenCalledTimes(1));
    expect(onInsert).toHaveBeenCalledWith(
      `![图片](data:image/png;base64,${PNG_BASE64} "提示")`
    );
  });

  it("Base64 模式无 title 输出 ![alt](src)", async () => {
    const onInsert = vi.fn();
    mockOpen.mockResolvedValue("/path/to/img.png");
    mockReadFile.mockResolvedValue(PNG_BYTES);
    render(<ImageInsertDialog open onInsert={onInsert} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择图片文件/));
    await waitFor(() =>
      // 默认 assets 模式下 preview code 也含 "img.png"，需用 selector 限定到 file-info span
      expect(screen.getByText(/img\.png/, { selector: ".image-insert-file-info" })).toBeTruthy(),
    );

    // Tauri 环境默认 assets 模式，显式切换到 Base64 模式
    fireEvent.click(screen.getByText(/Base64 内联/));

    fireEvent.change(screen.getByPlaceholderText("图片的替代文字"), {
      target: { value: "alt" },
    });
    fireEvent.click(screen.getByRole("button", { name: /插入/ }));
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(onInsert).toHaveBeenCalledWith(`![alt](data:image/png;base64,${PNG_BASE64})`);
  });

  it("assets 模式调用 copyFile/mkdir 并回调相对路径", async () => {
    const onInsert = vi.fn();
    mockOpen.mockResolvedValue("/path/to/img.png");
    mockReadFile.mockResolvedValue(PNG_BYTES);
    mockExists.mockResolvedValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);

    render(<ImageInsertDialog open onInsert={onInsert} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择图片文件/));
    await waitFor(() =>
      // 默认 assets 模式下 preview code 也含 "img.png"，需用 selector 限定到 file-info span
      expect(screen.getByText(/img\.png/, { selector: ".image-insert-file-info" })).toBeTruthy(),
    );

    // 切换到 assets 模式
    fireEvent.click(screen.getByText("📁 复制到 assets/"));
    fireEvent.change(screen.getByPlaceholderText("图片的替代文字"), {
      target: { value: "图" },
    });
    fireEvent.click(screen.getByRole("button", { name: /插入/ }));

    await waitFor(() => expect(mockCopyFile).toHaveBeenCalledTimes(1));
    // 目标路径应包含 assets/img.png
    const destArg = mockCopyFile.mock.calls[0][1] as string;
    expect(destArg).toContain("assets");
    expect(destArg).toContain("img.png");
    expect(onInsert).toHaveBeenCalledWith('![图](assets/img.png)');
  });

  it("assets 模式下未保存文档时显示错误且不插入", async () => {
    useEditorStore.setState({ filePath: null });
    const onInsert = vi.fn();
    mockOpen.mockResolvedValue("/path/to/img.png");
    mockReadFile.mockResolvedValue(PNG_BYTES);
    render(<ImageInsertDialog open onInsert={onInsert} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择图片文件/));
    await waitFor(() =>
      // 默认 assets 模式下 preview code 也含 "img.png"，需用 selector 限定到 file-info span
      expect(screen.getByText(/img\.png/, { selector: ".image-insert-file-info" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("📁 复制到 assets/"));
    fireEvent.click(screen.getByRole("button", { name: /插入/ }));

    await waitFor(() => expect(screen.getByText(/请先保存文档/)).toBeTruthy());
    expect(onInsert).not.toHaveBeenCalled();
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it("大图（>2MB）显示警告", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    mockOpen.mockResolvedValue("/path/to/big.png");
    mockReadFile.mockResolvedValue(big);
    render(<ImageInsertDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择图片文件/));
    // bytesToBase64 处理 2MB 数据耗时较长，增加 waitFor 超时到 5s
    await waitFor(
      () =>
        // 默认 assets 模式下 preview code 也含 "big.png"，需用 selector 限定到 file-info span
        expect(screen.getByText(/big\.png/, { selector: ".image-insert-file-info" })).toBeTruthy(),
      { timeout: 5000 },
    );
    // 大图警告仅在 Base64 模式下显示（assets 模式下不内联，无体积膨胀问题）
    fireEvent.click(screen.getByText(/Base64 内联/));
    await waitFor(() => expect(screen.getByText(/大于 2MB/)).toBeTruthy(), { timeout: 5000 });
  });

  it("不支持的格式显示错误", async () => {
    mockOpen.mockResolvedValue("/path/to/file.txt");
    render(<ImageInsertDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择图片文件/));
    await waitFor(() => expect(screen.getByText(/不支持的图片格式/)).toBeTruthy());
  });

  it("Esc 触发 onClose", () => {
    const onClose = vi.fn();
    render(<ImageInsertDialog open onInsert={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击取消调用 onClose", () => {
    const onClose = vi.fn();
    render(<ImageInsertDialog open onInsert={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("未选择文件时插入按钮禁用", () => {
    render(<ImageInsertDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    const insertBtn = screen.getByRole("button", { name: /插入/ }) as HTMLButtonElement;
    expect(insertBtn.disabled).toBe(true);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Favorites, collectFavoriteCandidates } from "../components/sidebar/Favorites";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";
import { useFileStore } from "../stores/useFileStore";

const tab = (path: string, name: string, isUntitled = false): TabInfo => ({ path, name, isUntitled });

beforeEach(() => {
  localStorage.clear();
  useFileStore.setState({ favorites: [] });
  useEditorStore.setState({
    openTabs: [tab("D:\\Docs\\A.md", "A.md"), tab("D:/Docs/B.md", "B.md")],
  });
});

afterEach(cleanup);

describe("v0.16.0 收藏候选与批量添加", () => {
  it("只收集已落盘标签，并按 Windows 路径比较键去重", () => {
    const candidates = collectFavoriteCandidates([
      tab("D:\\Docs\\A.md", "A.md"),
      tab("d:/docs/a.md", "重复.md"),
      tab("", "未命名.md", true),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("A.md");
  });

  it("支持多选、圆形复选语义、批量去重添加及成功反馈", () => {
    useFileStore.setState({
      favorites: [{ path: "d:/DOCS/a.md", name: "A.md", addedAt: 1 }],
    });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));

    const existing = screen.getByRole("checkbox", { name: /^A\.md/ });
    expect((existing as HTMLButtonElement).disabled).toBe(true);
    const target = screen.getByRole("checkbox", { name: /^B\.md/ });
    fireEvent.click(target);
    expect(target.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "添加至收藏" }));

    expect(useFileStore.getState().favorites).toHaveLength(2);
    expect(useFileStore.getState().favorites.some((file) => file.path === "D:/Docs/B.md")).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("1");
  });

  it("取消和 Esc 只丢弃未提交选择，不改变既有收藏", () => {
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^A\.md/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useFileStore.getState().favorites).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^B\.md/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("checkbox", { name: /^B\.md/ })).toBeNull();
    expect(useFileStore.getState().favorites).toHaveLength(0);
  });

  it("同名不同目录文件的可访问名称包含完整路径", () => {
    useEditorStore.setState({
      openTabs: [tab("D:/one/same.md", "same.md"), tab("D:/two/same.md", "same.md")],
    });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    expect(screen.getByRole("checkbox", { name: "same.md — D:/one/same.md" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "same.md — D:/two/same.md" })).toBeTruthy();
  });

  it("49 条既有收藏 + 选择 2 项：只添加 1 项并明确跳过 1 项，不淘汰旧收藏", () => {
    const existing = Array.from({ length: 49 }, (_, index) => ({
      path: `D:/old/${index}.md`, name: `${index}.md`, addedAt: index,
    }));
    useFileStore.setState({ favorites: existing });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^A\.md/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^B\.md/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加至收藏" }));

    const next = useFileStore.getState().favorites;
    expect(next).toHaveLength(50);
    expect(existing.every((old) => next.some((file) => file.path === old.path))).toBe(true);
    expect(next.some((file) => file.path === "D:\\Docs\\A.md")).toBe(true);
    expect(next.some((file) => file.path === "D:/Docs/B.md")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("已添加 1 项收藏，1 项因 50 条上限未添加");
  });

  it("已有 50 条且候选 51 项：全部跳过并保留原收藏，不虚报成功", () => {
    const existing = Array.from({ length: 50 }, (_, index) => ({
      path: `D:/old/${index}.md`, name: `${index}.md`, addedAt: index,
    }));
    useFileStore.setState({ favorites: existing });
    useEditorStore.setState({
      openTabs: Array.from({ length: 51 }, (_, index) => tab(`D:/new/${index}.md`, `${index}.md`)),
    });
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    for (const candidate of screen.getAllByRole("checkbox")) fireEvent.click(candidate);
    fireEvent.click(screen.getByRole("button", { name: "添加至收藏" }));

    const next = useFileStore.getState().favorites;
    expect(next).toHaveLength(50);
    expect(existing.every((old) => next.some((file) => file.path === old.path))).toBe(true);
    expect(next.some((file) => file.path.startsWith("D:/new/"))).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("已添加 0 项收藏，51 项因 50 条上限未添加");
  });

  it("选择期间关闭标签会清理失效候选和选择数量", () => {
    render(<Favorites onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加收藏" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^A\.md/ }));
    act(() => {
      useEditorStore.setState({ openTabs: [tab("D:/Docs/B.md", "B.md")] });
    });
    expect(screen.queryByRole("checkbox", { name: /^A\.md/ })).toBeNull();
    expect(screen.getByText("已选择 0 项")).toBeTruthy();
    expect((screen.getByRole("button", { name: "添加至收藏" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

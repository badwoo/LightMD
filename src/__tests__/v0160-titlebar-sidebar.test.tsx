// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TitleBar } from "../components/layout/TitleBar";
import { t } from "../i18n";

afterEach(cleanup);

describe("v0.16.0 标题栏侧栏控制", () => {
  it("文件侧栏收起时显示展开按钮，并切换侧栏", () => {
    const onToggleSidebar = vi.fn();
    const onCloseSidebarPanel = vi.fn();
    render(
      <TitleBar
        sidebarCollapsed
        sidebarView="files"
        onToggleSidebar={onToggleSidebar}
        onCloseSidebarPanel={onCloseSidebarPanel}
      />,
    );

    const button = screen.getByRole("button", { name: t("appshell.expandSidebar") });
    expect(button.getAttribute("title")).toBe(t("appshell.expandSidebar"));
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.nextElementSibling?.classList.contains("titlebar-brand")).toBe(true);
    fireEvent.click(button);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(onCloseSidebarPanel).not.toHaveBeenCalled();
  });

  it("文件侧栏展开时显示收起按钮", () => {
    render(
      <TitleBar
        sidebarCollapsed={false}
        sidebarView="files"
        onToggleSidebar={vi.fn()}
        onCloseSidebarPanel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: t("appshell.collapseSidebar") })).toBeTruthy();
  });

  it.each([
    ["favorites", "sidebar.closeFavorites"],
    ["recent", "sidebar.closeRecent"],
  ] as const)("%s 面板使用 X 图标关闭面板", (sidebarView, labelKey) => {
    const onToggleSidebar = vi.fn();
    const onCloseSidebarPanel = vi.fn();
    render(
      <TitleBar
        sidebarCollapsed={false}
        sidebarView={sidebarView}
        onToggleSidebar={onToggleSidebar}
        onCloseSidebarPanel={onCloseSidebarPanel}
      />,
    );

    const button = screen.getByRole("button", { name: t(labelKey) });
    expect(button.querySelector("svg line")).not.toBeNull();
    fireEvent.click(button);
    expect(onCloseSidebarPanel).toHaveBeenCalledTimes(1);
    expect(onToggleSidebar).not.toHaveBeenCalled();
  });
});

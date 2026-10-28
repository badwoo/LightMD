// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TABLE_MERGE_NOTICE_EVENT,
  TableMergeNotice,
  type TableMergeNoticeDetail,
} from "../components/editor/TableMergeNotice";
import { useSettingsStore } from "../stores/useSettingsStore";

/**
 * 派发提示事件。
 *
 * ⚠️ 必须包 `act`：事件监听器里会 `setOpen(true)`；在 React 18 下，组件外部的
 * `window.dispatchEvent` 不在 act 作用域内，状态更新不会被同步 flush，随后的
 * `screen.getByTestId` 就会拿不到刚渲染出来的 portal 节点（表现为"找不到元素"）。
 */
function emit(reason: TableMergeNoticeDetail["reason"]) {
  act(() => {
    window.dispatchEvent(new CustomEvent(TABLE_MERGE_NOTICE_EVENT, {
      detail: { reason },
    }));
  });
}

describe("TableMergeNotice", () => {
  beforeEach(() => {
    useSettingsStore.setState({ tableMergeNoticeSeen: false });
  });

  /**
   * ⚠️ 必须显式 cleanup：本项目**没有**全局 vitest setup 文件，
   * @testing-library/react 的自动 cleanup 依赖 `afterEach` 全局钩子被注册；
   * 这里手动兜底，否则上一个用例的 portal 会残留到下一个用例的 `document.body`，
   * `queryByTestId` 会命中多个元素直接抛错（表现为"找不到/找到多个"）。
   */
  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-testid="table-merge-notice"]').forEach((el) => el.remove());
  });

  it("首次成功合并显示一次，并写入 seen；后续自动事件不重复打开", () => {
    const { unmount } = render(<TableMergeNotice />);
    expect(screen.queryByTestId("table-merge-notice")).toBeNull();

    emit("merge");
    expect(screen.getByTestId("table-merge-notice")).not.toBeNull();
    expect(useSettingsStore.getState().tableMergeNoticeSeen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "关闭兼容性说明" }));
    expect(screen.queryByTestId("table-merge-notice")).toBeNull();
    emit("merge");
    expect(screen.queryByTestId("table-merge-notice")).toBeNull();

    unmount();
    render(<TableMergeNotice />);
    emit("merge");
    expect(screen.queryByTestId("table-merge-notice")).toBeNull();
  });

  it("手动说明随时可重看，且不产生编辑事务", () => {
    useSettingsStore.setState({ tableMergeNoticeSeen: true });
    render(<TableMergeNotice />);

    emit("manual");
    expect(screen.getByTestId("table-merge-notice")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("table-merge-notice")).toBeNull();

    emit("manual");
    expect(screen.getByTestId("table-merge-notice")).not.toBeNull();
    expect(useSettingsStore.getState().tableMergeNoticeSeen).toBe(true);
  });

  it("卸载后移除事件监听", () => {
    const { unmount } = render(<TableMergeNotice />);
    unmount();
    expect(() => emit("merge")).not.toThrow();
    expect(screen.queryByTestId("table-merge-notice")).toBeNull();
  });
});

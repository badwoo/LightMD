/**
 * 表格合并兼容性说明：成功合并后仅自动展示一次，菜单可随时重看。
 *
 * TableView 只发事件，不认识 React；本组件挂在每个 App 窗口根部，统一负责
 * seen 持久化与说明 UI。提示本身不修改文档、不产生撤销历史。
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/useSettingsStore";
import "./TableMergeNotice.css";

export const TABLE_MERGE_NOTICE_EVENT = "lightmd:tableMergeNotice";

export type TableMergeNoticeReason = "merge" | "manual";

export interface TableMergeNoticeDetail {
  reason: TableMergeNoticeReason;
}

export function TableMergeNotice() {
  const t = useT();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onNotice = (event: Event) => {
      const reason = (event as CustomEvent<TableMergeNoticeDetail>).detail?.reason;
      if (reason === "manual") {
        // 手动入口永远可重看，不受 seen 限制，也不改写 seen。
        setOpen(true);
        return;
      }
      if (reason !== "merge" || useSettingsStore.getState().tableMergeNoticeSeen) return;
      // 先记 seen 再展示，连续两次成功合并不会重复自动弹出。
      useSettingsStore.getState().setTableMergeNoticeSeen(true);
      setOpen(true);
    };
    window.addEventListener(TABLE_MERGE_NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(TABLE_MERGE_NOTICE_EVENT, onNotice);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="table-merge-notice" role="status" data-testid="table-merge-notice">
      <section className="table-merge-notice-card" aria-labelledby={titleId}>
        <div className="table-merge-notice-heading">
          <span className="table-merge-notice-icon" aria-hidden="true">ⓘ</span>
          <h2 id={titleId}>{t("table.mergeNoticeTitle")}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="table-merge-notice-close"
            aria-label={t("table.mergeNoticeClose")}
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="table-merge-notice-body">
          <p>{t("table.mergeNoticeGfm")}</p>
          <p>
            {t("table.mergeNoticeExtension")}{" "}
            <code>{'<td colspan="N" rowspan="N">'}</code>
          </p>
          <p>{t("table.mergeNoticeOtherEditors")}</p>
          <p>{t("table.mergeNoticeDepends")}</p>
          <p className="table-merge-notice-footnote">{t("table.mergeNoticeNoSourceChange")}</p>
        </div>
      </section>
    </div>,
    document.body,
  );
}

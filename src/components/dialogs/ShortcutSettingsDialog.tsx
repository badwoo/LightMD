/**
 * ShortcutSettingsDialog —— 自定义快捷键设置弹窗（v0.9.0）
 *
 * 交互（对齐 Ardot 设计稿 731114443999638 快捷键相关界面）：
 * - 顶部搜索框（按功能名/键位过滤）；
 * - 按分类分组列出 SHORTCUT_DEFS 全部可自定义条目，键帽显示生效键位；
 * - 点击条目进入录制态：按物理键盘组合即录入（D3，无虚拟键盘），
 *   Esc 取消 · Backspace 清除该条绑定（恢复默认）；
 * - 冲突：键帽红描边 + 行下方红色提示条「该快捷键已被『X』占用」，不写入；
 * - 行尾单项恢复图标；底部「恢复全部默认设置」+「完成」。
 *
 * 写入即时生效（useSettingsStore.setShortcut 内查重，persist v4 + 多窗口广播）。
 */
import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import {
  SHORTCUT_DEFS,
  comboFromEvent,
  findShortcutConflict,
  getShortcutLabel,
  type ShortcutCategory,
  type ShortcutDef,
} from "../../core/shortcuts";
import { useT } from "../../i18n";
import "./ShortcutSettingsDialog.css";

/** 分类展示顺序（与基线表一致） */
const CATEGORY_ORDER: ShortcutCategory[] = [
  "file", "edit", "format", "view", "tab", "window", "insert",
];

interface Props {
  onClose: () => void;
}

/** 键帽拆分："Ctrl+Shift+8" → ["Ctrl", "Shift", "8"] */
function comboParts(combo: string): string[] {
  return combo ? combo.split("+") : [];
}

export function ShortcutSettingsDialog({ onClose }: Props) {
  const t = useT();
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const setShortcut = useSettingsStore((s) => s.setShortcut);
  const resetShortcut = useSettingsStore((s) => s.resetShortcut);
  const resetAllShortcuts = useSettingsStore((s) => s.resetAllShortcuts);

  const [query, setQuery] = useState("");
  /** 录制态条目 id（null = 未在录制） */
  const [recordingId, setRecordingId] = useState<string | null>(null);
  /** 冲突/错误提示：id → i18n 已解析文案 */
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const customCount = Object.keys(shortcuts).length;

  /** 搜索过滤（功能名 + 当前生效键位） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_DEFS;
    return SHORTCUT_DEFS.filter((def) => {
      const label = t(def.labelKey).toLowerCase();
      const combo = (getShortcutLabel(def.id) ?? "").toLowerCase();
      return label.includes(q) || combo.includes(q) || def.id.toLowerCase().includes(q);
    });
  }, [query, t, shortcuts]);

  /** 按分类分组（保持 CATEGORY_ORDER 顺序） */
  const grouped = useMemo(() => {
    const map = new Map<ShortcutCategory, ShortcutDef[]>();
    for (const def of filtered) {
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({ category: c, defs: map.get(c)! }));
  }, [filtered]);

  // ─── 录制态：window 捕获阶段监听（拦截事件，避免触发应用快捷键） ───
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 输入法组合态用于选词，不能当快捷键
      if (e.isComposing) return;
      // Esc：取消录制，不修改
      if (e.key === "Escape") {
        setRecordingId(null);
        setError(null);
        return;
      }
      // Backspace：清除该条绑定（恢复默认）
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        resetShortcut(recordingId);
        setRecordingId(null);
        setError(null);
        return;
      }
      const combo = comboFromEvent(e);
      // 仅按修饰键：等待主键，不结束录制
      if (!combo) return;
      const conflict = findShortcutConflict(recordingId, combo);
      if (conflict) {
        const def = SHORTCUT_DEFS.find((d) => d.id === recordingId);
        if (!def) return;
        let message: string;
        if (conflict.type === "def") {
          const other = SHORTCUT_DEFS.find((d) => d.id === conflict.id);
          message = t("shortcuts.conflict", { name: other ? t(other.labelKey) : conflict.id });
        } else if (conflict.type === "reserved") {
          message = t("shortcuts.reserved");
        } else {
          message = t("shortcuts.illegal");
        }
        setError({ id: recordingId, message });
        return;
      }
      // 合法：写入（即时生效 + 跨窗广播），退出录制态
      setShortcut(recordingId, combo);
      setRecordingId(null);
      setError(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, resetShortcut, setShortcut, t]);

  const handleResetAll = () => {
    resetAllShortcuts();
    setRecordingId(null);
    setError(null);
  };

  return (
    <div className="shortcut-settings-overlay" onClick={onClose}>
      <div className="shortcut-settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="shortcut-settings-header">
          <h2>{t("shortcuts.title")}</h2>
          <button className="shortcut-settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="shortcut-settings-body">
          <input
            className="shortcut-settings-search"
            type="text"
            placeholder={t("shortcuts.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {grouped.map(({ category, defs }) => (
            <div key={category} className="shortcut-settings-group">
              <h3>{t(`shortcuts.category.${category}`)}</h3>
              {defs.map((def) => {
                const isRecording = recordingId === def.id;
                const combo = getShortcutLabel(def.id) ?? "";
                const isCustom = def.id in shortcuts;
                const rowError = error?.id === def.id ? error.message : null;
                return (
                  <div key={def.id} className="shortcut-settings-row-wrap">
                    <div
                      className={`shortcut-settings-row ${isRecording ? "recording" : ""}`}
                      onClick={() => {
                        setRecordingId(isRecording ? null : def.id);
                        setError(null);
                      }}
                    >
                      <span className="shortcut-settings-label">{t(def.labelKey)}</span>
                      {isRecording ? (
                        <span className="shortcut-settings-recording-pill">
                          {t("shortcuts.record")}
                          <span className="shortcut-settings-record-hint">
                            {t("shortcuts.recordHint")}
                          </span>
                        </span>
                      ) : (
                        <span className="shortcut-settings-keys">
                          {comboParts(combo).map((part, i) => (
                            <kbd key={i} className={`shortcut-keycap ${rowError ? "conflict" : ""}`}>
                              {part}
                            </kbd>
                          ))}
                        </span>
                      )}
                      {isCustom && !isRecording && (
                        <button
                          className="shortcut-settings-reset"
                          title={t("shortcuts.resetOne")}
                          onClick={(e) => {
                            e.stopPropagation();
                            resetShortcut(def.id);
                            setError(null);
                          }}
                        >
                          ↺
                        </button>
                      )}
                    </div>
                    {rowError && (
                      <div className="shortcut-settings-error">{rowError}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="shortcut-settings-footer">
          <span className="shortcut-settings-count">
            {customCount > 0 ? t("shortcuts.custom", { count: customCount }) : ""}
          </span>
          <button className="shortcut-settings-btn" onClick={handleResetAll}>
            {t("shortcuts.resetAll")}
          </button>
          <button className="shortcut-settings-btn primary" onClick={onClose}>
            {t("shortcuts.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ShortcutSettingsDialog —— 自定义快捷键设置弹窗（v0.9.0）
 *
 * 交互（对齐 Ardot 设计稿 731114443999638 快捷键相关界面）：
 * - 顶部搜索框（按功能名/键位/id 过滤）；
 * - 按分类分组列出 SHORTCUT_DEFS 全部可自定义条目，键帽显示生效键位；
 * - 点击条目进入录制态：按物理键盘组合即录入（D3，无虚拟键盘），
 *   Esc 取消 · Backspace 清除该条绑定（恢复默认）；
 * - 冲突：旧键位键帽/录制药丸红描边 + 行下方红色提示条「该快捷键已被『X』占用」，
 *   不写入且保持录制态；
 * - 系统级组合键（Alt+F4 等）：允许绑定，但成功后给黄色提示「可能被系统拦截」；
 * - 行尾单项恢复图标；底部「恢复全部默认设置」（二次确认）+「完成」。
 *
 * 写入即时生效（useSettingsStore.setShortcut 内查重，persist v4 + 多窗口广播），
 * 因此底部不需要「保存」；「恢复全部默认设置」是破坏性操作，故加二次确认。
 *
 * v0.9.0 review 修复：
 * - 冲突红描边此前是死代码（录制时键帽被药丸替换）→ 录制中同时显示旧键位键帽 + 药丸；
 * - 录制中点击搜索框仍吞按键（无法输入搜索词）→ 搜索框获焦即退出录制态；
 * - isComposing 判断前置于 preventDefault，中文/日文输入法选词不再被拦截；
 * - 非录制态 Esc 关闭弹窗；setShortcut 拒绝写入时保持录制态并提示；
 * - 恢复默认会被占用时拒绝并提示（此前会造出永远按不出来的重复绑定）；
 * - 补齐 role/aria、行键盘可达、空状态、恢复全部默认二次确认、系统键提示。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import {
  SHORTCUT_DEFS,
  comboFromEvent,
  effectiveCombo,
  findResetCollision,
  findShortcutConflict,
  formatComboForDisplay,
  getShortcutDef,
  getShortcutLabel,
  isSystemCombo,
  type ShortcutCategory,
  type ShortcutDef,
} from "../../core/shortcuts";
import { ChoiceDialog } from "./ChoiceDialog";
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

/** 行内提示：error=红条（未写入/被拒），warn=黄条（已写入但可能被系统拦截） */
interface RowNotice {
  id: string;
  message: string;
  tone: "error" | "warn";
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
  /** 行内提示（冲突/非法/系统键/恢复受阻） */
  const [notice, setNotice] = useState<RowNotice | null>(null);
  /** 「恢复全部默认设置」二次确认 */
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  const customCount = Object.keys(shortcuts).length;

  /** 条目 id → 已翻译功能名（错误提示里显示「已被『X』占用」） */
  const labelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const def of SHORTCUT_DEFS) map.set(def.id, t(def.labelKey));
    return map;
  }, [t]);

  // 打开即聚焦搜索框（键盘用户可直接输入过滤）
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // 非录制态：Esc 关闭弹窗（录制态由下方的捕获监听处理，捕获阶段 stopPropagation
  // 会阻止本监听触发，语义仍是「Esc 先取消录制，再按一次才关闭」）。
  // 二次确认打开时交给 ChoiceDialog 自己的 Esc 处理，避免一次 Esc 连关两层。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmResetAll) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, confirmResetAll]);

  /** 搜索过滤（功能名 + 当前生效键位 + 规范键位 + id） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_DEFS;
    return SHORTCUT_DEFS.filter((def) => {
      const label = t(def.labelKey).toLowerCase();
      const display = (getShortcutLabel(def.id) ?? "").toLowerCase();
      const canonical = effectiveCombo(def).toLowerCase();
      return (
        label.includes(q) ||
        display.includes(q) ||
        canonical.includes(q) ||
        def.id.toLowerCase().includes(q)
      );
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

  /**
   * 恢复单个条目默认键位；被别的条目占用时给出明确提示并保持原状。
   * 返回是否成功（供 Backspace 清除与 ↺ 按钮共用）。
   */
  const tryResetShortcut = (id: string): boolean => {
    const collide = findResetCollision(id);
    if (collide) {
      setNotice({
        id,
        message: t("shortcuts.resetBlocked", {
          combo: formatComboForDisplay(collide.combo),
          name: labelOf.get(collide.id) ?? collide.id,
        }),
        tone: "error",
      });
      return false;
    }
    resetShortcut(id);
    setNotice(null);
    return true;
  };

  // ─── 录制态：window 捕获阶段监听（拦截事件，避免触发应用快捷键） ───
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      // 输入法组合态用于选词，不能当快捷键——先于 preventDefault 放行，
      // 否则中文/日文输入法候选框的按键会被吞掉
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      // Esc：取消录制，不修改
      if (e.key === "Escape") {
        setRecordingId(null);
        setNotice(null);
        return;
      }
      // Backspace：清除该条绑定（恢复默认）；带修饰键的组合不在此语义内
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        tryResetShortcut(recordingId);
        setRecordingId(null);
        return;
      }
      const combo = comboFromEvent(e);
      // 仅按修饰键 / AltGr 布局输入：等待主键，不结束录制
      if (!combo) return;
      const conflict = findShortcutConflict(recordingId, combo);
      if (conflict) {
        const def = getShortcutDef(recordingId);
        if (!def) return;
        let message: string;
        if (conflict.type === "def") {
          message = t("shortcuts.conflict", {
            name: labelOf.get(conflict.id) ?? conflict.id,
          });
        } else if (conflict.type === "reserved") {
          message = t("shortcuts.reserved");
        } else {
          message = t("shortcuts.illegal");
        }
        setNotice({ id: recordingId, message, tone: "error" });
        return;
      }
      // 合法：写入（即时生效 + 跨窗广播），退出录制态。
      // store 侧会二次查重（防并发改键竞态），被拒时保持录制态并提示。
      if (!setShortcut(recordingId, combo)) {
        setNotice({
          id: recordingId,
          message: t("shortcuts.conflict", { name: formatComboForDisplay(combo) }),
          tone: "error",
        });
        return;
      }
      // 系统级组合键：已写入，但提示可能被系统/浏览器拦截（计划 §2.3 第 3 行）
      setRecordingId(null);
      setNotice(
        isSystemCombo(combo)
          ? { id: recordingId, message: t("shortcuts.systemWarn"), tone: "warn" }
          : null,
      );
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, labelOf, resetShortcut, setShortcut, t]);

  const handleResetAll = () => {
    resetAllShortcuts();
    setRecordingId(null);
    setNotice(null);
    setConfirmResetAll(false);
  };

  /** 行激活（点击或键盘 Enter/Space） */
  const activateRow = (id: string, isRecording: boolean) => {
    setRecordingId(isRecording ? null : id);
    setNotice(null);
  };

  return (
    <div className="shortcut-settings-overlay" onClick={onClose} role="presentation">
      <div
        className="shortcut-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcut-settings-header">
          <h2>{t("shortcuts.title")}</h2>
          <button
            className="shortcut-settings-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="shortcut-settings-body">
          <input
            ref={searchRef}
            className="shortcut-settings-search"
            type="text"
            aria-label={t("shortcuts.search")}
            placeholder={t("shortcuts.search")}
            value={query}
            // 录制中点击搜索框：退出录制态，否则按键会被捕获监听吞掉，无法输入
            onFocus={() => {
              if (recordingId) {
                setRecordingId(null);
                setNotice(null);
              }
            }}
            onChange={(e) => setQuery(e.target.value)}
          />

          {grouped.length === 0 && (
            <div className="shortcut-settings-empty" data-testid="shortcuts-empty">
              {t("shortcuts.empty")}
            </div>
          )}

          {grouped.map(({ category, defs }) => (
            <div key={category} className="shortcut-settings-group">
              <h3>{t(`shortcuts.category.${category}`)}</h3>
              {defs.map((def) => {
                const isRecording = recordingId === def.id;
                const combo = getShortcutLabel(def.id) ?? "";
                const isCustom = def.id in shortcuts;
                const rowNotice = notice?.id === def.id ? notice : null;
                const isError = rowNotice?.tone === "error";
                return (
                  <div key={def.id} className="shortcut-settings-row-wrap">
                    <div
                      className={`shortcut-settings-row ${isRecording ? "recording" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isRecording}
                      aria-label={t(def.labelKey)}
                      onClick={() => activateRow(def.id, isRecording)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          activateRow(def.id, isRecording);
                        }
                      }}
                    >
                      <span className="shortcut-settings-label">{t(def.labelKey)}</span>
                      {/* 录制中仍显示当前键位键帽（冲突时红描边），药丸追加在其后 */}
                      <span className="shortcut-settings-keys">
                        {comboParts(combo).map((part, i) => (
                          <kbd key={i} className={`shortcut-keycap ${isError ? "conflict" : ""}`}>
                            {part}
                          </kbd>
                        ))}
                      </span>
                      {isRecording && (
                        <span
                          className={`shortcut-settings-recording-pill ${isError ? "conflict" : ""}`}
                          data-testid={`recording-${def.id}`}
                        >
                          {t("shortcuts.record")}
                          <span className="shortcut-settings-record-hint">
                            {t("shortcuts.recordHint")}
                          </span>
                        </span>
                      )}
                      {isCustom && !isRecording && (
                        <button
                          className="shortcut-settings-reset"
                          type="button"
                          aria-label={t("shortcuts.resetOne")}
                          title={t("shortcuts.resetOne")}
                          onClick={(e) => {
                            e.stopPropagation();
                            tryResetShortcut(def.id);
                          }}
                        >
                          ↺
                        </button>
                      )}
                    </div>
                    {rowNotice && (
                      <div
                        className={`shortcut-settings-error ${rowNotice.tone === "warn" ? "warn" : ""}`}
                        role={rowNotice.tone === "error" ? "alert" : "status"}
                      >
                        {rowNotice.message}
                      </div>
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
          <button
            className="shortcut-settings-btn"
            onClick={() => setConfirmResetAll(true)}
            disabled={customCount === 0}
          >
            {t("shortcuts.resetAll")}
          </button>
          <button className="shortcut-settings-btn primary" onClick={onClose}>
            {t("shortcuts.done")}
          </button>
        </div>
      </div>

      {/* 破坏性操作二次确认（写入即时生效，无「保存」步骤，故用确认代替回退） */}
      <ChoiceDialog
        open={confirmResetAll}
        title={t("shortcuts.resetAll")}
        message={t("shortcuts.resetAllConfirm", { count: customCount })}
        options={[{ id: "reset", label: t("common.confirm"), tone: "danger" }]}
        cancelLabel={t("common.cancel")}
        onChoose={(id) => {
          if (id === "reset") handleResetAll();
        }}
        onCancel={() => setConfirmResetAll(false)}
      />
    </div>
  );
}

/**
 * G8 命令面板（Ctrl+Shift+P）
 *
 * 功能：
 * - 顶部搜索框（自动聚焦）
 * - 命令列表按 group 分组显示
 * - 键盘导航：↑↓ 选择、Enter 执行、Esc 关闭
 * - 显示快捷键提示（右侧）
 *
 * 数据流：
 * - 通过 searchCommands(query, t) 获取匹配命令
 * - 选中命令后调用 cmd.action()，由 commands.ts 派发 'lightmd:command' 事件
 * - App.tsx 监听事件并执行对应操作
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { useT } from "../../i18n";
import {
  commands,
  searchCommands,
  GROUP_ORDER,
  GROUP_TITLE_KEYS,
  type Command,
  type CommandGroup,
} from "../../core/commands";
import "./CommandPalette.css";

interface CommandPaletteProps {
  onClose: () => void;
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 计算匹配的命令列表（按搜索结果排序）
  const matchedCommands = useMemo(() => {
    return searchCommands(query, t);
  }, [query, t]);

  // 按分组组织命令（保持搜索排序，仅用于分组显示）
  const groupedCommands = useMemo(() => {
    const groups: Array<{ group: CommandGroup; items: Command[] }> = [];
    const groupMap = new Map<CommandGroup, Command[]>();

    for (const cmd of matchedCommands) {
      if (!groupMap.has(cmd.group)) {
        groupMap.set(cmd.group, []);
      }
      groupMap.get(cmd.group)!.push(cmd);
    }

    // 按 GROUP_ORDER 顺序输出
    for (const g of GROUP_ORDER) {
      const items = groupMap.get(g);
      if (items && items.length > 0) {
        groups.push({ group: g, items });
      }
    }
    return groups;
  }, [matchedCommands]);

  // 选中项的全局索引（在扁平 matchedCommands 中）
  const flatSelected = matchedCommands[selectedIdx];

  // 自动聚焦搜索框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 查询变化时重置选中项
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // 滚动选中项到可视区域
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector(
      `[data-idx="${selectedIdx}"]`
    ) as HTMLElement | null;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((idx) =>
        matchedCommands.length === 0
          ? 0
          : (idx + 1) % matchedCommands.length
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((idx) =>
        matchedCommands.length === 0
          ? 0
          : (idx - 1 + matchedCommands.length) % matchedCommands.length
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatSelected) {
        flatSelected.action();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // 空查询时显示全部命令（与 commands 一致）
  const totalCommands = commands.length;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* 搜索框 */}
        <div className="command-palette-header">
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder={t("command.palette.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* 命令列表 */}
        <div className="command-palette-body" ref={listRef}>
          {groupedCommands.length === 0 ? (
            <div className="command-palette-empty">
              {t("command.palette.noResult")}
            </div>
          ) : (
            groupedCommands.map(({ group, items }) => (
              <div key={group} className="command-palette-group">
                <div className="command-palette-group-title">
                  {t(GROUP_TITLE_KEYS[group])}
                </div>
                {items.map((cmd) => {
                  // 计算该命令在 matchedCommands 中的全局索引
                  const globalIdx = matchedCommands.indexOf(cmd);
                  const isSelected = globalIdx === selectedIdx;
                  return (
                    <div
                      key={cmd.id}
                      data-idx={globalIdx}
                      className={`command-palette-item${
                        isSelected ? " selected" : ""
                      }`}
                      onClick={() => {
                        cmd.action();
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIdx(globalIdx)}
                    >
                      <span className="command-palette-item-title">
                        {t(cmd.titleKey)}
                      </span>
                      {cmd.shortcut && (
                        <span className="command-palette-shortcut">
                          {cmd.shortcut}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* 底部状态栏：显示命令总数和操作提示 */}
        <div className="command-palette-footer">
          <span>
            {matchedCommands.length}/{totalCommands}
          </span>
          <span className="command-palette-hints">
            <kbd>↑↓</kbd> {t("command.palette.navigate")}
            <kbd>Enter</kbd> {t("command.palette.execute")}
            <kbd>Esc</kbd> {t("command.palette.close")}
          </span>
        </div>
      </div>
    </div>
  );
}

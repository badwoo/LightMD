/**
 * v0.15.0 R3c：AI 指令库编辑器（设计 §5.2）。
 *
 * ## 职责边界
 * - 只读写 `useSettingsStore.ai.instructions`（经 `setAiSettings`）；
 * - 内建模板**只读**（可"复制为我的指令"，不可原地改/删）；
 * - 变量**仅** `{{selection}}` / `{{document}}`，纯文本替换、不执行任何代码；
 * - 文案全部走 i18n key（本文件不写死任何中英文界面字符串）。
 *
 * ## 为什么变量用"插入按钮"而不是富文本
 * 指令模板是**纯文本**（最终作为 user message 的一部分发给模型），
 * 富文本会把格式字符带进 prompt。因此只给两个插入按钮 + 已用变量提示，
 * 并显式警示"其他 {{...}} 不会被替换"。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
// v0.15.0：内建指令模板正文随语言取（模板变量用双花括号，不能走 t() 占位符）
import { getCurrentLanguage } from "../../i18n/state";
import { useSettingsStore } from "../../stores/useSettingsStore";
import type { AiInstruction } from "../../services/aiProfiles";
import {
  AI_BUILTIN_INSTRUCTIONS,
  AI_INSTRUCTION_VARIABLES,
  AI_INSTRUCTION_VARIABLE_TOKENS,
  appendInstruction,
  collectUnknownVariables,
  collectUsedVariables,
  createBlankInstruction,
  createInstructionFromBuiltin,
  duplicateInstruction,
  moveInstruction,
  removeInstruction,
  scopeLabelKey,
  updateInstruction,
  validateInstruction,
  type AiInstructionScope,
} from "./aiInstructionOps";
import { instructionIssueKey } from "./aiValidationMessages";
import "./aiSettingsShared.css";
import "./AiInstructionEditor.css";

export interface AiInstructionEditorProps {
  /** 可选：只编辑某一作用域的指令（默认显示全部） */
  scopeFilter?: AiInstructionScope;
}

export function AiInstructionEditor({ scopeFilter }: AiInstructionEditorProps = {}) {
  const t = useT();
  const ai = useSettingsStore((s) => s.ai);
  const setAiSettings = useSettingsStore((s) => s.setAiSettings);

  const instructions = ai?.instructions ?? [];
  const visible = useMemo(
    () => (scopeFilter ? instructions.filter((item) => item.scope === scopeFilter) : instructions),
    [instructions, scopeFilter],
  );

  const [selectedId, setSelectedId] = useState<string>(() => instructions[0]?.id ?? "");

  // 列表变化（新增/删除/切作用域）后修正选中项
  useEffect(() => {
    if (!visible.length) {
      if (selectedId !== "") setSelectedId("");
      return;
    }
    if (!visible.some((item) => item.id === selectedId)) setSelectedId(visible[0]!.id);
  }, [visible, selectedId]);

  const current = visible.find((item) => item.id === selectedId) ?? null;

  /** 写回指令库（唯一出口） */
  const commit = useCallback(
    (next: AiInstruction[]) => {
      if (!ai) return;
      setAiSettings({ ...ai, instructions: next });
    },
    [ai, setAiSettings],
  );

  const handleAddBlank = useCallback(() => {
    const created = createBlankInstruction(t("settings.ai.instruction.newName"));
    commit(appendInstruction(instructions, created));
    setSelectedId(created.id);
  }, [commit, instructions, t]);

  const handleCopyBuiltin = useCallback(
    (builtinId: string) => {
      const builtin = AI_BUILTIN_INSTRUCTIONS.find((item) => item.id === builtinId);
      if (!builtin) return;
      const created = createInstructionFromBuiltin(
        builtin,
        t("settings.ai.instruction.copyName", { name: t(builtin.nameKey) }),
        // 模板正文随当前界面语言取（**不进** i18n 字典：模板变量是双花括号，
        // 与 t() 的单花括号占位符语法冲突；详见 aiInstructionOps 的注释）
        getCurrentLanguage() === "en-US" ? builtin.userTemplate.en : builtin.userTemplate.zh,
        builtin.systemSuffixKey ? t(builtin.systemSuffixKey) : undefined,
      );
      commit(appendInstruction(instructions, created));
      setSelectedId(created.id);
    },
    [commit, instructions, t],
  );

  const handleDuplicate = useCallback(() => {
    if (!current) return;
    const copied = duplicateInstruction(current, t("settings.ai.instruction.copyName", { name: current.name }));
    commit(appendInstruction(instructions, copied));
    setSelectedId(copied.id);
  }, [commit, current, instructions, t]);

  const handleRemove = useCallback(() => {
    if (!current) return;
    const next = removeInstruction(instructions, current.id);
    commit(next);
    setSelectedId(next[0]?.id ?? "");
  }, [commit, current, instructions]);

  const handleMove = useCallback(
    (direction: -1 | 1) => {
      if (!current) return;
      commit(moveInstruction(instructions, current.id, direction));
    },
    [commit, current, instructions],
  );

  const patch = useCallback(
    (value: Partial<AiInstruction>) => {
      if (!current) return;
      commit(updateInstruction(instructions, current.id, value));
    },
    [commit, current, instructions],
  );

  /** 在模板光标处插入变量（简单实现：追加到末尾；用户可再剪切粘贴） */
  const insertVariable = useCallback(
    (name: (typeof AI_INSTRUCTION_VARIABLES)[number]) => {
      if (!current) return;
      const token = AI_INSTRUCTION_VARIABLE_TOKENS[name];
      patch({ userTemplate: `${current.userTemplate}${token}` });
    },
    [current, patch],
  );

  const issues = current ? validateInstruction(current) : [];
  const errorIssues = issues.filter((issue) => issue.level === "error");
  const unknownVars = current ? collectUnknownVariables(current.userTemplate) : [];
  const usedVars = current ? collectUsedVariables(current.userTemplate) : [];

  return (
    <section className="settings-section ai-instruction-settings" data-testid="ai-instruction-section">
      <h3>{t("settings.ai.instruction.title")}</h3>
      <small className="settings-hint">{t("settings.ai.instruction.hint")}</small>

      <div className="ai-inst-layout">
        {/* 左：我的指令列表 */}
        <div className="ai-inst-list" role="listbox" aria-label={t("settings.ai.instruction.listLabel")}>
          {visible.length === 0 && (
            <p className="ai-inst-empty" data-testid="ai-inst-empty">
              {t("settings.ai.instruction.empty")}
            </p>
          )}
          {visible.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === current?.id}
              className={`ai-inst-item${item.id === current?.id ? " is-selected" : ""}`}
              onClick={() => setSelectedId(item.id)}
              data-testid={`ai-inst-item-${item.id}`}
            >
              <span className="ai-inst-name">{item.name || t("settings.ai.instruction.unnamed")}</span>
              <span className="ai-inst-scope">{t(scopeLabelKey(item.scope))}</span>
            </button>
          ))}
        </div>

        {/* 右：编辑区 + 内建模板 */}
        <div className="ai-inst-editor">
          <div className="ai-inst-toolbar">
            <button type="button" className="ai-btn ai-btn-primary" onClick={handleAddBlank} data-testid="ai-inst-add">
              {t("settings.ai.instruction.add")}
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={handleDuplicate}
              disabled={!current}
              data-testid="ai-inst-duplicate"
            >
              {t("settings.ai.instruction.duplicate")}
            </button>
            <button type="button" className="ai-btn" onClick={handleRemove} disabled={!current} data-testid="ai-inst-remove">
              {t("settings.ai.instruction.remove")}
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={() => handleMove(-1)}
              disabled={!current}
              aria-label={t("settings.ai.instruction.moveUp")}
              data-testid="ai-inst-move-up"
            >
              ↑
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={() => handleMove(1)}
              disabled={!current}
              aria-label={t("settings.ai.instruction.moveDown")}
              data-testid="ai-inst-move-down"
            >
              ↓
            </button>
          </div>

          {!current ? (
            <p className="ai-inst-tip" data-testid="ai-inst-select-tip">
              {t("settings.ai.instruction.selectTip")}
            </p>
          ) : (
            <>
              <div className="settings-field">
                <label htmlFor="ai-inst-name">{t("settings.ai.instruction.field.name")}</label>
                <input
                  id="ai-inst-name"
                  className="ai-input"
                  type="text"
                  value={current.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  data-testid="ai-inst-name"
                />
              </div>

              <div className="settings-field">
                <label htmlFor="ai-inst-scope">{t("settings.ai.instruction.field.scope")}</label>
                <select
                  id="ai-inst-scope"
                  className="settings-select"
                  value={current.scope}
                  onChange={(e) => patch({ scope: e.target.value as AiInstructionScope })}
                  data-testid="ai-inst-scope"
                >
                  <option value="selection">{t("settings.ai.instruction.scope.selection")}</option>
                  <option value="document">{t("settings.ai.instruction.scope.document")}</option>
                  <option value="none">{t("settings.ai.instruction.scope.none")}</option>
                </select>
              </div>

              <div className="settings-field">
                <label htmlFor="ai-inst-template">{t("settings.ai.instruction.field.template")}</label>
                <div className="ai-inst-var-row">
                  <span className="ai-inst-var-label">{t("settings.ai.instruction.variables")}:</span>
                  {AI_INSTRUCTION_VARIABLES.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="ai-inst-var-btn"
                      onClick={() => insertVariable(name)}
                      data-testid={`ai-inst-insert-${name}`}
                    >
                      {`{{${name}}}`} · {t(`settings.ai.instruction.var.${name}`)}
                    </button>
                  ))}
                </div>
                <textarea
                  id="ai-inst-template"
                  className="ai-textarea"
                  rows={6}
                  value={current.userTemplate}
                  placeholder={t("settings.ai.instruction.field.templatePlaceholder")}
                  onChange={(e) => patch({ userTemplate: e.target.value })}
                  spellCheck={false}
                  data-testid="ai-inst-template"
                />
                {usedVars.length > 0 && (
                  <small className="settings-hint" data-testid="ai-inst-used-vars">
                    {t("settings.ai.instruction.usedVariables", {
                      vars: usedVars.map((name) => AI_INSTRUCTION_VARIABLE_TOKENS[name]).join(", "),
                    })}
                  </small>
                )}
                {unknownVars.length > 0 && (
                  <small className="settings-hint settings-hint-warning" data-testid="ai-inst-unknown-vars">
                    {t("settings.ai.instruction.warn.unknownVariable", { vars: unknownVars.join(", ") })}
                  </small>
                )}
              </div>

              <div className="settings-field">
                <label htmlFor="ai-inst-system-suffix">{t("settings.ai.instruction.field.systemSuffix")}</label>
                <textarea
                  id="ai-inst-system-suffix"
                  className="ai-textarea"
                  rows={3}
                  value={current.systemSuffix ?? ""}
                  placeholder={t("settings.ai.instruction.field.systemSuffixPlaceholder")}
                  onChange={(e) => patch({ systemSuffix: e.target.value || undefined })}
                  spellCheck={false}
                  data-testid="ai-inst-system-suffix"
                />
                <small className="settings-hint">{t("settings.ai.instruction.field.systemSuffixHint")}</small>
              </div>

              {errorIssues.length > 0 && (
                <ul className="ai-error-list" data-testid="ai-inst-errors">
                  {errorIssues.map((issue) => (
                    <li key={issue.code}>{t(instructionIssueKey(issue.code))}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {/* 内建模板：只读，可复制 */}
          <div className="ai-inst-builtin" data-testid="ai-inst-builtin">
            <h4>{t("settings.ai.instruction.builtin.title")}</h4>
            <small className="settings-hint">{t("settings.ai.instruction.builtin.hint")}</small>
            <div className="ai-inst-builtin-list">
              {AI_BUILTIN_INSTRUCTIONS.filter(
                (builtin) => !scopeFilter || builtin.scope === scopeFilter,
              ).map((builtin) => (
                <div key={builtin.id} className="ai-inst-builtin-item">
                  <span className="ai-inst-builtin-name">{t(builtin.nameKey)}</span>
                  <span className="ai-inst-scope">{t(scopeLabelKey(builtin.scope))}</span>
                  <button
                    type="button"
                    className="ai-btn"
                    onClick={() => handleCopyBuiltin(builtin.id)}
                    data-testid={`ai-inst-copy-builtin-${builtin.id}`}
                  >
                    {t("settings.ai.instruction.builtin.copy")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default AiInstructionEditor;

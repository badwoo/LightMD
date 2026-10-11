/**
 * v0.12.2 P1：应用级错误边界。
 *
 * ─── 为什么需要 ───
 *
 * v0.11.0 的 emoji text NodeView 会让编辑器创建抛 `RangeError`，而
 * `EditorContainer` 的 useEffect 内没有任何 try/catch，应用也**没有 ErrorBoundary**
 * （全仓 grep `componentDidCatch` / `getDerivedStateFromError` 零命中）→
 * 抛错后 React 卸载整棵树，用户看到**纯白屏**，无法自救（切不了模式、打不开设置）。
 *
 * 现在该具体缺陷已修（emoji 改 Decoration、createEditor 加兜底），但这类
 * 「渲染期抛错即白屏」的脆弱性本身应当消除：任何未预期的渲染错误都应给出
 * 可读提示 + 恢复入口，而不是白屏。
 *
 * 设计：class 组件（React 错误边界目前只有 class 形式），提供「重试渲染」与
 * 「复制错误详情」两个动作；重试通过重置 state 重新挂载子树。
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 自定义兜底文案（i18n）；缺省用内置中英双语 */
  title?: string;
  hint?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台保留完整堆栈，便于真机排查（应用无崩溃上报，控制台是唯一出口）
    console.error("[ErrorBoundary] 渲染出错:", error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleCopy = (): void => {
    const { error } = this.state;
    if (!error) return;
    const text = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
    void navigator.clipboard?.writeText(text).catch(() => {
      /* 剪贴板不可用时静默（用户仍可从控制台复制） */
    });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const title = this.props.title ?? "界面渲染出错 / Something went wrong";
    const hint =
      this.props.hint ??
      "文档内容未受影响，可重试；若持续出错请复制详情并反馈。/ Your document is intact. Retry, or copy the details to report.";

    return (
      <div
        className="error-boundary"
        data-testid="error-boundary"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          alignItems: "flex-start",
          justifyContent: "center",
          height: "100%",
          padding: "32px",
          boxSizing: "border-box",
          fontFamily: "var(--font-sans, system-ui, sans-serif)",
          color: "var(--text-primary, #1a1a1a)",
          background: "var(--bg-primary, #fff)",
          overflow: "auto",
        }}
      >
        <div style={{ fontSize: "16px", fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: "13px", color: "var(--text-secondary, #666)", maxWidth: "640px" }}>
          {hint}
        </div>
        <pre
          data-testid="error-boundary-detail"
          style={{
            maxWidth: "100%",
            maxHeight: "240px",
            overflow: "auto",
            margin: 0,
            padding: "10px 12px",
            fontSize: "12px",
            lineHeight: 1.5,
            background: "var(--code-bg, #f4f4f4)",
            border: "1px solid var(--border-color, #e0e0e0)",
            borderRadius: "6px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error.name}: {error.message}
        </pre>
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" onClick={this.handleRetry} data-testid="error-boundary-retry">
            重试 / Retry
          </button>
          <button type="button" onClick={this.handleCopy} data-testid="error-boundary-copy">
            复制详情 / Copy details
          </button>
        </div>
      </div>
    );
  }
}

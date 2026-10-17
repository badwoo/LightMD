/**
 * ImageManagerButton —— 图片管理悬浮入口（v0.13.0 返修问题6）
 *
 * 背景：需求11 的图片管理面板此前只有两个入口（命令面板 / 快捷键），
 * 而命令面板路径因为 `lightmd:command` 路由缺分支而**回车无反应**，
 * 用户实际上找不到这个功能。这里补一个可见的悬浮入口。
 *
 * 布局约束（用户明确要求）：
 * - 位置：文档右上角，**在 AI 翻译小图标下面**；
 * - AI 翻译未开启时，自动接在**切换模式小图标**下面；
 * - 三个悬浮图标（模式切换 / AI 翻译 / 图片管理）**大小一致且居中对齐**；
 * - 仅当文档中**确实存在图片**时才出现该入口。
 *
 * 与既有两个按钮保持一致：绝对定位于 `.editor-main-area`（position:relative），
 * 不随文档滚动；样式复用 FullTranslateButton.css 里的变量体系，自动适配 6 主题。
 */
import { useT } from "../../i18n";
import "./FullTranslateButton.css";

interface ImageManagerButtonProps {
  /**
   * 纵向槽位：模式切换固定第 1 格，AI 翻译第 2 格（开启时），
   * 图片管理接在最后一个已占用槽位之后。
   */
  slot: number;
  /**
   * v0.13.2 需求4：是否可见。
   *
   * 组件**常驻挂载**（不再用 `{cond && <Btn/>}` 条件渲染），只切 `.is-hidden`
   * —— 条件渲染是瞬间从 DOM 摘除，CSS 过渡根本没机会播放，
   * 用户要求"文档里删掉所有图片时图片管理图标淡出消失"就做不到。
   * 不可见时同时 `pointer-events:none`（在 CSS 里）+ `aria-hidden` + `tabIndex=-1`，
   * 保证它既看不见、也点不到、也进不了 Tab 序列。
   */
  visible?: boolean;
  /** 点击打开图片管理面板 */
  onOpen: () => void;
}

export function ImageManagerButton({ slot, visible = true, onOpen }: ImageManagerButtonProps) {
  const t = useT();

  return (
    <button
      type="button"
      className={`image-manager-btn${visible ? "" : " is-hidden"}`}
      // 槽位 → 纵向偏移由 CSS 变量驱动，保证与上方图标等距、居中对齐
      style={{ ["--imb-slot" as string]: String(slot) }}
      title={t("imageManager.title")}
      aria-label={t("imageManager.title")}
      aria-hidden={visible ? undefined : true}
      tabIndex={visible ? undefined : -1}
      data-testid="image-manager-btn"
      data-visible={visible ? "true" : "false"}
      onClick={onOpen}
    >
      {/* 图片图标：山峦 + 太阳，与「译」气泡同为 20×20 视觉重量 */}
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </button>
  );
}

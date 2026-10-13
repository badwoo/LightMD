/**
 * v0.13.0 需求1：块操作菜单（右上角三点 `⋮`）的菜单项构建（纯函数）。
 *
 * ## 为什么抽纯函数
 *
 * 菜单项随「块类型 / 剪贴板内容 / 块位置（首块不可上移）」变化，逻辑分支不少；
 * 抽成纯函数后可以直接写真值表单测，DOM 层只负责渲染与定位。
 */

/** 菜单项 id */
export type BlockActionId =
  | "cut"
  | "copy"
  | "paste"
  | "delete"
  | "formatPainter"
  | "select"
  | "moveUp"
  | "moveDown";

export interface BlockMenuItem {
  id: BlockActionId;
  /** i18n key（不含命名空间，由调用方拼） */
  labelKey: string;
  /** 是否禁用 */
  disabled: boolean;
  /** 是否为危险操作（删除类，UI 标红） */
  danger: boolean;
  /** 分隔线（该项之前画一条） */
  separatorBefore: boolean;
}

export interface BuildBlockMenuInput {
  /** 剪贴板里是否有可用的块数据（无则禁用「粘贴」） */
  hasClipboard: boolean;
  /** 该块是否为文档第一个块（首块不可上移） */
  isFirstBlock: boolean;
  /** 该块是否为文档最后一个块（末块不可下移） */
  isLastBlock: boolean;
}

/**
 * 构建三点菜单项（顺序固定，便于用户形成肌肉记忆）。
 *
 * 分组：剪切/复制/粘贴 ｜ 删除 ｜ 格式刷 ｜ 选中 ｜ 上移/下移
 */
export function buildBlockMenuItems(input: BuildBlockMenuInput): BlockMenuItem[] {
  const { hasClipboard, isFirstBlock, isLastBlock } = input;
  return [
    {
      id: "cut",
      labelKey: "blockMenu.cut",
      disabled: false,
      danger: false,
      separatorBefore: false,
    },
    {
      id: "copy",
      labelKey: "blockMenu.copy",
      disabled: false,
      danger: false,
      separatorBefore: false,
    },
    {
      id: "paste",
      labelKey: "blockMenu.paste",
      // 剪贴板里没有本应用可识别的块数据时禁用
      disabled: !hasClipboard,
      danger: false,
      separatorBefore: false,
    },
    {
      id: "delete",
      labelKey: "blockMenu.delete",
      disabled: false,
      danger: true,
      separatorBefore: true,
    },
    {
      id: "formatPainter",
      labelKey: "blockMenu.formatPainter",
      disabled: false,
      danger: false,
      separatorBefore: true,
    },
    {
      id: "select",
      labelKey: "blockMenu.select",
      disabled: false,
      danger: false,
      separatorBefore: false,
    },
    {
      id: "moveUp",
      labelKey: "blockMenu.moveUp",
      disabled: isFirstBlock,
      danger: false,
      separatorBefore: true,
    },
    {
      id: "moveDown",
      labelKey: "blockMenu.moveDown",
      disabled: isLastBlock,
      danger: false,
      separatorBefore: false,
    },
  ];
}

/** 三点图标相对于块容器的定位（CSS 变量名 → 值） */
export function blockKebabStyle(): Record<string, string> {
  return {
    position: "absolute",
    top: "4px",
    right: "4px",
    zIndex: "5",
  };
}

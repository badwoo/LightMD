/**
 * v0.13.2 需求6：图片管理面板的「从按钮里跑出来 / 再跑回去」动画壳。
 *
 * ## 用户要求
 * 「需求10 的图片管理弹窗特效请改为类似底部栏搜索框的特效，点击图片管理图标，
 *  弹窗顺滑的从该按钮跑出来，关闭再顺滑跑回去。」
 *
 * ## 为什么需要这层壳
 * `ImageManagerDialog` 是**条件渲染**（`{open && <Dialog/>}`）：关闭即卸载，
 * 退场动画来不及播放。本壳采用与 `GenieSearchDialog` 完全相同的「延迟卸载」模式：
 * - `active` 翻 true → 挂载内部面板，测量按钮/面板几何，注入两个 CSS 变量后播入场；
 * - `active` 翻 false → 先播退场，动画结束后才真正卸载。
 *
 * ## 两个几何变量（与底部搜索框同口径，见 SearchReplace.tsx 的注释）
 * - `--genie-from-x` / `--genie-from-y`：面板**中心**相对按钮**中心**的位移，
 *   作为入场起点（面板从按钮位置出发）与退场终点（缩回按钮）；
 * - `--genie-origin-x` / `--genie-origin-y`：按钮中心相对面板左上角的位置，
 *   作为 `transform-origin`，面板收放时朝按钮那一侧收拢/展开。
 *
 * ## 为什么用「中心位移」而不是底部搜索框的「下沿对齐按钮上沿」
 * 底部搜索框在屏幕下方、按钮在它下方，竖直方向是单向的；而图片管理按钮在
 * **右上角**、面板居中偏上，两个方向都可能。用中心位移 + 中心缩放的写法
 * 对任意相对位置都成立（按钮在面板任何一侧，收放方向都正确）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * 退场动画总时长（毫秒）。
 *
 * **必须与 ImageManagerDialog.css 的 image-mgr-genie-out 时长保持一致**
 * （v0.13.2 返修后与搜索框同族：0.38s = 380ms，另留 60ms 余量）。
 * 改一处必须同时改另一处，否则会出现"动画还没播完就卸载"或"已经不可见却还挂在 DOM 上"。
 */
export const IMAGE_MGR_GENIE_OUT_MS = 440;

export interface GenieDialogShellProps {
  /** 是否应当显示（驱动挂载/退场） */
  active: boolean;
  /** 锚点选择器（默认取图片管理按钮） */
  anchorSelector?: string;
  /** 面板内部元素的选择器（用于测量面板矩形） */
  panelSelector?: string;
  /** 内部面板（负责自己的遮罩与样式） */
  children: ReactNode;
}

export function GenieDialogShell({
  active,
  anchorSelector = '[data-genie-anchor="image-manager"] [data-testid="image-manager-btn"]',
  panelSelector = ".image-mgr-dialog",
  children,
}: GenieDialogShellProps) {
  /** mounted：面板是否挂载；closing：退场中；ready：几何变量是否已注入 */
  const [mounted, setMounted] = useState(active);
  const [closing, setClosing] = useState(false);
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(active);
  const shellRef = useRef<HTMLDivElement>(null);

  /**
   * 测量「按钮 ↔ 面板」的关系，注入四个 CSS 变量（开合各一次，无监听、无持续开销）。
   * 测量失败（锚点缺失/被隐藏，如文档无图片时按钮 `is-hidden`）时退化为
   * 「从右上角方向浮入」的常规动画，不至于原地闪现。
   */
  const syncGenieVars = useCallback(() => {
    const shell = shellRef.current;
    const anchor = document.querySelector<HTMLElement>(anchorSelector);
    const panel = shell?.querySelector<HTMLElement>(panelSelector);
    if (!shell || !panel) return;
    const btn = anchor?.getBoundingClientRect();
    const pn = panel.getBoundingClientRect();
    const anchored =
      !!btn && btn.width > 0 && btn.height > 0 && pn.width > 0 && pn.height > 0;
    if (!anchored) {
      // 兜底：面板从自身右上角方向缩入/缩出（视觉上仍是"从右上角来"）
      shell.style.setProperty("--genie-from-x", "0px");
      shell.style.setProperty("--genie-from-y", "-40px");
      shell.style.setProperty("--genie-origin-x", "100%");
      shell.style.setProperty("--genie-origin-y", "0%");
      return;
    }
    const btnCx = btn.left + btn.width / 2;
    const btnCy = btn.top + btn.height / 2;
    const pnCx = pn.left + pn.width / 2;
    const pnCy = pn.top + pn.height / 2;
    shell.style.setProperty("--genie-from-x", `${Math.round(btnCx - pnCx)}px`);
    shell.style.setProperty("--genie-from-y", `${Math.round(btnCy - pnCy)}px`);
    shell.style.setProperty("--genie-origin-x", `${Math.round(btnCx - pn.left)}px`);
    shell.style.setProperty("--genie-origin-y", `${Math.round(btnCy - pn.top)}px`);
  }, [anchorSelector, panelSelector]);

  useEffect(() => {
    if (active) {
      mountedRef.current = true;
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mountedRef.current) return;
    setClosing(true);
    const timer = setTimeout(() => {
      mountedRef.current = false;
      setMounted(false);
      setClosing(false);
      setReady(false);
    }, IMAGE_MGR_GENIE_OUT_MS);
    return () => clearTimeout(timer);
  }, [active]);

  // 打开：等内部面板完成首次布局（双 rAF）后再测量并放行动画，
  // 否则首帧会读到尚未注入的变量而跳一下。期间壳带 pending 类把面板藏起来。
  useEffect(() => {
    if (!mounted || closing || ready) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        syncGenieVars();
        // 即使测量失败也放行（fail-open）
        setReady(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [mounted, closing, ready, syncGenieVars]);

  // 关闭：同步重测（面板可能已被滚动/布局变化移动，缩回轨迹要按当前位置连回按钮）
  useLayoutEffect(() => {
    if (closing) syncGenieVars();
  }, [closing, syncGenieVars]);

  if (!mounted) return null;
  const stateClass = closing
    ? "image-mgr-genie-out"
    : ready
      ? "image-mgr-genie-in"
      : "image-mgr-genie-pending";
  return (
    <div ref={shellRef} className={`image-mgr-genie ${stateClass}`} data-testid="image-mgr-genie">
      {children}
    </div>
  );
}

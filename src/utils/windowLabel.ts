/**
 * v0.9.0 WP0：窗口身份单点封装。
 *
 * 全项目**只允许**从这里获取当前窗口身份（label），禁止各处自行读 URL / metadata：
 * - Rust 侧固定槽位分配 label（`main` + `sec-1`~`sec-7`），见 `src-tauri/src/window/mod.rs`；
 * - 读取顺序：
 *   1. URL query `?win=sec-N`（Rust 建窗时写入，dev/prod 一致，最稳）；
 *   2. `__TAURI_INTERNALS__.metadata.currentWebview.label`（Tauri 同步注入，无 IPC 开销）；
 *   3. 回退 `"main"`（浏览器 dev / jsdom 单测）。
 *
 * 注意：本模块**不做 async**——窗口身份在模块求值期就确定，全局常量可直接使用。
 * 也**不 import 任何业务模块**（`fileService` 反过来依赖本模块读窗口 label，
 * 必须避免环形依赖）。
 */

/** 主窗口 label（tauri.conf.json 未指定 label，Tauri 默认即 "main"） */
export const MAIN_WINDOW_LABEL = "main";

/** 窗口上限（main + sec-1 ~ sec-7），与 Rust 侧 `MAX_WINDOWS` 保持一致 */
export const MAX_WINDOWS = 8;

let cached: string | null = null;
let testOverride: string | null = null;

function fromQuery(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const win = new URLSearchParams(window.location.search).get("win");
    return win && win.trim() ? win.trim() : null;
  } catch {
    return null;
  }
}

function fromTauriMetadata(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const label = (window as unknown as {
      __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } };
    }).__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
    return typeof label === "string" && label ? label : null;
  } catch {
    return null;
  }
}

/** 当前窗口 label（同步，结果缓存） */
export function getWindowLabel(): string {
  if (testOverride) return testOverride;
  if (cached) return cached;
  cached = fromQuery() ?? fromTauriMetadata() ?? MAIN_WINDOW_LABEL;
  return cached;
}

/** 当前是否主窗口（Primary 是运行时可变的；这里指「启动时的第一个窗口」） */
export function isMainWindow(): boolean {
  return getWindowLabel() === MAIN_WINDOW_LABEL;
}

/** 窗口级 localStorage key 后缀规则：main 沿用无后缀旧 key（零迁移），sec-* 加 `-{label}` */
export function withWindowSuffix(base: string): string {
  const label = getWindowLabel();
  return label === MAIN_WINDOW_LABEL ? base : `${base}-${label}`;
}

/** 单测用：强制指定当前窗口身份 */
export function __setWindowLabelForTest(label: string | null): void {
  testOverride = label;
  cached = null;
}

/**
 * label 是否合法（用于防御来自 URL 的任意输入）。
 * 非法值一律当 `main` 处理，避免污染 localStorage key 空间。
 */
export function isValidWindowLabel(label: string): boolean {
  if (label === MAIN_WINDOW_LABEL) return true;
  const m = /^sec-([1-9])$/.exec(label);
  return !!m && Number(m[1]) < MAX_WINDOWS;
}

/**
 * dragOrder ── 同目录手动顺序表（v0.8.4 需求3）
 *
 * 数据存应用内 localStorage（key: lightmd-manual-order），
 * 结构 Record<dirPath, string[]>：按目录存"期望顺序"，存 name（目录内天然唯一）。
 * 选 localStorage 而非在用户目录落文件（D1 决策）：零入侵、不进 git、
 * 也不会触发需求 10 的目录监听形成"自己写文件 → watch 事件 → 刷新"死循环。
 *
 * key 归一化：路径分隔符统一为 `/` 后再存取，避免 Windows 下 `\` 与 `/`
 * 混用导致同一目录产生两份顺序记录。
 *
 * 注意：applyManualOrder 是纯函数（渲染派生层 useMemo 中调用），只做内存过滤
 * 与排序，**绝不写 localStorage**——惰性清理的落库由下次 setManualOrder
 * 全量覆盖自然完成，避免渲染期副作用。
 */
import type { FileNodeData } from "../components/sidebar/FileNode";

/** localStorage 存储键（全表 JSON） */
const STORAGE_KEY = "lightmd-manual-order";

/** 归一化路径分隔符（统一为 `/`）后作为存储 key */
function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/");
}

/** 读取全表（非法/缺失数据一律回退空表，不抛错） */
function readAll(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** 写入全表 */
function writeAll(table: Record<string, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
  } catch {
    // 存储不可用（隐私模式/容量满）时静默降级：手动顺序仅本次会话内存有效
  }
}

/** 读取某目录的手动顺序表（无记录返回 null） */
export function getManualOrder(dir: string): string[] | null {
  const order = readAll()[normalizeDir(dir)];
  return Array.isArray(order) ? order : null;
}

/** 写入某目录的手动顺序表（全量覆盖，顺带清掉该目录表内的历史死项） */
export function setManualOrder(dir: string, names: string[]): void {
  const table = readAll();
  table[normalizeDir(dir)] = names;
  writeAll(table);
}

/**
 * 合并：按 order 排列 nodes；表内不存在的 name（新文件）按字母序插到**表尾**
 * （P5 拍板尾插：可预测、类似桌面新文件置底）；表中已不存在的 name
 * （文件已删除/移走）惰性清理——不出现在返回结果中（落库由下次
 * setManualOrder 全量覆盖完成，本函数不写存储）。
 */
export function applyManualOrder(nodes: FileNodeData[], order: string[]): FileNodeData[] {
  const nodeByName = new Map(nodes.map((n) => [n.name, n]));
  // 惰性清理：只保留仍存在于 children 中的表项
  const validOrder = order.filter((name) => nodeByName.has(name));
  const orderedSet = new Set(validOrder);
  // 表外节点（新文件）按字母序排好后插到表尾
  const rest = nodes
    .filter((n) => !orderedSet.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...validOrder.map((name) => nodeByName.get(name)!), ...rest];
}

/**
 * 拖拽重排：把 src 从当前顺序移动到 target 之前/之后。
 * target 不在列表中（如拖到空白处）→ 追加到末尾；
 * src 不在列表或 src === target → 原样返回（返回新数组，不修改入参）。
 */
export function reorderList(
  names: string[],
  src: string,
  target: string,
  place: "before" | "after"
): string[] {
  if (!names.includes(src) || src === target) return [...names];
  const without = names.filter((n) => n !== src);
  const idx = without.indexOf(target);
  if (idx === -1) {
    // 目标不在列表（拖到空白）→ 追加到末尾
    without.push(src);
    return without;
  }
  without.splice(place === "before" ? idx : idx + 1, 0, src);
  return without;
}

/**
 * 重命名联动（S5）：手动顺序表存的是 name，重命名后旧 name 失效会让文件
 * 跳到列表末尾——表内原地换名保持位置不变；表内不存在该 name（未手动排序过/
 * 旧名不在表中）则 no-op。
 */
export function renameInOrder(dir: string, oldName: string, newName: string): void {
  const order = getManualOrder(dir);
  if (!order) return;
  const idx = order.indexOf(oldName);
  if (idx === -1) return;
  const next = [...order];
  next[idx] = newName;
  setManualOrder(dir, next);
}

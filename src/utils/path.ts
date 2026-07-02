export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function getFileName(filePath: string): string {
  const parts = normalizePath(filePath).split("/");
  return parts[parts.length - 1] || "无标题.md";
}

/**
 * v0.17.0 R2-⑦ 附带排查：**CM6 的 defaultKeymap 抢走了宿主哪些键位**
 *
 * 修复第 7 项时发现一条通用机制：CM6 的 keymap 是
 * `Prec.default(domEventHandlers({keydown: runHandlers}))`，它会**先于**宿主经
 * `setDomEventHandlers` 注册的 `onKeyDown` 执行，且命中即 `preventDefault + break`。
 * 因此凡是 `defaultKeymap` 里绑定了的键，宿主的 `handleSourceKeyDown` **一律收不到**。
 *
 * 本探针逐个按键测量「宿主 handler 是否收到」，把"静默失效"的键位列出来。
 * 只做测量，不改产品代码。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const DOC = ["# 按键审计", "", "第二段落文字", "", "第三段落", ""].join("\n");

const INSTALL = `
  if (window.__KA && window.__KA.restore) { try { window.__KA.restore(); } catch (e) {} }
  const KA = { calls: [], patched: false };
  window.__KA = KA;
  function fiberRoot() {
    const el = document.querySelector(".editor-container") || document.body;
    const k = Object.keys(el).find((n) => n.startsWith("__reactFiber$"));
    if (!k) return null;
    let f = el[k]; let g = 0;
    while (f.return && g++ < 5000) f = f.return;
    return f;
  }
  function collect() {
    const root = fiberRoot(); if (!root) return [];
    const out = []; const seen = new Set();
    const v = (f) => {
      let g = 0; let h = f.memoizedState;
      while (h && typeof h === "object" && "next" in h && g++ < 800) {
        const s = h.memoizedState;
        if (s && typeof s === "object" && "current" in s && !seen.has(s)) { seen.add(s); out.push(s); }
        h = h.next;
      }
      if (f.child) v(f.child); if (f.sibling) v(f.sibling);
    };
    v(root); return out;
  }
  const surface = collect().map(r => r.current).find(
    (c) => c && typeof c === "object" && c.impl === "cm6" && typeof c.setDomEventHandlers === "function");
  if (!surface || !surface.domHandlers || typeof surface.domHandlers.onKeyDown !== "function") return { ok: false };
  const dh = surface.domHandlers;
  const orig = dh.onKeyDown;
  dh.onKeyDown = (e) => { KA.calls.push({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }); return orig(e); };
  KA.restore = () => { dh.onKeyDown = orig; };
  KA.patched = true;
  KA.reset = () => { KA.calls = []; return true; };
  return { ok: true, patched: KA.patched };
`;

await runBrowserProbe({ name: "v0170-r2-ghost-keys-audit", doc: DOC }, async (ui) => {
  const inst = await ui.ev(`${INSTALL} return window.__KA ? { ok: true, patched: window.__KA.patched } : { ok: false };`);
  ui.add("A0", "仪器安装（拿到 SourceSurface.domHandlers.onKeyDown）", inst.ok && inst.patched ? "PASS" : "FAIL", JSON.stringify(inst));

  await ui.focusSource();

  /** 逐个键：Ctrl+X / Ctrl+Shift+X 等，看宿主是否收到 */
  const cases = [
    { label: "Ctrl+B 粗体", key: "b", code: "KeyB", vk: 66, modifiers: 2, expect: "handleSourceKeyDown → format.bold" },
    { label: "Ctrl+I 斜体", key: "i", code: "KeyI", vk: 73, modifiers: 2, expect: "handleSourceKeyDown → format.italic" },
    { label: "Ctrl+U 下划线", key: "u", code: "KeyU", vk: 85, modifiers: 2, expect: "handleSourceKeyDown → format.underline" },
    { label: "Ctrl+/ 注释", key: "/", code: "Slash", vk: 191, modifiers: 2, expect: "handleSourceKeyDown → format.comment" },
    { label: "Ctrl+1 标题一", key: "1", code: "Digit1", vk: 49, modifiers: 2, expect: "handleSourceKeyDown → heading1" },
    { label: "Ctrl+0 转段落", key: "0", code: "Digit0", vk: 48, modifiers: 2, expect: "handleSourceKeyDown → paragraph" },
    { label: "Ctrl+Shift+8 无序列表", key: "8", code: "Digit8", vk: 56, modifiers: 2 | 8, expect: "handleSourceKeyDown → ul" },
    { label: "Ctrl+Shift+9 有序列表", key: "9", code: "Digit9", vk: 57, modifiers: 2 | 8, expect: "handleSourceKeyDown → ol" },
    { label: "Ctrl+Shift+. 引用", key: ".", code: "Period", vk: 190, modifiers: 2 | 8, expect: "handleSourceKeyDown → quote" },
    { label: "Ctrl+Alt+S 删除线", key: "s", code: "KeyS", vk: 83, modifiers: 2 | 1, expect: "handleSourceKeyDown → strikethrough" },
    { label: "Ctrl+Shift+M 数学块", key: "m", code: "KeyM", vk: 77, modifiers: 2 | 8, expect: "handleSourceKeyDown → math" },
    { label: "Escape 清 ghost", key: "Escape", code: "Escape", vk: 27, modifiers: 0, expect: "handleSourceKeyDown → clear(escape)" },
    { label: "Tab 缩进/采纳", key: "Tab", code: "Tab", vk: 9, modifiers: 0, expect: "CmSourceSurface 捕获监听（不经宿主）" },
    { label: "Backspace 整段删格式符", key: "Backspace", code: "Backspace", vk: 8, modifiers: 0, expect: "SoucePane 捕获监听（本次修复）" },
  ];

  const results = [];
  for (const c of cases) {
    await ui.ev(`window.__KA.reset(); return true;`);
    await ui.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: c.key, code: c.code,
      windowsVirtualKeyCode: c.vk, nativeVirtualKeyCode: c.vk, modifiers: c.modifiers,
      ...(c.key.length === 1 && c.modifiers === 0 ? { text: c.key } : {}),
    });
    await ui.sleep(40);
    await ui.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: c.key, code: c.code,
      windowsVirtualKeyCode: c.vk, nativeVirtualKeyCode: c.vk, modifiers: c.modifiers,
    });
    await ui.sleep(200);
    const calls = await ui.ev(`return window.__KA.calls.slice();`);
    results.push({ ...c, reachedHost: calls.length > 0 });
  }

  ui.log("");
  ui.log("[audit] 键位 → 宿主 handler 是否收到：");
  for (const r of results) {
    ui.log(`  ${r.reachedHost ? "收到  " : "被抢走"}  ${r.label.padEnd(22)} expect=${r.expect}`);
  }

  const stolen = results.filter((r) => !r.reachedHost && r.key !== "Tab" && r.key !== "Backspace");
  ui.add("K1", "★ CM6 defaultKeymap 抢走的键位清单（应为 0 个才算无回归）",
    stolen.length === 0 ? "PASS" : "FAIL",
    stolen.length === 0 ? "无" : `被抢走 ${stolen.length} 个：${stolen.map((s) => s.label).join(" / ")}`);

  for (const r of results) {
    if (r.key === "Tab" || r.key === "Backspace") continue;
    ui.log(`[audit] ${r.label}: ${r.reachedHost ? "OK" : "STOLEN"}`);
  }
});

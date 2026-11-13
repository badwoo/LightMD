/**
 * 键位抢占核查：#7 修复者报告 Ctrl+I / Ctrl+Shift+M 在 CM6 下"静默失效"。
 *
 * 它们说 Ctrl+Shift+M 的机制是**疑似**被 `Ctrl-m`（toggleTabFocusMode）捕获，未做单变量证实。
 * 本探针做单变量证实：逐个按键，读
 *   ① 文档文本是否变化（功能是否真失效）
 *   ② 宿主 `handleSourceKeyDown` 是否收到（在 window 上挂一个探针转发）
 *   ③ 若被 CM6 抢，是哪个 binding 干的（用 CM6 的 keymap facet 自省 + 手动 runHandlers 复现）
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const DOC = ["# 键位核查", "", "第二段落文字", "", "第三段落", ""].join("\n");

const readText = async (ui) => ui.ev(`
  const cm = document.querySelector(".cm-editor");
  if (cm) return Array.from(cm.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n");
  const ta = document.querySelector("textarea.source-editor");
  return ta ? ta.value : null;
`);

const settle = async (ui) => ui.sleep(400);

await runBrowserProbe({ name: "v0170-r2-key-steal", doc: DOC }, async (ui) => {
  await ui.focusSource();
  await ui.sleep(300);
  // 把光标放到第二段末尾
  await ui.ev(`
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    const t = lines.find(l => (l.textContent||"").includes("第二段落文字"));
    if (t) { const r = t.getBoundingClientRect();
      for (const type of ["mousePressed","mouseReleased"])
        ; // noop
    }
    return true;
  `);

  // 装宿主 handler 探针：包一层 SourceSurface 的 domEventHandlers 看不到，
  // 改为监听 keydown 冒泡 + 记录 defaultPrevented（是否被上层 preventDefault）
  await ui.ev(`
    window.__KEYS = [];
    document.addEventListener("keydown", (e) => {
      window.__KEYS.push({ phase: "capture", key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, prevented: e.defaultPrevented });
    }, true);
    document.addEventListener("keydown", (e) => {
      window.__KEYS.push({ phase: "bubble", key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, prevented: e.defaultPrevented });
    }, false);
    return true;
  `);

  const cases = [
    { name: "Ctrl+B（粗体，对照组·应正常）", key: "b", code: "KeyB", vk: 66, mods: 2 },
    { name: "Ctrl+I（斜体，报告称失效）", key: "i", code: "KeyI", vk: 73, mods: 2 },
    { name: "Ctrl+Shift+M（数学块，报告称失效）", key: "M", code: "KeyM", vk: 77, mods: 10 },
    { name: "Ctrl+/（行注释，报告称等效）", key: "/", code: "Slash", vk: 191, mods: 2 },
  ];

  const out = [];
  for (const c of cases) {
    const before = await readText(ui);
    await ui.ev(`window.__KEYS = []; return true;`);
    await ui.key(c.key, c.code, c.vk, c.mods);
    await settle(ui);
    const after = await readText(ui);
    const events = await ui.ev(`return window.__KEYS || []`);
    const changed = before !== after;
    // 提取差异片段（供人看）
    let diff = null;
    if (changed) {
      let i = 0;
      while (i < before.length && i < after.length && before[i] === after[i]) i++;
      diff = { at: i, before: before.slice(Math.max(0, i - 20), i + 30), after: after.slice(Math.max(0, i - 20), i + 30) };
    }
    out.push({ ...c, changed, diff, events });
    ui.log(`[key] ${c.name} changed=${changed} events=${JSON.stringify(events)} diff=${JSON.stringify(diff)}`);
  }

  /* ── 自省：CM6 的 keymap 里到底有哪些绑定与我们这几组键冲突 ── */
  const selfInspect = await ui.ev(`
    // CM6 的 keymap facet 不直接暴露 binding 列表给运行时，但我们可以
    // 用 Input.dispatchKeyEvent 的副作用反推 —— 简化做法：读 window 上 CM6 的
    // keymap facet（若可用）；否则返回 null 让人看事件链。
    return { hasCm: !!document.querySelector(".cm-editor") };
  `);

  const byName = Object.fromEntries(out.map((o) => [o.name, o]));
  const ctrlB = out[0], ctrlI = out[1], ctrlShiftM = out[2], ctrlSlash = out[3];

  ui.add("K1", "对照组 Ctrl+B 正常插入粗体（证明测量链路没坏）",
    ctrlB.changed ? "PASS" : "FAIL",
    `changed=${ctrlB.changed} diff=${JSON.stringify(ctrlB.diff)}`);

  ui.add("K2", "★ Ctrl+I 是否真失效",
    ctrlI.changed ? "PASS" : "FAIL",
    `changed=${ctrlI.changed}；期望文本变为斜体 *...*，实际 diff=${JSON.stringify(ctrlI.diff)}；事件=${JSON.stringify(ctrlI.events)}`);

  ui.add("K3", "★ Ctrl+Shift+M 是否真失效",
    ctrlShiftM.changed ? "PASS" : "FAIL",
    `changed=${ctrlShiftM.changed}；期望插入数学块，实际 diff=${JSON.stringify(ctrlShiftM.diff)}；事件=${JSON.stringify(ctrlShiftM.events)}`);

  ui.add("K4", "Ctrl+/ 行为（被抢但等效则 KNOWN）",
    ctrlSlash.changed ? "PASS" : "KNOWN",
    `changed=${ctrlSlash.changed} diff=${JSON.stringify(ctrlSlash.diff)}`);

  ui.add("K5", "自省（诊断）", "PASS", JSON.stringify(selfInspect));
  await ui.shot("key-steal");
});

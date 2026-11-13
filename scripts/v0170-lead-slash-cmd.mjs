/**
 * Lead 交叉验证 1：**Slash 命令菜单**（源码模式下输入 "/" 触发）在 CM6 下是否还能用。
 *
 * 为什么 Lead 亲自测：这条路径落在 B 流（格式/语法）与 D 流（输入）的**边界之外**——
 * 它不是格式栏按钮，也不是撤销/搜索。而代码上它有明确风险：
 *   EditorContainer.tsx:2105  `<SlashCommand textarea={sourceTextareaRef.current} … />`
 *   SlashCommand.tsx:243/398/435/457 直接读 `textarea.value` / `textarea.selectionStart`
 * CM6 下 sourceTextareaRef 指向**中性 div**（value 为 undefined、selectionStart 为 undefined）。
 *
 * 判定：
 * - 输入 "/" 后菜单是否出现（.slash-command 相关 DOM）
 * - 菜单不出现 / 抛异常 → CM6 下 Slash 命令失效（用户可感知功能缺失）
 * - 菜单出现且能插入 → 正常
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# Slash 命令验证", "", "第一段正文。", "", "第二段正文。", ""].join("\n");

await runProbe({ name: "v0170-lead-slash-cmd", doc: DOC, docTitle: "Slash 命令验证" }, async (ui) => {
  ui.add("0", "源码面实现", ui.impl === "cm6" ? "PASS" : "KNOWN", `impl=${ui.impl}`);

  // 先把光标放到末尾空行
  await ui.focusSource();
  await ui.sleep(300);

  // 探测 SlashCommand 相关 DOM 类名（先从源码里已知，再做存在性探测）
  const before = await ui.ev(`
    const all = Array.from(document.querySelectorAll("[class*='slash']")).map(e => e.className);
    return { slashEls: all };
  `);
  ui.log("[slash] 触发前的 slash 类元素: " + JSON.stringify(before));

  // 走到文档末尾新起一行，输入 "/"
  await ui.key("End", "End", 35, 2);
  await ui.sleep(200);
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(200);
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(300);

  const textBefore = await ui.readSourceText();
  await ui.typeText("/");
  await ui.sleep(900);

  const textAfter = await ui.readSourceText();
  ui.add("1", "“/” 已插入源码面", (textAfter || "").includes("/") ? "PASS" : "FAIL",
    `插入前最后 20 字=${JSON.stringify((textBefore || "").slice(-20))}`);

  // 菜单是否出现
  let menu = null;
  for (let i = 0; i < 10; i++) {
    menu = await ui.ev(`
      const cands = Array.from(document.querySelectorAll("[class*='slash'], [class*='Slash']"));
      const visible = cands.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const items = document.querySelectorAll(".slash-command-item, .slash-item, [class*='slash'] li");
      return {
        total: cands.length,
        visibleCount: visible.length,
        classes: [...new Set(cands.map(e => e.className))].slice(0, 6),
        itemCount: items.length,
        bodyChars: (document.body.textContent || "").length,
      };
    `);
    if (menu && menu.visibleCount > 0) break;
    await ui.sleep(400);
  }
  ui.log("[slash] 触发后: " + JSON.stringify(menu));
  ui.add("2", "★ 输入 “/” 后 Slash 命令菜单出现", menu && menu.visibleCount > 0 ? "PASS" : "FAIL",
    `可见 slash 元素=${menu?.visibleCount ?? 0}；类名=${JSON.stringify(menu?.classes ?? [])}`);

  await ui.shot("slash-triggered");

  // 看有没有未捕获异常（SlashCommand 读 undefined.selectionStart 会抛）
  const errs = await ui.errors();
  ui.add("3", "触发 Slash 无未捕获异常", errs.length === 0 ? "PASS" : "FAIL",
    errs.length ? JSON.stringify(errs.slice(0, 3)) : "无");

  // 应用是否还活着
  const alive = await ui.ev(`
    return {
      cm: !!document.querySelector(".cm-editor"),
      boundary: (document.body.textContent || "").indexOf("界面渲染出错") >= 0,
    };
  `);
  ui.add("4", "应用未被错误边界接管", alive && alive.cm && !alive.boundary ? "PASS" : "FAIL", JSON.stringify(alive));

  // 若菜单出现，尝试点第一项验证插入
  if (menu && menu.visibleCount > 0) {
    const clicked = await ui.ev(`
      const el = document.querySelector(".slash-command-item, .slash-item, [class*='slash'] li, [class*='slash'] button");
      if (!el) return null;
      const label = el.textContent ? el.textContent.slice(0, 20) : "";
      el.click();
      return { label };
    `);
    await ui.sleep(1200);
    const after2 = await ui.readSourceText();
    ui.log("[slash] 点击菜单项: " + JSON.stringify(clicked));
    ui.add("5", "点击 Slash 菜单项后源码变化", (after2 || "").length > (textAfter || "").length ? "PASS" : "KNOWN",
      `长度 ${(textAfter || "").length} → ${(after2 || "").length}`);
    await ui.shot("slash-after-click");
  }
});

/**
 * v0.17.0 R2-⑦ 附带排查（第二部分）：被 CM6 抢走的键位**实际功能是否失效**
 *
 * 第一支审计探针（`v0170-r2-ghost-keys-audit.mjs`）测出三个键到不了宿主：
 * `Ctrl+I`（斜体）/ `Ctrl+/`（注释）/ `Ctrl+Shift+M`（数学块）。
 * 但"到不了宿主"不等于"用户无感知地失效"——可能被别的层接住（App 全局、
 * CM6 的命令、甚至浏览器）。本探针测**用户可观测的结果**：文本有没有按预期变化。
 *
 * 判据：在空行上按该键 → 期望插入对应语法符号。文本没变 = 静默失效。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const DOC = ["# 被抢键位实测", "", "第二段落文字", "", "第三段落", ""].join("\n");

await runBrowserProbe({ name: "v0170-r2-stolen-keys-effect", doc: DOC }, async (ui) => {
  const VIEW = `
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
  `;

  const resetToEmpty = async () => {
    for (let i = 0; i < 3; i++) {
      await ui.ev(`
        ${VIEW}
        if (!v) return false;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(DOC)} } });
        return true;
      `);
      await ui.sleep(400);
      const t = await ui.ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
      if (t === DOC) break;
    }
    // 光标放到第 2 行（空行）
    await ui.ev(`
      ${VIEW}
      if (!v) return false;
      const line = v.state.doc.line(2);
      v.focus();
      v.dispatch({ selection: { anchor: line.from, head: line.from }, scrollIntoView: false });
      return true;
    `);
    await ui.sleep(250);
    return await ui.ev(`${VIEW} return v ? { sel: (() => { const m = v.state.selection.main; return { from: m.from, to: m.to }; })() } : null;`);
  };

  const press = async (key, code, vk, modifiers) => {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await ui.sleep(50);
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await ui.sleep(400);
  };

  const readDoc = () => ui.ev(`${VIEW} return v ? v.state.doc.toString() : null;`);

  /**
   * ⚠️⚠️ 合成键盘事件必须照抄**物理真值四元组**：`key` / `code` / `vk` / `modifiers`。
   *
   * ## 这里踩过的坑（recorded 2026-11-11，别再犯）
   * 本表 C3 原先写 `key: "m"`（小写）而 `modifiers: 2|8`（Ctrl+Shift）。
   * 但**真实物理按键 Ctrl+Shift+M 的 `KeyboardEvent.key` 是 `"M"`（大写）**
   * —— Shift 生效后，字母键的 `key` 就是大写字母。
   *
   * 结果：CM6 按 `event.key` 归一化后的名字去匹配 `Mod-` 绑定 → 大小写对不上 → 绑不上
   * → 落到默认行为 → 文本不变。**表现出来和"功能真实失效"一模一样**，
   * 于是被误报成了一条"Ctrl+Shift+M 静默失效"的产品缺陷。
   *
   * 单变量隔离实验（同一探针/同一浏览器/同一文档/`vk=77`/`modifiers=10`，**只改大小写**）：
   * ```
   * key: "m" → changed=false   （误报来源）
   * key: "M" → changed=true    （真实物理值，正常插入 $$…$$）
   * ```
   *
   * ## 结论
   * - `Ctrl+Shift+M`（数学块）**不是缺陷**，原判定作废。
   * - 本项目 §7.4「工具自身的缺陷会伪装成产品缺陷」的又一实例。
   * - 复核键位类问题时：**先证明"我的按键构造是真实的"**（例如用一个已知必然生效的
   *   对照组键验证同一条构造路径），再去判产品。
   *
   * 同时注意：`modifiers` 位运算里 `2 = Ctrl`、`8 = Shift`（CDP 的 `Input.dispatchKeyEvent`
   * 语义），`1 = Alt`、`4 = Meta`。别把 Ctrl 和 Shift 的位写反。
   */
  const cases = [
    { id: "C1", label: "Ctrl+I 斜体", key: "i", code: "KeyI", vk: 73, modifiers: 2, expect: "*", expectDesc: "插入 `*`（斜体成对）" },
    { id: "C2", label: "Ctrl+/ 注释", key: "/", code: "Slash", vk: 191, modifiers: 2, expect: "<!--", expectDesc: "行注释 `<!--  -->`" },
    // ⚠️ key 必须大写 "M"（Shift 生效时的物理真值）。曾误写小写 "m" → 造成"失效"误报。
    { id: "C3", label: "Ctrl+Shift+M 数学块", key: "M", code: "KeyM", vk: 77, modifiers: 2 | 8, expect: "$$", expectDesc: "插入 `$$` 数学块" },
    { id: "C4", label: "Ctrl+B 粗体（对照：未被抢）", key: "b", code: "KeyB", vk: 66, modifiers: 2, expect: "**", expectDesc: "插入 `**`（应成功）" },
  ];

  for (const c of cases) {
    const before = await resetToEmpty();
    await press(c.key, c.code, c.vk, c.modifiers);
    const afterDoc = await readDoc();
    const changed = afterDoc !== DOC;
    const hasExpected = (afterDoc || "").includes(c.expect);
    ui.log(`[stolen] ${c.label}: 变了=${changed} 含${c.expect}=${hasExpected} doc=${JSON.stringify((afterDoc || "").slice(0, 40))}`);
    if (c.id === "C4") {
      ui.add(c.id, `${c.label} — 对照组必须成功（证明测量方法有效）`,
        hasExpected ? "PASS" : "FAIL", `doc=${JSON.stringify((afterDoc || "").slice(0, 40))}`);
    } else {
      ui.add(c.id, `${c.label} — ${c.expectDesc}`,
        hasExpected ? "PASS" : "FAIL",
        `${hasExpected ? "生效" : "★ 静默失效（文本未变）"}；doc=${JSON.stringify((afterDoc || "").slice(0, 40))}`);
    }
  }
});

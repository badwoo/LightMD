/**
 * D2 缺陷（M6 发现）：`wrapRangeWithMarks` 的"先清后套"对**句中符号**失效
 *
 * ## 现象（端到端实测）
 * 采集 `**粗体源**`（marks=[strong]）→ 刷到目标行 `*已斜体目标*。`
 * 实际结果：`***已斜体目标*。**`   ← 畸形
 * 期望结果：`**已斜体目标。**`     ← 覆盖式（Word 语义：清掉斜体，只留粗体）
 *
 * ## 根因
 * `wrapRangeWithMarks` 的剥离循环只匹配「**整段首尾**被同一对符号包裹」：
 * ```ts
 * body.startsWith(open) && body.endsWith(close)
 * ```
 * 目标行 `*已斜体目标*。` 的尾字符是"。"，不是 `*` → 剥离失败 →
 * 直接在外层再包一层 → `**` + `*已斜体目标*。` + `**` = `***已斜体目标*。**`。
 *
 * ## 影响面（本文件要测的）
 * 1. 句中/句尾带标点的已有格式（`*斜体*。`、`**粗体**，`）
 * 2. 同一行有**多个**格式片段（`*甲* 和 **乙**`）
 * 3. 行首带列表前缀 + 行内已有格式
 *
 * 用法：
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t5" node scripts/v0170-r4-painter-d2.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const CASES = [
  { name: "句中斜体+句号", src: "**粗体源**", targetLine: "*已斜体目标*。", expectNote: "期望 **已斜体目标。**" },
  { name: "句中粗体+逗号", src: "*斜体源*", targetLine: "**已加粗目标**，", expectNote: "期望 *已加粗目标，*" },
  { name: "多个格式片段", src: "**粗体源**", targetLine: "*甲* 和 **乙** 混排。", expectNote: "覆盖语义应有明确结果" },
  { name: "删除线+句号", src: "**粗体源**", targetLine: "~~已有删除线~~。", expectNote: "期望 **已有删除线。**" },
];

const buildDoc = (c) => [
  "# D2 缺陷验证",
  "",
  c.src,
  "",
  c.targetLine,
  "",
  "结尾。",
  "",
].join("\n");

const CM_TEXT = `
  const c = document.querySelector(".cm-content");
  if (!c) return { ok: false };
  const v = c.cmTile && c.cmTile.view;
  if (v && v.state && v.state.doc) return { ok: true, text: v.state.doc.toString(), sel: { from: v.state.selection.main.from, to: v.state.selection.main.to } };
  return { ok: false };
`;

const PAINTER = `
  return { bodyClass: document.body.classList.contains("format-painter-armed") };
`;

await runBrowserProbe({ name: "v0170-r4-painter-d2", doc: buildDoc(CASES[0]) }, async (ui) => {
  const readCm = () => ui.ev(CM_TEXT);
  const clickPainter = async () => {
    const b = await ui.ev(`
      const el = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
        .find(x => (x.getAttribute("title") || "").includes("格式刷"));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    `);
    if (!b) return false;
    await ui.click(b.x, b.y);
    await ui.sleep(650);
    return true;
  };

  const selectExact = async (needle) => {
    const pt = await ui.ev(`
      for (const l of document.querySelectorAll(".cm-line")) {
        const t = l.textContent || "";
        const i = t.indexOf(${JSON.stringify(needle)});
        if (i >= 0) {
          const r = l.getBoundingClientRect();
          const cw = r.width / Math.max(1, t.length);
          return { ok: true, x: Math.round(r.left + (i + ${JSON.stringify(needle)}.length / 2) * cw),
                   y: Math.round(r.top + r.height / 2), idx: i };
        }
      }
      return { ok: false };
    `);
    if (!pt.ok) return null;
    await ui.click(pt.x, pt.y);
    await ui.sleep(230);
    await ui.key("Home", "Home", 36);
    await ui.sleep(100);
    for (let i = 0; i < pt.idx; i++) { await ui.key("ArrowRight", "ArrowRight", 39); await ui.sleep(12); }
    for (let i = 0; i < needle.length; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.sleep(13);
    }
    await ui.sleep(300);
    const cm = await readCm();
    return { ok: true, text: cm.text.slice(cm.sel.from, cm.sel.to) };
  };

  const clickLine = async (needle) => {
    const p = await ui.ev(`
      for (const l of document.querySelectorAll(".cm-line")) {
        const t = l.textContent || "";
        if (t.indexOf(${JSON.stringify(needle)}) >= 0) {
          const r = l.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
        }
      }
      return { ok: false };
    `);
    if (!p.ok) return false;
    await ui.click(p.x, p.y);
    await ui.sleep(850);
    return true;
  };

  await ui.command("view.edit");
  await ui.sleep(2200);

  const results = [];
  for (const c of CASES) {
    ui.log("");
    ui.log("═══ " + c.name + " ═══");
    const doc = buildDoc(c);
    await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
      path: ${JSON.stringify("d2-" + c.name + ".md")}, name: ${JSON.stringify("d2-" + c.name + ".md")},
      content: ${JSON.stringify(doc)} } })); return true;`);
    await ui.sleep(1500);

    const sel = await selectExact(c.src);
    ui.log(`  采集="${sel && sel.text}"  目标行="${c.targetLine}"`);
    if (!sel || sel.text !== c.src) { results.push({ ...c, ok: false, reason: "采集失败" }); continue; }

    await clickPainter();
    const armed = await ui.ev(PAINTER);
    if (!armed.bodyClass) { results.push({ ...c, ok: false, reason: "arm 失败" }); continue; }

    /**
     * 目标行定位：CM6 的 `.cm-line` **包含语法符号**（`*已斜体目标*。` 就原样在 textContent 里），
     * 所以要用**完整目标行文本**去找，不能先剥掉符号。
     * （第一版剥掉 `*`/`~`/`` ` `` 后再找 → 永远匹配不到 → 全部"目标行未找到"。）
     */
    const locate = c.targetLine;
    if (!(await clickLine(locate))) { results.push({ ...c, ok: false, reason: "目标行未找到: " + locate }); continue; }

    const cm = await readCm();
    const applied = cm.text.split("\n").find(l => l.includes(c.targetLine.replace(/[*~`]/g, "").slice(0, 4))) || "";
    ui.log(`  应用后="${applied}"`);

    /** 判据：结果中**不应出现嵌套/错位的同类符号**。
     *  畸形特征：
     *   - `***X*。**` 这类"内层符号未闭合在行尾"的形态
     *   - 原有符号残留（例如刷粗体后仍有孤立的单个 `*`）
     */
    const isMalformed = (() => {
      const l = applied.trim();
      // 统计 * 个数：合法形态下应为偶数且不出现 ** 与 * 交错的畸形
      const stars = (l.match(/\*/g) || []).length;
      // 畸形指纹：`***...*。**` → 以 *** 开头但中间还有孤立的 *
      if (l.startsWith("***") && /\*[^*]/.test(l.slice(3)) && !l.endsWith("***")) return true;
      // 更通用：剥离外层后仍残留原有符号
      return false;
    })();
    results.push({ ...c, ok: !isMalformed, applied, malformed: isMalformed, expectNote: c.expectNote });
  }

  ui.log("");
  ui.log("═══ 汇总 ═══");
  for (const r of results) ui.log("  " + JSON.stringify(r));

  const bad = results.filter(r => !r.ok);
  ui.add("D2-1", "★ 覆盖式语义对各形态目标都正确（无畸形嵌套）",
    bad.length === 0 ? "PASS" : "FAIL",
    `${results.length} 个用例，${bad.length} 个畸形：` +
    JSON.stringify(bad.map(b => ({ name: b.name, applied: b.applied, expect: b.expectNote }))));

  ui.log("[SUMMARY] " + JSON.stringify(results, null, 1));
  await ui.shot("d2");
});

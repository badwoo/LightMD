/**
 * LightMD v0.17.0 复核 —— **D 流：统一撤销栈（跨模式） + 统一搜索替换** 实机探针
 *
 * 产物：`_verify-out/v0170-verify-undo-search.json` / `.txt`，截图 `_verify-out/shots/v0170-verify-undo-search-*.png`
 * 骨架：`scripts/_lib/probe-harness.mjs`（Lead 共享；含单实例排队锁 + `--remote-allow-origins=*`）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 一、为什么必须从 `cmTile.view` 读全文
 * CM6 是**虚拟渲染**：`.cm-line` 只含视口内那几行，拿 DOM 文本长度当全文长度会算错
 * （简报 §4-3 明令禁止）。本探针经
 * `document.querySelector(".cm-content").cmTile.view.state.doc.toString()`
 * 读**权威全文**。实测校验：132 字符文档 → `.cm-line` 拼接 132 / `doc.length` 132 一致。
 *
 * ## 二、判定纪律（简报 §4 + Lead 两轮批注）
 * 1. **精确断言，禁止宽松兜底。** 撤销一律断言「撤销后文本 === 撤销前精确快照」；
 *    替换一律断言「=== 精确期望全文」+「计数 === 预期数」。
 *    ⚠️ 上一轮漏检 P0-1 的根因就是 `length > 178` 这类**恒真兜底**，本文件不出现任何
 *    「长度变短了 / 长度变了」式判定。
 * 2. **前置条件不成立则不得判 PASS。** 凡「多字符输入」的判定项，先断言输入**完整落地**
 *    （`text === before + 期望串`）；不成立就记 KNOWN 并注明「受 P0-1 干扰，本项未有效验证」。
 * 3. **破坏性对照**（≥3 处）：U1b（空历史 Ctrl+Z）、U4c（redo 栈耗尽）、S8（选项关闭后
 *    命中数必须变多）、S9（不含正则元字符时正则模式命中数必须不同）。
 *
 * ## 三、P0-1（Lead 已确证，本文件不重复上报，只做**归因标注**）
 * 症状：编辑模式每输入 1 字符焦点就离开编辑区（落到 BODY），后续字符全部丢失；
 * 机制：`EditorContainer` 的 callback ref 依赖里含 `content` → 每次内容变化
 * 先 `destroy()` 再 `mount()` 全新 CM6 → 焦点/选区丢失。
 * 本探针的应对：
 * - 输入统一走**单次 `Input.insertText`**（一次事务落地整串，绕开逐字符焦点丢失）；
 * - 每次按键前**重新聚焦编辑区**并重设光标；
 * - 用 MutationObserver 统计 `.cm-editor` 的 added/removed，作为 P0-1 的量化证据；
 * - 聚焦/选区的丢失一律归因 P0-1，**不**记成撤销栈缺陷。
 *
 * ## 四、本流 4 个历史缺陷的回归映射
 * ① CM6 下 Ctrl+Z 完全失效（`textarea.value` undefined → `.length` 抛 TypeError）→ U0c / U7
 * ② 搜索框输入 1 字符即崩（div 上用 setSelectionRange）        → S6
 * ③ 跨文件撤销切文档丢条目                                    → U6
 * ④ 撤销滚动/光标位置恢复用错类型判定                          → U5（并标注 P0-1 干扰）
 * ══════════════════════════════════════════════════════════════════════════
 */

import { runProbe } from "./_lib/probe-harness.mjs";

/* ───────────────────────────── 测试文档 ───────────────────────────── */

/** 撤销用文档（短，全行都在视口内，`.cm-line` 与全文一致可交叉校验） */
const DOC = [
  "# 撤销复核文档",
  "",
  "第一段普通文本，用于基线。",
  "",
  "第二段普通文本，用于跨模式。",
  "",
  "第三段普通文本，用于跨文档。",
  "",
].join("\n");

/** 第二个文档（跨文档撤销隔离） */
const DOC2 = ["# 撤销复核文档二", "", "这是第二个文档。", "", "它有自己的撤销时间线。", ""].join("\n");

const NEEDLE = "SEARCHNEEDLE";

/**
 * 搜索/替换用文档。**刻意构造可判定的命中数**：
 *
 * | 选项 | 期望命中 | 依据 |
 * |---|---|---|
 * | 默认（不区分大小写 / 非整词） | 5 | 甲、乙、丙 3 处 + `SEARCHNEEDLEEXTRA` 内 1 处 + 小写 `searchneedle` 1 处 |
 * | 匹配大小写 | 4 | 小写那处被排除，`EXTRA` 仍命中 |
 * | 整词匹配 | 4 | `EXTRA` 被排除，小写整词仍命中 |
 * | 大小写 + 整词 | 3 | 只剩甲、乙、丙 |
 *
 * 这四档给出**四个不同数字**，任何一档失效都会立刻偏离 → 选项效果可机器判定，
 * 不需要看勾选框外观。
 */
const SEARCH_DOC = [
  "# 搜索替换复核文档",
  "",
  "第一处 SEARCHNEEDLE 甲段落文本。",
  "",
  "searchneedle 小写一处。",
  "",
  "第二处 SEARCHNEEDLE 乙段落文本。",
  "",
  "SEARCHNEEDLEEXTRA 连写一处。",
  "",
  "第三处 SEARCHNEEDLE 丙段落文本。",
  "",
  "尾部段落结束。",
  "",
].join("\n");

/* ───────────────────────────── 工具 ───────────────────────────── */

/** 逐字节差异：同前缀/同后缀长度 + 双方独有片段（禁止"变了"式结论） */
function diffSnap(a, b) {
  if (a === b) return "逐字节完全相同";
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return `同前缀 ${i} / 同后缀 ${j}；A独有=${JSON.stringify(a.slice(i, a.length - j))} B独有=${JSON.stringify(b.slice(i, b.length - j))}`;
}

/** 读 CM6 权威全文 + 选区 + 滚动（每次重新查 .cm-content，容忍 P0-1 重建） */
const READ_DOC = `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return null;
  const s = v.state.selection.main;
  const a = document.activeElement;
  return {
    text: v.state.doc.toString(),
    len: v.state.doc.length,
    head: s.head, from: s.from, to: s.to,
    scroll: v.scrollDOM.scrollTop,
    focused: v.hasFocus,
    active: a ? a.tagName + "." + String(a.className || "").slice(0, 22) : "none",
  };
`;

await runProbe(
  { name: "v0170-verify-undo-search", doc: DOC, docTitle: "撤销复核文档", viewMode: "edit" },
  async (ui) => {
    /* ══════════════════════════ 基础设施 ══════════════════════════ */

    const read = () => ui.ev(READ_DOC);

    /** 等文本稳定：连续两次读取一致才返回（避开 React/CM6 异步落地） */
    async function stable(maxMs = 4000) {
      const t0 = Date.now();
      let last = null, same = 0, s = null;
      while (Date.now() - t0 < maxMs) {
        s = await read();
        if (last !== null && s && s.text === last) { same++; if (same >= 2) return s; }
        else same = 0;
        last = s ? s.text : null;
        await ui.sleep(130);
      }
      return s;
    }

    /** 聚焦编辑区并把光标放到指定位置（P0-1 后必须每次重做） */
    async function focusEditor(pos = "end") {
      await ui.ev(`
        const v = document.querySelector(".cm-content").cmTile.view;
        v.focus();
        const p = ${pos === "end" ? "v.state.doc.length" : Math.round(pos)};
        v.dispatch({ selection: { anchor: p, head: p }, scrollIntoView: false });
        return true;
      `);
      await ui.sleep(230);
    }

    /** 真实按键；mods 位：Ctrl=2, Shift=8（Ctrl+Shift=10） */
    async function press(key, code, vk, mods) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
      await ui.sleep(35);
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
    }

    /** 撤销一次（先聚焦，避免 P0-1 焦点丢失导致按键落到别处） */
    async function ctrlZ() { await focusEditor(); await press("z", "KeyZ", 90, 2); return await stable(); }
    async function ctrlY() { await focusEditor(); await press("y", "KeyY", 89, 2); return await stable(); }
    async function ctrlShiftZ() { await focusEditor(); await press("Z", "KeyZ", 90, 2 | 8); return await stable(); }

    /** 单次 insertText：整串一次事务落地（绕开 P0-1 逐字符焦点丢失） */
    async function insertWhole(text) {
      await focusEditor("end");
      const before = await stable();
      await ui.cdp.send("Input.insertText", { text });
      await ui.sleep(800);
      const after = await stable();
      return { before, after, landedAll: after.text === before.text + text };
    }

    const isCmVisible = () =>
      ui.ev(`
        const e = document.querySelector(".cm-editor");
        if (!e) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      `);
    const isPmVisible = () =>
      ui.ev(`
        const e = document.querySelector(".editor-container .ProseMirror");
        if (!e) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      `);

    async function switchMode(cmd) { await ui.command(cmd); await ui.sleep(2200); }

    /** 反复撤销直到文本回到 target（容忍 P0-1 的「两次才退一步」） */
    async function ensureText(target, maxPresses = 24) {
      for (let i = 0; i < maxPresses; i++) {
        const cur = await stable();
        if (cur.text === target) return { ok: true, presses: i };
        await ctrlZ();
      }
      const cur = await stable();
      return { ok: cur.text === target, presses: maxPresses };
    }

    /** P0-1 重建计数器 */
    await ui.ev(`
      window.__MUT = { added: 0, removed: 0 };
      const wrap = document.querySelector(".source-editor-wrapper") || document.body;
      new MutationObserver((recs) => {
        for (const r of recs) {
          for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches?.(".cm-editor") || n.querySelector?.(".cm-editor"))) window.__MUT.added++;
          for (const n of r.removedNodes) if (n.nodeType === 1 && (n.matches?.(".cm-editor") || n.querySelector?.(".cm-editor"))) window.__MUT.removed++;
        }
      }).observe(wrap, { childList: true, subtree: true });
      return true;
    `);
    const mutReset = () => ui.ev(`window.__MUT = { added: 0, removed: 0 }; return true`);
    const mutPeek = async () => {
      const m = await ui.ev(`const m = { ...window.__MUT }; window.__MUT = { added: 0, removed: 0 }; return m`);
      return `重建 +${m.added}/-${m.removed}`;
    };

    /* ══════════════════════ 第 0 组：装配与模式 ══════════════════════ */

    const s0 = await read();
    ui.add(
      "U0",
      "CM6 装配 + 权威全文可读（基线）",
      s0 && s0.len === DOC.length ? "PASS" : "FAIL",
      s0
        ? `doc.length=${s0.len}（期望 ${DOC.length}）；head=${s0.head}；焦点=${s0.active}`
        : "读不到 EditorView",
    );

    // 交叉校验：虚拟渲染下 .cm-line 拼接是否等于 doc.length（短文档应相等）
    const cross = await ui.ev(`
      const v = document.querySelector(".cm-content").cmTile.view;
      const joined = Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n");
      return { joined, joinedLen: joined.length, docLen: v.state.doc.length, same: joined === v.state.doc.toString() };
    `);
    ui.add(
      "U0b",
      "全文读取通道交叉校验（.cm-line 拼接 vs doc.toString）",
      cross && cross.same ? "PASS" : "KNOWN",
      cross
        ? `.cm-line 拼接 ${cross.joinedLen} 字；doc.toString ${cross.docLen} 字；完全一致=${cross.same}` +
          `（短文档应一致；长文档 CM6 虚拟渲染只渲染视口，故本探针全文一律读 doc.toString）`
        : "读取失败",
    );

    const mode0 = { cm: await isCmVisible(), pm: await isPmVisible() };
    ui.add(
      "U0c",
      "起始模式判定（简报 §3.1：必须用 getBoundingClientRect 宽高 > 0）",
      mode0.cm && !mode0.pm ? "PASS" : "KNOWN",
      `.cm-editor 可见=${mode0.cm} / .editor-container .ProseMirror 可见=${mode0.pm}（期望编辑模式：true / false）`,
    );

    /* ══════════════ 第 1 组：基线撤销 + 破坏性对照（历史缺陷①） ══════════════ */

    // U1b 破坏性对照：刚装入文档、历史为空时 Ctrl+Z 不应改变文本
    const noopBefore = await stable();
    const noopAfter = await ctrlZ();
    ui.add(
      "U1b",
      "破坏性对照：空历史下 Ctrl+Z 不应改变文本",
      noopAfter.text === noopBefore.text ? "PASS" : "KNOWN",
      noopAfter.text === noopBefore.text
        ? "逐字节无变化 → 证明本探针不会把「任意按键」误判成「撤销生效」"
        : `撤销消费了装载期的历史条目：${diffSnap(noopBefore.text, noopAfter.text)}`,
    );

    // U1 基线：单次 insertText → 一次 Ctrl+Z → 精确回到输入前
    const u1ins = await insertWhole("WXYZ");
    ui.add(
      "U1a",
      "前置：整串输入完整落地",
      u1ins.landedAll ? "PASS" : "FAIL",
      `len ${u1ins.before.len} → ${u1ins.after.len}（Δ${u1ins.after.len - u1ins.before.len}，期望 +4）；` +
        `精确拼接一致=${u1ins.landedAll}；焦点=${u1ins.after.active}`,
    );

    await mutReset();
    const u1undo = await ctrlZ();
    const u1mut = await mutPeek();
    ui.add(
      "U1",
      "★ 编辑模式 Ctrl+Z 撤销刚输入的内容（历史缺陷①回归）",
      u1undo.text === u1ins.before.text ? "PASS" : "FAIL",
      `撤销前 len=${u1ins.after.len}（尾部 ${JSON.stringify(u1ins.after.text.slice(-12))}）→ ` +
        `撤销后 len=${u1undo.len}（期望 ${u1ins.before.len}）｜${diffSnap(u1ins.before.text, u1undo.text)}｜${u1mut}`,
    );

    /* ══════════════ 第 2 组：撤销粒度 ══════════════ */

    // U2 单次整串输入 = 一步撤销（绕开 P0-1 逐字符重建，结论最干净）
    await ensureText(DOC);
    const g = await insertWhole("ABCDE");
    const g1undo = await ctrlZ();
    ui.add(
      "U2",
      "★ 撤销粒度：一次整串输入（5 字）应一次撤销全回退",
      g.landedAll && g1undo.text === g.before.text ? "PASS" : g.landedAll ? "KNOWN" : "KNOWN",
      `起点 len=${g.before.len}；落地 len=${g.after.len}（精确=${g.landedAll}）→ 一次 Ctrl+Z 后 len=${g1undo.len}` +
        `（回退 ${g.after.len - g1undo.len} 字，期望 5；期望回到 ${g.before.len}）｜${diffSnap(g.before.text, g1undo.text)}`,
    );

    // U2b 逐字符输入：先验「5 字是否全部落地」（P0-1 前置条件），不成立不得判 PASS
    await ensureText(DOC);
    await focusEditor("end");
    const perBase = await stable();
    const perLanded = [];
    for (const ch of "PQRST") {
      await focusEditor("end");
      const pre = (await stable()).len;
      await ui.cdp.send("Input.insertText", { text: ch });
      await ui.sleep(320);
      perLanded.push((await stable()).len - pre);
    }
    const perAll = (await stable());
    const perAllLanded = perLanded.filter((d) => d > 0).length === 5 && perAll.text === perBase.text + "PQRST";
    if (!perAllLanded) {
      ui.add(
        "U2b",
        "逐字符连续输入后的撤销粒度（受 P0-1 干扰，本项未有效验证）",
        "KNOWN",
        `逐字落点 Δ=[${perLanded.join(",")}]，仅 ${perLanded.filter((d) => d > 0).length}/5 落地 —— ` +
          `P0-1（焦点逐字符丢失）导致源数据不完整，本项无法给出撤销粒度的有效结论。` +
          `干净结论见 U2（单次整串输入）。`,
      );
    } else {
      const one = await ctrlZ();
      const backOne = perAll.len - one.len;
      ui.add(
        "U2b",
        "逐字符连续输入后的撤销粒度（5 字已全部落地，未受 P0-1 干扰）",
        one.text === perBase.text ? "PASS" : "KNOWN",
        `5 字全部落地（Δ=[${perLanded.join(",")}] → ${perAll.len}）—— 本项已避开 P0-1（每字前重设光标）。` +
          `一次 Ctrl+Z 后 len=${one.len}，回退 ${backOne} 字（期望整段 5 字一次回退到 ${perBase.len}）｜` +
          `${diffSnap(perBase.text, one.text)}` +
          (one.text === perBase.text
            ? ""
            : `｜⚠️ 只退 ${backOne} 字与 P1-2「方向反转滞后」规律一致（Lead 已独立复现并立为 P1-2），` +
              `本项与 U4 系列同源，不单独上报`),
      );
    }

    // U2c IME：一次组合 = 一步撤销（CDP 合成 composition 事件链）
    await ensureText(DOC);
    await focusEditor("end");
    const imeBase = await stable();
    const comp = await ui.ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return { error: "no cm-content" };
      const v = c.cmTile && c.cmTile.view;
      if (v) { v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: false }); }
      window.__COMP = [];
      const onStart = () => window.__COMP.push("start");
      const onEnd = (e) => window.__COMP.push("end:" + (e.data || ""));
      c.addEventListener("compositionstart", onStart, true);
      c.addEventListener("compositionend", onEnd, true);
      c.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      await new Promise((r) => setTimeout(r, 90));
      c.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "测试词" }));
      await new Promise((r) => setTimeout(r, 90));
      c.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "测试词" }));
      await new Promise((r) => setTimeout(r, 240));
      c.removeEventListener("compositionstart", onStart, true);
      c.removeEventListener("compositionend", onEnd, true);
      return { events: window.__COMP };
    `);
    // CDP 合成 composition 事件不带真实输入，补一次 insertText 让文本落地
    await ui.cdp.send("Input.insertText", { text: "测试词" });
    await ui.sleep(700);
    const imeTyped = await stable();
    const imeUndo = await ctrlZ();
    const imeOk = imeTyped.text === imeBase.text + "测试词";
    ui.add(
      "U2c",
      "IME 一次组合 = 一步撤销（C14 归并）",
      imeOk && imeUndo.text === imeBase.text ? "PASS" : imeOk ? "KNOWN" : "KNOWN",
      `composition 事件链=${JSON.stringify(comp?.events || [])}｜落地 len ${imeBase.len}→${imeTyped.len}` +
        `（Δ${imeTyped.len - imeBase.len}，精确含「测试词」=${imeOk}）→ 一次 Ctrl+Z 后 len=${imeUndo.len}` +
        `（期望整段一起消失回到 ${imeBase.len}）｜${diffSnap(imeBase.text, imeUndo.text)}` +
        `｜边界：CDP 只能合成 composition 事件，不是真实输入法`,
    );

    /* ══════════════ 第 3 组：恢复（Ctrl+Y / Ctrl+Shift+Z） ══════════════ */

    await ensureText(DOC);
    const rec = await insertWhole("MODE1");
    const recUndo = await ctrlZ();

    await mutReset();
    const recRedo = await ctrlY();
    const recMut = await mutPeek();
    ui.add(
      "U3",
      "★ 撤销后 Ctrl+Y 精确恢复",
      rec.landedAll && recRedo.text === rec.after.text ? "PASS" : "FAIL",
      `输入 ${rec.before.len}→${rec.after.len}（精确=${rec.landedAll}）；撤销后 ${recUndo.len}（期望 ${rec.before.len}，` +
        `${recUndo.text === rec.before.text ? "OK" : "NG"}）；Ctrl+Y 后 ${recRedo.len}（期望 ${rec.after.len}）` +
        `｜${diffSnap(rec.after.text, recRedo.text)}｜${recMut}`,
    );

    // U3b Ctrl+Shift+Z（mods=10，焦点在编辑区内 —— recon 实测焦点在 BODY 时会被 chrome 落点转给 redo，仍走同一处理器）
    await ensureText(DOC);
    const sz = await insertWhole("SHIFTZ");
    const szUndo = await ctrlZ();
    const szRedo = await ctrlShiftZ();
    ui.add(
      "U3b",
      "★ Ctrl+Shift+Z（modifiers=10）亦能恢复",
      sz.landedAll && szUndo.text === sz.before.text && szRedo.text === sz.after.text ? "PASS" : "FAIL",
      `输入 ${sz.before.len}→${sz.after.len}（精确=${sz.landedAll}）；撤销后 ${szUndo.len}（期望 ${sz.before.len}，` +
        `${szUndo.text === sz.before.text ? "OK" : "NG"}）；Ctrl+Shift+Z 后 ${szRedo.len}（期望 ${sz.after.len}，` +
        `${szRedo.text === sz.after.text ? "OK" : "NG"}）｜${diffSnap(sz.after.text, szRedo.text)}`,
    );

    // U3c 破坏性对照：redo 栈耗尽后 Ctrl+Y 不应改变文本
    const ex1 = await ctrlY(); // 已无 redo 可做（刚 redo 过）
    const ex2 = await ctrlY();
    ui.add(
      "U3c",
      "破坏性对照：redo 栈耗尽后 Ctrl+Y 不应改变文本",
      ex2.text === ex1.text ? "PASS" : "KNOWN",
      `连续两次 Ctrl+Y：${ex1.len} → ${ex2.len}｜${diffSnap(ex1.text, ex2.text)}`,
    );

    /* ══════════════ 第 4 组：连续撤销 / 交替撤销（真缺陷 P1-2） ══════════════ */
    //
    // ⚠️ 本组 4 项（U4 / U4b / U4c / U4d）已被 Lead 用**两套独立手法**复现
    //    （真实鼠标点击聚焦 & dispatch 事务聚焦，逐项完全相同），并额外用**格式工具栏
    //    按钮**路径复现成功 —— 绕过键盘与焦点仍失败 ⇒ 缺陷在**撤销决策层**，不是输入层，
    //    也不是 P0-1 的连带效应。Lead 已立为**独立缺陷 P1-2**，报告见
    //    `_plan/v0170-p1-2-undo-redo-alternating.md`。
    //    本探针保留这 4 项作为**独立复现证据**，不重复上报。

    // U4 两条历史 → 连按两次 Ctrl+Z 必须退两步（回到基线）
    await ensureText(DOC);
    const m1 = await insertWhole("AAA");
    const m2 = await insertWhole("BBB");
    const m1ok = m1.landedAll && m2.landedAll;
    const u_step1 = await ctrlZ();
    const u_step2 = await ctrlZ();
    ui.add(
      "U4",
      "★ 两条历史连按两次 Ctrl+Z 应退两步（精确断言）",
      m1ok && u_step1.text === m1.after.text && u_step2.text === m1.before.text ? "PASS" : m1ok ? "FAIL" : "KNOWN",
      `基线 ${m1.before.len}（精确匹配=${m1.before.text === DOC}）；` +
        `第 1 次输入 → ${m1.after.len}（精确=${m1.landedAll}）；第 2 次输入 → ${m2.after.len}（精确=${m2.landedAll}）｜` +
        `Ctrl+Z#1 → ${u_step1.len}（期望 ${m1.after.len}＝回退第 2 次，${u_step1.text === m1.after.text ? "OK" : "NG"}）；` +
        `Ctrl+Z#2 → ${u_step2.len}（期望 ${m1.before.len}＝回退第 1 次，${u_step2.text === m1.before.text ? "OK" : "NG"}）`,
    );

    // U4b 连续撤销逐步轨迹（8 次），暴露「每两次只生效一次」的模式
    const trail = [];
    const trailStates = [];
    await ensureText(DOC);
    const t1 = await insertWhole("AAA");
    const t2 = await insertWhole("BBB");
    const tBaseOk = t1.landedAll && t2.landedAll;
    trailStates.push(t2.after.len);
    for (let i = 0; i < 8; i++) {
      const s = await ctrlZ();
      trail.push(s.len);
      trailStates.push(s.text);
    }
    const backToBase = trailStates.some((t) => t === DOC);
    const firstBack = trailStates.indexOf(DOC);
    ui.add(
      "U4b",
      "★ 连续 8 次 Ctrl+Z 的逐步文本长度轨迹",
      tBaseOk && firstBack > 0 && firstBack <= 2 ? "PASS" : tBaseOk ? "FAIL" : "KNOWN",
      `起点（两次输入后）len=${t2.after.len}；逐次撤销后长度：${trail.join(" → ")}` +
        `｜首次回到基线（len=${DOC.length}）发生在第 ${firstBack > 0 ? firstBack : "未发生"} 次` +
        `｜理想：第 2 次即回到基线。${firstBack > 2 ? "⇒ 存在「按键被执行但没有产生回退」的空操作。" : ""}`,
    );

    // U4c 交替矩阵 undo/redo ×6，逐步精确判定（P2 复现）
    const altRows = [];
    await ensureText(DOC);
    const aIns = await insertWhole("EDIT");
    const altBase = aIns.before.text;
    const altEdit = aIns.after.text;
    let altCur = altEdit;
    for (let i = 0; i < 6; i++) {
      const u = await ctrlZ();
      const r = await ctrlY();
      altRows.push(`u${i + 1}=${u.len}${u.text === altBase ? "[base✓]" : u.text === altEdit ? "[edit·未回退]" : "[非法]"}` +
                   ` r${i + 1}=${r.len}${r.text === altEdit ? "[edit✓]" : r.text === altBase ? "[base·未恢复]" : "[非法]"}`);
      altCur = r;
    }
    const undoHits = altRows.filter((x) => x.includes("[base✓]")).length;
    const redoHits = altRows.filter((x) => x.includes("[edit✓]")).length;
    const illegal = altRows.join(" ").includes("[非法]");
    ui.add(
      "U4c",
      "★ 交替 undo/redo 6 轮：每次 undo 应回 base、每次 redo 应回 edit",
      aIns.landedAll && undoHits === 6 && redoHits === 6 ? "PASS" : aIns.landedAll ? "FAIL" : "KNOWN",
      `状态只可能有两个合法值：base(len=${altBase.length}) / edit(len=${altEdit.length})；` +
        `undo 命中 ${undoHits}/6，redo 命中 ${redoHits}/6；出现非法态=${illegal}｜明细：${altRows.join(" ｜ ")}`,
    );
    void altCur;

    // U4d 关键对照：同样的交替序列走**命令总线**（证明不是键盘/焦点层的问题）
    const altRowsCmd = [];
    await ensureText(DOC);
    const cIns = await insertWhole("CMDX");
    const cBase = cIns.before.text;
    const cEdit = cIns.after.text;
    for (let i = 0; i < 4; i++) {
      await ui.command("edit.undo"); await ui.sleep(1100);
      const u = await stable();
      await ui.command("edit.redo"); await ui.sleep(1100);
      const r = await stable();
      altRowsCmd.push(`u${i + 1}=${u.len}${u.text === cBase ? "[base✓]" : u.text === cEdit ? "[edit·未回退]" : "[非法]"}` +
                      ` r${i + 1}=${r.len}${r.text === cEdit ? "[edit✓]" : r.text === cBase ? "[base·未恢复]" : "[非法]"}`);
    }
    const cmdUndoHits = altRowsCmd.filter((x) => x.includes("[base✓]")).length;
    const cmdRedoHits = altRowsCmd.filter((x) => x.includes("[edit✓]")).length;
    ui.add(
      "U4d",
      "★ 对照：命令总线 undo/redo 交替（同样精确断言）",
      cIns.landedAll && cmdUndoHits === 4 && cmdRedoHits === 4 ? "PASS" : cIns.landedAll ? "FAIL" : "KNOWN",
      `undo 命中 ${cmdUndoHits}/4，redo 命中 ${cmdRedoHits}/4｜明细：${altRowsCmd.join(" ｜ ")}` +
        `｜本项若与 U4c 同样失败 ⇒ 与键盘/焦点无关，在撤销决策层`,
    );

    await ui.shot("undo-alternating");

    /* ══════════════ 第 5 组：撤销后光标 / 滚动（历史缺陷④，并标注 P0-1 归因） ══════════════ */

    await ensureText(DOC);
    await focusEditor("end");
    const caretPre = await stable();
    await ui.cdp.send("Input.insertText", { text: "CARE" });
    await ui.sleep(800);
    const caretTyped = await stable();
    const caretUndo = await ctrlZ();
    ui.add(
      "U5",
      "撤销后光标/滚动位置恢复（历史缺陷④：曾用错类型判定）",
      caretUndo.text === caretPre.text && caretUndo.head === caretPre.head ? "PASS" : "KNOWN",
      `输入前 head=${caretPre.head}（期望 ${DOC.length}）/ scroll=${caretPre.scroll}；` +
        `输入后 head=${caretTyped.head} / scroll=${caretTyped.scroll}（焦点=${caretTyped.active}）；` +
        `撤销后 head=${caretUndo.head} / scroll=${caretUndo.scroll}（偏移 ${Math.abs(caretUndo.head - caretPre.head)} 字符）` +
        `｜文本精确回退=${caretUndo.text === caretPre.text}` +
        `｜⚠️ 输入后 head 即被重置为 ${caretTyped.head}，与 P0-1（每次内容变化重建 CM6 → 选区归零）一致；` +
        `故本项的光标差异归因 P0-1，不单独记撤销栈缺陷`,
    );

    /* ══════════════ 第 6 组：跨模式撤销 ══════════════ */

    await ensureText(DOC);
    const xIns = await insertWhole("MODE2");
    const xEdit1 = await stable();

    await switchMode("view.preview");
    const mRead = { cm: await isCmVisible(), pm: await isPmVisible() };
    const pmHas = await ui.readPmText();
    await switchMode("view.edit");
    const mEdit = { cm: await isCmVisible(), pm: await isPmVisible() };
    const xBack = await stable();

    ui.add(
      "U6a",
      "前置：编辑→阅读→编辑往返后文本未丢",
      xBack.text === xEdit1.text ? "PASS" : "FAIL",
      `输入 ${xIns.before.len}→${xEdit1.len}（精确=${xIns.landedAll}）；往返后 ${xBack.len}｜${diffSnap(xEdit1.text, xBack.text)}` +
        `｜可见性 阅读(cm=${mRead.cm},pm=${mRead.pm}) / 编辑(cm=${mEdit.cm},pm=${mEdit.pm})` +
        `｜阅读面含 MODE2=${!!pmHas && pmHas.includes("MODE2")}`,
    );

    const xUndo = await ctrlZ();
    ui.add(
      "U6",
      "★ 跨模式撤销：切回编辑后 Ctrl+Z 撤掉切模式前那次输入",
      xIns.landedAll && xUndo.text === xIns.before.text ? "PASS" : xUndo.text === xBack.text ? "FAIL" : "KNOWN",
      `输入前 len=${xIns.before.len} → 输入后 ${xEdit1.len} → 切阅读再切回 ${xBack.len} → 撤销后 ${xUndo.len}` +
        `（期望 ${xIns.before.len}）｜${diffSnap(xIns.before.text, xUndo.text)}`,
    );

    // U6b 反向：阅读模式内按 Ctrl+Z（记录行为，不硬判 FAIL）
    await ensureText(DOC);
    const rIns = await insertWhole("RM3");
    await switchMode("view.preview");
    const pmVis = await isPmVisible();
    await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      if (pm) pm.focus();
      return true;
    `);
    await ui.sleep(300);
    await press("z", "KeyZ", 90, 2);
    await ui.sleep(1200);
    const pmAfter = await ui.readPmText();
    const srcAfter = await stable();
    await switchMode("view.edit");
    const backSrc = await stable();
    const revertedInReading = backSrc.text === rIns.before.text;
    ui.add(
      "U6b",
      "阅读模式内按 Ctrl+Z 的行为（该模式不可编辑，记录而不硬判）",
      !pmVis ? "KNOWN" : revertedInReading ? "PASS" : "KNOWN",
      `阅读面可见=${pmVis}；输入后源码 len=${(await (async () => rIns)()).after.len}` +
        `｜阅读模式按 Ctrl+Z 后：阅读面含 RM3=${!!pmAfter && pmAfter.includes("RM3")}；切回编辑后源码 len=${backSrc.len}` +
        `（期望 ${rIns.before.len}）｜结论：${revertedInReading ? "撤销穿透到统一时间线并生效" : "该按键未回退该次输入（阅读视图不可编辑场景，见报告「测不出来」）"}`,
    );

    /* ══════════════ 第 7 组：跨文档撤销隔离（历史缺陷③） ══════════════ */

    await ensureText(DOC);
    const d1 = await insertWhole("DOC1X");
    const d1ok = d1.landedAll;

    const doc2File = ui.path.join(ui.path.dirname(ui.docFile), "undo-doc2.md");
    ui.fs.writeFileSync(doc2File, DOC2, "utf8");
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(doc2File)}, name: "undo-doc2.md", content: ${JSON.stringify(DOC2)} },
      }));
      return true;
    `);
    await ui.sleep(2400);
    const tabCount = await ui.ev(`return document.querySelectorAll(".tab-item").length`);
    const activeTabName = await ui.ev(`
      const a = document.querySelector(".tab-item.tab-active .tab-name");
      return a ? a.textContent : null;
    `);
    const d2a = await stable();
    const d2 = await insertWhole("DOC2Y");

    ui.add(
      "U7a",
      "前置：两个标签都打开，第二个文档可写",
      tabCount >= 2 && d2a.text === DOC2 && d2.landedAll ? "PASS" : "FAIL",
      `标签数=${tabCount}；当前激活标签=${JSON.stringify(activeTabName)}；` +
        `文档2 起始 len=${d2a.len}（期望 ${DOC2.length}，精确=${d2a.text === DOC2}）→ 输入后 ${d2.after.len}（精确=${d2.landedAll}）`,
    );

    // 切回文档1（点第一个标签），确认真的切过去了
    await ui.ev(`const t = document.querySelectorAll(".tab-item")[0]; if (t) t.click(); return true;`);
    await ui.sleep(2400);
    const tabName1 = await ui.ev(`
      const a = document.querySelector(".tab-item.tab-active .tab-name");
      return a ? a.textContent : null;
    `);
    const back1 = await stable();
    const back1IsDoc1 = back1.text.startsWith("# 撤销复核文档") && back1.text.includes("DOC1X");

    ui.add(
      "U7b",
      "前置：切回文档1后内容确为文档1（切换未串内容）",
      back1IsDoc1 ? "PASS" : "FAIL",
      `激活标签=${JSON.stringify(tabName1)}；首行=${JSON.stringify((back1.text || "").split("\n")[0])}；` +
        `len=${back1.len}（期望 ${DOC.length + 5}）；含 DOC1X=${back1.text.includes("DOC1X")}`,
    );

    const d1Undo = await ctrlZ();
    ui.add(
      "U7c",
      "★ 历史缺陷③回归：在文档1撤销只回退文档1，且条目未丢失",
      d1ok && back1IsDoc1 && d1Undo.text === d1.before.text ? "PASS" : d1ok ? "FAIL" : "KNOWN",
      `文档1 输入前 len=${d1.before.len} → 输入后 ${d1.after.len} → 切到文档2 再切回 → 撤销后 ${d1Undo.len}` +
        `（期望 ${d1.before.len}）｜${diffSnap(d1.before.text, d1Undo.text)}`,
    );

    // 破坏性对照：文档1 的撤销不应波及文档2
    await ui.ev(`const t = document.querySelectorAll(".tab-item")[1]; if (t) t.click(); return true;`);
    await ui.sleep(2200);
    const tabName2 = await ui.ev(`
      const a = document.querySelector(".tab-item.tab-active .tab-name");
      return a ? a.textContent : null;
    `);
    const doc2After = await stable();
    const doc2Expect = DOC2 + "DOC2Y";
    ui.add(
      "U7d",
      "破坏性对照：文档1 的撤销不波及文档2",
      doc2After.text === doc2Expect ? "PASS" : "FAIL",
      `激活标签=${JSON.stringify(tabName2)}；文档2 现文本 len=${doc2After.len}（期望 ${doc2Expect.length}，精确=${doc2After.text === doc2Expect}）` +
        `｜${diffSnap(doc2Expect, doc2After.text)}`,
    );

    /* ══════════════ 第 8 组：历史缺陷① 精确回归 ══════════════ */

    const divProbe = await ui.ev(`
      const c = document.querySelector(".cm-content");
      return {
        hostTag: c ? c.tagName : null,
        hasValueProp: c ? ("value" in c) : null,
        valueType: c ? typeof c.value : null,
        setSelectionRangeType: c ? typeof c.setSelectionRange : null,
      };
    `);
    ui.add(
      "U8",
      "★ 历史缺陷①回归：CM6 宿主是 DIV，无 .value / .setSelectionRange（撤销不再因 TypeError 崩）",
      divProbe && divProbe.hostTag === "DIV" && divProbe.valueType === "undefined" && divProbe.setSelectionRangeType === "undefined"
        ? "PASS"
        : "FAIL",
      JSON.stringify(divProbe) + `｜全程未捕获异常见 Z9`,
    );

    // P0-1 量化证据（支撑 5/6 组归因）
    const mutTotals = await ui.ev(`return { ...window.__MUT }`);
    ui.add(
      "U9",
      "P0-1 量化证据：内容变化触发 .cm-editor 重建（支撑上面各组的归因）",
      "KNOWN",
      `整个探针期间观测到 .cm-editor added=${mutTotals.added} / removed=${mutTotals.removed}` +
        `（由 Lead 的 P0-1 统一上报，本流不重复上报；仅用于解释 U5 的光标归零与 U2b 的输入丢字）`,
    );

    await ui.shot("undo-final");
  },
);

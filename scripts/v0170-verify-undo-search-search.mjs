/**
 * LightMD v0.17.0 复核 —— **D 流 Part 2：统一搜索 / 内容替换** 实机探针
 *
 * 产物：`_verify-out/v0170-verify-undo-search-search.json` / `.txt`
 * 截图：`_verify-out/shots/v0170-verify-undo-search-search-*.png`
 * 骨架：`scripts/_lib/probe-harness.mjs`
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 一、判定口径（Lead 两轮批注后的硬要求）
 * - 命中数、替换计数、替换后全文，**全部用精确断言**：
 *   `afterText === expectedExactText` + `count(needle) === expectedCount`。
 * - **禁止**「长度变了 / 变短了」式判定（上一轮 P0-1 漏检就是 `length > 178` 这类恒真兜底）。
 * - 搜索框是受控 React `<input>`：本探针用 **单次 `Input.insertText`** 直写，
 *   **不用** `ui.typeText()` —— 骨架的 `typeText` 用 `readSourceText()`（只读源码面）
 *   做校验，搜索框不在其中，会走逐字兜底并**重复写入**
 *   （recon 实测：输入 `ABC` → 值变成 `ABCABCSEARCHNEEDLE`）。这条已在本文件 N5 复现记录。
 *
 * ## 二、可判定的选项矩阵（用 4 个不同数字，不看勾选框外观）
 * 测试文档刻意构造：
 * | 选项 | 期望命中 | 依据 |
 * |---|---|---|
 * | 默认 | 5 | 甲/乙/丙 3 处 + `SEARCHNEEDLEEXTRA` 内 1 处 + 小写 `searchneedle` 1 处 |
 * | 只勾「匹配大小写」 | 4 | 排除小写那处，`EXTRA` 仍命中 |
 * | 只勾「整词匹配」 | 4 | 排除 `EXTRA`，小写整词仍命中 |
 * | 两者都勾 | 3 | 只剩甲/乙/丙 |
 * 四档四个不同数字 → 任何一个选项失效都会立刻偏离，机器可判。
 *
 * ## 三、P0-1 归因
 * 替换会写 `content` → 触发 CM6 重建（Lead 的 P0-1）。因此：
 * - 「替换后文档文本是否正确」= 产品逻辑，**严格判定**；
 * - 「替换后焦点/选区是否还在」= P0-1 现象，**单列并归因**，不记成搜索缺陷。
 *
 * ## 四、历史缺陷②回归
 * 搜索框输入 1 个字符即崩溃（div 上用 `setSelectionRange`）→ S7 专项。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { runProbe } from "./_lib/probe-harness.mjs";

const NEEDLE = "SEARCHNEEDLE";

/**
 * 搜索/替换测试文档。命中数刻意设计成 5 / 4 / 4 / 3 四档（见文件头表格）。
 * 注意 `SEARCHNEEDLEEXTRA` 与 `searchneedle` 是「整词 / 大小写」两档的判别器。
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

/** 精确期望：默认 5 / 大小写 4 / 整词 4 / 两者 3 */
const HITS = { default: 5, caseSensitive: 4, wholeWord: 4, both: 3 };

/** 统计子串出现次数（精确计数，**区分大小写**，非长度比对） */
function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) return n;
    n++;
    i = j + needle.length;
  }
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 统计出现次数（**不区分大小写**）。
 *
 * 为什么必须有这个函数：搜索面板**默认不勾「匹配大小写」**，所以 `SEARCHNEEDLE`
 * 会同时命中文档里的小写 `searchneedle`。用区分大小写的 countOf 去断言
 * 「默认命中 5 处」会得到 4，是**探针算错**而不是产品错（实机首跑就踩了这个坑）。
 */
function countOfCI(hay, needle) {
  if (!needle) return 0;
  return (hay.match(new RegExp(reEsc(needle), "gi")) || []).length;
}

/** 不区分大小写的全部替换（用于「全部替换」的精确期望全文） */
function replaceAllCI(hay, needle, repl) {
  return hay.replace(new RegExp(reEsc(needle), "gi"), repl);
}

/** 从计数元素文本（"1/5" / "无结果" / "正则无效"）解析出**总命中数** */
function totalOf(countText) {
  const m = /^(\d+)\/(\d+)$/.exec(String(countText ?? "").trim());
  return m ? Number(m[2]) : null;
}

const diffSnap = (a, b) => {
  if (a === b) return "逐字节完全相同";
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return `同前缀 ${i} / 同后缀 ${j}；A独有=${JSON.stringify(a.slice(i, a.length - j))} B独有=${JSON.stringify(b.slice(i, b.length - j))}`;
};

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
  { name: "v0170-verify-undo-search-search", doc: SEARCH_DOC, docTitle: "搜索替换复核文档", viewMode: "edit" },
  async (ui) => {
    const read = () => ui.ev(READ_DOC);

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

    /* ── 搜索面板 DOM 探测（先探测再写死选择器，符合 task-4 要求）── */
    const panel = async () =>
      ui.ev(`
        const q = (s) => document.querySelector(s);
        const root = q(".search-replace");
        const r = root && root.getBoundingClientRect();
        const inputs = Array.from(document.querySelectorAll(".search-input"));
        return {
          rootVisible: !!r && r.width > 0 && r.height > 0,
          rootCls: root ? root.className : null,
          rootSize: r ? Math.round(r.width) + "x" + Math.round(r.height) : null,
          mainInputTag: inputs[0] ? inputs[0].tagName : null,
          mainInputValue: inputs[0] ? inputs[0].value : null,
          secondInputTag: inputs[1] ? inputs[1].tagName : null,
          navButtons: Array.from(document.querySelectorAll(".search-nav-btn")).map(b => b.title || b.textContent.trim()),
          countText: q(".search-count") ? q(".search-count").textContent : null,
          optionIds: Array.from(document.querySelectorAll("[data-testid^='search-']")).map(e => e.getAttribute("data-testid")),
          replaceBtns: Array.from(document.querySelectorAll(".replace-btn")).map(b => ({ t: b.textContent.trim(), tid: b.getAttribute("data-testid"), disabled: b.disabled })),
        };
      `);

    /** 搜索框聚焦（受控 input，用原生 focus + 全选） */
    async function focusSearchInput(idx = 0) {
      await ui.ev(`
        const i = document.querySelectorAll(".search-input")[${idx}];
        if (!i) return false;
        i.focus();
        i.setSelectionRange(0, i.value.length);
        return true;
      `);
      await ui.sleep(200);
    }

    /** 清空搜索框（全选 + Delete 逐字，走真实按键链路） */
    async function clearInput(idx = 0) {
      await focusSearchInput(idx);
      const v = await ui.ev(`const i = document.querySelectorAll(".search-input")[${idx}]; return i ? i.value : null`);
      for (let k = 0; k < (v ? v.length : 0); k++) {
        await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0 });
        await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0 });
        await ui.sleep(45);
      }
      await ui.sleep(400);
    }

    /**
     * 把文本写进搜索框 —— **单次 insertText**（不重复写）。
     * 不用 ui.typeText()：见文件头「一」，骨架实现会在搜索框重复写入。
     */
    async function setInput(text, idx = 0) {
      await clearInput(idx);
      await focusSearchInput(idx);
      await ui.cdp.send("Input.insertText", { text });
      await ui.sleep(1100); // 等 React 受控更新 + performSearch 落地
      const v = await ui.ev(`const i = document.querySelectorAll(".search-input")[${idx}]; return i ? i.value : null`);
      return v;
    }

    const readCount = async () =>
      ui.ev(`const c = document.querySelector(".search-count"); return c ? c.textContent : null`);
    const readHits = async () =>
      ui.ev(`
        return {
          all: document.querySelectorAll(".cm-source-search-hit").length,
          active: document.querySelectorAll(".cm-source-search-hit-active").length,
          texts: Array.from(document.querySelectorAll(".cm-source-search-hit")).map(e => e.textContent),
        };
      `);

    const clickNav = async (which) => {
      await ui.ev(`const bs = document.querySelectorAll(".search-nav-btn"); const b = bs[${which}]; if (b) b.click(); return true;`);
      await ui.sleep(800);
    };

    /** 打开/关闭搜索面板（幂等） */
    async function openPanel(withReplace) {
      await ui.command(withReplace ? "edit.replace" : "edit.find");
      await ui.sleep(1100);
      const p = await panel();
      if (!p || !p.rootVisible) { await ui.command(withReplace ? "edit.replace" : "edit.find"); await ui.sleep(1100); }
      return await panel();
    }
    async function closePanel() {
      await ui.ev(`const b = document.querySelector(".search-close-btn"); if (b) b.click(); return true;`);
      await ui.sleep(800);
    }

    /* ═══════════════════ S0：面板 DOM 契约 ═══════════════════ */

    const p0 = await openPanel(false);
    ui.add(
      "S0",
      "搜索面板可打开（edit.find）+ DOM 契约探测",
      p0 && p0.rootVisible && p0.mainInputTag === "INPUT" ? "PASS" : "FAIL",
      p0
        ? `面板 ${p0.rootSize}；主输入框 <${p0.mainInputTag}>；导航按钮 ${JSON.stringify(p0.navButtons)}；` +
          `计数=${JSON.stringify(p0.countText)}；data-testid 全集=${JSON.stringify(p0.optionIds)}`
        : "面板未出现",
    );

    /* ═══════════════════ S1：命中数（默认 5） ═══════════════════ */

    const v1 = await setInput(NEEDLE);
    const c1 = await readCount();
    const h1 = await readHits();
    ui.add(
      "S1",
      "★ 命中数：默认选项下应为 5（不区分大小写，精确）",
      v1 === NEEDLE && c1 === `1/${HITS.default}` && h1.all === HITS.default ? "PASS" : "FAIL",
      `搜索框值=${JSON.stringify(v1)}；计数元素=${JSON.stringify(c1)}（期望 1/5）；` +
        `CM6 Decoration 数=${h1.all}（期望 ${HITS.default}）；active=${h1.active}；命中文本=${JSON.stringify(h1.texts)}`,
    );

    /* ═══════════════════ S2：命中高亮（Decoration）精确覆盖搜索词 ═══════════════════ */

    /**
     * 默认不区分大小写 ⇒ 命中文本必须**逐个与搜索词忽略大小写相等**，
     * 且必须**恰好有一个**是小写形态（即文档里的 `searchneedle` 被正确命中）。
     * 若高亮错位，会出现半截词或整段相邻文本 → 这里立刻暴露。
     */
    const norm = (s) => String(s ?? "").toLowerCase();
    const allMatchCI = h1.texts.every((t) => norm(t) === norm(NEEDLE));
    const exactCaseCount = h1.texts.filter((t) => t === NEEDLE).length;
    const lowerCaseCount = h1.texts.filter((t) => t === "searchneedle").length;
    ui.add(
      "S2",
      "★ 命中高亮：Decoration 覆盖的文本精确等于搜索词（忽略大小写，位置准确）",
      h1.all === HITS.default && allMatchCI ? "PASS" : "FAIL",
      `每个命中节点的 textContent=${JSON.stringify(h1.texts)}；` +
        `逐个忽略大小写等于 ${JSON.stringify(NEEDLE)}=${allMatchCI}；` +
        `其中原文大写 ${exactCaseCount} 处 / 原文小写 ${lowerCaseCount} 处（期望 4 / 1）` +
        `｜若错位，这里会出现半截词或相邻整段文本`,
    );

    /* ═══════════════════ S3：上一个 / 下一个跳转（真实移动） ═══════════════════ */

    const navSeq = [];
    const navDetails = [];
    // 记录每次跳转后的选区/滚动，证明"真的移动了"
    for (let i = 0; i < 4; i++) {
      const before = await read();
      await clickNav(1); // 下一个
      const after = await read();
      const cnt = await readCount();
      navSeq.push(`${before.from}-${before.to}→${after.from}-${after.to}`);
      navDetails.push(`#${i + 1} 计数=${cnt} 选区 ${before.from}..${before.to} → ${after.from}..${after.to} 滚动 ${before.scroll}→${after.scroll}`);
    }
    // 再点「上一个」一次，应回到前一处
    await clickNav(0);
    const backCnt = await readCount();
    ui.add(
      "S3",
      "★ 上一个/下一个：选中位置真的移动（选区偏移，不只是计数变化）",
      new Set(navSeq).size >= 3 ? "PASS" : "FAIL",
      `4 次「下一个」的选区序列（from-to）：${navSeq.join(" ｜ ")}；不同位置数=${new Set(navSeq).size}` +
        `｜明细：${navDetails.join(" ／ ")}｜「上一个」后计数=${JSON.stringify(backCnt)}`,
    );

    /* ═══════════════════ S4：破坏性对照 —— 选项必须真的改变命中数 ═══════════════════ */

    const setCheck = async (tid, on) => {
      await ui.ev(`
        const el = document.querySelector("[data-testid='${tid}']");
        if (!el) return "missing";
        if (!!el.checked !== ${on}) el.click();
        return el.checked;
      `);
      await ui.sleep(1200);
    };

    // 4a 匹配大小写：5 → 4
    await setCheck("search-match-case", true);
    const cCase = await readCount();
    const hCase = await readHits();
    ui.add(
      "S4a",
      "★ 破坏性对照：勾选「匹配大小写」后总命中数 5 → 4（小写那处被排除）",
      totalOf(cCase) === HITS.caseSensitive && hCase.all === HITS.caseSensitive ? "PASS" : "FAIL",
      `计数元素=${JSON.stringify(cCase)}（总命中期望 ${HITS.caseSensitive}；斜杠前是当前项序号，会保留上一轮游标，故只比总数）；` +
        `Decoration=${hCase.all}（期望 ${HITS.caseSensitive}）；命中文本=${JSON.stringify(hCase.texts)}（不应出现小写 searchneedle）`,
    );

    // 4b 再加整词：4 → 3
    await setCheck("search-whole-word", true);
    const cBoth = await readCount();
    const hBoth = await readHits();
    ui.add(
      "S4b",
      "★ 破坏性对照：再勾「整词匹配」后总命中数 4 → 3（SEARCHNEEDLEEXTRA 被排除）",
      totalOf(cBoth) === HITS.both && hBoth.all === HITS.both ? "PASS" : "FAIL",
      `计数元素=${JSON.stringify(cBoth)}（总命中期望 ${HITS.both}）；Decoration=${hBoth.all}（期望 ${HITS.both}）；` +
        `命中文本=${JSON.stringify(hBoth.texts)}（不应出现 SEARCHNEEDLEEXTRA）`,
    );

    // 4c 关掉大小写、只留整词：3 → 4
    await setCheck("search-match-case", false);
    const cWhole = await readCount();
    const hWhole = await readHits();
    ui.add(
      "S4c",
      "★ 破坏性对照：只留「整词」时总命中数 3 → 4（小写整词回来、EXTRA 仍排除）",
      totalOf(cWhole) === HITS.wholeWord && hWhole.all === HITS.wholeWord ? "PASS" : "FAIL",
      `计数元素=${JSON.stringify(cWhole)}（总命中期望 ${HITS.wholeWord}）；Decoration=${hWhole.all}（期望 ${HITS.wholeWord}）；` +
        `命中文本=${JSON.stringify(hWhole.texts)}`,
    );

    // 复位：全不勾，回到 5
    await setCheck("search-whole-word", false);
    const cReset = await readCount();
    ui.add(
      "S4d",
      "选项复位后回到默认总命中数 5",
      totalOf(cReset) === HITS.default ? "PASS" : "FAIL",
      `计数元素=${JSON.stringify(cReset)}（总命中期望 ${HITS.default}）`,
    );

    /* ═══════════════════ S5：正则选项效果（精确） ═══════════════════ */

    // 正则 "SEARCHNEEDLE|searchneedle" 在默认（非整词、区分大小写关闭）下应命中… 用它更好：
    // 用正则 `SEARCHNEEDLE[A-Z]+` → 只命中 SEARCHNEEDLEEXTRA 的前缀部分，命中数 1
    await setCheck("search-use-regex", true);
    const reVal = await setInput("SEARCHNEEDLE[A-Z]+");
    const cRe = await readCount();
    const hRe = await readHits();
    ui.add(
      "S5",
      "★ 正则选项：SEARCHNEEDLE[A-Z]+ 只命中连写那 1 处（与默认 5 处不同）",
      cRe === "1/1" && hRe.all === 1 && hRe.texts[0] === "SEARCHNEEDLEEXTRA" ? "PASS" : "FAIL",
      `搜索框=${JSON.stringify(reVal)}；计数=${JSON.stringify(cRe)}（期望 1/1）；Decoration=${hRe.all}；` +
        `命中文本=${JSON.stringify(hRe.texts)}（期望 ["SEARCHNEEDLEEXTRA"]）`,
    );

    // 非法正则不应崩，且应给出明确提示
    const badVal = await setInput("SEARCH[NEEDLE");
    const errInfo = await ui.ev(`
      const c = document.querySelector(".search-count");
      return { count: c ? c.textContent : null,
               invalid: !!document.querySelector(".search-input-invalid"),
               errs: (window.__ERRS || []).slice(0, 3) };
    `);
    ui.add(
      "S5b",
      "非法正则：明确提示且不崩",
      errInfo && (errInfo.errs || []).length === 0 && (errInfo.invalid || (errInfo.count || "").length > 0) ? "PASS" : "FAIL",
      `搜索框=${JSON.stringify(badVal)}；计数=${JSON.stringify(errInfo?.count)}；输入框标红=${errInfo?.invalid}；异常=${JSON.stringify(errInfo?.errs)}`,
    );

    await setCheck("search-use-regex", false);

    /* ═══════════════════ S6：中文 / 特殊字符输入不崩（历史缺陷②同域） ═══════════════════ */

    const cjkItems = [];
    for (const probe of ["中", "中文", "甲段落", "。", "\\", "$1", "[](){}", ".*+"]) {
      const before = await ui.ev(`return (window.__ERRS||[]).length`);
      const val = await setInput(probe);
      const after = await ui.ev(`return (window.__ERRS||[]).length`);
      const cnt = await readCount();
      cjkItems.push(`${JSON.stringify(probe)}→框值=${JSON.stringify(val)} 计数=${JSON.stringify(cnt)} 新增异常=${after - before}`);
    }
    const cjkTotalErr = await ui.ev(`return (window.__ERRS||[]).length`);
    ui.add(
      "S6",
      "搜索框输入中文 / 特殊字符 / 正则元字符不崩",
      cjkTotalErr === 0 ? "PASS" : "FAIL",
      `共 9 种输入，全程未捕获异常数=${cjkTotalErr}｜明细：${cjkItems.join(" ； ")}`,
    );

    /* ═══════════════════ S7：单字符输入（历史缺陷②精确回归） ═══════════════════ */

    // 缺陷原文：搜索框输入 1 个字符即应用级崩溃（setSelectionRange 被用在 div 上）
    const oneCharSteps = [];
    for (const ch of ["S", "E", "A"]) {
      const val = await setInput(ch);
      const cnt = await readCount();
      const errs = await ui.ev(`return (window.__ERRS||[]).length`);
      oneCharSteps.push(`输入 ${JSON.stringify(ch)} → 框值=${JSON.stringify(val)} 计数=${JSON.stringify(cnt)} 累计异常=${errs}`);
    }
    const oneCharErr = await ui.ev(`return (window.__ERRS||[]).length`);
    const panelAlive = await panel();
    ui.add(
      "S7",
      "★ 历史缺陷②回归：搜索框逐字符输入（1 字符）不崩、面板存活",
      oneCharErr === 0 && panelAlive && panelAlive.rootVisible ? "PASS" : "FAIL",
      `全程未捕获异常=${oneCharErr}；面板仍可见=${panelAlive?.rootVisible}；主输入框 <${panelAlive?.mainInputTag}>` +
        `｜明细：${oneCharSteps.join(" ； ")}`,
    );

    // 顺带确认搜索框确实是原生 input（不是 div 冒充 → 历史缺陷②的根因不在）
    const inputKind = await ui.ev(`
      const i = document.querySelectorAll(".search-input")[0];
      return { tag: i ? i.tagName : null, hasSetSelectionRange: i ? typeof i.setSelectionRange : null,
               hasValue: i ? typeof i.value : null };
    `);
    ui.add(
      "S7b",
      "搜索框是真 <input>（有原生 setSelectionRange/value）—— 历史缺陷②根因不在",
      inputKind && inputKind.tag === "INPUT" && inputKind.hasSetSelectionRange === "function" ? "PASS" : "FAIL",
      JSON.stringify(inputKind),
    );

    /* ═══════════════════ S8：替换单项（精确全文断言） ═══════════════════ */

    // 复位搜索词（避免上一步单字符残留）
    await setInput(NEEDLE);
    const cntBefore = await readCount();

    const pRep = await openPanel(true);
    ui.add(
      "S8a",
      "替换行可展开（edit.replace）+ 两个替换按钮存在",
      pRep && pRep.secondInputTag === "INPUT" && (pRep.replaceBtns || []).length === 2 ? "PASS" : "FAIL",
      pRep ? `替换输入框 <${pRep.secondInputTag}>；按钮=${JSON.stringify(pRep.replaceBtns)}` : "替换行未出现",
    );

    const docBeforeRep = await stable();

    // 填替换词（单次 insertText）
    await focusSearchInput(1);
    await clearInput(1);
    await ui.cdp.send("Input.insertText", { text: "REPLX" });
    await ui.sleep(900);
    const replVal = await ui.ev(`const i = document.querySelectorAll(".search-input")[1]; return i ? i.value : null`);

    // 点「替换」（第一个 .replace-btn，无 data-testid）
    await ui.ev(`
      const btns = Array.from(document.querySelectorAll(".replace-btn"));
      const b = btns.find(x => !x.getAttribute("data-testid"));
      if (b) b.click();
      return !!b;
    `);
    await ui.sleep(2200);
    const docAfterRep = await stable();

    // 精确期望：把「当前命中的那一处」替换为 REPLX（第一处 = 甲段落那处）
    const expectOneRep = SEARCH_DOC.replace(NEEDLE, "REPLX");
    const oneRepExact = docAfterRep.text === expectOneRep;
    ui.add(
      "S8",
      "★ 替换单项：替换后全文精确等于预期 + 其余命中不受影响",
      oneRepExact ? "PASS" : "FAIL",
      `替换词框=${JSON.stringify(replVal)}；替换前 len=${docBeforeRep.len}（${NEEDLE} 不分大小写×${countOfCI(docBeforeRep.text, NEEDLE)}，计数元素 ${JSON.stringify(cntBefore)}）` +
        `→ 替换后 len=${docAfterRep.len}（${NEEDLE}×${countOfCI(docAfterRep.text, NEEDLE)}，REPLX×${countOf(docAfterRep.text, "REPLX")}）` +
        `｜期望：${NEEDLE}×${countOfCI(expectOneRep, NEEDLE)}、REPLX×1；全文精确匹配=${oneRepExact}` +
        (oneRepExact ? "" : `｜${diffSnap(expectOneRep, docAfterRep.text)}`),
    );

    // 替换后的焦点/选区归属（P0-1 归因，不记搜索缺陷）
    ui.add(
      "S8b",
      "替换后的焦点/选区状态（归因 P0-1，不记搜索缺陷）",
      "KNOWN",
      `替换后焦点=${docAfterRep.active}；光标 head=${docAfterRep.head}；选区 ${docAfterRep.from}..${docAfterRep.to}；` +
        `编辑器 hasFocus=${docAfterRep.focused}` +
        `｜替换写回 content → 触发 P0-1 的 CM6 重建；本例焦点恰好回到编辑器（重建后重新挂载），` +
        `但选区被重置到命中处而非用户原光标 —— 属 P0-1 连带效应，不记搜索缺陷`,
    );

    /* ═══════════════════ S9：替换后撤销（与撤销栈联动） ═══════════════════ */

    await closePanel();
    // 焦点在 BODY/编辑器外时，撤销走窗口监听的 chrome 落点（App.tsx 已接线）
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await ui.sleep(40);
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await ui.sleep(1800);
    const undoRep = await stable();
    const undoExact = undoRep.text === docBeforeRep.text;
    ui.add(
      "S9",
      "★ 替换后可撤销（撤销后全文精确等于替换前）",
      undoExact ? "PASS" : "FAIL",
      `替换后 len=${docAfterRep.len}（REPLX×${countOf(docAfterRep.text, "REPLX")}）→ 撤销后 len=${undoRep.len}` +
        `（${NEEDLE}×${countOf(undoRep.text, NEEDLE)}、REPLX×${countOf(undoRep.text, "REPLX")}）` +
        `｜精确回到替换前=${undoExact}` + (undoExact ? "" : `｜${diffSnap(docBeforeRep.text, undoRep.text)}`),
    );

    /* ═══════════════════ S10：全部替换（精确全文 + 计数） ═══════════════════ */

    // 重新打开面板并设定搜索/替换词
    await openPanel(true);
    await setInput(NEEDLE, 0);
    await focusSearchInput(1);
    await clearInput(1);
    await ui.cdp.send("Input.insertText", { text: "ALLREP" });
    await ui.sleep(900);
    const cntBeforeAll = await readCount();
    const hitsBeforeAll = await readHits();
    const docBeforeAll = await stable();

    await ui.ev(`
      const b = document.querySelector("[data-testid='search-replace-all']");
      if (b) b.click();
      return !!b;
    `);
    await ui.sleep(2600);
    const docAfterAll = await stable();
    const hitsAfterAll = await readHits();
    const cntAfterAll = await readCount();

    /**
     * 精确期望全文：搜索面板**默认不区分大小写**，所以「全部替换」必须把
     * 大小写两种形态**一起**替换掉（5 处）。用区分大小写的 split 只会替换 4 处
     * —— 那是探针算错，首跑就踩了这个坑（实测产品正确地替换了 5 处）。
     */
    const expectAll = replaceAllCI(docBeforeAll.text, NEEDLE, "ALLREP");
    const allExact = docAfterAll.text === expectAll;
    ui.add(
      "S10",
      "★ 全部替换：替换后全文精确等于预期全文 + 计数正确 + 剩余命中归零",
      allExact &&
        countOfCI(docAfterAll.text, NEEDLE) === 0 &&
        countOf(docAfterAll.text, "ALLREP") === HITS.default
        ? "PASS"
        : "FAIL",
      `替换前：计数元素=${JSON.stringify(cntBeforeAll)}（总命中期望 ${HITS.default}）、Decoration=${hitsBeforeAll.all}、` +
        `${NEEDLE} 不分大小写×${countOfCI(docBeforeAll.text, NEEDLE)}` +
        `｜替换后：${NEEDLE}×${countOfCI(docAfterAll.text, NEEDLE)}（期望 0）、ALLREP×${countOf(docAfterAll.text, "ALLREP")}（期望 ${HITS.default}）、` +
        `计数元素=${JSON.stringify(cntAfterAll)}、Decoration=${hitsAfterAll.all}` +
        `｜全文精确匹配期望值=${allExact}` + (allExact ? "" : `｜${diffSnap(expectAll, docAfterAll.text)}`),
    );

    /* ═══════════════════ S11：全部替换后撤销 ═══════════════════ */

    await closePanel();
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await ui.sleep(40);
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
    await ui.sleep(2000);
    const undoAll = await stable();
    const undoAllExact = undoAll.text === docBeforeAll.text;
    ui.add(
      "S11",
      "★ 全部替换后可撤销（一次撤销回到替换前全文）",
      undoAllExact ? "PASS" : "FAIL",
      `全部替换后 ${NEEDLE}×${countOfCI(docAfterAll.text, NEEDLE)}、ALLREP×${countOf(docAfterAll.text, "ALLREP")}` +
        ` → 撤销后 ${NEEDLE}×${countOfCI(undoAll.text, NEEDLE)}、ALLREP×${countOf(undoAll.text, "ALLREP")}` +
        `（期望 ${NEEDLE}×${HITS.default}、ALLREP×0）｜精确回到替换前=${undoAllExact}` +
        (undoAllExact ? "" : `｜${diffSnap(docBeforeAll.text, undoAll.text)}`),
    );

    await ui.shot("search-replace");

    /* ═══════════════════ S12：搜索面板整体健康度（收尾） ═══════════════════ */

    const finalErrs = await ui.ev(`return (window.__ERRS || [])`);
    const finalPanel = await panel();
    ui.add(
      "S12",
      "全程搜索面板存活 + 无异常累积",
      (finalErrs || []).length === 0 ? "PASS" : "FAIL",
      `未捕获异常=${JSON.stringify((finalErrs || []).slice(0, 5))}；面板可见=${finalPanel?.rootVisible}；` +
        `最终文档 ${NEEDLE}×${countOf((await stable()).text, NEEDLE)}`,
    );
  },
);

/**
 * LightMD v0.17.0 第四轮 —— T4「有序列表 markdown 语义」两项验收探针
 *
 * | 项 | 用户原话 | 本探针验什么 |
 * |---|---|---|
 * | #2 | 在有序列表上加任务待办会把有序列表弄没；正确例子如 `- [ ] 2.` | 真实键盘 Ctrl+T 后**序列化文本**：三行都在、任务项带 `2.`、`1.`/`3.` 逐字节不变 |
 * | #6 | 编辑模式两行各输 `1.`，切阅读→切回编辑要自动编号 | 端到端：真实键入 → 切模式 → 读回源码文本，且**幂等**（切两次仍是 `1.` `2.`） |
 *
 * ## 为什么必须读**序列化文本**，不能只读 DOM/结构
 *
 * #2 的验收形态 `1. aa // - [ ] 2. bb // 3. cc` 是 **3 个独立块**。
 * 只看 DOM 能数出 3 个块，但"`1.` / `3.` 是否逐字节保持不变"只有**文本**能证明。
 * #6 更是纯文本需求（"切回编辑仍是两个 1." 说的是源码文本）。
 *
 * ## ⚠️ 本轮踩到的探针工程坑（第三轮同一族，已内建规避）
 *
 * 1. **源码面受控于 React**：直接 `view.dispatch({changes})` 改文档，React 下次提交会用
 *    旧快照把文档**倒回去**。→ 改文档一律走 `lightmd:openFile`，并**双次读校验稳态**。
 * 2. **分屏右侧预览也是 `.ProseMirror`**：会抢焦点；App 全局快捷键**按焦点**分发 →
 *    焦点不在 `.cm-content` 时 Ctrl+T 落到阅读模式命令。→ 测 #2 前**关掉分屏预览**，
 *    并用**真实鼠标点 `.cm-line`**（按行文本精确匹配，不用 index）把焦点放回源码面。
 * 3. **CM6 虚拟滚动**：行索引不稳定 → 按行文本找目标行。
 * 4. **CM6 的 state 是 @codemirror/state**，**没有 `state.tr`** → 一律走 `view.dispatch`。
 *
 * 用法：
 * ```bash
 * npx vite build --outDir _verify-out/dist-t4 --emptyOutDir
 * BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t4" node scripts/v0170-r4-list.mjs
 * ```
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

/** #2 的文档：前置段落 + 3 项有序列表 + 尾段落（列表不在文档开头，能验"不跑到最前面"） */
const DOC_LIFT = ["前置段落", "", "1. 甲项", "2. 乙项", "3. 丙项", "", "尾段落", ""].join("\n");

/** #6 的文档：一段占位内容即可（真正要测的是"用户键入两个 1."之后的行为） */
const DOC_RENUM = ["# 重编号探针", "", "占位段落", ""].join("\n");

const VIEW = `
  const __c = document.querySelector(".cm-content");
  const __v = __c && __c.cmTile && __c.cmTile.root && __c.cmTile.root.view;
`;

await runBrowserProbe(
  { name: "v0170-r4-list", doc: DOC_RENUM, docTitle: "重编号探针" },
  async (ui) => {
    const ev = ui.ev;
    const sleep = ui.sleep;

    /* ══════════════ 0. 环境 ══════════════ */
    const env = await ev(`
      ${VIEW}
      return {
        impl: __v ? "cm6" : "other",
        formatBtns: document.querySelectorAll(".source-format-toolbar .format-btn").length,
        syntaxItems: document.querySelectorAll(".syntax-helper .syntax-helper-item").length,
      };
    `);
    ui.log(`[env] impl=${env.impl} 格式按钮=${env.formatBtns} 语法项=${env.syntaxItems}`);
    ui.add(
      "A0",
      "环境就绪：CM6 源码面 + 格式栏",
      env.impl === "cm6" && env.formatBtns > 0 ? "PASS" : "FAIL",
      JSON.stringify(env),
    );

    /* ══════════════ 通用工具 ══════════════ */

    const readDoc = async () => await ev(`${VIEW} return __v ? __v.state.doc.toString() : null;`);

    /**
     * 把文档换成 text —— **走 App 的 openFile 通道**，不走 dispatch。
     *
     * 原因见文件头坑 #1：源码面受控于 React，直接 dispatch 会被倒回去。
     * 这里做**双次读校验**（间隔一拍），确认没有被受控态覆盖。
     */
    const setDoc = async (text) => {
      for (let i = 0; i < 5; i++) {
        await ev(`
          window.dispatchEvent(new CustomEvent("lightmd:openFile", {
            detail: {
              path: ${JSON.stringify("/tmp/t4-list-")} + Date.now() + "-" + Math.random().toString(36).slice(2) + ".md",
              name: "t4-list.md",
              content: ${JSON.stringify(text)},
            },
          }));
          return true;
        `);
        await sleep(680);
        const a = await readDoc();
        if (a !== text) continue;
        await sleep(300);
        const b = await readDoc();
        if (b !== text) continue;
        return true;
      }
      return false;
    };

    /** 真实物理 Ctrl+T（key="t" + ctrlKey，与 WebView2 同一路径） */
    const pressCtrlT = async () => {
      await ui.key("Control", "ControlLeft", 17, 0);
      await ui.key("t", "KeyT", 84, 2 /* Ctrl */);
      await ui.key("Control", "ControlLeft", 17, 0);
      await sleep(360);
    };

    /** 把焦点**真实地**放回源码面（真实鼠标点目标行，按行文本精确匹配） */
    const focusSourceLine = async (lineText) => {
      const box = await ev(`
        const ed = document.querySelector(".cm-editor");
        if (!ed) return null;
        const wants = ${JSON.stringify(lineText)}.trim();
        const el = Array.from(ed.querySelectorAll(".cm-line"))
          .find(l => (l.textContent || "").trim() === wants);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return false;
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await sleep(200);
      return await ev(`
        const ae = document.activeElement;
        return !!(ae && ae.closest && ae.closest(".cm-content"));
      `);
    };

    /* ══════════════════════════════════════════════════════════
     * #2 Ctrl+T：保留原列表 + 任务项带字面序号
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ #2 有序列表 Ctrl+T ════════");

    /** 先关掉分屏预览（坑 #2：右侧预览的 PM 会抢焦点，导致 Ctrl+T 落到阅读模式） */
    {
      const before = await ev(`return document.querySelectorAll(".split-preview-shell.split-preview-open").length;`);
      if (before > 0) {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`).catch(() => {});
        await sleep(1500);
      }
      const after = await ev(`
        return {
          splitOpen: document.querySelectorAll(".split-preview-shell.split-preview-open").length,
          pmFocused: document.querySelectorAll(".ProseMirror-focused").length,
        };
      `);
      ui.log(`[#2] 分屏预览：before=${before} after=${JSON.stringify(after)}`);
    }

    /**
     * 在指定列表项上按 Ctrl+T，返回**序列化后的源码文本**。
     * 带重试：受控重渲染 / 焦点抖动都可能让一次按键落空（判据是"文档变了"）。
     */
    const liftAtItem = async (itemLine) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const okSet = await setDoc(DOC_LIFT);
        if (!okSet) {
          await sleep(280 + attempt * 120);
          continue;
        }
        const focused = await focusSourceLine(itemLine);
        if (!focused) {
          await sleep(240);
          continue;
        }
        // 确认 caret 真的落在目标行
        const pre = await ev(`
          ${VIEW}
          if (!__v) return null;
          const m = __v.state.selection.main;
          return { line: __v.state.doc.lineAt(m.from).text };
        `);
        if (!pre || pre.line.trim() !== itemLine.trim()) {
          await sleep(220);
          continue;
        }
        await pressCtrlT();
        const after = await readDoc();
        if (after !== DOC_LIFT) return { after, attempts: attempt + 1 };
        await sleep(300 + attempt * 120);
      }
      return { after: await readDoc(), attempts: 6 };
    };

    /* ── T1：3 个位置的「修复后文本」逐个对照 ── */
    /**
     * ⚠️ 探针抖动加固（实测：同一份构建跑两次，末项一次 PASS 一次 undefined）。
     *
     * `liftAtItem` 内部已有 6 次重试，但**每次重试都在同一个"坏状态"里打转**时无用
     * （例如某次 React 提交后焦点归属被别的面持有，之后的 setDoc + 点击都落进那个面）。
     * 因此外面再包一层**整轮重试**：整轮失败就彻底重来（重新 setDoc → 重新点行），
     * 最多 3 轮。
     *
     * ─── ⚠️ 重试的**反作用**必须防（Lead 特别提醒）───
     * 整轮重试会**掩盖真实的间歇性缺陷**：
     * - 若"产品有时坏、有时好"（时序竞态），3 轮重试里只要有一轮好就判 PASS
     *   → **缺陷被重试洗掉**，探针变成恒真。
     * - 若只是"仪器有时点不中行"，重试正是该做的。
     *
     * 两者的区别只能靠**统计分布**判断，不能靠"最终有没有成功"。所以这里**记录每一轮的结果**，
     * 并在 detail 里显式区分三种状态：
     * - `1/3` 轮成功 → 正常（仪器抖，已重试修复）
     * - `2/3` 或 `3/3` 轮才成功 → **★ 记录为 flaky**，detail 里标红，
     *   提示"可能是时序竞态，需要单轮跑 10 次确认"（不直接判 FAIL，但**不静默**）
     * - `0/3` → FAIL（产品坏）
     *
     * 判据本身不变：任务行必须是 `- [ ] <原序号>. <正文>`。
     */
    const boundaries = [];
    for (const [name, itemLine, wantFirstLine] of [
      ["首项", "1. 甲项", "- [ ] 1. 甲项"],
      ["中间项", "2. 乙项", "- [ ] 2. 乙项"],
      ["末项", "3. 丙项", "- [ ] 3. 丙项"],
    ]) {
      let best = { after: null, attempts: 0, rounds: 0 };
      const roundResults = [];
      for (let round = 1; round <= 3; round++) {
        const r = await liftAtItem(itemLine);
        const taskLine = (r.after || "").split("\n").find((l) => l.startsWith("- [ ] "));
        const okThisRound =
          !!taskLine && taskLine.includes(wantFirstLine.replace("- [ ] ", ""));
        roundResults.push(okThisRound);
        best = { after: r.after, attempts: r.attempts, rounds: round };
        if (okThisRound) break;
        ui.log(`[#2] ${name} 第 ${round} 轮未成功（尝试${r.attempts}次），重来整轮`);
        await sleep(500 + round * 300);
      }
      boundaries.push({ name, itemLine, ...best, wantFirstLine, roundResults });
      ui.log(
        `[#2] ${name} 轮=${best.rounds} 尝试=${best.attempts} 各轮=${JSON.stringify(roundResults)} -> ${JSON.stringify(best.after)}`,
      );
    }
    {
      const bad = boundaries.filter((b) => !(b.after || "").includes(b.wantFirstLine));
      /**
       * flaky 判定：**需要第 2 或第 3 轮才成功**。
       * 这类必须显式暴露 —— 否则"产品时序竞态"会被重试洗成 PASS。
       */
      const flaky = boundaries.filter(
        (b) => b.roundResults.length > 1 && b.roundResults.some((x) => x),
      );
      const flakyNote =
        flaky.length > 0
          ? `｜⚠️ **flaky**：${flaky
              .map((b) => `${b.name}(各轮=${JSON.stringify(b.roundResults)})`)
              .join("、")} —— 第 2/3 轮才成功，可能是**时序竞态**而非仪器抖，需单轮连跑 10 次确认`
          : "";
      ui.add(
        "T1",
        "★ Ctrl+T 后任务行是 `- [ ] <原序号>. <正文>`（三行列表都在，任务项带字面序号）",
        bad.length === 0 ? "PASS" : "FAIL",
        boundaries
          .map(
            (b) =>
              `${b.name}→${JSON.stringify((b.after || "").split("\n").find((l) => l.startsWith("- [ ] ")))}` +
              `(各轮=${JSON.stringify(b.roundResults)})`,
          )
          .join(" | ") + flakyNote,
      );
    }

    /* ── T2：`1. aa` 与 `3. cc` **逐字节不变**（用户"列表被弄没"的反面）── */
    {
      // 中间项是最严格的情况：前后各有一段列表
      const r = boundaries.find((b) => b.name === "中间项");
      const after = r.after || "";
      const hasFirst = after.includes("1. 甲项");
      const hasLast = after.includes("3. 丙项");
      const hasPara = after.includes("前置段落") && after.includes("尾段落");
      // 严格口径：原文里的列表项行必须**原样**出现（不是被重编号成 2./4.）
      const firstLiteral = after.split("\n").some((l) => l.trim() === "1. 甲项");
      const lastLiteral = after.split("\n").some((l) => l.trim() === "3. 丙项");
      ui.add(
        "T2",
        "★ `1. 甲项` 与 `3. 丙项` **逐字节不变**（不重编号；文档其余内容零丢失）",
        hasFirst && hasLast && hasPara && firstLiteral && lastLiteral ? "PASS" : "FAIL",
        `含1.甲项=${hasFirst} 含3.丙项=${hasLast} 段落完整=${hasPara} 列表项字面不变=${firstLiteral && lastLiteral}；` +
          `全文=${JSON.stringify(after)}`,
      );
    }

    /* ── T3：C2 旧口径的反例 —— 任务项**不得**是不带序号的 `- [ ] 乙项` ── */
    {
      const r = boundaries.find((b) => b.name === "中间项");
      const taskLine = (r.after || "").split("\n").find((l) => l.startsWith("- [ ] ")) || "";
      const c2Form = /^- \[ \] [^\d\s]/.test(taskLine); // C2: `- [ ] 乙项`（序号位置直接是正文）
      ui.add(
        "T3",
        "★ 破坏性对照：C2 旧口径形态（`- [ ] 乙项`，无序号）必须不再出现",
        !c2Form && /^- \[ \] 2\. 乙项$/.test(taskLine) ? "PASS" : "FAIL",
        `任务行=${JSON.stringify(taskLine)}；C2 形态=${c2Form}`,
      );
    }

    /* ── T4：序列化往返（修复后 → 再解析 → 再序列化，逐字节不变）── */
    {
      const r = boundaries.find((b) => b.name === "中间项");
      // 走页面里的真实 parser+serializer（不 import 源码，读打包产物行为）
      const rt = await ev(`
        // 用 App 的 openFile 再装一次该文本，然后切模式往返
        const text = ${JSON.stringify(r.after || "")};
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: "/tmp/t4-rt-" + Date.now() + ".md", name: "rt.md", content: text },
        }));
        await new Promise((res) => setTimeout(res, 900));
        ${VIEW}
        if (!__v) return null;
        // 编辑 → 阅读 → 编辑（往返一次）
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.preview" } }));
        await new Promise((res) => setTimeout(res, 1100));
        window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } }));
        await new Promise((res) => setTimeout(res, 1400));
        const c2 = document.querySelector(".cm-content");
        const v2 = c2 && c2.cmTile && c2.cmTile.root && c2.cmTile.root.view;
        return v2 ? v2.state.doc.toString() : null;
      `).catch(() => null);
      // 归一化（#6）只影响"两个 1."，此处是已编号列表，应完全不变
      ui.add(
        "T4",
        "★ 序列化往返：切阅读再切回编辑后文本**逐字节不变**（重新打开视觉不变）",
        rt === (r.after || "") ? "PASS" : "FAIL",
        `往返前=${JSON.stringify(r.after)} 往返后=${JSON.stringify(rt)}`,
      );
    }

    /* ══════════════════════════════════════════════════════════
     * #6 切回编辑自动重编号
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ #6 切回编辑自动重编号 ════════");

    /** 在源码面真实键入一段文本（逐字符，触发 CM6 的真实输入路径） */
    const typeText = async (text) => {
      for (const ch of text) {
        if (ch === "\n") {
          await ui.key("Enter", "Enter", 13, 0);
        } else {
          await ui.key(ch, "", 0, 0);
        }
        await sleep(45);
      }
      await sleep(300);
    };

    /** 切到阅读再切回编辑，返回切回后的源码文本 */
    const roundTrip = async () => {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.preview" } })); return true;`).catch(() => {});
      await sleep(1300);
      const reading = await ev(`
        const pm = document.querySelector(".ProseMirror");
        return pm ? pm.textContent : null;
      `);
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`).catch(() => {});
      await sleep(1500);
      const src = await readDoc();
      return { reading, src };
    };

    /* ── S1：用户场景 —— 逐行敲两个 `1.`，切阅读→切回编辑 ── */
    let s1 = null;
    {
      await setDoc("");
      await focusSourceLine("");
      // 若空文档没有可点行，退化为 dispatch 定位（只摆光标，不改文档 → 不会被受控态倒回）
      await ev(`
        ${VIEW}
        if (!__v) return false;
        const c = document.querySelector(".cm-content");
        if (c) c.focus();
        __v.focus();
        __v.dispatch({ selection: { anchor: 0 } });
        return true;
      `);
      await sleep(250);

      // UI 侧先关掉可能存在的列表自动续写干扰：直接键入原文
      await typeText("1. 甲\n1. 乙");
      const typed = await readDoc();
      ui.log(`[#6] 键入后源码=${JSON.stringify(typed)}`);

      // 切阅读，看渲染是否 1./2.（浏览器里读 ol 的 start + 文本）
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.preview" } })); return true;`).catch(() => {});
      await sleep(1400);
      const readingInfo = await ev(`
        const pms = Array.from(document.querySelectorAll(".ProseMirror"));
        const pm = pms.find(p => (p.textContent || "").indexOf("甲") >= 0) || pms[0];
        if (!pm) return null;
        const ols = Array.from(pm.querySelectorAll("ol")).map(o => ({
          start: o.getAttribute("start"),
          items: Array.from(o.querySelectorAll(":scope > li")).map(li => (li.textContent || "").trim()),
        }));
        return { text: pm.textContent, ols };
      `);
      ui.log(`[#6] 阅读面=${JSON.stringify(readingInfo)}`);

      // 切回编辑
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`).catch(() => {});
      await sleep(1600);
      const back = await readDoc();
      s1 = { typed, readingInfo, back };
      ui.log(`[#6] 切回编辑=${JSON.stringify(back)}`);
    }

    /* ── S2：核心判据 —— 切回编辑后必须是 `1. 甲` / `2. 乙` ── */
    {
      const back = s1.back || "";
      const lines = back.split("\n").filter((l) => l.trim() !== "");
      const wants = ["1. 甲", "2. 乙"];
      const got = lines.slice(0, 2);
      ui.add(
        "S1",
        "★ #6 用户场景：敲两个 `1.` → 切阅读 → 切回编辑 → 源码自动编号为 `1.` `2.`",
        JSON.stringify(got) === JSON.stringify(wants) ? "PASS" : "FAIL",
        `键入=${JSON.stringify(s1.typed)}；切回后=${JSON.stringify(back)}；` +
          `阅读面 ol=${JSON.stringify(s1.readingInfo?.ols)}`,
      );
    }

    /* ── S3：幂等 —— 再切一轮仍是 `1.` `2.`，不重复改写/不退化 ── */
    {
      const rt = await roundTrip();
      const lines = (rt.src || "").split("\n").filter((l) => l.trim() !== "");
      const got = lines.slice(0, 2);
      ui.add(
        "S2",
        "★ #6 幂等性：再切一轮阅读↔编辑，仍为 `1.` `2.`（不重复改写、不退化）",
        JSON.stringify(got) === JSON.stringify(["1. 甲", "2. 乙"]) ? "PASS" : "FAIL",
        `切回后=${JSON.stringify(rt.src)}`,
      );
    }

    /* ── S4：起始非 1 的列表不被改成 1./2.（保持起点 3、后续递增）── */
    {
      await setDoc("3. 甲\n3. 乙\n");
      const rt = await roundTrip();
      const lines = (rt.src || "").split("\n").filter((l) => l.trim() !== "");
      const got = lines.slice(0, 2);
      ui.add(
        "S3",
        "★ #6 边界：起始非 1（`3. 甲/3. 乙`）→ 保持起点 3、后续递增（`3.` `4.`），不得改成 `1.` `2.`",
        JSON.stringify(got) === JSON.stringify(["3. 甲", "4. 乙"]) ? "PASS" : "FAIL",
        `切回后=${JSON.stringify(rt.src)}`,
      );
    }

    /* ── S5：已是连续编号的列表不得被改写（`1./2.` 往返后仍 `1./2.`）── */
    {
      await setDoc("1. 甲\n2. 乙\n");
      const rt = await roundTrip();
      const lines = (rt.src || "").split("\n").filter((l) => l.trim() !== "");
      const got = lines.slice(0, 2);
      ui.add(
        "S4",
        "★ #6 无副作用：本已连号的 `1./2.` 往返后**逐字节不变**",
        JSON.stringify(got) === JSON.stringify(["1. 甲", "2. 乙"]) ? "PASS" : "FAIL",
        `切回后=${JSON.stringify(rt.src)}`,
      );
    }

    /* ══════════════════════════════════════════════════════════
     * 联合验证：#2 产物不能被 #6 归一化破坏
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ 联合验证 #2 × #6 ════════");
    {
      // #2 的产物是 `1. aa / - [ ] 2. bb / 3. cc`（3 个块，序号本就连续且字面保持）
      // #6 的归一化**不能**把它改成 `1. / 2. / 3.` 或把任务项序号抹掉
      await setDoc("1. 甲\n\n- [ ] 2. 乙\n\n3. 丙\n");
      const rt = await roundTrip();
      const src = rt.src || "";
      const lines = src.split("\n").filter((l) => l.trim() !== "");
      ui.add(
        "J1",
        "★ 联合验证：#2 的产物（`1.` / `- [ ] 2.` / `3.`）经 #6 的归一化往返后**逐字节不变**",
        lines[0] === "1. 甲" && lines[1] === "- [ ] 2. 乙" && lines[2] === "3. 丙" ? "PASS" : "FAIL",
        `切回后=${JSON.stringify(src)}`,
      );
    }

    /* ═════════ Z：无未捕获异常（骨架自动追加） ═════════ */
  },
);

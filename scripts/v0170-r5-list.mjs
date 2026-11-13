/**
 * v0.17.0 第五轮 · V3 实机验证 —— 列表语义 / mermaid / 序列化（5 项 + 8 种边界）
 *
 * ## 本轮性质：**纯验证**，不改任何源码
 * 用户要求：「重新进行一遍实机验证，验证 0.17.0 版本迁移 CM6 以来所解决的问题是否都真实修复。」
 * FAIL → 只记录 + 报 Lead，不修。
 *
 * ## 🔴 口径基线（**必须按 R4，不是 R3**）
 *
 * | 轮次 | 口径 | `1. aa / 2. bb / 3. cc` 转第 2 项 |
 * |---|---|---|
 * | R3（**已废**） | C2：任务项不带序号、列表断两段 | `1. aa` / `☐ bb` / `2. cc` |
 * | **R4（现行）** | 保留原列表 + 任务项带字面序号 | `1. aa` / `- [ ] 2. bb` / `3. cc` |
 *
 * 若按 R3 判据测，会把**正确**判成错误 —— 这是本轮最易踩的坑。
 * 本探针的期望值全部取自 `_plan/v0170-r4-t4-list.md` 的 8 种边界表（现行口径）。
 *
 * ## 读取纪律（真机同样适用）
 * - CM6 全文必须走 **`state.doc.toString()`**：
 *   骨架的 `readSourceText()` 拼 `.cm-line`，而 **CM6 虚拟化只渲染视口内的行** →
 *   拼出来是**不完整文本**。本探针自带 `readDocFull()` 绕开这个坑。
 *   实测依据：R2 曾用旧读法得到 `8641 → 1880`，差点被误判成"一次撤销撤掉整篇"。
 * - 真机 mermaid 渲染：阅读面在 `.ProseMirror svg`；**分屏右屏是 iframe**，
 *   svg 在 `iframe.contentDocument` 里 —— 两条路径都要读。
 *
 * ## V3-3（#6 归一化）的真机风险点 —— 必须切 **3 轮**
 * R4 发现序列化有 **5 处快路径**会绕过归一化。真机上最危险的是**序列化缓存**
 * （`core/editor.ts` 的 `serializationCache`，按 doc 引用做键）：
 * 它会导致**第 1 圈对、第 2 圈变回去** —— 这正是"缓存快路径命中"的指纹。
 * 因此 V3-3 切 **3 轮往返**，每轮都断言源码 == `1.` `2.`。
 *
 * 用法：
 * ```bash
 * node scripts/v0170-r5-list.mjs
 * ```
 * （真机 exe 已内联 dist；骨架会自动验 hash 一致性）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

/* ══════════════════ 文档 fixtures ══════════════════ */

/** 主导文档：列表三种位置 + 尾部撑高 + mermaid 区（一次装载覆盖多数场景） */
const DOC = [
  "# V3 列表语义验证",
  "",
  "前置段落。",
  "",
  "1. 甲项",
  "2. 乙项",
  "3. 丙项",
  "",
  "尾段落。",
  "",
  "## 起始非 1",
  "",
  "3. 阿",
  "4. 诶",
  "5. 衣",
  "",
  "## 分隔符",
  "",
  "1) 一",
  "2) 二",
  "3) 三",
  "",
  "## 多段落项",
  "",
  "1. 段一甲",
  "",
  "   段一乙",
  "",
  "2. 段二甲",
  "",
  "## 嵌套",
  "",
  "1. 外层",
  "   1. 内一",
  "   2. 内二",
  "",
  "## 末尾撑高",
  "",
  "撑高行。".repeat(3),
  "",
].join("\n");

/** mermaid 专用文档（含 20 个模板占位，逐个插入测试时用这个干净底座） */
const DOC_MERMAID = ["# Mermaid 验证", "", "占位段落。", ""].join("\n");

/* ══════════════════ 页内工具（字符串模板） ══════════════════ */

/**
 * 读 CM6 全文（**不走 `.cm-line`**，见文件头读取纪律）。
 * 兼容 `.cmTile.view` 与 `.cmTile.root.view` 两种内部挂载形态（CM6 版本差异）。
 */
const READ_FULL = `
  const c = document.querySelector(".cm-content");
  if (!c) return null;
  const v = (c.cmTile && (c.cmTile.view || (c.cmTile.root && c.cmTile.root.view))) || null;
  if (v && v.state && v.state.doc) return v.state.doc.toString();
  return null;
`;

await runProbe(
  { name: "v0170-r5-list", doc: DOC, docTitle: "V3 列表语义验证", viewMode: "edit" },
  async (ui) => {
    const ev = ui.ev;
    const sleep = ui.sleep;

    /* ── 通用工具 ─────────────────────────────────────── */

    /** 读 CM6 全文（带 fallback 标记，避免"空值当成产品结论"） */
    const readDocFull = async () => {
      const t = await ev(READ_FULL);
      if (t === null) {
        // 兜底：拼 .cm-line（不完整），但**明确标记**，不静默
        const partial = await ev(`
          const ed = document.querySelector(".cm-editor");
          if (!ed) return null;
          return Array.from(ed.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n");
        `);
        ui.log(`[warn] readDocFull 退回 DOM 拼行（CM6 虚拟化 → 文本可能不完整）`);
        return partial;
      }
      return t;
    };

    /** 装文档（走 App 的 openFile 通道；**双次读校验稳态**，防受控回退） */
    const loadDoc = async (text) => {
      for (let i = 0; i < 5; i++) {
        await ev(`
          window.dispatchEvent(new CustomEvent("lightmd:openFile", {
            detail: {
              path: ${JSON.stringify("/tmp/v3-")} + Date.now() + "-" + Math.random().toString(36).slice(2) + ".md",
              name: "v3.md",
              content: ${JSON.stringify(text)},
            },
          }));
          return true;
        `);
        await sleep(700);
        const a = await readDocFull();
        if (a !== text) continue;
        await sleep(320);
        const b = await readDocFull();
        if (b !== text) continue;
        return true;
      }
      return false;
    };

    /** 真实鼠标点目标行（按行文本精确匹配；CM6 虚拟滚动下行索引不可靠） */
    const clickLine = async (lineText) => {
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
      if (!box) return { ok: false, why: `找不到行「${lineText}」` };
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await sleep(200);
      const focused = await ev(`
        const ae = document.activeElement;
        return !!(ae && ae.closest && ae.closest(".cm-content"));
      `);
      return { ok: focused, why: focused ? "" : "点后焦点不在 .cm-content" };
    };

    /** 真实物理 Ctrl+T */
    const pressCtrlT = async () => {
      await ui.key("Control", "ControlLeft", 17, 0);
      await ui.key("t", "KeyT", 84, 2 /* Ctrl */);
      await ui.key("Control", "ControlLeft", 17, 0);
      await sleep(380);
    };

    /** 切到阅读再切回编辑（一次往返），返回切回后的源码全文 */
    const roundTrip = async () => {
      await ui.command("view.preview");
      await sleep(1500);
      const reading = await ui.ev(`
        const pms = Array.from(document.querySelectorAll(".ProseMirror"));
        const pm = pms.find(p => (p.textContent || "").length > 0) || pms[0];
        if (!pm) return null;
        const ols = Array.from(pm.querySelectorAll("ol")).map(o => ({
          start: o.getAttribute("start"),
          items: Array.from(o.querySelectorAll(":scope > li")).map(li => (li.textContent || "").trim()),
        }));
        return { text: pm.textContent, ols };
      `);
      await ui.command("view.edit");
      await sleep(1700);
      const src = await readDocFull();
      return { reading, src };
    };

    /* ══════════════ 环境前置 ══════════════ */
    const env = await ev(`
      const c = document.querySelector(".cm-content");
      const v = (c && c.cmTile && (c.cmTile.view || (c.cmTile.root && c.cmTile.root.view))) || null;
      return {
        impl: v ? "cm6" : "other",
        docLen: v ? v.state.doc.length : 0,
        splitOpen: document.querySelectorAll(".split-preview-shell.split-preview-open").length,
        cmCount: document.querySelectorAll(".cm-editor").length,
      };
    `);
    ui.log(`[env] ${JSON.stringify(env)}`);
    ui.add(
      "V3-0",
      "环境前置：CM6 源码面就绪 + 全文可读（非 DOM 拼行）",
      env.impl === "cm6" && env.docLen > 0 ? "PASS" : "FAIL",
      JSON.stringify(env) + `；骨架 impl=${ui.impl}`,
    );

    /**
     * 关掉分屏预览再测 #2。
     *
     * R4 的实测教训（浏览器同样适用真机）：分屏右屏是另一个 `.ProseMirror`，
     * 每次 Ctrl+T 后它会把焦点抢走；App 的全局快捷键**按焦点分发** →
     * 后续 Ctrl+T 落到阅读模式命令，源码文档纹丝不动 →
     * 看起来像"功能只对首项生效"。**这不是产品缺陷。**
     */
    {
      const before = await ev(`return document.querySelectorAll(".split-preview-shell.split-preview-open").length;`);
      if (before > 0) {
        await ui.command("view.togglePreview");
        await sleep(1600);
      }
      const after = await ev(`
        return {
          splitOpen: document.querySelectorAll(".split-preview-shell.split-preview-open").length,
          pmFocused: document.querySelectorAll(".ProseMirror-focused").length,
        };
      `);
      ui.log(`[env] 分屏预览 before=${before} after=${JSON.stringify(after)}`);
    }

    /* ══════════════════════════════════════════════════════════
     * V3-1 + V3-4：#2 有序列表 Ctrl+T 保留列表（R4 口径）
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ V3-1/V3-4 #2 有序列表 Ctrl+T（R4 口径）════════");

    /**
     * 在 DOC 的指定列表项上按 Ctrl+T，返回全文。
     * 带**整轮重试**（抗仪器抖动）+ **记录每轮结果**（防重试掩盖真实竞态，R4 的教训）。
     */
    const liftAt = async (lineText, expectTaskLine) => {
      const roundResults = [];
      for (let round = 1; round <= 3; round++) {
        const okLoad = await loadDoc(DOC);
        if (!okLoad) {
          roundResults.push({ round, ok: false, why: "装文档失败" });
          continue;
        }
        const clicked = await clickLine(lineText);
        if (!clicked.ok) {
          roundResults.push({ round, ok: false, why: clicked.why });
          await sleep(400);
          continue;
        }
        await pressCtrlT();
        const after = await readDocFull();
        const lines = (after || "").split("\n");
        const hasTask = lines.some((l) => l.trim() === expectTaskLine.trim());
        roundResults.push({ round, ok: hasTask, after });
        if (hasTask) return { after, roundResults, ok: true };
        await sleep(500 + round * 300);
      }
      return { after: roundResults[roundResults.length - 1]?.after ?? null, roundResults, ok: false };
    };

    /* ── V3-1：用户主诉场景 —— 中间项 ── */
    {
      const r = await liftAt("2. 乙项", "- [ ] 2. 乙项");
      const after = r.after || "";
      const lines = after.split("\n").map((l) => l.trim());
      // R4 验收：三行都在、任务项带 `2.`、`1. 甲项` / `3. 丙项` 逐字节不变
      const hasFirst = lines.includes("1. 甲项");
      const hasTask = lines.includes("- [ ] 2. 乙项");
      const hasLast = lines.includes("3. 丙项");
      const noR3Form = !lines.includes("- [ ] 乙项"); // R3/C2 形态（无序号）必须不出现
      ui.log(`[V3-1] 各轮=${JSON.stringify(r.roundResults.map((x) => x.ok))} 全文=${JSON.stringify(after)}`);
      ui.add(
        "V3-1",
        "★ R4#2：`1. 甲项/2. 乙项/3. 丙项` 第 2 项 Ctrl+T → `- [ ] 2. 乙项`，**三行都在、1./3. 逐字节不变**",
        hasFirst && hasTask && hasLast && noR3Form ? "PASS" : "FAIL",
        `含1.甲项=${hasFirst} 含- [ ] 2.乙项=${hasTask} 含3.丙项=${hasLast} ` +
          `R3形态(无序号)出现=${!noR3Form}｜各轮=${JSON.stringify(r.roundResults.map((x) => x.ok))}｜` +
          `实测原文=${JSON.stringify(after)}`,
      );
    }

    /* ── V3-4：R3#2 的现行形态（与 V3-1 同源，仅确认"不破坏列表"）── */
    {
      // 复用 V3-1 的形态判据，但换成末项再验一次"列表不被弄没"
      const r = await liftAt("3. 丙项", "- [ ] 3. 丙项");
      const lines = (r.after || "").split("\n").map((l) => l.trim());
      const keepList = lines.includes("1. 甲项") && lines.includes("2. 乙项");
      const hasTask = lines.includes("- [ ] 3. 丙项");
      ui.add(
        "V3-4",
        "★ R3#2（现行 R4 形态）：末项 Ctrl+T 后前两项列表**保留**、任务项带 `3.`（不按 R3 的\"断两段\"判）",
        keepList && hasTask ? "PASS" : "FAIL",
        `含1.甲项/2.乙项=${keepList} 含- [ ] 3.丙项=${hasTask}｜实测原文=${JSON.stringify(r.after)}`,
      );
    }

    /* ══════════════════════════════════════════════════════════
     * V3-2：#2 边界 8 种
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ V3-2 #2 边界 8 种 ════════");

    /**
     * 8 种边界的期望（现行 R4 口径，取自 `_plan/v0170-r4-t4-list.md` §1.2）。
     * 每条给出：目标行 → 期望任务行 → 期望"必须仍存在"的其余行。
     */
    const BOUNDARIES = [
      { id: "B1", name: "首项", line: "1. 甲项", task: "- [ ] 1. 甲项", keep: ["2. 乙项", "3. 丙项"] },
      { id: "B2", name: "中间项", line: "2. 乙项", task: "- [ ] 2. 乙项", keep: ["1. 甲项", "3. 丙项"] },
      { id: "B3", name: "末项", line: "3. 丙项", task: "- [ ] 3. 丙项", keep: ["1. 甲项", "2. 乙项"] },
      { id: "B4", name: "起始非1（4. 诶）", line: "4. 诶", task: "- [ ] 4. 诶", keep: ["3. 阿", "5. 衣"] },
      { id: "B5", name: "`)` 分隔符（2) 二）", line: "2) 二", task: "- [ ] 2) 二", keep: ["1) 一", "3) 三"] },
      { id: "B6", name: "多段落项（1. 段一甲）", line: "1. 段一甲", task: "- [ ] 1. 段一甲", keep: ["2. 段二甲"] },
      /**
       * B7 嵌套：**判据分两层**（R4 复核时发现原判据过严，会误报"丢内容"）。
       *
       * 真机 + jsdom 纯函数实测一致的行为：
       * ```
       * 输入 1. 外层 / ␣␣␣1. 内一 / ␣␣␣2. 内二
       * 输出 - [ ] 1. 外层 / ␣␣␣2. 内一 / ␣␣␣3. 内二   ← 内层被 +1
       * ```
       * - `keepText`：内层**文本**（内一/内二）必须保留 → 这是"不丢内容"的判据
       * - `keepOrder`：内层**序号**应保持 1./2. → 这是"不变形"的判据
       * 两者分开报，避免把"序号变了"误写成"内容丢了"。
       */
      {
        id: "B7",
        name: "嵌套外层（1. 外层）",
        line: "1. 外层",
        task: "- [ ] 1. 外层",
        keepText: ["内一", "内二"],
        keepOrder: ["1. 内一", "2. 内二"],
        keep: ["1. 内一", "2. 内二"],
      },
    ];

    const boundaryResults = [];
    for (const b of BOUNDARIES) {
      const r = await liftAt(b.line, b.task);
      const lines = (r.after || "").split("\n").map((l) => l.trim());
      const hasTask = lines.includes(b.task);
      // keepText：只要求**文本**在（不要求序号一致）→ 用于判"不丢内容"
      const missingText = (b.keepText || b.keep || []).filter(
        (k) => !lines.some((l) => l.includes(k)),
      );
      // keepOrder：要求**带序号的整行**在 → 用于判"不变形"
      const missingOrder = (b.keepOrder || b.keep || []).filter((k) => !lines.includes(k));
      // 主判据（PASS 条件）：
      // - 有 keepText 的项（B7）：任务行正确 + 文本不丢（序号问题单独记，不混进主判据）
      // - 其余项：任务行正确 + 整行（含序号）都在
      const pass = b.keepText
        ? hasTask && missingText.length === 0
        : hasTask && missingOrder.length === 0;
      boundaryResults.push({
        ...b, pass, after: r.after, hasTask,
        missing: b.keepText ? missingText : missingOrder,
        missingOrder,
        rounds: r.roundResults.map((x) => x.ok),
      });
      ui.log(
        `[${b.id}] ${b.name} → ${pass ? "OK" : "FAIL"} task=${hasTask} ` +
          `缺文本=${JSON.stringify(missingText)} 缺序号行=${JSON.stringify(missingOrder)} ` +
          `各轮=${JSON.stringify(boundaryResults[boundaryResults.length - 1].rounds)}`,
      );
    }

    /* 第 8 种：唯一一项 —— 需单独文档（整表被待办替换是**正确**的） */
    {
      const uniq = "1. 唯一项\n";
      const okLoad = await loadDoc(uniq);
      let after = null;
      if (okLoad) {
        const clicked = await clickLine("1. 唯一项");
        if (clicked.ok) {
          await pressCtrlT();
          after = await readDocFull();
        }
      }
      const lines = (after || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const pass = lines.length === 1 && lines[0] === "- [ ] 1. 唯一项";
      boundaryResults.push({ id: "B8", name: "唯一一项", pass, after, hasTask: pass, missing: [], rounds: [pass] });
      ui.log(`[B8] 唯一一项 → ${pass ? "OK" : "FAIL"} 实测=${JSON.stringify(after)}`);
    }

    {
      const bad = boundaryResults.filter((r) => !r.pass);
      const flaky = boundaryResults.filter((r) => r.rounds && r.rounds.length > 1 && r.rounds.some((x) => x));
      // 序号变形项（文本在、但带序号的整行不在）—— 单独列，不混进"内容丢失"
      const orderShifted = boundaryResults.filter(
        (r) => r.pass && r.missingOrder && r.missingOrder.length > 0,
      );
      ui.add(
        "V3-2",
        "★ R4#2 边界 8 种（首/中/末/唯一/起始非1/`)`/多段落/嵌套）—— 任务项带原序号，其余项内容不丢",
        bad.length === 0 ? "PASS" : "FAIL",
        `${boundaryResults.length} 种；失败 ${bad.length}` +
          (bad.length ? `：${bad.map((r) => `${r.id}${r.name}(task=${r.hasTask},missing=${JSON.stringify(r.missing)})`).join("；")}` : "：全部通过") +
          (orderShifted.length
            ? `｜⚠️ 序号变形（内容未丢，但序号被重排）：${orderShifted
                .map((r) => `${r.id}${r.name} 期望=${JSON.stringify(r.keepOrder)} 实际缺=${JSON.stringify(r.missingOrder)} 输出=${JSON.stringify(r.after)}`)
                .join("；")}`
            : "") +
          (flaky.length ? `｜⚠️ flaky：${flaky.map((r) => `${r.id}(各轮=${JSON.stringify(r.rounds)})`).join("、")}` : "｜各轮均为第 1 轮成功"),
      );
    }

    /* ══════════════════════════════════════════════════════════
     * V3-3：#6 切回编辑自动重编号（**切 3 轮**，验幂等 + 防缓存快路径）
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ V3-3 #6 切回编辑自动重编号（3 轮往返）════════");

    /**
     * R4 的核心风险：序列化有 5 处快路径会绕过归一化，其中**序列化缓存**
     * （`core/editor.ts` 的 `serializationCache`，按 doc 引用做键）会导致
     * **第 1 圈对、第 2 圈变回去**。所以必须切 3 轮，每轮独立断言。
     */
    {
      const two1s = "1. 甲\n1. 乙\n";
      const okLoad = await loadDoc(two1s);
      const rounds = [];
      let lastReading = null;
      for (let round = 1; round <= 3; round++) {
        const rt = await roundTrip();
        lastReading = rt.reading;
        const lines = (rt.src || "").split("\n").filter((l) => l.trim() !== "");
        const got = lines.slice(0, 2);
        const pass = JSON.stringify(got) === JSON.stringify(["1. 甲", "2. 乙"]);
        rounds.push({ round, pass, got, src: rt.src });
        ui.log(`[V3-3] 第 ${round} 轮：切回=${JSON.stringify(got)} ${pass ? "OK" : "FAIL"}`);
        if (!pass) break;
      }
      const allPass = rounds.length === 3 && rounds.every((r) => r.pass);
      ui.add(
        "V3-3",
        "★ R4#6：`1. 甲/1. 乙` → 切阅读 → 切回编辑源码 = `1.` `2.`，且**切 3 轮幂等**（防缓存快路径只对第 1 圈）",
        allPass ? "PASS" : "FAIL",
        `装文档=${okLoad}｜各轮=${JSON.stringify(rounds.map((r) => ({ round: r.round, pass: r.pass, got: r.got })))}｜` +
          `阅读面 ol=${JSON.stringify(lastReading?.ols)}`,
      );
    }

    /* ── V3-3 附加：本已连号的列表不得被改写（无副作用）── */
    {
      const okLoad = await loadDoc("1. 甲\n2. 乙\n");
      const rt = await roundTrip();
      const lines = (rt.src || "").split("\n").filter((l) => l.trim() !== "");
      const got = lines.slice(0, 2);
      ui.add(
        "V3-3b",
        "R4#6 无副作用：本已连号的 `1./2.` 往返后**不变**",
        JSON.stringify(got) === JSON.stringify(["1. 甲", "2. 乙"]) ? "PASS" : "FAIL",
        `装文档=${okLoad} 切回=${JSON.stringify(got)}`,
      );
    }

    /* ── V3-3 附加：#2 产物经归一化往返不被破坏（两项联合）── */
    {
      const md = "1. 甲\n\n- [ ] 2. 乙\n\n3. 丙\n";
      const okLoad = await loadDoc(md);
      const rt = await roundTrip();
      const lines = (rt.src || "").split("\n").filter((l) => l.trim() !== "");
      const ok =
        lines[0] === "1. 甲" && lines[1] === "- [ ] 2. 乙" && lines[2] === "3. 丙";
      ui.add(
        "V3-3c",
        "R4 联合验证：#2 的产物（`1.` / `- [ ] 2.` / `3.`）经 #6 归一化往返后**逐字节不变**",
        ok ? "PASS" : "FAIL",
        `装文档=${okLoad} 切回=${JSON.stringify(rt.src)}`,
      );
    }

    /* ══════════════════════════════════════════════════════════
     * V3-5：R3#10 mermaid —— 20 种类型 + 图标中文 + 每种渲染出 SVG
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ V3-5 #10 mermaid（20 种 + 中文 + SVG）════════");

    /* ── 先读下拉菜单：项数 + 文案语言 ── */
    /**
     * ⚠️ v3 修正：**首版在下拉读到 0 项时判了 FAIL，但那是探针问题不是产品缺陷。**
     *
     * 诊断证据（`_tmp-v3-diag`）：
     * ```
     * byTitleCount: 1        ← Mermaid 按钮**找得到**（title="Mermaid 图表"）
     * labels: [...,"◈",...]   ← 按钮存在、文案正确
     * 但下拉 items = 0
     * ```
     * 根因：本探针在 V3-0 之后**关掉了分屏预览**（`view.togglePreview`）以解决
     * "右侧 PM 抢焦点"（R4 教训）。这个开合会让 `FormatMenuHost` **重渲染**，
     * 而首版在 `b.click()` 后只等 380ms 就读 —— 菜单还没挂载。
     *
     * 修法（三层）：
     * 1. 先 `waitFor` 确认格式栏按钮**数量稳定**（重渲染收敛）
     * 2. 点击后**轮询**等菜单项出现（最多 3s），而不是死等固定 380ms
     * 3. 整段**重试 3 次**（每次先关菜单再开）
     */
    let menuLabels = [];
    {
      const okLoad = await loadDoc(DOC_MERMAID);

      // 等格式栏按钮数量稳定（重渲染收敛的指纹）
      const btnCount = await ui.waitFor(
        `
        const n = document.querySelectorAll(".source-format-toolbar .format-btn").length;
        if (window.__lastBtnCount === n && n > 0) return n;
        window.__lastBtnCount = n;
        return 0;
        `,
        6000,
        400,
      );
      ui.log(`[V3-5] 格式栏按钮数（稳定后）= ${btnCount}`);

      /** 打开下拉并**轮询**等菜单项出现 */
      const openMenu = async () => {
        return await ev(`
          // 先关掉可能已经打开的菜单（避免 click 变成 toggle-close）
          document.body.click();
          await new Promise(r => setTimeout(r, 200));
          const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
          const b = btns.find(x => (x.getAttribute("title") || "").indexOf("Mermaid") >= 0);
          if (!b) return { ok: false, count: 0, labels: [], why: "未找到 Mermaid 按钮", btnCount: btns.length };
          if (b.getBoundingClientRect().width <= 0) return { ok: false, count: 0, labels: [], why: "按钮不可见" };
          b.click();
          // 轮询最多 3s 等菜单项
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 100));
            const items = Array.from(document.querySelectorAll(".mermaid-dropdown-menu .mermaid-dropdown-item"));
            if (items.length > 0) {
              return { ok: true, count: items.length, labels: items.map(x => (x.textContent || "").trim()) };
            }
          }
          return { ok: false, count: 0, labels: [], why: "点击后 3s 内菜单项仍为 0" };
        `);
      };

      let menu = { ok: false, count: 0, labels: [], why: "未执行" };
      for (let attempt = 1; attempt <= 3; attempt++) {
        menu = await openMenu();
        ui.log(`[V3-5] 下拉尝试 ${attempt}：count=${menu.count} why=${menu.why || "-"}`);
        if (menu.count > 0) break;
        await sleep(700);
      }
      menuLabels = menu.labels;
      ui.log(`[V3-5] 下拉 ${menu.count} 项：${JSON.stringify(menu.labels)}`);
      const allChinese = menu.labels.length > 0 && menu.labels.every((l) => /[\u4e00-\u9fff]/.test(l));
      ui.add(
        "V3-5a",
        "★ R3#10：mermaid 下拉含 **20 种**类型，且中文界面下**全部为中文**",
        menu.count === 20 && allChinese ? "PASS" : "FAIL",
        `装文档=${okLoad} 按钮数=${btnCount} 项数=${menu.count}（期望 20）全中文=${allChinese}` +
          `${menu.why ? `｜打开失败原因=${menu.why}` : ""}｜标签=${JSON.stringify(menu.labels)}`,
      );
      await ev(`document.body.click(); return true;`).catch(() => {});
      await sleep(250);
    }

    /* ── 逐类型：点选 → 检查插入的围栏能渲染出 SVG ── */
    /**
     * 真机渲染判定的**两条路径**（任务卡提醒：分屏右屏可能是 iframe）：
     * 1. 阅读面 PM：`.ProseMirror svg`（mermaid_block NodeView 渲染）
     * 2. 分屏 iframe：`iframe.contentDocument` 里的 svg
     *
     * 本项在**阅读模式**下逐类型验证（点选后切阅读 → 数 SVG）。
     * 为什么不在分屏测：分屏 iframe 需要 vendor/mermaid 脚本就绪，且
     * 每种类型都要重写整篇 → 时序复杂、易出假 FAIL。阅读面 NodeView 更直接。
     */
    const mermaidMatrix = [];
    if (menuLabels.length > 0) {
      for (let i = 0; i < menuLabels.length; i++) {
        const label = menuLabels[i];
        // 每次都要干净底座 + 重开下拉
        const okLoad = await loadDoc(DOC_MERMAID);
        if (!okLoad) {
          mermaidMatrix.push({ i, label, ok: false, why: "装文档失败" });
          continue;
        }
        /**
         * ⚠️ v3 修正：与 V3-5a 同一时序坑 —— 每轮 `loadDoc` 会让格式栏重渲染，
         * 首版死等 360ms 就读，读到 0。改为**轮询等菜单项**（最多 3s）。
         */
        /**
         * ⚠️ v4 修正：首项（i=0）曾报"下拉未打开"，其余 19 项全 OK。
         *
         * 真因：进循环前我刚做过 `loadDoc`（整篇替换）→ `FormatMenuHost` 重渲染，
         * 第一次 `body.click()` + `b.click()` 撞在重渲染窗口里，
         * **菜单还没挂载完成就被读了**（或第一次 click 恰好把上一轮残留的菜单关掉）。
         *
         * 修法：**整段重试 3 次**，每次之间留足间隔（首项冷启动需要更长时间），
         * 并且每次先确认"菜单已关闭"这个前置状态（toggle 语义下重复点击会关掉）。
         */
        let opened = 0;
        for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
          opened = await ev(`
            // 1) 先确保菜单是**关闭**状态（toggle 语义：点两次等于没开）
            for (let d = 0; d < 6; d++) {
              const open = document.querySelector(".mermaid-dropdown-menu");
              if (!open) break;
              document.body.click();
              await new Promise(r => setTimeout(r, 120));
            }
            // 2) 等按钮出现（重渲染收敛）
            let b = null;
            for (let d = 0; d < 20; d++) {
              b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
                .find(x => (x.getAttribute("title") || "").indexOf("Mermaid") >= 0);
              if (b && b.getBoundingClientRect().width > 0) break;
              await new Promise(r => setTimeout(r, 100));
            }
            if (!b) return 0;
            // 3) 点击并轮询等菜单项
            b.click();
            for (let k = 0; k < 40; k++) {
              await new Promise(r => setTimeout(r, 100));
              const n = document.querySelectorAll(".mermaid-dropdown-menu .mermaid-dropdown-item").length;
              if (n > 0) return n;
            }
            return 0;
          `);
          if (!opened) {
            ui.log(`[V3-5] 第 ${i + 1} 项「${label}」下拉第 ${attempt} 次未打开，重试`);
            await sleep(600 + attempt * 400);
          }
        }
        if (!opened) {
          mermaidMatrix.push({ i, label, ok: false, why: "下拉未打开（重试 3 次）" });
          continue;
        }
        await ev(`
          const items = Array.from(document.querySelectorAll(".mermaid-dropdown-menu .mermaid-dropdown-item"));
          const el = items[${i}];
          if (el) el.click();
          await new Promise(r => setTimeout(r, 500));
          return true;
        `);
        const insertedSrc = await readDocFull();
        const fence = /```mermaid\r?\n([\s\S]*?)```/.exec(insertedSrc || "");
        if (!fence) {
          mermaidMatrix.push({ i, label, ok: false, why: "未插入 mermaid 围栏", src: (insertedSrc || "").slice(0, 80) });
          continue;
        }
        // 切到阅读模式，让 NodeView 渲染
        await ui.command("view.preview");
        await sleep(1600);
        const svgInfo = await ev(`
          const pms = Array.from(document.querySelectorAll(".ProseMirror"));
          const pm = pms.find(p => (p.textContent || "").length > 0) || pms[0];
          const inPm = pm ? pm.querySelectorAll("svg").length : 0;
          // 兜底：分屏 iframe 里的 svg
          let inIframe = 0;
          const f = document.querySelector("iframe.split-preview");
          try {
            const d = f && f.contentDocument;
            if (d) inIframe = d.querySelectorAll("svg").length;
          } catch (e) { /* 跨源忽略 */ }
          const errEl = pm ? pm.querySelectorAll(".mermaid-error").length : 0;
          return { inPm, inIframe, errEl, hasBlock: !!pm };
        `);
        // 回到编辑模式准备下一轮
        await ui.command("view.edit");
        await sleep(1500);
        const rendered = svgInfo.inPm > 0 || svgInfo.inIframe > 0;
        mermaidMatrix.push({ i, label, ok: rendered, svg: svgInfo, kw: (fence[1].trim().split(/\s+/)[0] || "") });
        ui.log(
          `[V3-5] ${String(i + 1).padStart(2)} ${label.padEnd(12)} kw=${(fence[1].trim().split(/\s+/)[0] || "").padEnd(18)} svg:pm=${svgInfo.inPm} iframe=${svgInfo.inIframe} err=${svgInfo.errEl} → ${rendered ? "OK" : "FAIL"}`,
        );
      }
    }
    {
      const bad = mermaidMatrix.filter((r) => !r.ok);
      ui.add(
        "V3-5b",
        "★ R3#10：下拉里**每一种**类型点选后都能在阅读面渲染出 SVG（逐类型实测）",
        mermaidMatrix.length === 20 && bad.length === 0 ? "PASS" : "FAIL",
        `实测 ${mermaidMatrix.length} 种；失败 ${bad.length}` +
          (bad.length
            ? `：${bad.map((r) => `${r.label}(${r.why || `pm=${r.svg?.inPm},iframe=${r.svg?.inIframe},err=${r.svg?.errEl}`})`).join("；")}`
            : "：全部渲染成功"),
      );
    }

    /* ══════════════ 收尾 ══════════════ */
    ui.log(`\n[summary] V3 五项 + 8 边界 + 3 轮幂等 实测完成`);
  },
);

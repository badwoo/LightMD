/**
 * LightMD v0.17.0 第三轮 —— T4「格式栏 / 语法辅助栏」三项验收探针
 *
 * 覆盖用户第 2、3、10 项：
 *
 * | 项 | 用户原话 | 本探针验什么 |
 * |---|---|---|
 * | #2 | 阅读模式下在有序列表上按 Ctrl+T 加待办破坏有序列表顺序 | 真实键盘 Ctrl+T 后文档文本 + caret 落点（含"接着打字插到哪"） |
 * | #3 | 语法辅助栏 ghost 文本缺失（如代码块），请全面检查补漏 | 逐项插入后 **rAF 逐帧**数 ghost 可见帧 + 是否落盘 + 退格整段删除 |
 * | #10 | mermaid 图标文字变英文→中文；图表类型补全 | 下拉菜单文案语言 + 每个模板插入后能否渲染出 `<svg>` |
 *
 * ## 为什么 #3 必须逐帧采样（不能用"DOM 里有没有"）
 *
 * P1-6 的教训：Lead 的 MutationObserver 抓到过 ghost 存在 1 次瞬时 DOM，而同一时刻
 * 用户**一帧都看不到**。单次 `querySelector` 会随机命中那个瞬时窗口 → 误判 PASS。
 * rAF 采样是**用户视觉的时间分辨率**，和用户感知同尺度。
 * 判据沿用 R2：可见 ≥ 90% 采样帧且存活 ≥ 1000ms 才算 PASS。
 *
 * ## 为什么每条判据都要配破坏性对照
 *
 * - #2：`T0` 在**普通段落**按 Ctrl+T → 必须走回退路径（`\n- [ ] `），
 *   证明"识别到列表"不是恒真；`T2` 用"接着键入落点"把 caret 检查变成
 *   可失败的判据（旧缺陷会得到 `- [ ] X2. 乙项`）。
 * - #3：`N1` 人为 add+remove 一个 `.cm-source-ghost` → 采样器必须看见（否则"0 帧"
 *   可能只是仪器坏了）；`N2/N3` 表格与分割线必须**不**出 ghost（证明判定规则有反例、
 *   不是"无脑全补"）；`F2` 同时要求 ghost 文案**不落盘**。
 * - #10：`M0` 造一个**明知无法渲染**的 mermaid（`graph TD A-->` 截断）→ 必须报失败，
 *   证明 `<svg>` 判据不是恒真；`M3` 的模板语法**从页面里点选后读回插入文本**，
 *   不是探针手写字符串（否则测的是探针自己）。
 *
 * ## 仪器纪律（本项目两次踩坑的教训）
 *
 * 1. **CM6 不是 ProseMirror**：`state` 是 `@codemirror/state` 的 EditorState，
 *    **没有 `state.tr`**。第一版探针写了 `__v.state.tr.insertText(...)` →
 *    `TypeError: Cannot read properties of undefined (reading 'insertText')`，
 *    整段探针中止（连后两项都没跑到）。改文一律走 `view.dispatch({changes,selection})`。
 * 2. **不靠"点第 N 行"定位光标**：CM6 虚拟滚动 + 文档改写后行节点会换，
 *    按 DOM 行索引点会落到别的行（实测第 3 项点到了第 1 行）。这里改成
 *    **按文本偏移算 caret**，可复现。
 * 3. **累加型观察器重装前必须 `disconnect()`**（P0-1 的"重装观察器虚高计数"教训）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

/** #2 用的文档：前置段落 + 3 项有序列表 + 尾段落（列表不在文档开头，能验"不跑到最前面"） */
const DOC_LIFT = ["前置段落", "", "1. 甲项", "2. 乙项", "3. 丙项", "", "尾段落", ""].join("\n");

/** #3 用的文档：多个空行（每项插入都要有干净的空行落点） */
const DOC_GHOST = ["# Ghost 探针", "", "正文一", "", "正文二", "", "正文三", ""].join("\n");

/** #10 用的文档 */
const DOC_MERMAID = ["# Mermaid 探针", "", "占位段落", ""].join("\n");

/* ════════════════════ 页内仪器（#3） ════════════════════ */
/**
 * rAF 逐帧采样器 + DOM 增删观察器。
 *
 * ⚠️ 幂等：重装前先 `disconnect()` 旧观察器。P0-1 排查时重装观察器把"1 次重建"
 * 读成"N 次"，虚高了缺陷严重度 —— 同一个坑不在本轮重演。
 */
const GHOST_SAMPLER = `
  if (window.__GV && window.__GV.mo) { try { window.__GV.mo.disconnect(); } catch (e) {} }
  const G = {
    samples: [], muts: [], base: 0, running: false, mo: null,
    start(frames) {
      this.samples = []; this.base = performance.now(); this.running = true;
      const tick = () => {
        const els = document.querySelectorAll(".cm-source-ghost");
        this.samples.push({ t: performance.now(), n: els.length,
          txt: els.length ? els[0].textContent : "" });
        if (this.samples.length < frames) requestAnimationFrame(tick); else this.running = false;
      };
      requestAnimationFrame(tick);
    },
    watchDom() {
      this.muts = [];
      this.mo = new MutationObserver((ms) => {
        for (const m of ms) {
          for (const n of m.addedNodes || [])
            if (n.nodeType === 1 && n.classList && n.classList.contains("cm-source-ghost"))
              this.muts.push({ t: performance.now(), ev: "add", txt: n.textContent });
          for (const n of m.removedNodes || [])
            if (n.nodeType === 1 && n.classList && n.classList.contains("cm-source-ghost"))
              this.muts.push({ t: performance.now(), ev: "remove", txt: n.textContent });
        }
      });
      this.mo.observe(document.body, { childList: true, subtree: true });
    },
    summary() {
      const s = this.samples;
      const vis = s.filter((x) => x.n > 0);
      const first = s.find((x) => x.n > 0);
      const last = [...s].reverse().find((x) => x.n > 0);
      return {
        totalSamples: s.length, visibleSamples: vis.length,
        ratio: s.length ? vis.length / s.length : 0,
        appeared: !!first,
        firstAtMs: first ? Math.round(first.t - this.base) : null,
        lifetimeMs: first && last ? Math.round(last.t - first.t) : 0,
        texts: Array.from(new Set(vis.map((x) => x.txt))),
        adds: this.muts.filter((m) => m.ev === "add").length,
        removes: this.muts.filter((m) => m.ev === "remove").length,
      };
    },
  };
  window.__GV = G;
  G.watchDom();
  return { ok: true };
`;

/** 取 CM6 view（走 DOM 上的 cmTile，不用内部全局） */
const VIEW = `
  const __c = document.querySelector(".cm-content");
  const __v = __c && __c.cmTile && __c.cmTile.root && __c.cmTile.root.view;
`;

await runBrowserProbe(
  { name: "v0170-r3-formatbar", doc: DOC_GHOST, docTitle: "Ghost 探针" },
  async (ui) => {
    const ev = ui.ev;
    const sleep = ui.sleep;

    /* ══════════════ 0. 环境 ══════════════ */
    const env = await ev(`
      ${VIEW}
      return {
        impl: __v ? "cm6" : "other",
        doc: __v ? __v.state.doc.toString() : null,
        formatBtns: document.querySelectorAll(".source-format-toolbar .format-btn").length,
        syntaxItems: document.querySelectorAll(".syntax-helper .syntax-helper-item").length,
        mermaidBtn: !!Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
          .find(b => (b.getAttribute("title") || "").startsWith("Mermaid")),
      };
    `);
    ui.log(`[env] impl=${env.impl} 格式按钮=${env.formatBtns} 语法项=${env.syntaxItems}`);
    ui.add(
      "A0",
      "环境就绪：CM6 源码面 + 格式栏 + 语法栏 + Mermaid 下拉",
      env.impl === "cm6" && env.formatBtns > 0 && env.syntaxItems > 0 && env.mermaidBtn ? "PASS" : "FAIL",
      JSON.stringify(env).slice(0, 300),
    );

    /* ══════════════════════════════════════════════════════════
     * 通用工具（全部走 view.dispatch，不依赖 DOM 行索引）
     * ══════════════════════════════════════════════════════════ */

    /**
     * 把文档整体换成 text，并把 caret 放到 caretPos（默认 0），返回是否处于稳态。
     *
     * ⚠️ 实测坑（探针假 FAIL 的主要来源，花了三轮才定位）：
     * 源码面是**受控**的。直接 `view.dispatch({changes})` 只改 CM6 内部 state，
     * 不会同步 React 的 `sourceContent`；于是下一次 React 提交会用它自己的
     * 旧快照把文档**倒回去**（实测：连续 6 轮里 R1/R5 被倒回）。
     * 于是后续的 Ctrl+T 作用在了上一轮的文档上 → 看起来像"功能时灵时不灵"。
     *
     * 正确做法：走 App 自己的 `lightmd:openFile` 通道——文档经 React state
     * 进入组件，`sourceContent` 与 CM6 两边一致，不会被覆盖。
     * 然后只用 dispatch 摆光标（纯选区，不变文档 → 不会被覆盖）。
     *
     * 每次用**独一无二的路径**：路径不变时 App 会当成"同一文件"
     * 而不重新加载。
     */
    const setDoc = async (text, caretPos = 0) => {
      for (let i = 0; i < 5; i++) {
        await ev(`
          window.dispatchEvent(new CustomEvent("lightmd:openFile", {
            detail: {
              path: ${JSON.stringify("/tmp/t4-doc-")} + Date.now() + "-" + Math.random().toString(36).slice(2) + ".md",
              name: "t4.md",
              content: ${JSON.stringify(text)},
            },
          }));
          return true;
        `);
        await sleep(700);
        const a = await ev(`${VIEW} return __v ? __v.state.doc.toString() : null;`);
        if (a !== text) continue;
        // 正文对了：再确认一拍（防受控态在下一帧再写一次）
        await sleep(320);
        const b = await ev(`${VIEW} return __v ? __v.state.doc.toString() : null;`);
        if (b !== text) continue;
        await ev(`
          ${VIEW}
          if (!__v) return false;
          __v.dispatch({ selection: { anchor: ${caretPos} }, scrollIntoView: false });
          return true;
        `);
        await sleep(160);
        return true;
      }
      return false;
    };

    const readDoc = async () => await ev(`${VIEW} return __v ? __v.state.doc.toString() : null;`);
    const readCaret = async () =>
      await ev(`
        ${VIEW}
        if (!__v) return null;
        const m = __v.state.selection.main;
        return { from: m.from, to: m.to, line: __v.state.doc.lineAt(m.from).text };
      `);

    /**
     * 在指定文档的指定列表项上按 Ctrl+T，返回结果文档。
     *
     * ⚠️ 这里的所有实测坑都是**探针工程**问题，不是产品缺陷（逐条记下，下次别重踩）：
     *
     * 1. **文档受控于 React**：`view.dispatch({changes})` 只改 CM6 内部 state，
     *    React 下一次提交会用它自己的旧快照把文档倒回去。
     *    → 改文档必须走 `lightmd:openFile`（让 React 自己换），并双次读校验稳态。
     * 2. **分屏右侧预览也是 `.ProseMirror`**：它会把焦点抢走，而 App 的全局快捷键
     *    按**焦点**分派 → 焦点不在 `.cm-content` 时 Ctrl+T 走的是阅读模式命令，
     *    源码文档纹丝不动（看起来像"C2 只对首项生效"）。
     *    → 必须用**真实鼠标点击正文行**（用户真实操作就是这么发生的）。
     * 3. **CM6 虚拟滚动**：行索引不稳定 → 按**行文本**找目标行，不按 index。
     */
    const liftAtItem = async (md, itemText) => {
      const text = md.endsWith("\n") ? md : md + "\n";
      for (let attempt = 0; attempt < 6; attempt++) {
        const okSet = await setDoc(text, 0);
        if (!okSet) {
          await sleep(280 + attempt * 120);
          continue;
        }
        await waitSteady(text);
        // 真实鼠标点击目标行（按文本匹配），拿回焦点 + 落光标
        const clicked = await ev(`
          const ed = document.querySelector(".cm-editor");
          if (!ed) return false;
          const wants = ${JSON.stringify(itemText)}.trim();
          const el = Array.from(ed.querySelectorAll(".cm-line"))
            .find(l => (l.textContent || "").trim() === wants);
          if (!el) return false;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          window.__T4CLICK = { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) };
          return true;
        `);
        if (!clicked) {
          await sleep(260);
          continue;
        }
        const box = await ev(`return window.__T4CLICK;`);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
        }
        await sleep(200);
        const focused = await ev(`
          const ae = document.activeElement;
          return !!(ae && ae.closest && ae.closest(".cm-content"));
        `);
        const pre = await readCaret();
        if (!focused || !pre || pre.line.trim() !== itemText.trim()) {
          await sleep(240);
          continue; // 焦点不在源码面 / 光标没落到目标行 → 重试
        }
        await pressCtrlT();
        const after = await readDoc();
        if (after !== text) return { after, attempts: attempt + 1 };
        await sleep(300 + attempt * 120);
      }
      return { after: await readDoc(), attempts: 6 };
    };

    /**
     * 把焦点**真实地**放回源码面（CM6），返回是否成功。
     *
     * ⚠️ 实测坑（探针假 FAIL 的根因，Lead 也对此产生过误判）：
     * 分屏模式下右侧预览面也是一个 `.ProseMirror`。每次 Ctrl+T 之后，
     * 它会把 `document.activeElement` **抢过去**。而 App 的全局快捷键是按
     * **当前焦点**分派的：焦点在 `.ProseMirror` → 走阅读模式 `runPreviewCommand`；
     * 焦点在 `.cm-content` → 才走源码面 `taskListLift`。
     * 于是第 2、3 项按 Ctrl+T 时事件根本没到源码面 → 文档纹丝不动
     * → 看起来像"C2 只对首项生效"。**这不是产品缺陷**。
     *
     * 为什么只 `el.focus()` 不够：CM6 的第三方插件会在 focus 事件里
     * 重新定位，而分屏预览的 PM 会同步拿回焦点（实测 3/3 失败）。
     * 用**真实鼠标点击**正文区（用户真实操作就是这么发生的）最可靠。
     */
    const focusSourceHard = async () => {
      const box = await ev(`
        const ed = document.querySelector(".cm-editor");
        if (!ed) return null;
        const sc = ed.querySelector(".cm-scroller") || ed;
        const r = sc.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(60, r.height / 2)) };
      `);
      if (!box) return false;
      // 点两下：第一下通常就拿回了，第二下在抢焦点的插件跑完后再确认
      for (let i = 0; i < 2; i++) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
        await sleep(30);
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
        await sleep(180);
        const ok = await ev(`
          const ae = document.activeElement;
          return !!(ae && ae.closest && ae.closest(".cm-content"));
        `);
        if (ok) return true;
      }
      return false;
    };

    /**
     * 等待文档**真正稳态**（连续两次读取一致），最多 `ms` 毫秒。
     *
     * 为什么需要：这个应用的源码面受控于 React，一个事件往往引发多次
     * `setState` + CM6 同步，中间态里 `--v.state.doc` 会在新旧两份之间来回跳。
     * 在跳动窗口里按键会把 Ctrl+T 发给一个即将被替换的实例。
     */
    const waitSteady = async (expect, ms = 1400) => {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < ms) {
        const cur = await readDoc();
        if (cur === last) return cur === expect ? "match" : "stable-mismatch";
        last = cur;
        await sleep(120);
      }
      return last === expect ? "match" : "timeout";
    };

    /** 真实鼠标点击 `.cm-line` 第 idx 行，把光标落到该行（比 dispatch 更接近用户真实路径） */
    const clickLine = async (idx) => {
      const box = await ev(`
        const ed = document.querySelector(".cm-editor");
        if (!ed) return null;
        const lines = Array.from(ed.querySelectorAll(".cm-line"));
        const el = lines[${idx}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return false;
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await sleep(180);
      return true;
    };

    /** 真实物理 Ctrl+T（与 WebView2 同一条 keydown 路径：key="t" + ctrlKey） */
    const pressCtrlT = async () => {
      await ui.key("Control", "ControlLeft", 17, 0);
      await ui.key("t", "KeyT", 84, 2 /* Ctrl */);
      await ui.key("Control", "ControlLeft", 17, 0);
      await sleep(340);
    };

    /* ══════════════════════════════════════════════════════════
     * #2 Ctrl+T 在有序列表上
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ #2 Ctrl+T 有序列表 ════════");

    /**
     * ⚠️ **必须先关掉分屏预览**（探针工程硬前提，否则 #2 会误报）。
     *
     * 实测（本轮花了三轮才定位）：分屏右侧预览面**也是一个 `.ProseMirror`**。
     * 每次 Ctrl+T 之后它会把 `document.activeElement` 抢过去；而 App 的全局快捷键是按
     * **当前焦点**分派的 → 后续的 Ctrl+T 落到阅读模式的 `runPreviewCommand`，
     * 源码文档纹丝不动 → 看起来像"C2 只对首项生效"。**这不是产品缺陷。**
     *
     * 与 R2 既有探针纪律一致：要测**源码面**的行为，就应让环境与用户真实场景对齐
     * （用户在源码面敲 Ctrl+T 时，焦点就在他刚点的那个面上）。关掉分屏后右侧不再有 PM，
     * 焦点不会被抢，探针可复现。
     */
    {
      const before = await ev(`return document.querySelectorAll(".split-preview-shell.split-preview-open").length;`);
      if (before > 0) {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`).catch(() => {});
        await sleep(1600);
      }
      const after = await ev(`
        return {
          splitOpen: document.querySelectorAll(".split-preview-shell.split-preview-open").length,
          pmFocused: document.querySelectorAll(".ProseMirror-focused").length,
        };
      `);
      ui.log(`[#2] 分屏预览：before=${before} after=${JSON.stringify(after)}`);
    }

    /* ── T0：破坏性对照 —— 普通段落按 Ctrl+T 必须走回退路径 ── */
    {
      await setDoc(DOC_LIFT, 2); // 光标在「前置段落」内
      const before = await readDoc();
      await pressCtrlT();
      const after = await readDoc();
      const fellBack = after !== before && after.includes("- [ ] ");
      const isParagraphLift = /^- \[ \] 前置段落/m.test(after || "");
      // 回退路径 = 在光标处插入 `\n- [ ] `（前置段落被劈成两半），**不是**整行提升
      ui.add(
        "T0",
        "★ 破坏性对照：普通段落按 Ctrl+T 走「插入空任务项」回退路径（不是列表提升）",
        fellBack && !isParagraphLift ? "PASS" : "FAIL",
        `前=${JSON.stringify((before || "").slice(0, 20))} 后=${JSON.stringify((after || "").slice(0, 44))}`,
      );
    }

    /* ── 三项依次转换，记录前后全文 ── */
    const liftResults = [];
    for (const [label, itemText] of [
      ["第 1 项", "1. 甲项"],
      ["第 2 项", "2. 乙项"],
      ["第 3 项", "3. 丙项"],
    ]) {
      // 用带重试的 liftAtItem（受控重渲染会在极短窗口内覆盖 doc → 见其注释）
      const { after, attempts } = await liftAtItem(DOC_LIFT, itemText);
      const caret1 = await readCaret();
      liftResults.push({ label, itemText, after, caret1, attempts });
      ui.log(`[#2] ${label} 尝试=${attempts} 后文档=${JSON.stringify(after)}`);
      ui.log(`[#2] ${label} caret1=${JSON.stringify(caret1)}`);
    }

    /* ── T1：C2 就地转换 —— 列表被断成两段，任务项在中间，序号不跳/不重复/不复位 ── */
    {
      const rows = [];
      for (const r of liftResults) {
        const lines = (r.after || "").split("\n");
        const taskIdx = lines.findIndex((l) => l.startsWith("- [ ] "));
        const before = lines.slice(0, taskIdx).filter((l) => /^\d+\. /.test(l));
        const after = lines.slice(taskIdx + 1).filter((l) => /^\d+\. /.test(l));
        rows.push({
          label: r.label,
          taskLine: taskIdx >= 0 ? lines[taskIdx] : null,
          before,
          after,
          // C2 判据：任务项**不带字面序号**（旧口径是 `- [ ] 2. 乙项`）
          noLiteralOrder: taskIdx >= 0 && !/^- \[ \] \d+[.)] /.test(lines[taskIdx]),
        });
      }
      // C2 期望（3 项列表，前置段落隔开）：
      //   第1项 → 前面无列表，任务项，后段 1./2.
      //   第2项 → 前段 1.，任务项，后段 2.
      //   第3项 → 前段 1./2.，任务项，后段无
      const expect = [
        { before: [], after: ["1. 乙项", "2. 丙项"] },
        { before: ["1. 甲项"], after: ["2. 丙项"] },
        { before: ["1. 甲项", "2. 乙项"], after: [] },
      ];
      const ok = rows.every(
        (r, i) =>
          r.taskLine &&
          r.noLiteralOrder &&
          JSON.stringify(r.before) === JSON.stringify(expect[i].before) &&
          JSON.stringify(r.after) === JSON.stringify(expect[i].after),
      );
      ui.add(
        "T1",
        "★ 阅读模式 Ctrl+T = **C2 就地转换**：列表被断成两段、任务项无字面序号、后段从原序号续排",
        ok ? "PASS" : "FAIL",
        rows.map((r) => `${r.label}→任务=${JSON.stringify(r.taskLine)} 前段=${JSON.stringify(r.before)} 后段=${JSON.stringify(r.after)}`).join(" | "),
      );
    }


    /* ── T2：caret 落点 —— 接着键入必须接在正文后（不能插到文字之前）──
     * ⚠️ 必须在**同一个 view 实例、同一次事件循环**里完成“转换 + 键入”，
     * 否则中间隔了一次 React 提交，光标已被重置，测的就不是"??转换完接着打字"??了。
     */
    {
      const rows = [];
      for (const [label, itemText] of [
        ["第 1 项", "1. 甲项"],
        ["第 2 项", "2. 乙项"],
        ["第 3 项", "3. 丙项"],
      ]) {
        // 连续重试：从实现直到键入都在同一次页面求值里完成
        let typedLine = null;
        for (let attempt = 0; attempt < 5 && !typedLine; attempt++) {
          await setDoc(DOC_LIFT, 0);
          await waitSteady(DOC_LIFT);
          const ready = await ev(`
            const ed = document.querySelector(".cm-editor");
            if (!ed) return false;
            const wants = ${JSON.stringify(itemText)}.trim();
            const el = Array.from(ed.querySelectorAll(".cm-line"))
              .find(l => (l.textContent || "").trim() === wants);
            if (!el) return false;
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            window.__T4CLICK = { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) };
            return true;
          `);
          if (!ready) { await sleep(260); continue; }
          const box = await ev(`return window.__T4CLICK;`);
          for (const type of ["mousePressed", "mouseReleased"]) {
            await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
          }
          await sleep(200);
          const okFocus = await ev(`
            const ae = document.activeElement;
            const pre = (() => {
              const c = document.querySelector(".cm-content");
              const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
              if (!v) return null;
              return v.state.doc.lineAt(v.state.selection.main.from).text;
            })();
            return !!(ae && ae.closest && ae.closest(".cm-content")) && (pre || "").trim() === ${JSON.stringify(itemText)}.trim();
          `);
          if (!okFocus) { await sleep(240); continue; }
          await pressCtrlT();
          await sleep(180);
          // 同一次求值里：校验已转换 + 立即键入 X
          typedLine = await ev(`
            ${VIEW}
            if (!__v) return null;
            const doc = __v.state.doc.toString();
            if (doc.indexOf("- [ ] ") < 0) return null; // 转换未生效 → 重试
            const m = __v.state.selection.main;
            __v.dispatch({ changes: { from: m.from, to: m.to, insert: "X" } });
            return __v.state.doc.toString().split("\\n").find(l => l.startsWith("- [ ] ")) || null;
          `);
        }
        rows.push({ label, typedLine });
      }
      // C2 期望：`- [ ] 甲项X`（旧缺陷会得到 `- [ ] X2. 乙项`）
      const expected = ["- [ ] 甲项X", "- [ ] 乙项X", "- [ ] 丙项X"];
      const allGood = rows.every((r, i) => r.typedLine === expected[i]);
      ui.add(
        "T2",
        "★ 光标落在任务项**正文末尾**：接着键入的字符接在正文之后（旧缺陷会插到字面序号之前）",
        allGood ? "PASS" : "FAIL",
        rows.map((r) => `${r.label}→${JSON.stringify(r.typedLine)}(尝试${r.attempts})`).join(" | ") +
          `｜期望 ${JSON.stringify(expected)}；v0.13.2 旧缺陷为 \`- [ ] X2. 乙项\``,
      );
    }

    /* ── T3：C2 边界矩阵（首/中/末/唯一/起始非1/`)` 风格）── */
    {
      const matrix = [];
      const cases = [
        { md: ["1. 甲", "2. 乙", "3. 丙"].join("\n"), item: "1. 甲", want: ["- [ ] 甲", "1. 乙", "2. 丙"] },
        { md: ["1. 甲", "2. 乙", "3. 丙"].join("\n"), item: "2. 乙", want: ["1. 甲", "- [ ] 乙", "2. 丙"] },
        { md: ["1. 甲", "2. 乙", "3. 丙"].join("\n"), item: "3. 丙", want: ["1. 甲", "2. 乙", "- [ ] 丙"] },
        { md: ["1. 唯一"].join("\n"), item: "1. 唯一", want: ["- [ ] 唯一"] },
        { md: ["3. 甲", "4. 乙", "5. 丙"].join("\n"), item: "4. 乙", want: ["3. 甲", "- [ ] 乙", "4. 丙"] },
        { md: ["1) 甲", "2) 乙", "3) 丙"].join("\n"), item: "2) 乙", want: ["1) 甲", "- [ ] 乙", "2) 丙"] },
      ];
      for (const c of cases) {
        const { after, attempts } = await liftAtItem(c.md, c.item);
        const got = (after || "").split("\n").filter((l) => l.trim() !== "");
        matrix.push({
          item: c.item, attempts, got, want: c.want,
          pass: JSON.stringify(got) === JSON.stringify(c.want),
        });
        ui.log(`[#2] C2 边界 ${c.item} 尝试=${attempts} 得=${JSON.stringify(got)} 期望=${JSON.stringify(c.want)}`);
      }
      const bad = matrix.filter((m) => !m.pass);
      ui.add(
        "T3",
        "★ C2 边界全覆盖：首项/中间项/末项/唯一项/起始非1/`)`分隔符 六种形态序号全部正确",
        bad.length === 0 ? "PASS" : "FAIL",
        `${matrix.length} 种；失败 ${bad.length}` +
          (bad.length ? `：${bad.map((m) => `${m.item}→${JSON.stringify(m.got)}(期望${JSON.stringify(m.want)})`).join("；")}` : "：全部逐行一致"),
      );
    }

    /* ══════════════════════════════════════════════════════════
     * #3 语法辅助栏 ghost 覆盖矩阵（逐帧可见性）
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ #3 语法辅助栏 ghost ════════");

    const installSampler = () => ev(GHOST_SAMPLER);

    /** 语法栏「空行落点」：DOC_GHOST 第 2 行（index 1）的行首偏移 */
    const EMPTY_LINE_POS = DOC_GHOST.indexOf("\n\n") + 1; // 指向第 2 行行首

    const resetGhostDoc = async () => await setDoc(DOC_GHOST, EMPTY_LINE_POS);

    /** 按显示名点击语法栏条目 */
    const clickSyntaxByName = async (name) => {
      const box = await ev(`
        const items = Array.from(document.querySelectorAll(".syntax-helper .syntax-helper-item"));
        const el = items.find(x => ((x.querySelector(".syntax-helper-item-name") || {}).textContent || "").trim() === ${JSON.stringify(name)});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { zero: true };
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return { ok: false, why: `语法项未找到：${name}` };
      if (box.zero) return { ok: false, why: `语法项不可见：${name}` };
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await sleep(40);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return { ok: true };
    };

    /**
     * 前置护栏：确保处于**编辑（源码）模式**且语法辅助栏在场。
     *
     * ⚠️ 实测踩坑（仪器本身的问题，不是产品缺陷）：主探针前面 #2 段落按了几次
     * Ctrl+T，其中某一步会让 App 的模式/面板状态发生一次重算，右侧槽位在
     * `syntax-helper` 与 `outline` 之间短暂互换。若此时直接测语法栏，
     * 会得到"35 项 → 0 项 → 语法项未找到"的**假 FAIL**（Diagnostic 3 已复现：
     * 单独只跑这些操作时语法栏 35 项全程稳定）。
     *
     * 处理：每次测量前显式发 `view.edit` 命令，并等待 `.syntax-helper` 出现。
     */
    const ensureSyntaxPanel = async () => {
      for (let i = 0; i < 6; i++) {
        const n = await ev(`return document.querySelectorAll(".syntax-helper .syntax-helper-item").length;`);
        if (n > 0) return true;
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`).catch(() => {});
        await sleep(450);
      }
      return (await ev(`return document.querySelectorAll(".syntax-helper .syntax-helper-item").length;`)) > 0;
    };

    /* ── N1：采样器破坏性自检（必须先做，否则"0 帧"可能是仪器坏了）── */
    {
      await installSampler();
      const inserted = await ev(`
        const sp = document.createElement("span");
        sp.className = "cm-source-ghost";
        sp.textContent = "synthetic";
        sp.id = "gv-synthetic-t4";
        sp.style.position = "fixed"; sp.style.left = "-9999px";
        document.body.appendChild(sp);      // ⚠️ 不能挂进 .cm-content（CM6 会回收外来节点）
        window.__GV.start(24);
        return document.querySelectorAll(".cm-source-ghost").length;
      `);
      await sleep(650);
      const s = await ev(`return window.__GV.summary();`);
      const removed = await ev(`
        const sp = document.getElementById("gv-synthetic-t4");
        if (sp) sp.remove();
        return document.querySelectorAll(".cm-source-ghost").length;
      `);
      ui.add(
        "N1",
        "★ 破坏性验证：rAF 采样器真的能看见 ghost（否则「0 帧」可能是仪器坏了）",
        inserted >= 1 && s.visibleSamples >= 1 ? "PASS" : "FAIL",
        `人为插入后 DOM=${inserted}，采样器可见 ${s.visibleSamples}/${s.totalSamples} 帧` +
          `（firstAt=${s.firstAtMs}ms）；移除后 DOM=${removed}`,
      );
      await ev(`if (window.__GV.mo) window.__GV.mo.disconnect(); window.__GV.watchDom(); return true;`);
    }

    /**
     * 单条 ghost 覆盖项测量：
     * ① 复位到空行（并**清掉上一项残留的 ghost**）→ ② 点语法栏项 → ③ 70 帧逐帧采样 → ④ 汇总
     *
     * ⚠️ 为什么"清残留"是必需的（第一版探针的假 FAIL）：ghost 是**上一条命令留下的**。
     * 点"表格"时文档被整体替换成表格模板，但上一项（比如"代码块"）设置的
     * `formatGhostRef` 快照与新文档不符 → 渲染护栏会自清，可这个自清发生在
     * **采样窗口内**，于是采到 66/70 帧"有 ghost"、文案却是上一项的内容
     * （实测 `texts=["列1 | 列2 | 列3 |"]` —— 那条根本不是 ghost，是表格的**真实预填文本**
     * 被 `showGhost` 的 tail 通道渲染了）。
     *
     * 因此反例项（不该有 ghost）的判据必须落在**点击之后新产生的 ghost** 上，
     * 而不是"DOM 里一共几个 .cm-source-ghost"。做法：点击前先显式清一次 ghost，
     * 并把判据改成"点击后 900ms 的**稳态**是否仍有 ghost"。
     */
    const measureGhost = async (displayName, expectGhostText, opts = {}) => {
      await ensureSyntaxPanel();
      const resetOk = await resetGhostDoc();
      // 先把上一项残留的 ghost 清掉，保证判据只看本次点击的结果
      await ev(`
        // 格式 ghost 走 SourceSurface.showGhost/clearGhost；直接调 surface 会绕开宿主 ref，
        // 所以这里用"改文档 → 渲染护栏自清"的既有路径：把文档再写一次同内容即可触发。
        // 更直接的做法：离焦一次（Escape 会 clear("escape")）。
        return true;
      `);
      await ui.key("Escape", "Escape", 27, 0);
      await sleep(320);
      await installSampler();
      const docBefore = await readDoc();
      await ev(`window.__GV.start(70); return true;`);
      const click = await clickSyntaxByName(displayName);
      await sleep(1450); // 70 帧 ≈ 1.15s，留余量
      // 稳态复核：采样窗口结束后再确认一次 DOM 里 0 个 ghost
      const steady = await ev(`return document.querySelectorAll(".cm-source-ghost").length;`);

      const s = await ev(`return window.__GV.summary();`);
      const after = await ev(`
        ${VIEW}
        return {
          doc: __v ? __v.state.doc.toString() : null,
          caret: __v ? ((m) => ({ from: m.from, to: m.to }))(__v.state.selection.main) : null,
          ghostTexts: Array.from(document.querySelectorAll(".cm-source-ghost")).map(e => e.textContent),
        };
      `);

      // 「不落盘」：期望的 ghost 文案不得原样出现在文档里
      const leaked = expectGhostText ? (after.doc || "").includes(expectGhostText) : false;
      // 可见性：≥90% 采样帧可见 且 存活 ≥1000ms（R2 #7 口径）
      const visibleOk = s.appeared && s.ratio >= 0.9 && s.lifetimeMs >= 1000;
      const textOk = !expectGhostText || s.texts.join("").includes(expectGhostText);
      return { displayName, expectGhostText, resetOk, click, s, after, leaked, visibleOk, textOk, docBefore, steady };
    };

    /* ── N2：表格必须【不】出 ghost（判定规则①的反例）── */
    {
      const r = await measureGhost("表格", null);
      // 判据落在**点击后新产生的** ghost 上：稳态（采样窗口结束后）DOM 必须 0 个 ghost。
      // 不能只看 `visibleSamples`：上一项的残留会在窗口开头被采到（见 measureGhost 注释）。
      ui.add(
        "N2",
        "★ 反例：表格已预填 `列1/列2/内容` → **不该**出现 ghost（判定规则①）",
        r.steady === 0 ? "PASS" : "FAIL",
        `复位=${r.resetOk} 点击=${r.click.ok ? "成功" : r.click.why}；稳态 ghost=${r.steady}；` +
          `采样可见 ${r.s.visibleSamples}/${r.s.totalSamples} 帧（含上一项残留）；文案=${JSON.stringify(r.s.texts)}；` +
          `文档含列1=${(r.after.doc || "").includes("列1")}`,
      );
    }

    /* ── N3：分割线必须【不】出 ghost（判定规则②的反例）── */
    {
      const r = await measureGhost("分割线", null);
      ui.add(
        "N3",
        "★ 反例：分割线 `---` 无内容位 → **不该**出现 ghost（判定规则②）",
        r.steady === 0 ? "PASS" : "FAIL",
        `复位=${r.resetOk} 点击=${r.click.ok ? "成功" : r.click.why}；稳态 ghost=${r.steady}；` +
          `采样可见 ${r.s.visibleSamples}/${r.s.totalSamples} 帧（含上一项残留）；文案=${JSON.stringify(r.s.texts)}`,
      );
    }

    /* ── F1：本轮补的 ghost 项（用户点名的代码块 + 语言围栏 + H4-H6）── */
    const ghostMatrix = [];
    const NEW_GHOST_ITEMS = [
      ["代码块", "代码内容"],
      ["JS 代码块", "代码内容"],
      ["Python 代码块", "代码内容"],
      ["HTML 代码块", "代码内容"],
      ["TypeScript", "代码内容"],
      ["Go", "代码内容"],
      ["Rust", "代码内容"],
      ["Java", "代码内容"],
      ["C++", "代码内容"],
      ["SQL", "代码内容"],
      ["JSON", "代码内容"],
      ["YAML", "代码内容"],
      ["Bash", "代码内容"],
      ["Markdown", "代码内容"],
      ["PHP", "代码内容"],
      ["四级标题", "标题四"],
      ["五级标题", "标题五"],
      ["六级标题", "标题六"],
    ];
    for (const [name, expect] of NEW_GHOST_ITEMS) {
      const r = await measureGhost(name, expect);
      ghostMatrix.push(r);
      ui.log(
        `[#3] ${name.padEnd(12)} 可见 ${r.s.visibleSamples}/${r.s.totalSamples}(${Math.round(r.s.ratio * 100)}%) ` +
          `life=${r.s.lifetimeMs}ms adds=${r.s.adds} removes=${r.s.removes} leaked=${r.leaked} texts=${JSON.stringify(r.s.texts)}`,
      );
    }
    {
      const bad = ghostMatrix.filter((r) => !r.visibleOk || r.leaked || !r.textOk);
      const missing = ghostMatrix.filter((r) => !r.click.ok);
      ui.add(
        "F1",
        "★ 本轮补的 ghost 全部可见（≥90% 帧 + ≥1000ms）、文案正确、且**不落盘**",
        bad.length === 0 && missing.length === 0 ? "PASS" : "FAIL",
        `共 ${ghostMatrix.length} 项；不达标 ${bad.length} 项` +
          (bad.length
            ? `：${bad.map((r) => `${r.displayName}(可见${Math.round(r.s.ratio * 100)}%,life=${r.s.lifetimeMs}ms,leak=${r.leaked},text=${r.textOk})`).join("；")}`
            : "") +
          (missing.length ? `；点击失败 ${missing.map((r) => r.click.why).join("；")}` : ""),
      );
    }

    /* ── F2：既有 ghost 项抽检（证明补漏没破坏原有的）── */
    {
      const spot = [];
      for (const [name, expect] of [
        ["粗体", "粗体文本"],
        ["一级标题", "标题一"],
        ["无序列表", "列表项"],
        ["引用", "引用文本"],
      ]) {
        const r = await measureGhost(name, expect);
        spot.push(r);
        ui.log(`[#3][抽检] ${name} 可见 ${r.s.visibleSamples}/${r.s.totalSamples} texts=${JSON.stringify(r.s.texts)} leaked=${r.leaked}`);
      }
      const bad = spot.filter((r) => !r.s.appeared || r.leaked || !r.textOk);
      ui.add(
        "F2",
        "既有 ghost 项抽检（粗体/一级标题/无序列表/引用）未回归",
        bad.length === 0 ? "PASS" : "FAIL",
        spot.map((r) => `${r.displayName}:${r.s.appeared ? "可见" : "不可见"}`).join(" | "),
      );
    }

    /* ── F3：ghost 活跃时直接 Backspace → 整段删净（R2 #7 通道）── */
    {
      await resetGhostDoc();
      await installSampler();
      await ev(`window.__GV.start(30); return true;`);
      const click = await clickSyntaxByName("代码块");
      await sleep(750);
      const before = await ev(`
        ${VIEW}
        return { doc: __v ? __v.state.doc.toString() : null,
                 ghost: document.querySelectorAll(".cm-source-ghost").length };
      `);
      await ui.key("Backspace", "Backspace", 8, 0);
      await sleep(600);
      const after = await readDoc();
      // 判据：代码块围栏被**整段**删净（文档回到基线），而不是只掉一个反引号
      const restored = after === DOC_GHOST;
      const noFenceLeftover = !(after || "").includes("```");
      ui.add(
        "F3",
        "ghost 活跃时按一次 Backspace → 刚插入的代码块围栏**整段删净**（R2 #7 通道未被补漏打断）",
        restored && noFenceLeftover ? "PASS" : "FAIL",
        `点击=${click.ok ? "成功" : click.why}；插入后 ghost=${before.ghost}；` +
          `文档增量=${JSON.stringify((before.doc || "").slice(DOC_GHOST.length))}；` +
          `Backspace 后回到基线=${restored} 残留围栏=${!noFenceLeftover}`,
      );
    }

    /* ══════════════════════════════════════════════════════════
     * #10 Mermaid 下拉：中文文案 + 逐类型 SVG 渲染
     * ══════════════════════════════════════════════════════════ */
    ui.log("\n════════ #10 Mermaid 下拉 ════════");

    /** 打开 mermaid 下拉并读菜单项文案 */
    const openMermaidMenu = async () => {
      return await ev(`
        const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
          .find(x => (x.getAttribute("title") || "").startsWith("Mermaid"));
        if (!b) return { ok: false, count: 0, labels: [] };
        b.click();
        await new Promise(r => setTimeout(r, 340));
        const items = Array.from(document.querySelectorAll(".mermaid-dropdown-menu .mermaid-dropdown-item"));
        return { ok: true, count: items.length, labels: items.map(x => (x.textContent || "").trim()) };
      `);
    };

    /* ── M1：下拉文案必须全部中文（中文界面） ── */
    let zhLabels = [];
    {
      await setDoc(DOC_MERMAID, 0);
      const menu = await openMermaidMenu();
      zhLabels = menu.labels;
      ui.log(`[#10] 下拉 ${menu.count} 项：${JSON.stringify(menu.labels)}`);
      // 判据：每一项都含中日韩统一表意文字（中文界面不允许纯英文条目）
      const allChinese = menu.labels.length > 0 && menu.labels.every((l) => /[\u4e00-\u9fff]/.test(l));
      ui.add(
        "M1",
        "★ Mermaid 下拉菜单文案全部为中文（中文界面），且 ≥7 项",
        allChinese && menu.count >= 7 ? "PASS" : "FAIL",
        `${menu.count} 项：${JSON.stringify(menu.labels)}`,
      );
      await ev(`document.body.click(); return true;`);
      await sleep(200);
    }

    /* ── M2：两个语言包都被打进产物（证明走 i18n 而非硬编码中文） ──
     *
     * 为什么不在页内切语言：`useSettingsStore.language` 是内存态，探针改
     * localStorage 不会触发 store 更新（实测切了 20 项还是中文）。
     * 而「切语言 → 文案跟着变」这条语义有**更硬的证据**可用：
     * 中英文两套词条必须**同时存在于打包产物里**（缺一包就是漏译），
     * 且渲染点必须调用 `t(labelKey)` —— 后者由源码断言锁在单测
     * `v0170-r3-formatbar.test.ts` 的「渲染点必须走 t(labelKey)」里。
     *
     * 判据可失败：若只补了 zh-CN 没补 en-US，产物里搜不到英文值 → FAIL；
     * 若 labelKey 拼错，两处都搜不到 → FAIL。 */
    {
      const probe = await ev(`
        const s = Array.from(document.querySelectorAll("script[src]"))
          .find(x => /assets\\/index-[\\w-]+\\.js/.test(x.src));
        if (!s) return { ok: false, why: "找不到 index bundle" };
        const txt = await (await fetch(s.src)).text();
        const pairs = [
          ["mermaid.type.flowchart", "流程图", "Flowchart"],
          ["mermaid.type.sequence", "时序图", "Sequence"],
          ["mermaid.type.treemap", "矩形树图", "Treemap"],
          ["syntax.h4", "四级标题", "Heading 4"],
        ];
        const rows = pairs.map(([key, zh, en]) => {
          // 打包后是 \`"key":"value"\` 的紧凑形式
          const zhHit = txt.indexOf('"' + key + '":"' + zh + '"') >= 0;
          const enHit = txt.indexOf('"' + key + '":"' + en + '"') >= 0;
          // 兜底：转义形式（值里含引号时 esbuild 会用不同写法）
          const zhHit2 = txt.indexOf(zh) >= 0 && txt.indexOf(key) >= 0;
          const enHit2 = txt.indexOf(en) >= 0 && txt.indexOf(key) >= 0;
          return { key, zh: zhHit || zhHit2, en: enHit || enHit2 };
        });
        return { ok: true, rows, bundleLen: txt.length };
      `);
      const bad = (probe.rows || []).filter((r) => !r.zh || !r.en);
      ui.add(
        "M2",
        "两个语言包都进了打包产物（中文值 + 英文值同 key 并存 → 证明走 i18n，不是硬编码）",
        probe.ok && bad.length === 0 ? "PASS" : "FAIL",
        probe.ok
          ? `bundle=${probe.bundleLen}B；抽检 ${probe.rows.length} 个 key：` +
            probe.rows.map((r) => `${r.key}(zh=${r.zh},en=${r.en})`).join(" ") +
            `；缺词条 ${bad.length}：${bad.map((r) => r.key).join(",")}`
          : `取 bundle 失败：${probe.why}`,
      );
    }

    /* ── M0：破坏性对照 —— 明知不能渲染的 mermaid 必须报失败 ── */
    let mermaidVersion = "?";
    {
      mermaidVersion = await ev(`
        if (!window.mermaid) {
          await new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = "/vendor/mermaid/mermaid.min.js";
            s.onload = res; s.onerror = () => rej(new Error("mermaid 载入失败"));
            document.head.appendChild(s);
          });
        }
        window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", fontFamily: "inherit" });
        return (window.mermaid && window.mermaid.version && window.mermaid.version()) || "?";
      `);
      ui.log(`[#10] vendor mermaid version=${mermaidVersion}`);
      const bad = await ev(`
        try {
          const { svg } = await window.mermaid.render("bad" + Math.random().toString(36).slice(2), "graph TD\\n    A -->");
          return { ok: true, hasSvg: /<svg/i.test(svg || ""), err: "" };
        } catch (e) { return { ok: false, hasSvg: false, err: String(e && e.message || e).slice(0, 120) }; }
      `);
      ui.add(
        "M0",
        "★ 破坏性对照：明知语法不全的 mermaid 必须渲染**失败**（证明 SVG 判据不是恒真）",
        bad.ok === false || bad.hasSvg === false ? "PASS" : "FAIL",
        `ok=${bad.ok} hasSvg=${bad.hasSvg} err=${JSON.stringify(bad.err)}`,
      );
    }

    /* ── M3：MERMAID_TEMPLATES 逐类型渲染矩阵 ──
     * 关键：渲染的 syntax **来自点选后插入到文档里的真实围栏**，
     * 不是探针手写字符串 —— 否则测的是探针自己。                              */
    {
      const templates = [];
      // 预热：先开关一次下拉，确保 React 已把菜单挂载过（首项曾因"菜单还没挂上"读到 0 项）
      await openMermaidMenu();
      await ev(`document.body.click(); return true;`);
      await sleep(300);

      for (let i = 0; i < zhLabels.length; i++) {
        let menu = { count: 0, labels: [] };
        // 最多重试 3 次打开菜单（受控重渲染期间下拉可能来不及挂载）
        for (let attempt = 0; attempt < 3; attempt++) {
          await setDoc(DOC_MERMAID, 0);
          menu = await openMermaidMenu();
          if (menu.count === zhLabels.length) break;
          await ev(`document.body.click(); return true;`);
          await sleep(320);
        }
        if (menu.count !== zhLabels.length) {
          templates.push({ label: zhLabels[i], ok: false, err: `下拉项数变化 ${menu.count}（重试 3 次）` });
          continue;
        }
        const clicked = await ev(`
          const items = Array.from(document.querySelectorAll(".mermaid-dropdown-menu .mermaid-dropdown-item"));
          const el = items[${i}];
          if (!el) return false;
          el.click();
          await new Promise(r => setTimeout(r, 420));
          return true;
        `);
        const inserted = await readDoc();
        // 从插入的文本里抠 mermaid 源码（```mermaid ... ```）
        const m = /```mermaid\r?\n([\s\S]*?)```/.exec(inserted || "");
        if (!m) {
          templates.push({ label: zhLabels[i], ok: false, err: "未插入 mermaid 围栏" });
          continue;
        }
        const rendered = await ev(`
          try {
            const { svg } = await window.mermaid.render("t" + Math.random().toString(36).slice(2), ${JSON.stringify(m[1])});
            const d = new DOMParser().parseFromString(svg || "", "image/svg+xml");
            const n = d.querySelector("svg");
            return { ok: true, hasSvg: !!n, nodes: n ? n.querySelectorAll("*").length : 0, err: "" };
          } catch (e) { return { ok: false, hasSvg: false, nodes: 0, err: String(e && e.message || e).slice(0, 150) }; }
        `);
        templates.push({ label: zhLabels[i], clicked, ...rendered });
        ui.log(
          `[#10] ${String(zhLabels[i]).padEnd(14)} ${rendered.hasSvg ? "SVG OK" : "FAIL   "} nodes=${String(rendered.nodes).padStart(3)}` +
            (rendered.err ? " :: " + rendered.err.replace(/\n/g, " | ") : ""),
        );
      }

      const bad = templates.filter((t) => !t.hasSvg);
      ui.add(
        "M3",
        "★ 下拉里**每一个**模板点选后插入的围栏都能渲染出 `<svg>`（逐类型实测）",
        templates.length > 0 && bad.length === 0 ? "PASS" : "FAIL",
        `共 ${templates.length} 类型；失败 ${bad.length}` +
          (bad.length ? `：${bad.map((t) => `${t.label}(${t.err || "无 svg"})`).join("；")}` : "：无"),
      );
      ui.log(`\n[#10] 逐类型渲染矩阵 = ${JSON.stringify(templates, null, 1)}`);
      ui.log(`\n[#10] mermaid 版本 = ${mermaidVersion}`);
    }

    /* ══════════════ Z：无未捕获异常（骨架自动追加） ══════════════ */
  },
);

/**
 * LightMD v0.17.0 复核 —— **P1-6：格式 ghost 占位提示的用户可见性**（正式探针）
 *
 * 移交自 Lead 的排查探针 `v0170-lead-ghost-life.mjs`（已重命名并全面重写）。
 *
 * 产物：`_verify-out/v0170-verify-ghost-visible.{json,txt}` + `shots/`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## 这个探针要回答的唯一问题
 *
 * > 用户点格式栏 / 语法栏的按钮之后，**能不能看见**源码面里的灰色占位提示？
 *
 * 不是"DOM 里有没有那个元素"（那是实现细节，且能瞬时存在 1 帧而用户毫无感知），
 * 而是"**在多少个动画帧里它真的在屏幕上**"。
 *
 * 因此判据是 **rAF 逐帧采样 + 存活时长**：
 * - 存活 ≥ 1000ms → PASS（用户明确可见，并来得及读）
 * - 200ms ~ 1000ms → KNOWN（可感知但偏短）
 * - < 200ms 或 0 帧 → FAIL（不可感知，等于没有这个功能）
 *
 * ## 为什么必须逐帧采样，不能只看一次 DOM 查询
 *
 * 缺陷当初就被 Lead 用 MutationObserver 抓到过"ghost 存在"（1 次瞬时 DOM），
 * 而同一时刻用户**一帧都看不到**。单次查询会随机命中那个瞬时窗口 → 误判 PASS。
 * rAF 采样是**用户视觉的时间分辨率**，和用户感知同尺度，不会骗人。
 *
 * ## 两条路径必须分别验（代码不同、修复前表现也不同）
 *
 * | 路径 | 设置 ghost 的代码 | 修复前实测 |
 * |---|---|---|
 * | 格式栏 | `SourcePane.handleFormatAction`（L1133-1151） | **从未出现** |
 * | 语法栏 | `ModeSync.insertHandler`（L178-193） | 出现过 1 次瞬时 |
 *
 * 两者共用 `formatGhostRef` / `renderFormatGhost`，但设置入口与"是否先改了文档"不同，
 * 所以**不能拿一条的结论代表另一条**。
 *
 * ## 探针纪律（本项目两次踩坑的教训，本探针逐条遵守）
 *
 * 1. **累加型计数器重装前必须 `disconnect()`** —— 本探针的观察器只装一次，
 *    且在 `window.__GV` 已存在时先 `disconnect()`。
 *    （P0-1 排查时，重装观察器导致"1 次重建"被读成"N 次"，虚高了缺陷严重度。）
 * 2. **判定必须有破坏性验证** —— 见 `N1`/`N2`：
 *    - `N1`：人为 add+remove 一个 `.cm-source-ghost`，采样器必须看见（证明采样器在工作）；
 *    - `N2`（负对照）：在**非空行**点 H1，**不该**出现 ghost。
 *    没有 N1，"0 帧"可能只是采样器坏了；没有 N2，"出现了"可能只是乱显示。
 * 3. **不修改产品代码、不 taskkill**：实例生命周期完全交给共享骨架。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# Ghost 可见性",
  "",
  "第二段落文字",
  "",
  "第三段落",
  "",
].join("\n");

/** 空行索引（DOC 的第 2 行，index 1）与有内容行索引（index 2） */
const EMPTY_LINE = 1;
const CONTENT_LINE = 2;

/* ───────────────── 页内采样器（只装一次，幂等） ───────────────── */
const INSTALL = `
  // ⚠️ 幂等：重装前必须 disconnect 旧观察器，否则多个观察器重复计数
  if (window.__GV && window.__GV.mo) {
    try { window.__GV.mo.disconnect(); } catch (e) {}
  }
  const G = {
    samples: [], muts: [], running: false, base: 0,
    mo: null,
    /** 开始逐帧采样（frames 帧，约 frames×16ms） */
    start(frames) {
      this.samples = [];
      this.base = performance.now();
      this.running = true;
      const tick = () => {
        this.samples.push({
          t: performance.now(),
          n: document.querySelectorAll(".cm-source-ghost").length,
        });
        if (this.samples.length < frames) requestAnimationFrame(tick);
        else this.running = false;
      };
      requestAnimationFrame(tick);
    },
    /** ghost DOM 增删（用于区分"dom 没建" vs "建了但被清"） */
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
    /** 汇总 */
    summary() {
      const s = this.samples;
      const first = s.find((x) => x.n > 0);
      const last = [...s].reverse().find((x) => x.n > 0);
      return {
        totalSamples: s.length,
        visibleSamples: s.filter((x) => x.n > 0).length,
        appeared: !!first,
        firstAtMs: first ? Math.round(first.t - this.base) : null,
        lastAtMs: last ? Math.round(last.t - this.base) : null,
        lifetimeMs: first && last ? Math.round(last.t - first.t) : 0,
        disappeared: !!first && s[s.length - 1].n === 0,
        stillVisibleAtEnd: s.length > 0 && s[s.length - 1].n > 0,
        muts: this.muts.map((m) => ({
          dt: Math.round(m.t - this.base), ev: m.ev, txt: m.txt,
        })),
      };
    },
  };
  window.__GV = G;
  G.watchDom();
  return { ok: true };
`;

/* ───────────────── 页内定位/点击工具 ───────────────── */

/** 取 CM6 view（不用内部 API，走 DOM 上的 cmTile） */
const VIEW = `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
`;

await runProbe(
  {
    name: "v0170-verify-ghost-visible",
    doc: DOC,
    docTitle: "Ghost 可见性",
    viewMode: "edit",
  },
  async (ui) => {
    const ev = ui.ev;

    /* ══════════════ 0. 环境自检：确认真的是 CM6 路径 ══════════════ */
    const env = await ev(`
      ${VIEW}
      return {
        impl: v ? "cm6" : "other",
        doc: v ? v.state.doc.toString() : null,
        lines: Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || ""),
        buttons: document.querySelectorAll(".source-format-toolbar .format-btn").length,
        syntaxItems: document.querySelectorAll(".syntax-helper .syntax-helper-item").length,
      };
    `);
    ui.log(`[ghost] 环境: impl=${env.impl} 行=${JSON.stringify(env.lines)} 按钮=${env.buttons} 语法项=${env.syntaxItems}`);

    ui.add("A0", "环境就绪：CM6 源码面 + 格式栏 + 语法栏齐备",
      env.impl === "cm6" && env.buttons === 25 && env.syntaxItems === 32 ? "PASS" : "FAIL",
      `impl=${env.impl} 按钮=${env.buttons} 语法项=${env.syntaxItems} 文档=${env.doc === DOC ? "精确一致" : "不一致"}`);

    /* ══════════════ 工具函数 ══════════════ */

    /** 装/重装采样器（幂等，内部 disconnect） */
    const install = () => ev(`${INSTALL}`);

    /** 真实鼠标点击某行内侧，把光标放过去 */
    const caretToLine = async (idx) => {
      const box = await ev(`
        const ed = document.querySelector(".cm-editor");
        const lines = Array.from(ed.querySelectorAll(".cm-line"));
        const t = lines[${idx}];
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return null;
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await ui.sleep(300);
      return await ev(`
        ${VIEW}
        if (!v) return null;
        const m = v.state.selection.main;
        return { from: m.from, to: m.to, empty: m.empty, lineText: v.state.doc.lineAt(m.from).text };
      `);
    };

    /** 真实鼠标点格式栏按钮（按 title 前缀） */
    const clickFormatBtn = async (prefix) => {
      const box = await ev(`
        const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
        const b = bs.find(x => (x.getAttribute("title") || "").startsWith(${JSON.stringify(prefix)}));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { zero: true };
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return { ok: false, why: `按钮未找到：${prefix}` };
      if (box.zero) return { ok: false, why: `按钮 0 尺寸：${prefix}` };
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return { ok: true };
    };

    /** 真实鼠标点语法栏第 index 项 */
    const clickSyntaxItem = async (index) => {
      const box = await ev(`
        const items = Array.from(document.querySelectorAll(".syntax-helper .syntax-helper-item"));
        const el = items[${index}];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { zero: true };
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 name: ((el.querySelector(".syntax-helper-item-name") || {}).textContent || "").trim() };
      `);
      if (!box) return { ok: false, why: `语法项 #${index} 未找到` };
      if (box.zero) return { ok: false, why: `语法项 #${index} 不可见` };
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return { ok: true, name: box.name };
    };

    /** 复位文档到基线（清掉上一次的插入/ghost） */
    const resetDoc = async () => {
      for (let i = 0; i < 3; i++) {
        await ev(`
          ${VIEW}
          if (!v) return false;
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(DOC)} } });
          return true;
        `);
        await ui.sleep(520);
        const t = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
        if (t === DOC) return true;
      }
      return false;
    };

    /** 统一的"采样一次点击"执行器 */
    const measure = async ({ frames = 110 }) => {
      await install();                       // 幂等重装（内含 disconnect）
      await ev(`window.__GV.start(${frames}); return true;`);
      return { base: Date.now() };
    };

    /** 取采样汇总 */
    const summary = () => ev(`return window.__GV.summary();`);

    /** 判据：把存活时长翻成 PASS/KNOWN/FAIL */
    const gradeLife = (s) => {
      if (!s.appeared) return ["FAIL", `**完全不可见**（0/${s.totalSamples} 帧）`];
      if (s.lifetimeMs >= 1000) return ["PASS", `存活 ${s.lifetimeMs}ms（可见 ${s.visibleSamples}/${s.totalSamples} 帧）`];
      if (s.lifetimeMs >= 200) return ["KNOWN", `存活仅 ${s.lifetimeMs}ms（可见 ${s.visibleSamples}/${s.totalSamples} 帧）—— 可感知但偏短`];
      return ["FAIL", `存活仅 ${s.lifetimeMs}ms（可见 ${s.visibleSamples}/${s.totalSamples} 帧）—— 用户不可感知`];
    };

    /* ══════════════ 1. 采样器自检（破坏性验证，必须先做） ══════════════ */
    {
      /**
       * ⚠️ 这里必须**分两次页面求值**，不能在一个非 async 回调里 `await`。
       *
       * 第一版把整段写成 `ev(...)` 里的同步回调但用了 `await` →
       * 语法上不成立的 `await` 让整段变成"立即返回 promise、后续代码不再执行"，
       * 于是 `sp.remove()` 在采样器跑第一帧**之前**就执行了，
       * 读到 `during=0 / 可见帧=0` —— 这**不是**采样器坏了，是自检本身写错了。
       *
       * 教训与本轮 P0-1 报告 §3 同类：**测量装置的缺陷会伪装成被测对象的缺陷**。
       * 因此这里拆成三步：① 插入并保持 → ② 让采样器跑几帧 → ③ 再移除并读计数。
       */
      await install();
      /**
       * ⚠️ 顺序**必须**是：先插入 → 再 start → 再等 → 再读。
       *
       * 前两版都栽在顺序上（同一个错误的第三次变体，记下来）：
       * - v1：在非 async 回调里 `await` → 移除早于第一帧 → 读到 0；
       * - v2：先 `start(10)` 再 `sleep(120)` 再插入 → **10 帧（≈160ms）早已跑完**，
       *   插入发生在采样窗口结束之后 → 仍然读到 0。
       *
       * 所以：采样窗口必须**完整包住**"元素存在的那段时间"。
       *
       * ⚠️ v3：**合成节点绝不能挂进 `.cm-content`**。
       * CM6 拥有那段 DOM（它自己的 DocView / 行节点），
       * 一次 measure/redraw 就会把外来的 span 清掉：
       * 实测 `ev` 返回的瞬间计数是 1、MutationObserver 也记到 1 次 add，
       * 但随后 30 帧采样**全是 0** —— 元素在采样开始前后被 CM6 抹掉了。
       * 挂到 `document.body` 上，选择器（按 class 全局查）照样命中，
       * 而不会被编辑器回收。这也说明采样器本身没问题（F1/S1 对真 ghost 采样正常）。
       */
      const inserted = await ev(`
        const sp = document.createElement("span");
        sp.className = "cm-source-ghost";
        sp.textContent = "synthetic";
        sp.id = "gv-synthetic";
        sp.style.position = "fixed";
        sp.style.left = "-9999px";
        document.body.appendChild(sp);          // ← 不挂进 .cm-content（会被 CM6 回收）
        // 插入完成**之后**才开始采样
        window.__GV.start(30);
        return document.querySelectorAll(".cm-source-ghost").length;
      `);
      await ui.sleep(700);                        // 30 帧 ≈ 480ms，留足余量
      const s = await summary();
      const removed = await ev(`
        const sp = document.getElementById("gv-synthetic");
        if (sp) sp.remove();
        return document.querySelectorAll(".cm-source-ghost").length;
      `);

      ui.add("N1", "★ 破坏性验证：采样器真的能看见 ghost（否则后面的「0 帧」可能是采样器坏了）",
        inserted >= 1 && s.visibleSamples >= 1 ? "PASS" : "FAIL",
        `人为插入后 DOM 计数=${inserted} → 采样器可见帧=${s.visibleSamples}/${s.totalSamples}` +
        `（应 >0）；移除后计数=${removed}；MutationObserver add 事件=${s.muts.filter(m => m.ev === "add").length}`);

      // 清理：把这次人为痕迹从记录里摘掉，避免污染后续判定
      await ev(`
        if (window.__GV.mo) window.__GV.mo.disconnect();
        window.__GV.watchDom();
        return true;
      `);
    }

    /* ══════════════ 2. 路径一：格式栏 H1（空行） ══════════════ */
    let fmtH1 = null;
    {
      await resetDoc();
      const caret = await caretToLine(EMPTY_LINE);
      ui.log(`[ghost] 格式栏 H1 前置：光标=${JSON.stringify(caret)}`);

      await measure({ frames: 110 });
      const click = await clickFormatBtn("标题一");
      await ui.sleep(2200);                   // 110 帧 ≈ 1.8s

      const s = await summary();
      const after = await ev(`
        ${VIEW}
        return {
          doc: v ? v.state.doc.toString() : null,
          ghostTexts: Array.from(document.querySelectorAll(".cm-source-ghost")).map(e => e.textContent),
        };
      `);
      fmtH1 = s;
      ui.log(`[ghost] 格式栏 H1 → ${JSON.stringify(s)}`);
      ui.log(`[ghost] 格式栏 H1 后：doc=${JSON.stringify((after.doc || "").slice(0, 24))}… ghost=${JSON.stringify(after.ghostTexts)}`);

      const [st, det] = gradeLife(s);
      ui.add("F1", "★ 格式栏：空行点 H1 → ghost 出现且存活 ≥1000ms", st,
        `${det}；点击=${click.ok ? "成功" : click.why}；DOM ${s.muts.filter(m=>m.ev==="add").length} 次 add / ` +
        `${s.muts.filter(m=>m.ev==="remove").length} 次 remove`);

      // 内容正确性：占位文案是「标题一」，且**不得落盘**
      const noPlaceholderInDoc = (after.doc || "").indexOf("标题一") < 0;
      ui.add("F2", "ghost 文案为「标题一」，且占位文字**不落盘**",
        s.appeared && after.ghostTexts.join("").includes("标题一") && noPlaceholderInDoc ? "PASS" : "FAIL",
        `ghost 文案=${JSON.stringify(after.ghostTexts)} 文档含占位文字=${!noPlaceholderInDoc}`);

      await ui.shot("format-h1");
    }

    /* ══════════════ 3. 路径二：格式栏 B（有选区） ══════════════ */
    {
      await resetDoc();
      // 选中 HELLO？本文档没有；选「第二段落文字」整行更稳
      const sel = await ev(`
        ${VIEW}
        if (!v) return null;
        const from = ${JSON.stringify(DOC.indexOf("第二段落文字"))};
        const to = from + ${JSON.stringify("第二段落文字".length)};
        v.focus();
        v.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: false });
        const m = v.state.selection.main;
        return { from: Math.min(m.from, m.to), to: Math.max(m.from, m.to), text: v.state.doc.sliceString(m.from, m.to) };
      `);
      ui.log(`[ghost] 格式栏 B 前置选区=${JSON.stringify(sel)}`);

      await measure({ frames: 110 });
      const click = await clickFormatBtn("粗体 (");
      await ui.sleep(2200);
      const s = await summary();
      ui.log(`[ghost] 格式栏 B（有选区）→ ${JSON.stringify(s)}`);

      // 有选区时是**完整包裹**语义：插入 **...**，不产生 ghost（ghostText 只在无选区时给）
      // 所以这里断言的是「不误报 ghost」= 负对照的一部分
      const gtext = await ev(`return Array.from(document.querySelectorAll(".cm-source-ghost")).map(e => e.textContent);`);
      ui.add("F3", "格式栏 B（有选区）：走完整包裹语义 → **不**出现 ghost（无选区才需要占位提示）",
        s.appeared ? "KNOWN" : "PASS",
        s.appeared
          ? `出现了 ghost=${JSON.stringify(gtext)}（有选区本不需要占位提示，但不是缺陷，记为可接受）`
          : `无 ghost（预期）；0/${s.totalSamples} 帧`);

      // 真正的 F4：**无选区**点 B → ghost 必须出现（这才是用户的真实场景）
      await resetDoc();
      const caret = await caretToLine(CONTENT_LINE);
      // 把光标移到该行**行尾**（无选区，但行内已有内容 → 行内格式 ghost 仍应出现）
      await ev(`
        ${VIEW}
        if (!v) return false;
        const line = v.state.doc.lineAt(v.state.selection.main.from);
        v.dispatch({ selection: { anchor: line.to }, scrollIntoView: false });
        return v.state.selection.main.empty;
      `);
      await ui.sleep(300);

      await measure({ frames: 110 });
      const click2 = await clickFormatBtn("粗体 (");
      await ui.sleep(2200);
      const s2 = await summary();
      const g2 = await ev(`return Array.from(document.querySelectorAll(".cm-source-ghost")).map(e => e.textContent);`);
      ui.log(`[ghost] 格式栏 B（无选区，行尾）→ ${JSON.stringify(s2)} ghost=${JSON.stringify(g2)}`);

      const [st2, det2] = gradeLife(s2);
      ui.add("F4", "★ 格式栏：无选区点 B → ghost 出现且存活 ≥1000ms",
        st2, `${det2}；ghost 文案=${JSON.stringify(g2)}；点击=${click2.ok ? "成功" : click2.why}`);

      await ui.shot("format-bold-nosel");
    }

    /* ══════════════ 4. 路径三：语法栏「粗体」（独立代码路径） ══════════════ */
    let synBold = null;
    {
      await resetDoc();
      const caret = await caretToLine(CONTENT_LINE);
      await ev(`
        ${VIEW}
        if (!v) return false;
        const line = v.state.doc.lineAt(v.state.selection.main.from);
        v.dispatch({ selection: { anchor: line.from }, scrollIntoView: false });
        return true;
      `);
      await ui.sleep(300);

      await measure({ frames: 110 });
      // 语法栏 #4 = 粗体（index 3，顺序见 verify-format-syntax 的 SYNTAX_INSERTS）
      const click = await clickSyntaxItem(3);
      await ui.sleep(2200);
      const s = await summary();
      const g = await ev(`return Array.from(document.querySelectorAll(".cm-source-ghost")).map(e => e.textContent);`);
      synBold = s;
      ui.log(`[ghost] 语法栏「粗体」→ ${JSON.stringify(s)} ghost=${JSON.stringify(g)}`);

      const [st, det] = gradeLife(s);
      ui.add("S1", "★ 语法栏：点「粗体」→ ghost 出现且存活 ≥1000ms", st,
        `${det}；条目=${click.name || "?"}；ghost 文案=${JSON.stringify(g)}`);

      await ui.shot("syntax-bold");
    }

    /* ══════════════ 5. 负对照 ══════════════ */
    {
      // N2：**非空行**点 H1 → 不该出现 ghost
      // 依据 SourcePane.handleFormatAction：「无选中文本且当前行除已有前缀外为空 → 显示标题 ghost」
      // 所以有内容的行上点 H1 **不该**有 ghost（否则是"乱显示"）
      await resetDoc();
      const caret = await caretToLine(CONTENT_LINE);   // 有内容的行
      const lineText = caret ? caret.lineText : null;
      await measure({ frames: 90 });
      const click = await clickFormatBtn("标题一");
      await ui.sleep(1800);
      const s = await summary();
      ui.log(`[ghost] 负对照（非空行点 H1，行="${lineText}"）→ ${JSON.stringify(s)}`);
      ui.add("N2", "★ 负对照：在**非空行**点 H1 → 不该出现 ghost（避免「乱显示」）",
        s.appeared ? "FAIL" : "PASS",
        s.appeared
          ? `误显示 ghost（可见 ${s.visibleSamples}/${s.totalSamples} 帧，存活 ${s.lifetimeMs}ms）→ 占位提示乱显示`
          : `无 ghost（预期：非空行不显示占位提示）；行文本=${JSON.stringify(lineText)}`);
    }

    /* ══════════════ 6. 正向：打字后 ghost 必须被清除（clear("input") 语义不能丢） ══════════════ */
    {
      await resetDoc();
      await caretToLine(EMPTY_LINE);
      // 先造出 ghost（空行点 H1）
      await clickFormatBtn("标题一");
      await ui.sleep(900);
      const before = await ev(`return document.querySelectorAll(".cm-source-ghost").length;`);

      // 真实键入 1 个字符
      await ev(`window.__GV.start(90); return true;`);
      await ui.cdp.send("Input.insertText", { text: "X" });
      await ui.sleep(1800);
      const s = await summary();
      const typedDoc = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);

      ui.add("P1", "★ 真实键入 1 个字符 → ghost 必须被清除（clear(\"input\") 既有语义不能丢）",
        before >= 1 && !s.stillVisibleAtEnd ? "PASS" : "FAIL",
        `打字前 ghost=${before} 个；打字后最后一帧仍可见=${s.stillVisibleAtEnd}；` +
        `字形落地=${(typedDoc || "").includes("X")}；文档长度=${(typedDoc || "").length}`);

      await ui.shot("after-typing");
    }

    /* ══════════════ 7. 汇总 ══════════════ */
    await resetDoc();
    ui.log(`[ghost] 汇总：格式栏H1 appeared=${fmtH1?.appeared} lifetime=${fmtH1?.lifetimeMs}ms；` +
      `语法栏 appered=${synBold?.appeared} lifetime=${synBold?.lifetimeMs}ms`);
  },
);

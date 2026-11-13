/**
 * v0.17.0 第二轮：12 项用户报告的**基线测量**（浏览器内，dist）
 *
 * 先量现状再定修法。每项独立 try/catch。
 * 覆盖：#1 插入符号 / #4 专注遮罩 / #5 页面框线 / #11 过渡动画 / #12 预览开合抖动
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 基线", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.`, "");
}
const DOC = parts.join("\n");

await runBrowserProbe({ name: "v0170-r2-base-a", doc: DOC }, async (ui) => {
  /* ── #1 插入符号 ─────────────────────────────────────────── */
  try {
    await ui.focusSource();
    await ui.key("x", "KeyX", 88);
    await ui.sleep(500);
    const caret = await ui.ev(`
      const ed = document.querySelector(".cm-editor");
      const cur = document.querySelector(".cm-cursor");
      const content = document.querySelector(".cm-content");
      const edCs = getComputedStyle(ed);
      const curCs = cur ? getComputedStyle(cur) : null;
      const rootCs = getComputedStyle(document.documentElement);
      // 找出所有含 cm-cursor 的选择器规则（诊断优先级来源）
      const rules = [];
      for (const ss of document.styleSheets) {
        let rs; try { rs = ss.cssRules; } catch { continue; }
        for (const r of rs) {
          const t = r.selectorText || "";
          if (t.includes("cm-cursor")) rules.push({ sel: t, css: r.style.cssText.slice(0,160), href: ss.href ? "link" : "inline" });
        }
      }
      return {
        hasCursorEl: !!cur,
        cursorBorderColor: curCs ? curCs.borderLeftColor : null,
        cursorBorderWidth: curCs ? curCs.borderLeftWidth : null,
        cursorDisplay: curCs ? curCs.display : null,
        cursorRect: cur ? (r => ({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}))(cur.getBoundingClientRect()) : null,
        cursorColor: curCs ? curCs.color : null,
        contentCaretColor: content ? getComputedStyle(content).caretColor : null,
        editorColor: edCs.color,
        editorBg: edCs.backgroundColor,
        themeAttr: document.documentElement.getAttribute("data-theme"),
        textPrimaryVar: rootCs.getPropertyValue("--text-primary").trim(),
        focused: ed.classList.contains("cm-focused"),
        rules: rules.slice(0, 12),
      };
    `);
    ui.log("[#1] " + JSON.stringify(caret, null, 0));
    const cb = String(caret.cursorBorderColor || "");
    const m = /rgba?\((\d+), (\d+), (\d+)/.exec(cb);
    const lum = m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : null;
    ui.add("1", "插入符号元素可取到", caret.hasCursorEl ? "PASS" : "FAIL", `display=${caret.cursorDisplay} rect=${JSON.stringify(caret.cursorRect)}`);
    ui.add("2", "★ 插入符号亮度（0=黑 255=白）",
      lum == null ? "FAIL" : lum >= 240 ? "FAIL" : lum <= 120 ? "PASS" : "KNOWN",
      `border=${cb} 平均亮度=${lum}；主题=${caret.themeAttr} --text-primary=${caret.textPrimaryVar}`);
    ui.add("3", "插入符号与背景对比度足够",
      lum == null ? "FAIL" : Math.abs(lum - 255) > 90 ? "PASS" : "FAIL",
      `光标亮度 ${lum} vs 背景 ${caret.editorBg}`);
    await ui.shot("caret");
  } catch (e) {
    ui.add("1", "#1 插入符号", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── #5 页面框线与右屏篇幅 ─────────────────────────────────── */
  try {
    const geo = await ui.ev(`
      const round = (n) => Math.round(n);
      const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return {x:round(r.left),y:round(r.top),w:round(r.width),h:round(r.height)}; };
      const ed = document.querySelector(".cm-editor");
      const host = document.querySelector(".source-editor-cm6");
      const wrap = document.querySelector(".source-editor-wrapper");
      const shell = document.querySelector(".split-preview-shell");
      const area = document.querySelector(".editor-main-area");
      const scroller = document.querySelector(".cm-scroller");
      const cs = ed ? getComputedStyle(ed) : null;
      const hostCs = host ? getComputedStyle(host) : null;
      const scrCs = scroller ? getComputedStyle(scroller) : null;
      return {
        outline: cs ? cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor : null,
        area: R(area), wrapper: R(wrap), host: R(host), editor: R(ed), scroller: R(scroller), shell: R(shell),
        hostPad: hostCs ? hostCs.paddingLeft + " / " + hostCs.paddingRight : null,
        scrPad: scrCs ? scrCs.paddingLeft + " / " + scrCs.paddingRight : null,
      };
    `);
    ui.log("[#5] " + JSON.stringify(geo));
    const a = geo.area, w = geo.wrapper, e = geo.editor, s = geo.shell, h = geo.host;
    ui.add("4", "页面框线（outline）存在", String(geo.outline || "").includes("none") ? "KNOWN" : "PASS", `outline=${geo.outline}`);
    ui.add("5", "★ 框线围成的高度接近右分屏",
      s && e ? (Math.abs(e.h - s.h) <= 8 ? "PASS" : "FAIL") : "FAIL",
      `编辑框高 ${e?.h} vs 右屏高 ${s?.h}（差 ${e && s ? e.h - s.h : "?"}px）`);
    ui.add("6", "★ 框线围成的宽度 vs 左栏可用宽（是否被双重内边距挤窄）",
      w && e ? (Math.abs(e.w - w.w) <= 8 ? "PASS" : "FAIL") : "FAIL",
      `编辑框宽 ${e?.w} vs 左栏宽 ${w?.w}（差 ${w && e ? e.w - w.w : "?"}px）；宿主内边距=${geo.hostPad} 滚动容器内边距=${geo.scrPad}`);
    ui.add("7", "左栏与右屏的垂直起止一致",
      e && s ? (Math.abs(e.y - s.y) <= 8 && Math.abs(e.h - s.h) <= 20 ? "PASS" : "FAIL") : "FAIL",
      `编辑框 y=${e?.y} h=${e?.h} ｜ 右屏 y=${s?.y} h=${s?.h}`);
    await ui.shot("frame");
  } catch (e) {
    ui.add("4", "#5 页面框线", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── #4 专注遮罩跟随光标 ─────────────────────────────────── */
  try {
    await ui.key("F8", "F8", 119);
    await ui.sleep(700);
    let overlayOn = await ui.ev(`
      const ov = document.querySelector(".source-focus-overlay");
      return { exists: !!ov, bi: ov ? ov.style.backgroundImage.slice(0,120) : null };
    `);
    ui.log("[#4] overlay = " + JSON.stringify(overlayOn));
    if (!overlayOn.exists) {
      await ui.command("toggleFocusMode");
      await ui.sleep(600);
      overlayOn = await ui.ev(`
        const ov = document.querySelector(".source-focus-overlay");
        return { exists: !!ov, bi: ov ? ov.style.backgroundImage.slice(0,120) : null };
      `);
      ui.log("[#4] overlay(2) = " + JSON.stringify(overlayOn));
    }

    const samples = [];
    for (const lineText of ["PI06", "PI14", "PI24"]) {
      const r = await ui.ev(`
        const lines = Array.from(document.querySelectorAll(".cm-line"));
        const t = lines.find(l => (l.textContent||"").includes(${JSON.stringify(lineText)}));
        if (!t) return { ok:false };
        const rect = t.getBoundingClientRect();
        return { ok:true, x: Math.round(rect.left + 3), y: Math.round(rect.top + rect.height/2), top: Math.round(rect.top) };
      `);
      if (!r?.ok) { samples.push({ lineText, ok: false }); continue; }
      await ui.click(r.x, r.y);
      await ui.sleep(600);
      const s = await ui.ev(`
        const ov = document.querySelector(".source-focus-overlay");
        const bi = ov ? ov.style.backgroundImage : "";
        const tm = /transparent ([0-9.]+)px,\\s*transparent ([0-9.]+)px/.exec(bi);
        const sc = document.querySelector(".cm-scroller");
        const caret = document.querySelector(".cm-cursor");
        const scR = sc.getBoundingClientRect();
        const cr = caret ? caret.getBoundingClientRect() : null;
        const ovR = ov ? ov.getBoundingClientRect() : null;
        // 高亮窗相对 overlay 的顶点
        const winRel = tm ? [Number(tm[1]), Number(tm[2])] : null;
        // 光标相对 overlay 的顶点
        const caretRel = cr && ovR ? [Math.round(cr.top - ovR.top), Math.round(cr.bottom - ovR.top)] : null;
        return {
          win: winRel, caretRel,
          overlayTop: ovR ? Math.round(ovR.top) : null,
          overlayH: ovR ? Math.round(ovR.height) : null,
          winCenter: winRel ? Math.round((winRel[0]+winRel[1])/2) : null,
          overlayCenter: ovR ? Math.round(ovR.height/2) : null,
          biHead: bi.slice(0, 160),
        };
      `);
      samples.push({ lineText, ok: true, ...s });
      ui.log(`[#4] ${lineText} → win=${JSON.stringify(s.win)} caretRel=${JSON.stringify(s.caretRel)} 窗中心=${s.winCenter} 视口中心=${s.overlayCenter}`);
    }

    const withWin = samples.filter((x) => x.ok && x.win);
    const follow = withWin.filter((x) => x.caretRel && x.caretRel[0] >= x.win[0] - 6 && x.caretRel[1] <= x.win[1] + 6);
    const fixedCenter = withWin.filter((x) => x.winCenter != null && x.overlayCenter != null && Math.abs(x.winCenter - x.overlayCenter) <= 6);
    ui.add("8", "专注遮罩开窗跟随光标",
      follow.length >= 2 ? "PASS" : "FAIL",
      `${follow.length}/${withWin.length} 个位置光标落在窗内；详情=${JSON.stringify(withWin.map((s) => ({ at: s.lineText, win: s.win, caret: s.caretRel, winC: s.winCenter, viewC: s.overlayCenter })))}`);
    ui.add("9", "★ 遮罩是否固定在视口居中（用户报告的缺陷形态）",
      fixedCenter.length >= 2 && follow.length < 2 ? "FAIL" : "PASS",
      `固定居中样本 ${fixedCenter.length}/${withWin.length}，跟随样本 ${follow.length}`);
    await ui.shot("focus");
    await ui.key("F8", "F8", 119);
    await ui.sleep(400);
  } catch (e) {
    ui.add("8", "#4 专注遮罩", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── #11 模式切换过渡 ───────────────────────────────────── */
  try {
    const traceMode = async (targetCmd, selector) => {
      await ui.ev(`
        window.__ANIM = [];
        const t0 = performance.now();
        const tick = () => {
          const area = document.querySelector(".editor-main-area");
          const el = document.querySelector(${JSON.stringify(selector)});
          const cs = el ? getComputedStyle(el) : null;
          window.__ANIM.push({
            t: Math.round(performance.now() - t0),
            attr: area ? area.getAttribute("data-lmd-mode-anim") : null,
            anim: cs ? cs.animationName : null,
            tr: cs ? cs.transform : null,
          });
          if (performance.now() - t0 < 900) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
      `);
      await ui.command(targetCmd);
      await ui.sleep(1300);
      return await ui.ev(`
        const a = window.__ANIM || [];
        const withAttr = a.filter(x => x.attr);
        const withAnim = a.filter(x => x.anim && x.anim !== "none");
        const trs = [...new Set(a.map(x => x.tr).filter(t => t && t !== "none"))];
        return {
          n: a.length, attrN: withAttr.length, attrVals: [...new Set(withAttr.map(x => x.attr))],
          animN: withAnim.length, animNames: [...new Set(withAnim.map(x => x.anim))],
          transforms: trs.slice(0, 8),
          firstAttrAt: withAttr.length ? withAttr[0].t : null,
        };
      `);
    };

    const toRead = await traceMode("view.preview", ".editor-container");
    ui.log("[#11] 编辑→阅读 " + JSON.stringify(toRead));
    ui.add("10", "★ 编辑→阅读 有模式切换过渡",
      toRead.attrN > 0 && toRead.animN > 0 ? "PASS" : "FAIL",
      `属性样本 ${toRead.attrN}/${toRead.n} 值=${JSON.stringify(toRead.attrVals)}；动画样本 ${toRead.animN} 名称=${JSON.stringify(toRead.animNames)}；transform 取值 ${toRead.transforms.length}`);

    const toEdit = await traceMode("view.edit", ".source-editor-wrapper");
    ui.log("[#11] 阅读→编辑 " + JSON.stringify(toEdit));
    ui.add("11", "★ 阅读→编辑 有模式切换过渡",
      toEdit.attrN > 0 && toEdit.animN > 0 ? "PASS" : "FAIL",
      `属性样本 ${toEdit.attrN}/${toEdit.n} 值=${JSON.stringify(toEdit.attrVals)}；动画样本 ${toEdit.animN} 名称=${JSON.stringify(toEdit.animNames)}；transform 取值 ${toEdit.transforms.length}`);
  } catch (e) {
    ui.add("10", "#11 模式切换过渡", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── #12 预览开合宽度抖动 ────────────────────────────────── */
  try {
    await ui.sleep(800);
    const measure = async () => ui.ev(`
      const line = document.querySelector(".cm-line");
      const sc = document.querySelector(".cm-scroller");
      const lnR = line ? line.getBoundingClientRect() : null;
      return {
        lineLeft: lnR ? Math.round(lnR.left) : null,
        lineW: lnR ? Math.round(lnR.width) : null,
        scrollTop: sc ? Math.round(sc.scrollTop) : null,
        max: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : null,
        clientW: sc ? Math.round(sc.clientWidth) : null,
        txtLeft: (() => { const t = document.querySelector(".cm-line"); return t ? Math.round(t.getBoundingClientRect().left) : null; })(),
        scrollH: sc ? sc.scrollHeight : null,
      };
    `);
    const waitStable = async () => {
      let prev = null, same = 0;
      for (let i = 0; i < 40; i++) {
        const m = await measure();
        const key = JSON.stringify([m.lineLeft, m.scrollTop, m.scrollH]);
        if (key === prev) { same++; if (same >= 2) return m; } else { same = 0; prev = key; }
        await ui.sleep(120);
      }
      return await measure();
    };

    // 滚到中段
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * 0.5;
      sc.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    `);
    await ui.sleep(900);
    const before = await waitStable();

    const runToggle = async (tag) => {
      await ui.ev(`
        window.__TOG = [];
        const t0 = performance.now();
        const tick = () => {
          const sc = document.querySelector(".cm-scroller");
          const ln = document.querySelector(".cm-line");
          const r = ln ? ln.getBoundingClientRect() : null;
          window.__TOG.push({ t: Math.round(performance.now()-t0), st: sc?Math.round(sc.scrollTop):null, left: r?Math.round(r.left):null, w: r?Math.round(r.width):null, sh: sc?sc.scrollHeight:null });
          if (performance.now() - t0 < 1100) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
      `);
      await ui.command("view.togglePreview");
      await ui.sleep(1400);
      const s = await ui.ev(`return window.__TOG || []`);
      const stable = await waitStable();
      return { tag, samples: s, stable };
    };

    const afterClose = await runToggle("close");
    const afterOpen = await runToggle("open");

    const summarize = (s) => {
      const uniq = (k) => new Set(s.map((x) => x[k]).filter((v) => v != null)).size;
      const stVals = s.map((x) => x.st).filter((v) => v != null);
      const leftVals = s.map((x) => x.left).filter((v) => v != null);
      const wVals = s.map((x) => x.w).filter((v) => v != null);
      const jumps = [];
      for (let i = 1; i < leftVals.length; i++) {
        const d = Math.abs(leftVals[i] - leftVals[i - 1]);
        if (d > 12) jumps.push({ i, from: leftVals[i - 1], to: leftVals[i], d });
      }
      return {
        n: s.length, stUniq: uniq("st"),
        leftUniq: uniq("left"), wUniq: uniq("w"),
        leftFirst: leftVals[0], leftLast: leftVals[leftVals.length - 1],
        stFirst: stVals[0], stLast: stVals[stVals.length - 1],
        bigLeftJumps: jumps.length, jumpMax: jumps.length ? Math.max(...jumps.map((j) => j.d)) : 0,
      };
    };

    const c = summarize(afterClose.samples), o = summarize(afterOpen.samples);
    ui.log(`[#12] before=${JSON.stringify(before)}`);
    ui.log(`[#12] 关预览 stable=${JSON.stringify(afterClose.stable)} trace=${JSON.stringify(c)}`);
    ui.log(`[#12] 开预览 stable=${JSON.stringify(afterOpen.stable)} trace=${JSON.stringify(o)}`);

    const drift = Math.abs((afterOpen.stable.scrollTop ?? 0) - (before.scrollTop ?? 0));
    ui.add("12", "★ 预览开合往返后滚动位置回到原处",
      drift <= 8 ? "PASS" : drift <= 40 ? "KNOWN" : "FAIL",
      `漂移 ${drift}px；before=${before.scrollTop} afterClose=${afterClose.stable.scrollTop} afterOpen=${afterOpen.stable.scrollTop}`);
    ui.add("13", "开合期间正文左缘逐帧平滑（无 >12px 单帧跳变）",
      c.bigLeftJumps === 0 && o.bigLeftJumps === 0 ? "PASS" : "FAIL",
      `关：${c.leftUniq} 种取值 / ${c.bigLeftJumps} 次大跳（最大 ${c.jumpMax}px）；开：${o.leftUniq} 种 / ${o.bigLeftJumps} 次大跳（最大 ${o.jumpMax}px）`);
    ui.add("14", "开合期间滚动位置无中间剧烈跳变",
      c.stUniq <= 4 && o.stUniq <= 4 ? "PASS" : "KNOWN",
      `关 stUniq=${c.stUniq} (${c.stFirst}→${c.stLast})；开 stUniq=${o.stUniq} (${o.stFirst}→${o.stLast})`);
    await ui.shot("toggle");
  } catch (e) {
    ui.add("12", "#12 预览开合", "FAIL", String(e.message).slice(0, 200));
  }
});

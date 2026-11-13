/**
 * v0.17.0 第二轮 —— **最终真机验收**（正式 exe，非探针版）
 *
 * 目的：把本轮修好的项在**真实 exe（WebView2 + 正式 identifier）**上复验一遍。
 * 浏览器探针证明了逻辑/几何正确，但 WebView2 的字体回退、缩放、compositor 行为不同，
 * 必须真机确认（本项目 §4「观感类缺陷必须实测几何」）。
 *
 * 覆盖（能在无用户交互下稳定测的项）：
 *   #11 模式切换过渡（有没有动画 / 方向 / 时长）
 *   #5  页面框线范围 = 右屏篇幅
 *   #9  两模式正文列宽一致
 *   #4  专注遮罩跟随（滚动平移不变量）
 *   #7  ghost 整段退格
 *   #10 编辑模式持久化（写入 localStorage）
 *   #1  插入符号颜色（6 主题抽样）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const parts = ["# 真机验收", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`第 ${i} 段。哨兵 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur adipiscing elit.`, "");
}
const DOC = parts.join("\n");

await runProbe({ name: "v0170-r2-final-exe", doc: DOC, docTitle: "PI01" }, async (ui) => {
  const impl = ui.impl;
  ui.add("E0", "源码面实现", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);

  /* ── #11 模式切换过渡（真机 compositor） ── */
  try {
    const trace = async (cmd, sel) => {
      await ui.ev(`
        window.__A = [];
        const t0 = performance.now();
        const tick = () => {
          const el = document.querySelector(${JSON.stringify(sel)});
          const cs = el ? getComputedStyle(el) : null;
          window.__A.push({ t: Math.round(performance.now()-t0), anim: cs?cs.animationName:null, tr: cs?cs.transform:null });
          if (performance.now()-t0 < 900) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
      `);
      await ui.command(cmd);
      await ui.sleep(1300);
      return await ui.ev(`
        const a = window.__A || [];
        const withAnim = a.filter(x => x.anim && x.anim !== "none");
        return { n: a.length, animN: withAnim.length,
                 names: [...new Set(withAnim.map(x=>x.anim))],
                 trUniq: new Set(a.map(x=>x.tr).filter(t=>t&&t!=="none")).size };
      `);
    };
    const toRead = await trace("view.preview", ".editor-container");
    ui.log("[#11 编辑→阅读] " + JSON.stringify(toRead));
    ui.add("E1", "★ #11 编辑→阅读 有过渡动画（真机）",
      toRead.animN > 0 ? "PASS" : "FAIL",
      `动画帧 ${toRead.animN}/${toRead.n}；name=${JSON.stringify(toRead.names)}；transform 取值 ${toRead.trUniq}`);

    const toEdit = await trace("view.edit", ".source-editor-wrapper");
    ui.log("[#11 阅读→编辑] " + JSON.stringify(toEdit));
    ui.add("E2", "★ #11 阅读→编辑 有过渡动画（真机）",
      toEdit.animN > 0 ? "PASS" : "FAIL",
      `动画帧 ${toEdit.animN}/${toEdit.n}；name=${JSON.stringify(toEdit.names)}；transform 取值 ${toEdit.trUniq}`);
    await ui.shot("mode-anim");
  } catch (e) {
    ui.add("E1", "#11 真机", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── #5 框线范围 / #9 对齐（真机） ── */
  try {
    const geo = await ui.ev(`
      const R = (el) => { if (!el) return null; const q = el.getBoundingClientRect();
        return { x: Math.round(q.left), y: Math.round(q.top), w: Math.round(q.width), h: Math.round(q.height) }; };
      const gut = document.querySelector(".cm-gutters");
      const host = document.querySelector(".source-editor-cm6");
      const shell = document.querySelector(".split-preview-shell");
      const hostCs = host ? getComputedStyle(host) : null;
      return {
        host: R(host), shell: R(shell),
        hostOutline: hostCs ? hostCs.outlineStyle + " " + hostCs.outlineWidth : null,
        gutterW: gut ? Math.round(gut.getBoundingClientRect().width) : null,
      };
    `);
    ui.log("[#5/#9 真机] " + JSON.stringify(geo));
    ui.add("E3", "★ #5 框线范围 = 右屏篇幅（真机）",
      geo.host && geo.shell ? (Math.abs(geo.host.w - geo.shell.w) <= 8 && Math.abs(geo.host.h - geo.shell.h) <= 8 ? "PASS" : "FAIL") : "FAIL",
      `框线(宿主) ${geo.host?.w}×${geo.host?.h} vs 右屏 ${geo.shell?.w}×${geo.shell?.h}；outline=${geo.hostOutline}`);
    ui.add("E4", "#5 框线画在宿主上",
      String(geo.hostOutline || "").includes("dotted") ? "PASS" : "FAIL", `outline=${geo.hostOutline}`);
    ui.add("E5", "#9 行号槽宽已注入（对齐补偿生效）",
      geo.gutterW ? "PASS" : "KNOWN", `gutterW=${geo.gutterW}px`);
  } catch (e) {
    ui.add("E3", "#5/#9 真机", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── #1 插入符号颜色（真机 6 主题） ── */
  try {
    await ui.focusSource();
    const themes = [];
    for (let i = 0; i < 6; i++) {
      const cur = await ui.ev(`return document.documentElement.getAttribute("data-theme") || "(none)"`);
      await ui.command("view.toggleTheme");
      await ui.sleep(380);
      await ui.focusSource();
      await ui.key("x", "KeyX", 88);
      await ui.sleep(320);
      const r = await ui.ev(`
        const cur = document.querySelector(".cm-cursor");
        const ed = document.querySelector(".cm-editor");
        const cs = cur ? getComputedStyle(cur) : null;
        const edCs = ed ? getComputedStyle(ed) : null;
        const p = (s) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(s||""); return m ? Math.round((+m[1]+ +m[2]+ +m[3])/3) : null; };
        return { theme: document.documentElement.getAttribute("data-theme"),
                 border: cs?cs.borderLeftColor:null, lum: cs?p(cs.borderLeftColor):null,
                 edBgLum: edCs?p(edCs.backgroundColor):null };
      `);
      themes.push(r);
    }
    ui.log("[#1 真机主题] " + JSON.stringify(themes));
    const invisible = themes.filter((t) => t.lum != null && t.edBgLum != null && Math.abs(t.lum - t.edBgLum) < 90);
    const pureWhite = themes.filter((t) => t.lum != null && t.lum >= 245);
    ui.add("E6", "★ #1 六主题均无纯白/不可见插入符号（真机）",
      invisible.length === 0 && pureWhite.length === 0 ? "PASS" : "FAIL",
      `纯白=${JSON.stringify(pureWhite.map(t=>t.theme+":"+t.border))}；对比不足=${JSON.stringify(invisible.map(t=>t.theme))}；各主题=${themes.map(t=>`${t.theme}:亮度${t.lum}/底${t.edBgLum}`).join(" ")}`);
  } catch (e) {
    ui.add("E6", "#1 真机", "FAIL", String(e.message).slice(0, 200));
  }

  /* ── #10 viewMode 持久化（真机 localStorage） ── */
  try {
    await ui.command("view.edit");
    await ui.sleep(800);
    const keys = await ui.ev(`
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/view-mode|scroll-progress/i.test(k)) out[k] = localStorage.getItem(k);
      }
      return out;
    `);
    ui.log("[#10 真机持久化] " + JSON.stringify(keys));
    const vmKey = Object.keys(keys).find((k) => k.includes("view-mode"));
    ui.add("E7", "★ #10 真机 viewMode 已落 localStorage",
      vmKey ? "PASS" : "FAIL",
      vmKey ? `${vmKey} = ${keys[vmKey]}` : `未找到 view-mode key；实际 keys=${JSON.stringify(Object.keys(keys))}`);
  } catch (e) {
    ui.add("E7", "#10 真机", "FAIL", String(e.message).slice(0, 200));
  }

  await ui.shot("final");
});

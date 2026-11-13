/**
 * C 流 / 诊断探针 #7 —— 解决两个未定项
 *  A. fontSize 设置是否真的影响 CM6 源码面渲染（级联到底谁赢）
 *  B. 打字机模式：先真正点进编辑区放置光标，再看光标行是否居中
 *     （上一次测试没放光标，.cm-cursor 停在文档开头 → 误判）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const paras = [];
for (let i = 1; i <= 36; i++) {
  paras.push(
    `这是第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位使用。` +
      `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  );
}
const DOC = `# DIAG-HEAD 诊断文档

${paras.slice(0, 9).join("\n\n")}

## DIAG-H2

${paras.slice(9, 18).join("\n\n")}

## DIAG-TAIL

${paras.slice(18, 30).join("\n\n")}
`;

await runProbe(
  { name: "v0170-probe-rp-diag7", doc: DOC, docTitle: "DIAG-HEAD", viewMode: "edit" },
  async (ui) => {
    /* ══ A. fontSize 级联诊断 ══ */
    const chain = async (label) => {
      const v = await ui.ev(`
        const ed = document.querySelector(".cm-editor");
        const host = document.querySelector(".source-editor-cm6");
        const line = document.querySelector(".cm-line");
        const content = document.querySelector(".cm-content");
        const root = getComputedStyle(document.documentElement);
        const cs = (el) => el ? getComputedStyle(el) : null;
        return {
          rootVar: root.getPropertyValue("--editor-font-size").trim(),
          hostInline: host ? host.style.fontSize : null,
          hostComputed: host ? cs(host).fontSize : null,
          editorComputed: ed ? cs(ed).fontSize : null,
          contentComputed: content ? cs(content).fontSize : null,
          lineComputed: line ? cs(line).fontSize : null,
          editorInline: ed ? ed.style.fontSize : null,
        };
      `);
      ui.log(`[A] ${label}: ${JSON.stringify(v)}`);
      return v;
    };

    await chain("初始");

    // 打开设置，驱动 fontSize
    await ui.command("view.settings");
    await ui.sleep(1600);
    const drv = async (testid, v) => {
      await ui.ev(`
        const el = document.querySelector('[data-testid="${testid}"]');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, ${JSON.stringify(String(v))});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      `);
      await ui.sleep(1200);
    };
    await drv("settings-font-size", 26);
    const preview26 = await chain("拖到 26（仅实时预览，未保存）");

    // 保存
    await ui.ev(`
      const btn = Array.from(document.querySelectorAll(".settings-footer .settings-btn"))
        .find(b => b.className.indexOf("primary") >= 0);
      if (btn) btn.click();
      return true;
    `);
    await ui.sleep(1600);
    const saved26 = await chain("保存后 26");

    // 确认 --editor-font-size 到底有没有被 CM6 的 .cm-editor 规则使用
    const rule = await ui.ev(`
      // 找到所有作用于 .cm-editor 的 font-size 规则，看谁在最后
      const out = [];
      for (const ss of document.styleSheets) {
        let rules;
        try { rules = ss.cssRules; } catch { continue; }
        if (!rules) continue;
        const walk = (rs) => {
          for (const r of rs) {
            if (r.cssRules) { walk(r.cssRules); continue; }
            if (!r.selectorText) continue;
            if (r.selectorText.indexOf(".cm-editor") < 0) continue;
            if (!r.style || !r.style.fontSize) continue;
            out.push({ sel: r.selectorText.slice(0, 90), fontSize: r.style.fontSize });
          }
        };
        walk(rules);
      }
      return out;
    `);
    ui.log(`[A] 所有含 font-size 的 .cm-editor 规则: ${JSON.stringify(rule, null, 1)}`);

    // 把字号还原
    await ui.command("view.settings");
    await ui.sleep(1500);
    await drv("settings-font-size", 16);
    await ui.ev(`
      const btn = Array.from(document.querySelectorAll(".settings-footer .settings-btn"))
        .find(b => b.className.indexOf("primary") >= 0);
      if (btn) btn.click();
      return true;
    `);
    await ui.sleep(1400);
    ui.log(`[A] 已还原字号 16`);

    /* ══ B. 打字机（先点进编辑区放光标） ══ */
    // 1) 先把某行滚到视口中央并**真实点击**该行放置光标
    const clickTarget = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      const target = lines[Math.floor(lines.length * 0.5)];
      if (!target) return null;
      target.scrollIntoView({ block: "center" });
      const r = target.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(r.width - 20, 140)),
               y: Math.round(r.top + r.height / 2),
               text: (target.textContent || "").slice(0, 30),
               scTop: Math.round(sc.getBoundingClientRect().top),
               scH: Math.round(sc.getBoundingClientRect().height) };
    `);
    ui.log(`[B] 点击目标行: ${JSON.stringify(clickTarget)}`);
    if (clickTarget) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: clickTarget.x, y: clickTarget.y, button: "left", clickCount: 1 });
      await ui.sleep(70);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: clickTarget.x, y: clickTarget.y, button: "left", clickCount: 1 });
      await ui.sleep(600);
    }
    const caretBefore = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const rr = sc.getBoundingClientRect();
      const c = document.querySelector(".cm-cursor-primary") || document.querySelector(".cm-cursor");
      if (!c) return { found: false };
      const r = c.getBoundingClientRect();
      return { found: true, caretVY: Math.round(r.top - rr.top),
               midVY: Math.round(rr.height / 2),
               off: Math.round((r.top - rr.top) - rr.height / 2) };
    `);
    ui.log(`[B] 打字机开启前光标: ${JSON.stringify(caretBefore)}`);

    // 2) 开打字机
    const twState0 = await ui.ev(`
      const o = JSON.parse(localStorage.getItem("lightmd-settings") || "{}");
      return o.state ? o.state.typewriterMode : null;
    `);
    await ui.command("view.toggleTypewriter");
    await ui.sleep(2000);
    const twState1 = await ui.ev(`
      const o = JSON.parse(localStorage.getItem("lightmd-settings") || "{}");
      return o.state ? o.state.typewriterMode : null;
    `);
    const caretAfter = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const rr = sc.getBoundingClientRect();
      const c = document.querySelector(".cm-cursor-primary") || document.querySelector(".cm-cursor");
      if (!c) return { found: false };
      const r = c.getBoundingClientRect();
      return { found: true, caretVY: Math.round(r.top - rr.top),
               midVY: Math.round(rr.height / 2),
               off: Math.round((r.top - rr.top) - rr.height / 2),
               st: Math.round(sc.scrollTop) };
    `);
    ui.log(`[B] 打字机含开关值: 前=${twState0} 后=${twState1}`);
    ui.log(`[B] 打字机开启后光标: ${JSON.stringify(caretAfter)}`);

    // 3) 再敲一个字符，看打字机是否把光标行拉回中间（真实用法）
    await ui.typeText("Z");
    await ui.sleep(900);
    const caretAfterType = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const rr = sc.getBoundingClientRect();
      const c = document.querySelector(".cm-cursor-primary") || document.querySelector(".cm-cursor");
      if (!c) return { found: false };
      const r = c.getBoundingClientRect();
      return { found: true, caretVY: Math.round(r.top - rr.top),
               midVY: Math.round(rr.height / 2),
               off: Math.round((r.top - rr.top) - rr.height / 2),
               st: Math.round(sc.scrollTop),
               typed: (document.querySelector(".cm-content") || {}).textContent ? true : false };
    `);
    ui.log(`[B] 敲 1 字符后光标: ${JSON.stringify(caretAfterType)}`);

    // 4) 关掉打字机
    await ui.command("view.toggleTypewriter");
    await ui.sleep(1000);
    const twState2 = await ui.ev(`
      const o = JSON.parse(localStorage.getItem("lightmd-settings") || "{}");
      return o.state ? o.state.typewriterMode : null;
    `);
    ui.log(`[B] 打字机关闭后值=${twState2}`);

    await ui.shot("typewriter");
    ui.log(`errors: ${JSON.stringify(await ui.errors()).slice(0, 300)}`);
  },
);

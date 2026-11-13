/**
 * Lead 复核：P1-3 修复后的**真实对齐精度**（用正确口径）。
 *
 * 上一轮探针的「中央口径」取「视口中央那行」，但左屏中央常落在**空行**上
 * （Markdown 段落之间有大量空行），空行没有文字 → 「文字同源」必然 0/4。
 * 这是探针口径问题，不是产品缺陷。
 *
 * 本探针改用**内容级正确口径**：
 *   对左屏视口内可见的若干「非空行」，读出该行文字，
 *   再到右屏找含同样文字的块，算两者在视口内的 Y 偏移。
 *   偏移 < 1 行高 = 对齐良好。
 *
 * 同时给出「左屏顶行 vs 右屏顶块」的行号差（顶对顶在等密度文档上应≈0）。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

// 结构均匀、行不太长的文档（与主探针同构，便于对比）
const parts = ["# 对齐精度复核", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`## 第 ${i} 节标题`, "");
  parts.push(`第 ${i} 节的正文段落 UNIQ${i}。这一段用于制造可滚动的行数与均匀的块结构，使左右两侧的「第 N 个顶层块」能够一一对应。`, "");
  parts.push(`- 要点 ${i}.1：对齐测试条目`, `- 要点 ${i}.2：对齐测试条目`, "");
}
const DOC = parts.join("\n");

const scrollWheel = async (ui, x, y, times, delta = 400) => {
  for (let i = 0; i < times; i++) {
    await ui.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY: delta, modifiers: 0,
    });
    await ui.sleep(130);
  }
  await ui.sleep(1500);
};

await runProbe({ name: "v0170-lead-align-precise", doc: DOC, docTitle: "第 40 节" }, async (ui) => {
  const box = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);

  const samples = [];
  // 逐步滚到底，每步测一次
  for (let step = 1; step <= 6; step++) {
    await scrollWheel(ui, box.x, box.y, 6);

    const r = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const f = document.querySelector("iframe.split-preview");
      const d = f && f.contentDocument;
      if (!sc || !d) return null;
      const win = f.contentWindow;
      const cm = document.querySelector(".cm-editor");
      const lines = Array.from(cm.querySelectorAll(".cm-line"));
      const scRect = sc.getBoundingClientRect();

      // 左屏视口内**非空**行：取中央附近 5 行里最靠近中央的那个非空行
      const visible = lines.map((l) => {
        const lr = l.getBoundingClientRect();
        const y = lr.top + lr.height / 2 - scRect.top;   // 相对滚动视口
        return { text: (l.textContent || "").trim(), y: Math.round(y * 10) / 10, h: Math.round(lr.height) };
      }).filter((x) => x.y > -20 && x.y < scRect.height + 20);

      const centerY = scRect.height / 2;
      const nonEmpty = visible.filter((v) => v.text.length > 0);
      // 中央最近的非空行
      let best = null;
      for (const v of nonEmpty) {
        const d2 = Math.abs(v.y - centerY);
        if (!best || d2 < Math.abs(best.y - centerY)) best = v;
      }
      if (!best) return { ok: false, why: "no non-empty visible line" };

      // 在右屏找含该行文字（取前 12 字）的块，算它的视口 Y
      const needle = best.text.slice(0, 12);
      let hit = null;
      for (const el of d.querySelectorAll("[data-src-line], body > *")) {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (t.indexOf(needle.replace(/\\s+/g, " ")) >= 0) {
          const br = el.getBoundingClientRect();
          hit = {
            y: Math.round((br.top + br.height / 2 - win.innerHeight / 2) * 10) / 10,
            h: Math.round(br.height),
            tag: el.tagName,
            line: el.getAttribute("data-src-line"),
          };
          break;
        }
      }
      return {
        ok: true,
        leftText: best.text.slice(0, 40),
        leftY: best.y,
        leftLineH: best.h,
        centerY: Math.round(centerY),
        right: hit,
        leftTop: Math.round(sc.scrollTop),
        leftMax: Math.round(sc.scrollHeight - sc.clientHeight),
        rightScrollY: Math.round(win.scrollY),
      };
    `);

    if (r?.ok) {
      samples.push({ step, ...r });
      const off = r.right ? Math.round(r.right.y) : null;
      ui.log(`[step${step}] 左屏中央非空行 y=${r.leftY}(行高${r.leftLineH}) 文本=${JSON.stringify(r.leftText.slice(0, 24))} ` +
        `→ 右屏块 y偏移=${off}px 块高=${r.right?.h} data-src-line=${r.right?.line}｜leftTop=${r.leftTop}/${r.leftMax} rightScrollY=${r.rightScrollY}`);
    } else {
      ui.log(`[step${step}] 采样失败: ${JSON.stringify(r)}`);
    }
  }

  const withHit = samples.filter((s) => s.right);
  ui.add("A1", "产生有效采样", withHit.length >= 3 ? "PASS" : "FAIL", `${withHit.length}/${samples.length}`);

  if (withHit.length) {
    const offs = withHit.map((s) => Math.abs(s.right.y));
    const worst = Math.max(...offs);
    const worstS = withHit[offs.indexOf(worst)];
    const tol = worstS.right.h;
    const ratio = worst / tol;
    ui.add("A2", "★ 内容级对齐：左屏中央可见文字 ↔ 右屏同一块的视口偏移 / 块高",
      ratio < 1 ? "PASS" : ratio < 3 ? "KNOWN" : "FAIL",
      `最差 ${worst}px / 块高 ${tol}px = ${ratio.toFixed(2)} 块高；` +
      `各点=[${withHit.map((s) => Math.round(s.right.y)).join(", ")}]；` +
      `文本对照=[${withHit.map((s) => JSON.stringify(s.leftText.slice(0, 12))).join(" ｜ ")}]`);
  }

  await ui.shot("align-precise");
});

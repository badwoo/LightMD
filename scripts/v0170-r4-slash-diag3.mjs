/**
 * v0.17.0 R4 · T2 · 斜杠命令（P4）是否可达 —— 严格版
 *
 * ## 上一版结论不可用（自己抓到的仪器缺陷）
 *
 * diag1/diag2 都得出"`/` 敲了但菜单没弹"，但那两次的**光标位置不对**：
 * - diag1 直接点空行 → 落点 col=0，`/` 进了文档，但没验 axe 之后的选区；
 * - diag2 点行中 → End → Enter → 光标在**新行行首**，之后 `cmTile` 读数变成 null
 *   （读数方式在那一瞬失效，属仪器问题），于 `ok:false`。
 *
 * `findSlashTrigger` 的判定是 `lineText.match(/^(\s*)\/(\w*)$/)` ——
 * **必须整行只有空白 + `/` + 词字符**。只要行内前面有任何别的字符就不触发。
 * 所以探针必须**逐个断言**：
 *   ① `/` 之前该行确实是空的；② `/` 之后该行文本恰好是 `/`；③ 光标 col = 1。
 * 三条全成立而菜单仍不弹 → 才是产品缺陷。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

/** 页面内：读光标所在行（多路兜底，避免 cmTile 瞬时为 null 被当成"读不到"） */
const READ_LINE = `
  const c = document.querySelector(".cm-content");
  const v = (c && c.cmTile && c.cmTile.view) || (window.__VIEW || null);
  if (!v) return { ok: false, why: "no-view" };
  const m = v.state.selection.main;
  const line = v.state.doc.lineAt(m.head);
  return {
    ok: true, head: m.head, col: m.head - line.from,
    lineFrom: line.from, lineTo: line.to, lineText: line.text,
    docLen: v.state.doc.length, docLines: v.state.doc.lines,
    selFrom: m.from, selTo: m.to,
  };
`;

await runBrowserProbe({ name: "v0170-r4-slash-diag3", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  // 点视口中央附近一个**空行**（try 3 个候选，逐个验 col）
  const cand = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    const out = [];
    for (const l of sc.querySelectorAll(".cm-line")) {
      if ((l.textContent || "").trim() !== "") continue;
      const r = l.getBoundingClientRect();
      if (r.height <= 0 || r.top < scR.top + 30 || r.bottom > scR.bottom - 30) continue;
      out.push({ x: Math.round(r.left + 5), y: Math.round(r.top + r.height / 2), d: Math.round(Math.abs((r.top + r.bottom) / 2 - midY)) });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, 3);
  `);
  ui.log("[cand] 空行候选(按离中线距离) = " + JSON.stringify(cand));
  if (!cand.length) { ui.add("K0", "找到视口内空行", "FAIL", "无候选"); return; }

  await ui.click(cand[0].x, cand[0].y);
  await ui.sleep(450);

  const s0 = await ui.ev(READ_LINE);
  ui.log("[s0] 点击后 = " + JSON.stringify(s0));
  // 断言①：光标所在行是空的
  if (!s0.ok || s0.lineText !== "") {
    ui.add("K1", "前置：光标落在**空行**上", "FAIL", `lineText=${JSON.stringify(s0.ok ? s0.lineText : s0.why)} col=${s0.col}`);
  } else {
    ui.add("K1", "前置：光标落在**空行**上", "PASS", `lineText="" col=${s0.col} docLines=${s0.docLines}`);
  }

  // 装事件监听（确认真实事件链）
  await ui.ev(`
    window.__EV = [];
    const c = document.querySelector(".cm-content");
    for (const t of ["keydown", "beforeinput", "input"]) {
      c.addEventListener(t, (e) => window.__EV.push({ t, key: e.key || null, data: e.data || null, it: e.inputType || null }), true);
    }
    return true;
  `);

  await ui.key("/", "Slash", 191);
  await ui.sleep(120);
  const s1 = await ui.ev(READ_LINE);
  await ui.sleep(700);
  const s2 = await ui.ev(READ_LINE);

  const menu = await ui.ev(`
    const m = document.querySelector(".slash-command-menu");
    return {
      found: !!m,
      items: document.querySelectorAll(".slash-command-item").length,
      composed: Array.from(document.querySelectorAll("[class*=slash]")).map(e => String(e.className).slice(0, 40)),
    };
  `);
  const evs = await ui.ev(`return window.__EV || []`);

  ui.log("[s1] 敲 / 后 120ms = " + JSON.stringify(s1));
  ui.log("[s2] 敲 / 后 820ms = " + JSON.stringify(s2));
  ui.log("[menu] " + JSON.stringify(menu));
  ui.log("[ev]  " + JSON.stringify(evs));

  // 断言②：`/` 之后该行文本恰好是 `/`
  const okLine = s2.ok && s2.lineText === "/" && s2.col === 1;
  ui.add("K2", "断言②：`/` 之后光标所在行恰好是 \"/\"、col=1", okLine ? "PASS" : "FAIL",
    s2.ok ? `lineText=${JSON.stringify(s2.lineText)} col=${s2.col} docLen=${s2.docLen}` : s2.why);

  // 断言③：菜单是否弹出
  ui.add("K3", "断言③：斜杠菜单应当出现（P4 路径可达性）", menu.found ? "PASS" : "FAIL",
    `found=${menu.found} items=${menu.items}`);

  // 若没弹，再验"再敲一个字母过滤"是否也无效（排除"要输入 query 才显示"）
  if (!menu.found) {
    await ui.key("c", "KeyC", 67);
    await ui.sleep(700);
    const s3 = await ui.ev(READ_LINE);
    const menu3 = await ui.ev(`return { found: !!document.querySelector(".slash-command-menu"), items: document.querySelectorAll(".slash-command-item").length }`);
    ui.log("[s3] 再敲 c 后 = " + JSON.stringify(s3) + " menu=" + JSON.stringify(menu3));
    ui.add("K4", "变体：敲 `/c` 后菜单是否出现", menu3.found ? "PASS" : "FAIL",
      `lineText=${s3.ok ? JSON.stringify(s3.lineText) : "?"} menuFound=${menu3.found}`);
  }

  await ui.shot("slash-diag3");
});

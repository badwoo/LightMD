/**
 * P0-1 修复侧诊断：**逐层定位「重建」发生在哪一层 DOM 替换上**
 *
 * 目的：Lead 的缺陷报告指出「单次内容变化会重建 2 次（有时 del=2）」，怀疑
 * 除 `sourceHostRef` 的 `content` 依赖外还有第二处重建源。本探针不改源码，
 * 逐层挂 MutationObserver，回答三件事：
 *
 * 1. 每次内容变化，`.cm-editor` 的 del/add 精确次数；
 * 2. 宿主 `.source-editor-cm6` 这个**元素本身**是否被 React 换掉（removedNodes 里
 *    出现的是 `.cm-editor` 还是宿主 div）——两者含义完全不同：
 *    · 只有 `.cm-editor` 换 → CM6 被 destroy/mount，宿主 DOM 稳定（callback ref 重跑）；
 *    · 宿主 div 也换 → React 在重建子树（key 变化 / 条件渲染翻转）；
 * 3. 跨内容变化统计 mount/destroy 的真实调用次数（用 CDP 侧无法直接 hook 类，
 *    改用「同一 tick 内 del 的批次数」近似，并额外记录 reactor 提交次数）。
 *
 * 输出用于 `_plan/v0170-fix-p0-1.md` 的「第二处重建源是什么」。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 逐层重建源", "", "正文一。", "", "正文二。", ""].join("\n");

const clickContent = async (ui) => {
  const box = await ui.ev(`
    const c = document.querySelector(".cm-content");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 12) };
  `);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  await ui.sleep(350);
  return true;
};

const install = async (ui) => ui.ev(`
  window.__LAYERS = { cmEditor: [], host: [], wrapper: [], mainArea: [], cmContent: [] };
  window.__HOST_IDENTITY = [];
  const cls = (n) => String((n && n.className) || "");
  const tag = (n) => {
    if (!n) return "?";
    if (n.nodeType !== 1) return "#text";
    const c = cls(n).split(/\\s+/)[0] || "";
    return n.tagName.toLowerCase() + (c ? "." + c : "");
  };
  const mk = (key, pred) => {
    const el = document.querySelector(pred);
    if (!el) return null;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes || []) {
          if (n.nodeType !== 1) continue;
          window.__LAYERS[key].push({ t: "del", node: tag(n), at: Date.now() });
          // 如果被删的是宿主自己，说明 React 换掉了整个子树
          if (key === "wrapper" && cls(n).indexOf("source-editor-cm6") >= 0) window.__HOST_IDENTITY.push("HOST-REPLACED");
        }
        for (const n of m.addedNodes || []) {
          if (n.nodeType !== 1) continue;
          window.__LAYERS[key].push({ t: "add", node: tag(n), at: Date.now() });
        }
      }
    });
    mo.observe(el, { childList: true, subtree: false });
    return mo;
  };
  mk("cmEditor", ".source-editor-cm6");           // 宿主内部：CM6 的 .cm-editor 换没换
  mk("wrapper", ".source-editor-wrapper");        // 宿主 div 自己被换没换
  mk("mainArea", ".editor-main-area") ;           // 更上一层
  const cmc = document.querySelector(".cm-content");
  if (cmc) {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes || []) {
        if (n.nodeType === 1) window.__LAYERS.cmContent.push({ t: "add", node: tag(n) });
      }
    });
    mo.observe(cmc, { childList: true, subtree: false });
  }
  window.__HOST_ID = document.querySelector(".source-editor-cm6");
  return {
    hostPresent: !!document.querySelector(".source-editor-cm6"),
    wrapperPresent: !!document.querySelector(".source-editor-wrapper"),
    mainAreaPresent: !!document.querySelector(".editor-main-area"),
  };
`);

const read = async (ui) => ui.ev(`
  const h = document.querySelector(".source-editor-cm6");
  return { layers: window.__LAYERS, hostIdentity: window.__HOST_IDENTITY,
           hostSame: h === window.__HOST_ID, cmCount: document.querySelectorAll(".cm-editor").length,
           hostChildCount: h ? h.childElementCount : -1 };
`);

const reset = async (ui) => ui.ev(`
  window.__LAYERS = { cmEditor: [], host: [], wrapper: [], mainArea: [], cmContent: [] };
  window.__HOST_IDENTITY = [];
  return true;
`);

await runProbe({ name: "v0170-p01-diag-layers", doc: DOC, docTitle: "逐层重建源" }, async (ui) => {
  await clickContent(ui);
  const present = await install(ui);
  ui.log("[layers] 各层存在: " + JSON.stringify(present));

  /* ── 场景 1：输入 1 个字符（内容变化 1 次）── */
  await reset(ui);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "X", text: "X", unmodifiedText: "X" });
  await ui.sleep(900);
  const r1 = await read(ui);
  ui.log("[layers] 输入 1 字符 → " + JSON.stringify({
    cmEditor: r1.layers.cmEditor,
    wrapper: r1.layers.wrapper,
    cmCount: r1.cmCount,
    hostSame: r1.hostSame,
    hostChildCount: r1.hostChildCount,
  }));
  const del1 = r1.layers.cmEditor.filter((x) => x.t === "del").length;
  const add1 = r1.layers.cmEditor.filter((x) => x.t === "add").length;
  const hostReplaced1 = r1.layers.wrapper.some((x) => x.t === "del" && String(x.node).indexOf("cm6") >= 0);
  ui.add("L1", "输入 1 字符：宿主内 .cm-editor del/add", del1 === del1 ? "KNOWN" : "KNOWN",
    `del=${del1} add=${add1}`);
  ui.add("L2", "输入 1 字符：宿主 div 本身是否被 React 换掉",
    hostReplaced1 ? "KNOWN" : "KNOWN",
    `hostReplaced=${hostReplaced1}；hostSame=${r1.hostSame}；wrapper 层事件=${JSON.stringify(r1.layers.wrapper)}`);

  /* ── 场景 2：不重新点击，再打 1 个字符（焦点已在 BODY，应不变化）── */
  await reset(ui);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "Y", text: "Y", unmodifiedText: "Y" });
  await ui.sleep(700);
  const r2 = await read(ui);
  ui.log("[layers] 焦点丢失后再打 1 字符 → " + JSON.stringify({
    cmEditor: r2.layers.cmEditor, wrapper: r2.layers.wrapper, cmCount: r2.cmCount,
  }));
  ui.add("L3", "焦点丢失后按键不引发重建（证明重建只由内容变化驱动）",
    r2.layers.cmEditor.length === 0 ? "PASS" : "KNOWN",
    `cmEditor 事件数=${r2.layers.cmEditor.length}`);

  /* ── 场景 3：重新点击 + 输入，看是否是 2 次 ── */
  await clickContent(ui);
  await reset(ui);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "Z", text: "Z", unmodifiedText: "Z" });
  await ui.sleep(900);
  const r3 = await read(ui);
  const del3 = r3.layers.cmEditor.filter((x) => x.t === "del").length;
  const add3 = r3.layers.cmEditor.filter((x) => x.t === "add").length;
  ui.log("[layers] 点击后输入 1 字符 → " + JSON.stringify({
    cmEditor: r3.layers.cmEditor, wrapper: r3.layers.wrapper, cmCount: r3.cmCount, hostSame: r3.hostSame,
  }));
  ui.add("L4", "点击后输入 1 字符的真实重建次数", "KNOWN",
    `del=${del3} add=${add3}；wrapper 事件=${JSON.stringify(r3.layers.wrapper)}；hostSame=${r3.hostSame}`);

  /* ── 场景 4：撤销路径 ── */
  await reset(ui);
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(1100);
  const r4 = await read(ui);
  ui.log("[layers] 撤销 → " + JSON.stringify({
    cmEditor: r4.layers.cmEditor, wrapper: r4.layers.wrapper, cmCount: r4.cmCount,
  }));
  ui.add("L5", "撤销路径重建次数", "KNOWN",
    `del=${r4.layers.cmEditor.filter((x) => x.t === "del").length} ` +
    `add=${r4.layers.cmEditor.filter((x) => x.t === "add").length}`);

  /* ── 汇总：宿主身份稳定性 ── */
  ui.add("L6", "★ 结论：重建发生在哪一层", "KNOWN",
    `hostSame=${r4.hostSame}（true = 宿主 div 元素从未被替换 → 只是 CM6 被 destroy/remount）`);

  await ui.shot("layers");
});

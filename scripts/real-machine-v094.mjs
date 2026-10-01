/**
 * LightMD v0.9.4 实机功能验证（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖 0.9.4 修复项的可自动化部分（其余由 vitest 单测覆盖）：
 *  1. E6：光标进入加粗文本 → 行内显示 ** 源码符号（.md-reveal + ::before）；移出消失
 *  2. E9：合成粘贴事件（text/plain Markdown）→ 解析为标题/列表结构
 *  3. E9：合成粘贴事件（text/html）→ turndown → 富文本结构
 *  4. E9：代码块内粘贴 Markdown → 不转换（字面保留）
 *  5. E12：源码模式撤销栈为空时按 Ctrl+Z → warning toast「已到本模式撤销边界」
 *  6. E17：代码块右上角语言下拉存在且初值正确
 *  7. E17：下拉切换语言 → 节点 attrs 更新、源码模式序列化保留 ```python
 *  8. E17：设置「代码块自动换行」关闭 → 双层同步 pre + 横向滚动；恢复开启
 *
 * 用法（先启动打包产物）：
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9225"
 *   .\src-tauri\target\release\lightmd.exe
 *   node scripts\real-machine-v094.mjs
 */
const CDP_BASE = process.env.V094_CDP_BASE || "http://127.0.0.1:9225";
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${CDP_BASE}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 端口未就绪
    }
    await sleep(500);
  }
  throw new Error("未找到 WebView2 调试目标");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((r) => pending.set(i, r));
        },
        close: () => ws.close(),
      });
  });
}

async function main() {
  const target = await findPageTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(`页面执行异常: ${r.result.exceptionDetails.exception?.description ?? "?"}`);
    }
    return r.result?.result?.value;
  };
  const waitFor = async (expr, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evalJs(expr)) return true;
      await sleep(150);
    }
    return false;
  };
  const dispatchCommand = (id) =>
    evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); true`);

  const press = async (init) => {
    await cdp.send("Input.dispatchKeyEvent", {
      windowsVirtualKeyCode: init.vk ?? 0,
      ...init,
    });
  };
  const modBits = (o) =>
    (o.altKey ? 1 : 0) | (o.ctrlKey ? 2 : 0) | (o.metaKey ? 4 : 0) | (o.shiftKey ? 8 : 0);
  const keyPress = async (key, opts = {}) => {
    const mods = modBits(opts) | (opts.modifiers ?? 0);
    const common = { key, ...(opts.code ? { code: opts.code } : {}), ...(mods ? { modifiers: mods } : {}) };
    await press({ type: "rawKeyDown", ...common });
    await press({ type: "keyUp", ...common });
  };
  const clickPoint = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(250);
  };
  /** 点击某个 DOM 元素内部的水平中心（借助 Range 取真实坐标） */
  const clickSelector = async (selector) => {
    const box = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = document.createRange();
      r.selectNodeContents(el);
      const b = r.getBoundingClientRect();
      if (!b.width && !b.height) return null;
      return JSON.stringify({ x: Math.round(b.left + Math.min(6, b.width / 2)), y: Math.round(b.top + b.height / 2) });
    })()`);
    if (!box) return false;
    const { x, y } = JSON.parse(box);
    await clickPoint(x, y);
    return true;
  };

  const resetDoc = async () => {
    await dispatchCommand("file.new");
    await sleep(700);
    await dispatchCommand("view.preview");
    await sleep(300);
    const t = await evalJs(`window.pmEl()?.textContent ?? "?"`);
    return t === "";
  };

  /** 通过 lightmd:openFile 打开含指定内容的临时文档（阅读模式并聚焦） */
  const openContent = async (name, content) => {
    await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(name)},content:${JSON.stringify(content)}}})); true`);
    await sleep(800);
    await dispatchCommand("view.preview");
    await sleep(300);
    await evalJs(`window.pmEl()?.focus(); true`);
    await sleep(150);
  };

  /** 在编辑器上派发合成 paste 事件（text/plain / text/html） */
  const syntheticPaste = async (map) => {
    const json = JSON.stringify(map);
    return evalJs(`(() => {
      const pm = window.pmEl();
      if (!pm) return false;
      pm.focus();
      const dt = new DataTransfer();
      const map = ${json};
      for (const k of Object.keys(map)) dt.setData(k, map[k]);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      pm.dispatchEvent(ev);
      return true;
    })()`);
  };

  // ── 0. 环境就绪 ──
  check("应用外壳渲染(.titlebar 存在)", await waitFor(`!!document.querySelector(".titlebar")`));
  await evalJs(`window.pmEl = () => [...document.querySelectorAll(".ProseMirror")].find(e => e.offsetParent !== null) || document.querySelector(".ProseMirror"); true`);
  check("新建干净文档就绪", await resetDoc());

  // ══════════ E6：行内语法标记显示 ══════════
  await openContent("e6-bold.md", "# 标题\n\nfoo **bold** bar\n");
  const clickedBold = await clickSelector("strong");
  await sleep(250);
  const revealState = await evalJs(`(() => {
    const el = window.pmEl().querySelector(".md-reveal");
    if (!el) return JSON.stringify({ ok: false });
    const before = getComputedStyle(el, "::before").content || "";
    const after = getComputedStyle(el, "::after").content || "";
    return JSON.stringify({
      ok: true,
      open: el.getAttribute("data-md-open"),
      close: el.getAttribute("data-md-close"),
      before, after,
    });
  })()`);
  const rv = JSON.parse(revealState);
  check("E6: 光标进入加粗文本 → 出现 md-reveal 装饰", clickedBold && rv.ok, revealState);
  check("E6: data-md-open/close 为 **", rv.ok && rv.open === "**" && rv.close === "**", revealState);
  check("E6: ::before/::after 伪元素渲染出 **", rv.ok && rv.before.includes("**") && rv.after.includes("**"), revealState);

  // 光标移到标题（离开加粗）→ 装饰消失
  await clickSelector("h1");
  await sleep(300);
  const revealGone = await evalJs(`window.pmEl().querySelectorAll(".md-reveal").length`);
  check("E6: 光标移出 mark → 装饰消失", revealGone === 0, `残留 ${revealGone}`);

  // ══════════ E9：Markdown 感知粘贴 ══════════
  check("E9 准备:干净文档", await resetDoc());
  await evalJs(`window.pmEl()?.focus(); true`);
  await syntheticPaste({ "text/plain": "# 粘贴标题\n\n- 甲\n- 乙\n" });
  await sleep(500);
  const mdPaste = await evalJs(`(() => {
    const pm = window.pmEl();
    return JSON.stringify({
      heading: pm.querySelector("h1")?.textContent ?? "",
      items: pm.querySelectorAll("li").length,
    });
  })()`);
  const mp = JSON.parse(mdPaste);
  check("E9: Markdown 文本粘贴 → 标题结构", mp.heading.includes("粘贴标题"), mdPaste);
  check("E9: Markdown 文本粘贴 → 列表结构(2 项)", mp.items === 2, mdPaste);

  check("E9 准备:干净文档", await resetDoc());
  await evalJs(`window.pmEl()?.focus(); true`);
  await syntheticPaste({ "text/html": "<p>hello <strong>world</strong></p>" });
  await sleep(500);
  const htmlPaste = await evalJs(`(() => {
    const st = window.pmEl().querySelector("strong");
    return JSON.stringify({ text: st?.textContent ?? "", literal: window.pmEl().textContent.includes("**") });
  })()`);
  const hp = JSON.parse(htmlPaste);
  check("E9: HTML 片段粘贴 → 富文本结构(strong)", hp.text === "world", htmlPaste);
  check("E9: HTML 粘贴无 ** 字面残留", !hp.literal, htmlPaste);

  await openContent("e9-code.md", "```\ncode line\n```\n");
  await clickSelector(".code-block-wrapper code[contenteditable]");
  await syntheticPaste({ "text/plain": "# 不该变标题\n\n- 甲\n" });
  await sleep(500);
  const codePaste = await evalJs(`(() => {
    const pm = window.pmEl();
    return JSON.stringify({
      heading: pm.querySelectorAll("h1").length,
      headerLess: !pm.textContent.includes("# 不该变标题") ? false : true,
    });
  })()`);
  const cp = JSON.parse(codePaste);
  check("E9: 代码块内粘贴 Markdown → 不转换（无标题节点）", cp.heading === 0, codePaste);
  check("E9: 代码块内粘贴内容字面保留", cp.headerLess, codePaste);

  // ══════════ E12：撤销边界提示 ══════════
  await dispatchCommand("file.new");
  await sleep(700);
  await dispatchCommand("view.edit");
  await sleep(500);
  await evalJs(`document.querySelector("textarea.source-editor")?.focus(); true`);
  await sleep(200);
  // 清掉可能存在的 warning toast 干扰：直接读最新一条
  await keyPress("z", { key: "z", code: "KeyZ", vk: 90, ctrlKey: true });
  await sleep(500);
  const toastState = await evalJs(`(() => {
    const msgs = [...document.querySelectorAll(".notification-toast.notification-warning .notification-message")].map(e => e.textContent);
    return JSON.stringify(msgs);
  })()`);
  const toasts = JSON.parse(toastState);
  check("E12: 源码栈空 Ctrl+Z → 撤销边界提示 toast", toasts.some((m) => m.includes("已到本模式撤销边界")), toastState);

  // ══════════ E17：代码块语言下拉 ══════════
  await openContent("e17-code.md", "```js\nconst a = 1;\n```\n");
  const selectState = await evalJs(`(() => {
    const sel = window.pmEl().querySelector(".code-lang-select");
    if (!sel) return JSON.stringify({ ok: false });
    return JSON.stringify({
      ok: true,
      value: sel.value,
      hasAuto: [...sel.options].some(o => o.value === ""),
      hasPlain: [...sel.options].some(o => o.value === "plaintext"),
      count: sel.options.length,
    });
  })()`);
  const ss = JSON.parse(selectState);
  check("E17: 代码块语言下拉存在且初值 js", ss.ok && ss.value === "js", selectState);
  check("E17: 下拉含「自动检测」与「纯文本」", ss.ok && ss.hasAuto && ss.hasPlain, selectState);

  // 切换到 python
  await evalJs(`(() => {
    const sel = window.pmEl().querySelector(".code-lang-select");
    sel.value = "python";
    sel.dispatchEvent(new Event("change"));
    return true;
  })()`);
  await sleep(500);
  const afterLang = await evalJs(`(() => {
    const wrap = window.pmEl().querySelector(".code-block-wrapper");
    const code = wrap?.querySelector('code[contenteditable]');
    return JSON.stringify({
      dataLang: wrap?.getAttribute("data-language") ?? "",
      cls: code?.className ?? "",
    });
  })()`);
  const al = JSON.parse(afterLang);
  check("E17: 切换语言 → data-language 更新为 python", al.dataLang === "python", afterLang);
  check("E17: 切换语言 → 编辑层 language-python 类更新", al.cls.includes("language-python"), afterLang);

  // 源码模式序列化保留
  await dispatchCommand("view.edit");
  await sleep(500);
  const srcVal = await evalJs(`document.querySelector("textarea.source-editor")?.value ?? ""`);
  check("E17: 源码模式序列化保留 ```python", srcVal.includes("```python"), String(srcVal).slice(0, 60));
  await dispatchCommand("view.preview");
  await sleep(400);

  // ══════════ E17：自动换行开关 ══════════
  await dispatchCommand("view.settings");
  const settingsOpen = await waitFor(`!!document.querySelector(".settings-dialog")`, 4000);
  check("E17 准备:设置对话框打开", settingsOpen);
  const toggled = await evalJs(`(() => {
    const fields = [...document.querySelectorAll(".settings-field")];
    const f = fields.find(el => (el.querySelector("label")?.textContent || "").includes("代码块自动换行"));
    if (!f) return false;
    const cb = f.querySelector('input[type="checkbox"]');
    if (!cb) return false;
    cb.click();
    return true;
  })()`);
  await sleep(400);
  const wrapOff = await evalJs(`(() => {
    const codes = window.pmEl().querySelectorAll(".code-block-wrapper code");
    return JSON.stringify({
      n: codes.length,
      a: codes[0]?.style.whiteSpace ?? "",
      b: codes[1]?.style.whiteSpace ?? "",
      ax: codes[0]?.style.overflowX ?? "",
      bx: codes[1]?.style.overflowX ?? "",
    });
  })()`);
  const wo = JSON.parse(wrapOff);
  check("E17: 关闭自动换行 → 双层同步 pre", toggled && wo.a === "pre" && wo.b === "pre", wrapOff);
  check("E17: 关闭自动换行 → 双层横向滚动 auto", wo.ax === "auto" && wo.bx === "auto", wrapOff);

  // 恢复开启（不改变用户设置）
  await evalJs(`(() => {
    const fields = [...document.querySelectorAll(".settings-field")];
    const f = fields.find(el => (el.querySelector("label")?.textContent || "").includes("代码块自动换行"));
    f?.querySelector('input[type="checkbox"]')?.click();
    return true;
  })()`);
  await sleep(400);
  const wrapOn = await evalJs(`(() => {
    const codes = window.pmEl().querySelectorAll(".code-block-wrapper code");
    return JSON.stringify({ a: codes[0]?.style.whiteSpace ?? "", b: codes[1]?.style.whiteSpace ?? "" });
  })()`);
  const won = JSON.parse(wrapOn);
  check("E17: 恢复自动换行 → 双层 pre-wrap", won.a === "pre-wrap" && won.b === "pre-wrap", wrapOn);
  await evalJs(`document.querySelector(".settings-close")?.click(); true`);
  await sleep(300);

  // ── 汇总 ──
  console.log("\n===== v0.9.4 实机验证结果 =====");
  for (const r of results) console.log(r);
  console.log(`\n总计 ${results.length} 项,通过 ${results.length - failed},失败 ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
  cdp.close();
}

main().catch((e) => {
  console.error("脚本执行失败:", e.message);
  process.exitCode = 1;
});

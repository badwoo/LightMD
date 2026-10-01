/**
 * LightMD v0.9.3 实机功能验证（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖 0.9.3 修复项的可自动化部分（其余由 vitest 单测覆盖）：
 *  1. E8：阅读模式选中文字 → Ctrl+U 真实下划线；再经命令路由 format.underline 取消（toggle 双向）
 *  2. E10：打开含 HTML 文档 → <u> 转结构、<span> 剥离保内容、块级 <div> 字面保留
 *  3. E8：Ctrl+Shift+K → 弹出链接对话框（insert.link 默认键位）
 *  4. E11a：打开含 ![示例|300](x.png) 文档 → img 渲染 style width:300px
 *  5. E11b：点击图片 → 编辑对话框出现「替代文本/宽度」输入（值来自节点），修改确认后写回
 *  6. E7：打字即所得——$公式$、$$、[链接](url)+空格、![图](src)+空格、[^1]+空格、
 *         [toc]+空格、两行表格语法 → 全部转换为真实节点
 *
 * 用法（先启动打包产物）：
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9224"
 *   .\src-tauri\target\release\lightmd.exe
 *   node scripts/real-machine-v093.mjs
 */
const CDP_BASE = process.env.V093_CDP_BASE || "http://127.0.0.1:9224";
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
  const typeText = async (text) => {
    for (const ch of text) {
      await press({ type: "char", text: ch });
      await sleep(40);
    }
  };
  /** 修饰键位掩码:Alt=1 Ctrl=2 Meta=4 Shift=8(CDP 不认 ctrlKey/shiftKey 属性) */
  const modBits = (o) =>
    (o.altKey ? 1 : 0) | (o.ctrlKey ? 2 : 0) | (o.metaKey ? 4 : 0) | (o.shiftKey ? 8 : 0);
  const keyPress = async (key, opts = {}) => {
    const rest = { ...opts };
    delete rest.modifiers;
    const mods = modBits(opts) | (opts.modifiers ?? 0);
    const common = { key, ...(opts.code ? { code: opts.code } : {}), ...(mods ? { modifiers: mods } : {}) };
    await press({ type: "rawKeyDown", ...common });
    await press({ type: "keyUp", ...common });
  };
  const clickPoint = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(200);
  };
  const clickEditor = async () => {
    const rect = await evalJs(`(() => {
      const el = window.pmEl();
      el.focus();
      const b = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(28, b.height / 2)) });
    })()`);
    const { x, y } = JSON.parse(rect);
    await clickPoint(x, y);
  };

  /** 重置为全新空文档并聚焦(阅读模式) */
  const resetDoc = async () => {
    await dispatchCommand("file.new");
    await sleep(700);
    await dispatchCommand("view.preview");
    await sleep(300);
    await clickEditor();
    const t = await evalJs(`window.pmEl()?.textContent ?? "?"`);
    return t === "";
  };

  /** 通过 lightmd:openFile 打开含指定内容的临时文档 */
  const openContent = async (name, content) => {
    await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(name)},content:${JSON.stringify(content)}}})); true`);
    await sleep(800);
    await dispatchCommand("view.preview");
    await sleep(300);
    await clickEditor();
    await sleep(200);
  };

  // ── 0. 环境就绪 ──
  check("应用外壳渲染(.titlebar 存在)", await waitFor(`!!document.querySelector(".titlebar")`));
  await evalJs(`window.pmEl = () => [...document.querySelectorAll(".ProseMirror")].find(e => e.offsetParent !== null) || document.querySelector(".ProseMirror"); true`);
  check("新建干净文档就绪", await resetDoc());

  // ── 1. E8:Ctrl+U 真实下划线 + 命令路由 toggle ──
  await typeText("hello-ul");
  await sleep(150);
  await evalJs(`(() => {
    const pm = window.pmEl();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm.firstChild);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`);
  await sleep(150);
  await keyPress("u", { key: "u", code: "KeyU", vk: 85, ctrlKey: true });
  await sleep(300);
  const uState = await evalJs(`(() => {
    const pm = window.pmEl();
    return JSON.stringify({ u: pm.querySelectorAll("u").length, hasLiteral: pm.textContent.includes("<u>") });
  })()`);
  const u1 = JSON.parse(uState);
  check("E8: Ctrl+U → 选中文本真实下划线", u1.u >= 1, uState);
  check("E8: 无 <u> 字面残留", !u1.hasLiteral, uState);
  // 命令路由同一命令源:再执行一次应取消(toggle off)
  await dispatchCommand("format.underline");
  await sleep(300);
  const uOff = await evalJs(`window.pmEl().querySelectorAll("u").length`);
  check("E8: format.underline 命令路由再执行 → 取消下划线", uOff === 0, `u 数量 ${uOff}`);

  // ── 2. E10:HTML 白名单(打开含 HTML 的文档) ──
  await openContent(
    "html-test.md",
    "# HTML 测试\n\n<u>ux</u> 中间 <span onclick=\"alert(1)\">hi</span> 尾部\n\n<div class=\"k\">divlit</div>\n",
  );
  await sleep(300);
  const htmlState = await evalJs(`(() => {
    const pm = window.pmEl();
    return JSON.stringify({
      uText: pm.querySelector("u")?.textContent ?? "",
      onclickInjected: !!pm.querySelector("span[onclick], [onclick]"),
      hasHi: pm.textContent.includes("hi"),
      divLiteral: pm.textContent.includes('<div class="k">divlit</div>'),
    });
  })()`);
  const h = JSON.parse(htmlState);
  check("E10: <u>ux</u> 解析为下划线结构", h.uText === "ux", htmlState);
  // 应用自身的装饰 span(如行首前缀)合法;仅拦截内容驱动的 onclick 注入
  check("E10: <span onclick> 标签剥离(无事件处理器注入)", !h.onclickInjected && h.hasHi, htmlState);
  check("E10: 块级 <div> 字面文本保留(不丢内容)", h.divLiteral, htmlState);

  // ── 3. E8:Ctrl+Shift+K 打开链接对话框 ──
  await resetDoc();
  await keyPress("k", { key: "k", code: "KeyK", vk: 75, ctrlKey: true, shiftKey: true });
  await sleep(400);
  const linkDialogOpen = await evalJs(`!!document.querySelector(".link-dialog")`);
  check("E8: Ctrl+Shift+K 弹出链接对话框", linkDialogOpen, "");
  if (linkDialogOpen) {
    await evalJs(`document.querySelector(".link-dialog-overlay")?.click(); true`);
    await sleep(200);
  }

  // ── 4. E11a:图片尺寸属性渲染 ──
  await openContent("img-size.md", "前段\n\n![示例|300](x.png)\n");
  const imgState = await evalJs(`(() => {
    const img = window.pmEl().querySelector("img");
    if (!img) return JSON.stringify({ ok: false });
    return JSON.stringify({ ok: true, alt: img.alt, width: img.style.width });
  })()`);
  const img1 = JSON.parse(imgState);
  check("E11a: ![示例|300] 解析为 img 且 style width:300px", img1.ok && img1.width === "300px", imgState);
  check("E11a: alt 不含 |300 后缀", img1.ok && img1.alt === "示例", imgState);

  // ── 5. E11b:点击图片 → 编辑对话框 alt/宽度写回 ──
  const imgBox = await evalJs(`(() => {
    const img = window.pmEl().querySelector("img");
    if (!img) return null;
    img.scrollIntoView({ block: "center" });
    const b = img.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
  })()`);
  if (imgBox) {
    const { x, y } = JSON.parse(imgBox);
    await sleep(300);
    await clickPoint(x, y);
    const dialogShown = await waitFor(`!!document.querySelector(".image-edit-dialog")`, 4000);
    check("E11b: 点击图片打开编辑对话框", dialogShown, "");
    if (dialogShown) {
      const metaState = await evalJs(`(() => {
        const [alt, width] = document.querySelectorAll(".image-edit-meta-input");
        return JSON.stringify({ alt: alt?.value ?? "?", width: width?.value ?? "?" });
      })()`);
      const meta = JSON.parse(metaState);
      check("E11b: 对话框带出节点 alt/宽度初值", meta.alt === "示例" && meta.width === "300", metaState);
      // 修改 alt 与宽度 → 确认 → PM 中 img 属性写回
      await evalJs(`(() => {
        const [alt, width] = document.querySelectorAll(".image-edit-meta-input");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(alt, "新描述");
        alt.dispatchEvent(new Event("input", { bubbles: true }));
        setter.call(width, "240");
        width.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
      await sleep(150);
      await evalJs(`document.querySelector(".image-edit-btn.primary")?.click(); true`);
      await sleep(400);
      const afterState = await evalJs(`(() => {
        const img = window.pmEl().querySelector("img");
        return JSON.stringify({ alt: img?.alt ?? "?", width: img?.style.width ?? "?" });
      })()`);
      const after = JSON.parse(afterState);
      check("E11b: 确认后 alt/宽度写回节点", after.alt === "新描述" && after.width === "240px", afterState);
      // 关闭可能残留的对话框
      await evalJs(`document.querySelector(".image-edit-overlay")?.click(); true`);
      await sleep(150);
    }
  } else {
    check("E11b: 点击图片打开编辑对话框", false, "未找到图片元素");
  }

  // ── 6. E7:打字即所得(逐项,各自干净文档) ──
  // 6a. 行内公式
  check("E7 准备:干净文档", await resetDoc());
  await typeText("$E=mc^2$");
  await sleep(300);
  check("E7a: $E=mc^2$ 即时转换为行内公式", await evalJs(`!!window.pmEl().querySelector('[data-math="inline"]')`));

  // 6b. 块级公式
  check("E7 准备:干净文档", await resetDoc());
  await typeText("$$");
  await sleep(300);
  check("E7b: $$ 行首转换为块级公式", await evalJs(`!!window.pmEl().querySelector('[data-math="block"]')`));

  // 6c. 链接(空格触发)
  check("E7 准备:干净文档", await resetDoc());
  await typeText("[link](https://a.b)");
  await typeText(" ");
  await sleep(300);
  const linkState = await evalJs(`(() => {
    const a = window.pmEl().querySelector("a");
    return JSON.stringify({ href: a?.href ?? "", text: a?.textContent ?? "" });
  })()`);
  const lk = JSON.parse(linkState);
  check("E7c: [link](https://a.b)+空格 → 真实链接", lk.href.includes("https://a.b") && lk.text === "link", linkState);

  // 6d. 图片(空格触发)
  check("E7 准备:干净文档", await resetDoc());
  await typeText("![pic|300](x.png)");
  await typeText(" ");
  await sleep(300);
  const img2State = await evalJs(`(() => {
    const img = window.pmEl().querySelector("img");
    return JSON.stringify({ ok: !!img, alt: img?.alt ?? "", width: img?.style.width ?? "" });
  })()`);
  const img2 = JSON.parse(img2State);
  check("E7d: ![pic|300](x.png)+空格 → 图片节点(带尺寸)", img2.ok && img2.alt === "pic" && img2.width === "300px", img2State);

  // 6e. 脚注引用(空格触发)
  check("E7 准备:干净文档", await resetDoc());
  await typeText("see[^1]");
  await typeText(" ");
  await sleep(300);
  const fnState = await evalJs(`(() => {
    const sup = window.pmEl().querySelector("sup.footnote-ref");
    return JSON.stringify({ ok: !!sup, label: sup?.getAttribute("data-label") ?? "" });
  })()`);
  const fn = JSON.parse(fnState);
  check("E7e: [^1]+空格 → 脚注引用", fn.ok && fn.label === "1", fnState);

  // 6f. 目录(空格触发)
  check("E7 准备:干净文档", await resetDoc());
  await typeText("[toc]");
  await typeText(" ");
  await sleep(400);
  check("E7f: [toc]+空格 → 目录节点", await evalJs(`!!window.pmEl().querySelector("nav[data-toc]")`));

  // 6g. 表格(分隔行末尾触发)
  check("E7 准备:干净文档", await resetDoc());
  await typeText("a | b");
  await keyPress("Enter", { key: "Enter", code: "Enter", vk: 13 });
  await sleep(150);
  await typeText("| --- | --- |");
  await sleep(400);
  const tblState = await evalJs(`(() => {
    const tbl = window.pmEl().querySelector("table");
    if (!tbl) return JSON.stringify({ ok: false });
    const heads = [...tbl.querySelectorAll("th")].map((c) => c.textContent);
    return JSON.stringify({ ok: true, heads });
  })()`);
  const tbl = JSON.parse(tblState);
  check("E7g: 两行表格语法 → 真实表格(表头 a/b)", tbl.ok && tbl.heads.join(",") === "a,b", tblState);

  // ── 汇总 ──
  console.log("\n===== v0.9.3 实机验证结果 =====");
  for (const r of results) console.log(r);
  console.log(`\n总计 ${results.length} 项,通过 ${results.length - failed},失败 ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
  cdp.close();
}

main().catch((e) => {
  console.error("脚本执行失败:", e.message);
  process.exitCode = 1;
});

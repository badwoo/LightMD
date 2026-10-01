/**
 * LightMD v0.9.2 实机功能验证（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖 0.9.2 修复项的可自动化部分（其余由 vitest 单测覆盖）：
 *  1. 需求1：侧边栏「最近打开」区块默认关闭，点击时钟按钮可开启
 *  2. 需求2：标题栏文件名(.titlebar-center)相对窗口水平居中
 *  3. E1：阅读模式选中文字 → lightmd:command format.bold → 真实加粗（不再是 **** 字面文本）
 *  4. E2：阅读模式 insert.codeblock → 代码块内真实按键 Tab → 插入 2 空格且焦点未移出
 *  5. E3：阅读模式列表项内输入 --- → 保持字面文本（不误转水平线）
 *  6. E4：表格右键菜单为 i18n 文案（"上方添加行"），表头右键无"删除行"
 *  7. E14：设置出现「段内换行」下拉，切 commonmark 后 localStorage 落盘，随后恢复 gfm
 *
 * 用法（先启动打包产物）：
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   .\src-tauri\target\release\lightmd.exe
 *   node scripts/real-machine-v092.mjs
 */
const CDP_BASE = process.env.V092_CDP_BASE || "http://127.0.0.1:9223";
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

  /** 真实按键（渲染器层合成,走 DOM keydown/keypress/input 链路） */
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
  const keyPress = async (key, opts = {}) => {
    await press({ type: "rawKeyDown", key, ...(opts.code ? { code: opts.code } : {}), ...opts });
    await press({ type: "keyUp", key, ...(opts.code ? { code: opts.code } : {}), ...opts });
  };
  /** 真实鼠标点击可见编辑器(把键盘焦点与光标真正迁移过去,JS focus() 不可靠) */
  const clickEditor = async () => {
    const rect = await evalJs(`(() => {
      const el = window.pmEl();
      el.focus();
      const b = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(28, b.height / 2)) });
    })()`);
    const { x, y } = JSON.parse(rect);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(200);
  };

  // ── 0. 环境就绪 ──
  check("应用外壳渲染(.titlebar 存在)", await waitFor(`!!document.querySelector(".titlebar")`));
  // 多标签架构:隐藏标签的 .ProseMirror 也在 DOM 中,统一取「可见的活跃编辑器」
  await evalJs(`window.pmEl = () => [...document.querySelectorAll(".ProseMirror")].find(e => e.offsetParent !== null) || document.querySelector(".ProseMirror"); true`);
  // 新建干净文档(应用启动可能恢复了上次会话的文件,避免内容污染断言)
  await dispatchCommand("file.new");
  await sleep(600);
  const freshEmpty = await evalJs(`(window.pmEl()?.textContent ?? "?").length === 0`);
  if (!freshEmpty) {
    // 活跃文档非空(可能聚焦在旧标签),再次新建并校验
    await dispatchCommand("file.new");
    await sleep(600);
  }
  check("新建干净文档就绪", await evalJs(`(window.pmEl()?.textContent ?? "?").length === 0`), "");
  // 切到阅读模式并聚焦编辑器(后续 PM 断言都在该模式)
  await dispatchCommand("view.preview");
  await sleep(300);
  await evalJs(`[...document.querySelectorAll(".ProseMirror")].find(e=>e.offsetParent!==null)?.focus(); true`);
  await sleep(200);

  // ── 1. 需求1:最近打开默认关闭 ──
  const recentTextCount = await evalJs(
    `(document.body.innerText.match(/最近打开/g)||[]).length`,
  );
  check("启动后侧边栏无「最近打开」区块(仅按钮 title,不渲染标题文本)", recentTextCount === 0, `出现 ${recentTextCount} 次`);
  await evalJs(
    `[...document.querySelectorAll(".filetree-btn")].find(b=>b.title==="最近打开")?.click(); true`,
  );
  await sleep(300);
  const recentAfterToggle = await evalJs(
    `(document.body.innerText.match(/最近打开/g)||[]).length`,
  );
  check("点击时钟按钮后「最近打开」区块开启", recentAfterToggle >= 1, `出现 ${recentAfterToggle} 次`);
  // 还原:再点一次关闭,保持环境干净
  await evalJs(
    `[...document.querySelectorAll(".filetree-btn")].find(b=>b.title==="最近打开")?.click(); true`,
  );
  await sleep(200);

  // ── 2. 需求2:标题栏文件名居中 ──
  const centerDelta = await evalJs(`(() => {
    const c = document.querySelector(".titlebar-center");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return Math.abs(r.left + r.width / 2 - window.innerWidth / 2);
  })()`);
  check("titlebar 文件名中心与窗口中心偏差 < 8px", centerDelta !== null && centerDelta < 8, `偏差 ${centerDelta}px`);

  // ── 3. E1:阅读模式 format.bold 真命令 ──
  // 光标输入文本 → 全选 → 命令面板通道加粗 → DOM 应出现 <strong>(而非 **** 字面文本)
  await typeText("hello-bold");
  await sleep(150);
  await evalJs(`(() => {
    const pm = [...document.querySelectorAll(".ProseMirror")].find(e=>e.offsetParent!==null);
    pm.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm.firstChild);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`);
  await sleep(200);
  await dispatchCommand("format.bold");
  await sleep(300);
  const boldState = await evalJs(`(() => {
    const strongs = document.querySelectorAll(".ProseMirror strong").length;
    const hasLiterals = document.querySelector(".ProseMirror").textContent.includes("****");
    return JSON.stringify({ strongs, hasLiterals });
  })()`);
  const bold = JSON.parse(boldState);
  check("E1: 阅读模式点加粗 → strong mark 生效", bold.strongs >= 1, boldState);
  check("E1: 无 **** 字面文本残留(假命令消除)", !bold.hasLiterals, boldState);

  // ── 4. E2:代码块内 Tab 缩进 ──
  // 光标移回段内 → insert.codeblock 把当前块转为代码块 → Tab 应插入 2 空格
  await evalJs(`(() => {
    const pm = [...document.querySelectorAll(".ProseMirror")].find(e=>e.offsetParent!==null);
    pm.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm.firstChild);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`);
  await sleep(150);
  await dispatchCommand("insert.codeblock");
  await sleep(300);
  const hasCodeBlock = await evalJs(`(()=>{const p=pmEl();return !!p && !!(p.querySelector(".code-block-wrapper")||p.querySelector("pre")||p.querySelector("[data-language]"));})()`);
  check("E2: insert.codeblock 生成代码块", hasCodeBlock, "");
  if (hasCodeBlock) {
    await typeText("x");
    await sleep(150);
    const before = await evalJs(
      `((pmEl().querySelector(".code-block-wrapper")||pmEl().querySelector("pre")||pmEl().querySelector("[data-language]")).textContent)`,
    );
    await keyPress("Tab", { code: "Tab", vk: 9 });
    await sleep(250);
    const after = await evalJs(
      `((pmEl().querySelector(".code-block-wrapper")||pmEl().querySelector("pre")||pmEl().querySelector("[data-language]")).textContent)`,
    );
    // code-block-wrapper 为双层结构(高亮层+编辑层,textContent 内容重复两份,各含行号)
    // Tab 在光标(输入的 x 之后)处插入 2 空格 → 两层各 +2,总长 +4,且出现 "x  "
    check("E2: 代码块内 Tab 插入 2 空格", after.length === before.length + 4 && after.includes("x  "), `"${before}" → "${after}"`);
    const focusKept = await evalJs(`!!document.activeElement?.closest(".ProseMirror")`);
    check("E2: Tab 后焦点仍在编辑器内", focusKept, "");
  }

  // ── 5. E3:列表项内输入 --- 保持文本 ──
  // 重置为全新文档(file.new 无弹窗直接生效;Ctrl+A 在代码块内只能清内容不能删块)
  const resetDoc = async () => {
    await dispatchCommand("file.new");
    await sleep(700);
    // 新标签可能默认编辑模式:强制阅读模式,并真实鼠标点击迁移键盘焦点
    await dispatchCommand("view.preview");
    await sleep(300);
    await clickEditor();
    const focused = await evalJs(`!!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".ProseMirror"))`);
    const t = await evalJs(`window.pmEl()?.textContent ?? "?"`);
    console.log(`    [重置后文档] "${t}" 焦点在编辑器内=${focused}`);
    return t === "" && focused;
  };
  await typeText("- a");
  await sleep(150);
  await keyPress("Enter", { code: "Enter", vk: 13 });
  await sleep(150);
  await typeText("---");
  await sleep(300);
  const hrState = await evalJs(`(() => {
    const pm = [...document.querySelectorAll(".ProseMirror")].find(e=>e.offsetParent!==null);
    return JSON.stringify({
      hr: pm.querySelectorAll("hr").length,
      listText: (pm.querySelector("ul,ol")?.textContent ?? ""),
      text: pm.textContent.slice(0, 60),
    });
  })()`);
  const hr = JSON.parse(hrState);
  check("E3: 列表项内输入 --- 不转换为水平线", hr.hr === 0, hrState);
  check("E3: --- 以字面文本保留在列表项中", hr.listText.includes("---"), hrState);

  // ── 6. E4:表格右键菜单 i18n + 表头禁删 ──
  check("E4: 重置干净文档", await resetDoc(), "");
  await dispatchCommand("insert.table");
  await sleep(400);
  const hasTable = await evalJs(`(()=>{const p=pmEl();return !!p && !!p.querySelector("table");})()`);
  check("E4: insert.table 生成表格", hasTable, "");
  if (hasTable) {
    // 表体第一格右键
    await evalJs(`(() => {
      const td = pmEl().querySelector("td");
      td.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(300);
    const bodyMenu = await evalJs(
      `document.querySelector(".table-context-menu")?.textContent ?? ""`,
    );
    check("E4: 表体右键菜单 i18n(含「上方添加行」)", bodyMenu.includes("上方添加行") && !bodyMenu.includes("上方插入行"), bodyMenu.slice(0, 60));
    check("E4: 表体右键有「删除行」", bodyMenu.includes("删除行"), "");
    await evalJs(`document.body.click(); true`);
    await sleep(200);
    // 表头右键:不应有删除行
    await evalJs(`(() => {
      const th = pmEl().querySelector("th");
      th.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(300);
    const headMenu = await evalJs(
      `document.querySelector(".table-context-menu")?.textContent ?? ""`,
    );
    check("E4: 表头右键无「删除行」(防误删整个表头)", headMenu !== "" && !headMenu.includes("删除行"), headMenu.slice(0, 60));
    await evalJs(`document.body.click(); true`);
    await sleep(200);
  }

  // ── 7. E14:段内换行设置项 ──
  await dispatchCommand("view.settings");
  check("设置弹窗打开", await waitFor(`!!document.querySelector(".settings-select")`));
  const breaksSelectExists = await evalJs(
    `[...document.querySelectorAll("select.settings-select")].some(s=>[...s.options].some(o=>o.value==="commonmark"))`,
  );
  check("E14: 设置出现「段内换行」下拉(gfm/commonmark)", breaksSelectExists, "");
  if (breaksSelectExists) {
    await evalJs(`(() => {
      const select = [...document.querySelectorAll("select.settings-select")].find(s=>[...s.options].some(o=>o.value==="commonmark"));
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      select.focus();
      setter.call(select, "commonmark");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const persisted = await evalJs(
      `JSON.parse(localStorage.getItem("lightmd-settings")||"{}").state?.paragraphBreaks ?? ""`,
    );
    check("E14: commonmark 选择落盘 localStorage", persisted === "commonmark", persisted);
    // 恢复 gfm
    await evalJs(`(() => {
      const select = [...document.querySelectorAll("select.settings-select")].find(s=>[...s.options].some(o=>o.value==="commonmark"));
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      setter.call(select, "gfm");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const restored = await evalJs(
      `JSON.parse(localStorage.getItem("lightmd-settings")||"{}").state?.paragraphBreaks ?? "gfm"`,
    );
    check("E14: 恢复 gfm 默认", restored === "gfm" || restored === undefined, restored);
  }
  // 关闭设置弹窗(Esc)
  await keyPress("Escape", { code: "Escape", vk: 27 });
  await sleep(200);

  // ── 结果 ──
  console.log("\n===== LightMD v0.9.2 实机验证结果 =====");
  results.forEach((r) => console.log(r));
  console.log(`\n通过 ${results.length - failed}/${results.length}`);
  process.exitCode = failed > 0 ? 1 : 0;
  cdp.close();
}

main().catch((e) => {
  console.error("脚本执行失败:", e.message);
  console.log("\n===== 已完成断言 =====");
  results.forEach((r) => console.log(r));
  process.exitCode = 2;
});

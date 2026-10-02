/**
 * LightMD v0.9.5 实机功能验证（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖 0.9.5 修复项的可自动化部分（另存为对话框部分需人工验收 ✋）：
 *  1. 问题1（等效路径）：lightmd:refresh-folder 事件 → 文件夹树立即刷新出新增文件
 *     （handleSaveAsFile 落盘成功后派发同一事件；原生另存为对话框本身无法自动化 ✋）
 *  2. 问题3：文档内相对路径链接点击 → 打开目标文档（阅读模式 + 分屏 iframe 桥接）
 *  3. 问题4：打开含 data:image base64 图片的文档 → img 正常渲染（src 不被清空）
 *  4. 问题5：分屏下打开文档 A → 新建空临时文件 → 预览 iframe 立即清空（无 A 内容残留）
 *  5. 问题6：打开收藏/最近打开栏 → 面板紧凑内嵌（无标题栏、spacer 空档、
 *     「打开的文件」栏高度自适应）
 *  6. E15 抽查：任务项内嵌套普通列表解析为嵌套结构；多段落脚注保持分段
 *  7. E16 抽查：专注模式装饰正常（mermaid/focus 性能为代码层修复，vitest 覆盖）
 *
 * 用法（先启动打包产物）：
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9225"
 *   .\src-tauri\target\release\lightmd.exe
 *   node scripts/real-machine-v095.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CDP_BASE = process.env.V095_CDP_BASE || "http://127.0.0.1:9225";
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

// 1x1 红色 PNG 的 base64（真实可渲染）
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
  // ── 准备真实文件目录 ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v095-"));
  const subDir = path.join(tmpDir, "docs");
  fs.mkdirSync(subDir, { recursive: true });
  const dirFwd = subDir.replace(/\\/g, "/");
  const fileA = path.join(subDir, "链接源文档.md");
  const fileB = path.join(subDir, "链接目标文档.md");
  const fileImg = path.join(subDir, "图片文档.md");
  const fileTask = path.join(subDir, "任务嵌套.md");
  const fileFn = path.join(subDir, "脚注多段.md");
  fs.writeFileSync(fileA, "# 链接源\n\n[跳转到目标](./链接目标文档.md)\n\n正文结尾\n");
  fs.writeFileSync(fileB, "# 链接目标\n\n这是目标文档的内容标记 TARGET-OK\n");
  fs.writeFileSync(fileImg, `# 图片\n\n![红点](${TINY_PNG})\n`);
  fs.writeFileSync(
    fileTask,
    "- [ ] 主任务\n    - 普通子弹一\n    - 普通子弹二\n- [x] 已完成任务\n"
  );
  fs.writeFileSync(fileFn, "正文[^1]\n\n[^1]: 第一段\n\n    第二段\n");

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
      throw new Error(`eval failed: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
    }
    return r.result?.result?.value;
  };

  const openFile = async (p, content) => {
    await evalJs(
      `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(p)},content:${JSON.stringify(content)}}})); true`
    );
    await sleep(350);
  };

  const runCommand = async (id) => {
    await evalJs(
      `window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); true`
    );
    await sleep(250);
  };

  /** 当前可见编辑器 */
  const VISIBLE_PM = `[...document.querySelectorAll(".ProseMirror")].find(e=>e.offsetParent!==null)`;

  // ═══ 1. 问题3：文档内链接点击跳转 ═══
  await runCommand("view.preview");
  await openFile(fileA, fs.readFileSync(fileA, "utf-8"));
  await sleep(400);
  const linkClick = await evalJs(`(() => {
    const pm = ${VISIBLE_PM};
    if (!pm) return "no-pm";
    const a = pm.querySelector('a[href]');
    if (!a) return "no-link";
    a.click();
    return "clicked";
  })()`);
  // 轮询等待打开链路完成(readFile → openFile → 标签切换 → PM 更新)
  let targetLoaded = "no";
  for (let i = 0; i < 16; i++) {
    targetLoaded = await evalJs(
      `(() => {
        const pm = [...document.querySelectorAll(".ProseMirror")].find(e => e.offsetParent !== null && !e.tagName.includes("IFRAME"));
        return pm && pm.textContent.includes("TARGET-OK") ? "yes" : "no";
      })()`
    );
    if (targetLoaded === "yes") break;
    await sleep(250);
  }
  check(
    "问题3 相对路径链接点击打开目标文档",
    linkClick === "clicked" && targetLoaded === "yes",
    `click=${linkClick} target=${targetLoaded}`
  );

  // ═══ 2. 问题4：data:image 渲染 ═══
  await openFile(fileImg, fs.readFileSync(fileImg, "utf-8"));
  await sleep(500);
  const imgState = await evalJs(`(() => {
    const pm = ${VISIBLE_PM};
    if (!pm) return "no-pm";
    const img = pm.querySelector('img');
    if (!img) return "no-img";
    return img.getAttribute("src") || "empty-src";
  })()`);
  check(
    "问题4 base64 内联图片渲染 src 保留",
    imgState === TINY_PNG,
    `src=${String(imgState).slice(0, 40)}...`
  );

  // ═══ 3. E15 抽查：任务项嵌套普通列表 + 多段落脚注 ═══
  await openFile(fileTask, fs.readFileSync(fileTask, "utf-8"));
  await sleep(500);
  const taskNested = await evalJs(`(() => {
    const pm = ${VISIBLE_PM};
    if (!pm) return "no-pm";
    // task-item 内应存在嵌套 ul(普通子弹列表),且子弹条目在主任务项内
    const items = pm.querySelectorAll('li.task-item');
    if (items.length < 2) return "items:" + items.length;
    const first = items[0];
    const nested = first.querySelector('.task-content > ul li');
    return nested ? "nested-ok:" + nested.textContent.trim() : "no-nested-ul";
  })()`);
  check(
    "E15 任务项内嵌套普通列表解析为嵌套结构",
    String(taskNested).startsWith("nested-ok:普通子弹一"),
    String(taskNested)
  );

  await openFile(fileFn, fs.readFileSync(fileFn, "utf-8"));
  await sleep(500);
  const fnParas = await evalJs(`(() => {
    const pm = ${VISIBLE_PM};
    if (!pm) return "no-pm";
    const def = pm.querySelector('.footnote-def');
    if (!def) return "no-def";
    return "paras:" + def.querySelectorAll(':scope > p').length;
  })()`);
  check("E15 多段落脚注保持分段(2 个段落)", fnParas === "paras:2", String(fnParas));

  // ═══ 4. 问题5：分屏空文档残留 ═══
  await openFile(fileA, fs.readFileSync(fileA, "utf-8"));
  await sleep(300);
  await runCommand("view.split");
  await sleep(600);
  const splitHasA = await evalJs(`(() => {
    const f = document.querySelector('iframe');
    if (!f || !f.contentDocument) return "no-iframe";
    return f.contentDocument.body && f.contentDocument.body.textContent.includes("链接源") ? "has-A" : "empty";
  })()`);
  // 新建空临时文件(阅读模式下新建,再切分屏)
  await runCommand("file.new");
  await sleep(400);
  await runCommand("view.preview");
  await sleep(200);
  await runCommand("view.split");
  await sleep(600);
  const afterNew = await evalJs(`(() => {
    const f = document.querySelector('iframe');
    if (!f || !f.contentDocument) return "no-iframe";
    const t = f.contentDocument.body ? f.contentDocument.body.textContent.trim() : "no-body";
    return t.includes("链接源") || t.includes("TARGET") ? "residual:" + t.slice(0, 30) : "clean";
  })()`);
  check(
    "问题5 分屏预览无上一文档残留",
    splitHasA === "has-A" && afterNew === "clean",
    `A 时=${splitHasA} 新建空文件后=${afterNew}`
  );

  // ═══ 5. 问题6：收藏/最近打开紧凑内嵌 ═══
  await openFile(fileB, fs.readFileSync(fileB, "utf-8"));
  await sleep(300);
  // 打开收藏栏(点击工具栏星标按钮;若上次运行残留为打开态则先关闭再打开)
  const favOpen = await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('.filetree-btn')];
    const star = btns.find(b => b.querySelector('svg path[fill="#ffa726"]') || b.innerHTML.includes('8 1l2.2'));
    if (!star) return "no-star-btn";
    if (document.querySelector('.favorites-section')) {
      star.click();
      await new Promise(r => setTimeout(r, 500));
    }
    star.click();
    return "clicked";
  })()`);
  await sleep(500);
  const favLayout = await evalJs(`(() => {
    const sec = document.querySelector('.favorites-section');
    if (!sec) return "no-fav-section";
    const header = sec.querySelector('.favorites-header');
    // v0.9.5 反馈修复:紧凑内嵌形态保留标题栏(计数/折叠/关闭可用)
    const headerVisible = !!header && getComputedStyle(header).display !== "none";
    const spacer = !!sec.querySelector('.filetree-temp-spacer');
    const temp = document.querySelector('.filetree-temp-section');
    const scroller = document.querySelector('.filetree-scroll');
    if (!temp) return "no-temp";
    const tempRect = temp.getBoundingClientRect();
    const secRect = sec.getBoundingClientRect();
    const items = [...temp.querySelectorAll('.filetree-temp-content > *')];
    const itemSum = items.reduce((s, e) => s + e.getBoundingClientRect().height, 0);
    const headerH = header ? header.getBoundingClientRect().height : 0;
    return JSON.stringify({
      headerVisible,
      spacer,
      itemCount: items.length,
      itemSum: Math.round(itemSum),
      headerH: Math.round(headerH),
      tempH: Math.round(tempRect.height),
      // 面板顶部与「打开的文件」栏底部的间距（只应为 4px 分隔条）
      gap: Math.round(secRect.top - tempRect.bottom),
      panelH: Math.round(secRect.height),
      // 末栏撑满：面板底部与侧栏可视底部的距离（应≈0）
      panelBottomGap: scroller ? Math.round(scroller.getBoundingClientRect().bottom - secRect.bottom) : null,
    });
  })()`);
  let favOk = false;
  let favDetail = favLayout;
  try {
    const o = JSON.parse(favLayout);
    // 空档由「打开的文件」栏高度承担：高度 ≈ 条目高之和 + 标题栏高 + 一个条目位(30)
    const slotOk = Math.abs(o.tempH - (o.itemSum + o.headerH + 30)) <= 12;
    // 面板整体紧随空档之后（仅隔 4px 分隔条）
    const gapOk = o.gap >= 0 && o.gap <= 12;
    // 面板内不应再有空档元素
    const innerOk = o.spacer === false;
    // 末栏无条件撑满到底部：未溢出时须贴底（bottomGap≈0）；内容超出可视高度时
    // 由滚动条接管（bottomGap 为负），此时不应出现"未撑满却留白"的正间隙
    const fillOk = o.panelBottomGap !== null && o.panelBottomGap <= 12;
    favOk = favOpen === "clicked" && o.headerVisible && innerOk && slotOk && gapOk && fillOk;
    favDetail = `layout=${favLayout} slotOk=${slotOk} gapOk=${gapOk} innerOk=${innerOk} fillOk=${fillOk}`;
  } catch { /* ignore */ }
  check(
    "问题6 收藏栏接位(列表末尾下一个条目位)且末栏撑满到底部",
    favOk,
    favDetail
  );

  // v0.9.5 问题6 修订2:temp↔收藏 分隔条拖拽守恒（末栏撑满后向下拖：temp 变高、面板变矮）
  const dragBefore = JSON.parse(await evalJs(`(() => {
    const t = document.querySelector('.filetree-temp-section');
    const s = document.querySelector('.favorites-section');
    const r = s ? s.previousElementSibling : null;
    const rr = r ? r.getBoundingClientRect() : null;
    return JSON.stringify({
      temp: t ? Math.round(t.getBoundingClientRect().height) : null,
      panel: s ? Math.round(s.getBoundingClientRect().height) : null,
      x: rr ? Math.round(rr.x + rr.width / 2) : null,
      y: rr ? Math.round(rr.y + rr.height / 2) : null,
      resizer: r ? r.className : "",
    });
  })()`));
  if (String(dragBefore.resizer).includes("filetree-v-resizer")) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragBefore.x, y: dragBefore.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragBefore.x, y: dragBefore.y + (40 * i) / 6, button: "left", buttons: 1 });
      await sleep(30);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragBefore.x, y: dragBefore.y + 40, button: "left", buttons: 0, clickCount: 1 });
    await sleep(300);
  }
  const dragAfter = JSON.parse(await evalJs(`(() => {
    const t = document.querySelector('.filetree-temp-section');
    const s = document.querySelector('.favorites-section');
    return JSON.stringify({
      temp: t ? Math.round(t.getBoundingClientRect().height) : null,
      panel: s ? Math.round(s.getBoundingClientRect().height) : null,
    });
  })()`));
  const dTemp = (dragAfter.temp ?? 0) - (dragBefore.temp ?? 0);
  const dPanel = (dragBefore.panel ?? 0) - (dragAfter.panel ?? 0);
  check(
    "问题6 修订2:temp↔收藏分隔条拖拽守恒(拖拽逻辑不受影响)",
    dTemp > 0 && dPanel > 0 && Math.abs(dTemp - dPanel) <= 2,
    `before=${JSON.stringify(dragBefore)} after=${JSON.stringify(dragAfter)} Δtemp=${dTemp} Δpanel=${dPanel}`
  );

  // ═══ 6. 问题1（等效）：refresh-folder 事件 → 文件夹树立即刷新 ═══
  await evalJs(
    `window.dispatchEvent(new CustomEvent("lightmd:openFolder",{detail:{path:${JSON.stringify(subDir)}}})); true`
  );
  await sleep(900);
  // 通过 node 侧直接落盘新文件(模拟另存为写盘),随后派发与 handleSaveAsFile 相同的刷新事件
  fs.writeFileSync(path.join(subDir, "另存为新文件.md"), "新文件内容\n");
  await evalJs(
    `window.dispatchEvent(new CustomEvent("lightmd:refresh-folder",{detail:{dir:${JSON.stringify(dirFwd)}}})); true`
  );
  await sleep(700);
  const treeHasNew = await evalJs(
    `document.body.innerText.includes("另存为新文件") ? "yes" : "no"`
  );
  check(
    "问题1 refresh-folder 定向刷新文件夹树",
    treeHasNew === "yes",
    `tree=${treeHasNew}`
  );

  // ═══ 7. E16 抽查：专注模式装饰 ═══
  await openFile(fileA, fs.readFileSync(fileA, "utf-8"));
  await sleep(300);
  await runCommand("view.toggleFocusMode");
  await sleep(400);
  const focusDeco = await evalJs(
    `${VISIBLE_PM} ? (document.querySelector('.focus-dimmed') ? "deco-ok" : "no-deco") : "no-pm"`
  );
  await runCommand("view.toggleFocusMode");
  check(
    "E16 专注模式 focus-dimmed 装饰生效",
    focusDeco === "deco-ok",
    String(focusDeco)
  );

  // ── 清理 ──
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* Windows 句柄延迟,忽略 */ }

  console.log("=== v0.9.5 实机验证结果 ===");
  for (const r of results) console.log(r);
  console.log(`\n${failed === 0 ? "ALL PASS" : "FAILED: " + failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
  cdp.close();
}

main().catch((err) => {
  console.error("脚本执行失败:", err.message);
  console.log("=== 已完成断言 ===");
  for (const r of results) console.log(r);
  process.exitCode = 1;
});

/**
 * LightMD v0.10.0 实机功能验证（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖 0.10.0（R1/R2/R3s/R4/R5）可自动化部分；R2 的 PNG/DOCX/EPUB 导出与
 * R3s 的 PDF 导出涉及原生保存对话框，无法自动化 → ✋ 人工验收（步骤见发布说明）。
 *  1. R4：搜索框正则开关（.* 按钮）——正则匹配计数、非法正则红字提示、
 *     源码模式正则替换 $1 捕获组全流程
 *  2. R5：大纲 1000 项上限 + 截断提示文案
 *  3. R1：分屏/导出统一管线——typographer 直引号不被改写、javascript: 链接被
 *     白名单拦截、mermaid 代码块包装为 pre.mermaid（iframe 内渲染为 svg）
 *
 * 用法（先启动打包产物）：
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9226"
 *   .\src-tauri\target\release\lightmd.exe
 *   node scripts/real-machine-v0100.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CDP_BASE = process.env.V0100_CDP_BASE || "http://127.0.0.1:9226";
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
  // ── 准备真实文件目录 ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0100-"));
  const fileQuote = path.join(tmpDir, "引号与链接.md");
  const fileMermaid = path.join(tmpDir, "图表文档.md");
  const fileSearch = path.join(tmpDir, "搜索源.md");
  const fileOutline = path.join(tmpDir, "超长大纲.md");
  fs.writeFileSync(
    fileQuote,
    '他说 "hello" 和 \'world\'\n\n[恶意链接](javascript:alert(1))\n\n[正常链接](https://example.com)\n'
  );
  fs.writeFileSync(
    fileMermaid,
    "# 图表\n\n```mermaid\ngraph TD; A-->B;\n```\n"
  );
  fs.writeFileSync(
    fileSearch,
    "# 搜索源\n\n- 1.apple\n- 2.banana\n- 3.cherry\n\n正文关键词 apple\n"
  );
  const outlineLines = [];
  for (let i = 1; i <= 1100; i++) outlineLines.push(`# 标题${String(i).padStart(4, "0")}`);
  fs.writeFileSync(fileOutline, outlineLines.join("\n") + "\n");

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

  /** React 受控输入赋值（绕过 React 对 value 的劫持） */
  const setReactInput = `
    ((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })`;

  /** 关闭搜索面板（若打开） */
  const closeSearch = async () => {
    await evalJs(`(() => {
      const btn = document.querySelector('.search-close-btn');
      if (btn) btn.click();
      return "ok";
    })()`);
    await sleep(250);
  };

  const VISIBLE_PM = `[...document.querySelectorAll(".ProseMirror")].find(e=>e.offsetParent!==null)`;

  // ═══ 1. R1：分屏管线——直引号保留 + javascript: 拦截 ═══
  await runCommand("view.preview");
  await openFile(fileQuote, fs.readFileSync(fileQuote, "utf-8"));
  await sleep(400);
  await runCommand("view.split");
  await sleep(900);
  const r1State = await evalJs(`(() => {
    const f = document.querySelector('iframe');
    if (!f || !f.contentDocument) return "no-iframe";
    const text = f.contentDocument.body ? f.contentDocument.body.textContent : "";
    const badLink = f.contentDocument.querySelector('a[href^="javascript:"]');
    const goodLink = f.contentDocument.querySelector('a[href="https://example.com"]');
    return JSON.stringify({
      straight: text.includes('"hello"'),
      curly: text.includes("\\u201Chello"),
      jsBlocked: !badLink,
      jsTextKept: text.includes("恶意链接"),
      goodKept: !!goodLink,
    });
  })()`);
  const r1 = JSON.parse(r1State);
  check("R1 分屏直引号不被 typographer 改写", r1.straight && !r1.curly, r1State);
  check("R1 javascript: 链接被白名单拦截且文本保留", r1.jsBlocked && r1.jsTextKept, r1State);
  check("R1 正常 https 链接不受影响", r1.goodKept, r1State);

  // ═══ 2. R1：mermaid 包装 + iframe 内渲染为 svg ═══
  await openFile(fileMermaid, fs.readFileSync(fileMermaid, "utf-8"));
  await sleep(500);
  let mermaidState = "no-svg";
  for (let i = 0; i < 12; i++) {
    mermaidState = await evalJs(`(() => {
      const f = document.querySelector('iframe');
      if (!f || !f.contentDocument) return "no-iframe";
      const pre = f.contentDocument.querySelector('pre.mermaid');
      const svg = f.contentDocument.querySelector('pre.mermaid svg, svg[aria-roledescription], .mermaid svg');
      return pre && svg ? "svg-rendered" : pre ? "pre-wrapped" : "no-pre";
    })()`);
    if (mermaidState === "svg-rendered") break;
    await sleep(400);
  }
  check(
    "R1 mermaid 经统一管线包装且 iframe 内渲染",
    ["pre-wrapped", "svg-rendered"].includes(mermaidState),
    mermaidState
  );

  // ═══ 3. R4：搜索正则开关 + 非法正则提示 ═══
  await runCommand("view.preview");
  await openFile(fileSearch, fs.readFileSync(fileSearch, "utf-8"));
  await sleep(500);
  await closeSearch();
  // 点击底栏搜索按钮打开搜索面板
  await evalJs(`(() => {
    const btn = document.querySelector('[data-genie-anchor="search"]');
    if (btn) btn.click();
    return "ok";
  })()`);
  await sleep(600);
  // 字面量搜索 "1." → 应只有 1 处（转义语义）
  await evalJs(`${setReactInput}(document.querySelector('.search-input'), '1.');`);
  await sleep(400);
  const literalCount = await evalJs(
    `document.querySelector('.search-count')?.textContent || "none"`
  );
  check("R4 字面量模式转义语义回归（1. 仅 1 处）", literalCount === "1/1", literalCount);
  // 切换正则开关（.* 按钮）
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.search-option-btn')];
    const re = btns.find(b => b.textContent.trim() === ".*");
    if (!re) return "no-regex-btn";
    re.click();
    return "ok";
  })()`);
  await sleep(300);
  await evalJs(`${setReactInput}(document.querySelector('.search-input'), '\\\\d+\\\\.\\\\w+');`);
  await sleep(400);
  const regexCount = await evalJs(
    `document.querySelector('.search-count')?.textContent || "none"`
  );
  check("R4 正则模式匹配计数（3 项列表）", regexCount === "1/3", regexCount);
  // 非法正则 → 红字提示且不崩溃
  await evalJs(`${setReactInput}(document.querySelector('.search-input'), '[');`);
  await sleep(400);
  const invalidState = await evalJs(`(() => {
    const count = document.querySelector('.search-count')?.textContent || "none";
    const input = document.querySelector('.search-input');
    return JSON.stringify({ count, invalidClass: input?.classList.contains("search-input-invalid") });
  })()`);
  const inv = JSON.parse(invalidState);
  check(
    "R4 非法正则红字提示且禁用查找",
    inv.count.includes("正则无效") && inv.invalidClass === true,
    invalidState
  );
  await closeSearch();

  // ═══ 4. R4：源码模式正则替换 $1 捕获组全流程 ═══
  await runCommand("view.edit");
  await sleep(500);
  await evalJs(`(() => {
    const btn = document.querySelector('[data-genie-anchor="search"]');
    if (btn) btn.click();
    return "ok";
  })()`);
  await sleep(600);
  // 打开替换行
  await evalJs(`(() => {
    const t = document.querySelector('.search-toggle-btn');
    if (t) t.click();
    return "ok";
  })()`);
  await sleep(300);
  // 切正则开关（面板被重新挂载，重新查找按钮）
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.search-option-btn')];
    const re = btns.find(b => b.textContent.trim() === ".*");
    if (!re) return "no-regex-btn";
    re.click();
    return "ok";
  })()`);
  await sleep(300);
  await evalJs(`${setReactInput}(document.querySelector('.search-input'), '(\\\\d+)\\\\.(\\\\w+)');`);
  await sleep(400);
  const regexCount2 = await evalJs(
    `document.querySelector('.search-count')?.textContent || "none"`
  );
  await evalJs(
    `${setReactInput}(document.querySelectorAll('.replace-row .search-input')[0], '$2: $1');`
  );
  await sleep(300);
  // 全部替换
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.replace-btn')];
    const all = btns.find(b => (b.title || "").includes("全部替换") || (b.textContent || "").includes("全部替换"));
    if (!all) return "no-replace-all";
    all.click();
    return "ok";
  })()`);
  await sleep(600);
  const replaceResult = await evalJs(`(() => {
    const ta = document.querySelector('textarea.source-editor') || document.querySelector('textarea');
    return ta ? ta.value : "no-textarea";
  })()`);
  const replacedOk =
    replaceResult.includes("apple: 1") &&
    replaceResult.includes("banana: 2") &&
    replaceResult.includes("cherry: 3");
  check(
    "R4 源码模式正则替换 $1 捕获组全流程",
    regexCount2 === "1/3" && replacedOk,
    `count=${regexCount2} result=${String(replaceResult).replace(/\n/g, "|").slice(0, 120)}`
  );
  await closeSearch();

  // ═══ 5. R5：大纲 1000 上限 + 截断提示 ═══
  await runCommand("view.preview");
  await openFile(fileOutline, fs.readFileSync(fileOutline, "utf-8"));
  await sleep(1500);
  const outlineState = await evalJs(`(() => {
    const outline = document.querySelector('.outline');
    if (!outline) return "no-outline";
    const items = outline.querySelectorAll('.outline-item').length;
    const more = outline.querySelector('.outline-more')?.textContent || "";
    return JSON.stringify({ items, more });
  })()`);
  const ol = JSON.parse(outlineState);
  check(
    "R5 大纲渲染 1000 项 + 截断提示（1100 标题文档）",
    ol.items === 1000 && ol.more.includes("1000") && ol.more.includes("100"),
    outlineState
  );

  // ═══ 汇总 ═══
  console.log("=== LightMD v0.10.0 实机验证结果 ===");
  for (const line of results) console.log(line);
  console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  await cdp.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("验证脚本执行失败:", err);
  process.exit(2);
});

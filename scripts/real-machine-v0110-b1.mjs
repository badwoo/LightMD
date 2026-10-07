/**
 * LightMD v0.11.0 —— B1 三项 P0 数据安全 实机验证
 *
 * 验证对象（PLAN-0.11.0.md B1 批次，commit 55e6a99）：
 *  1. B1-1 代码块 / 公式块内按 Shift+Enter 不得腰斩块结构（存盘必须与输入逐字节一致）
 *         —— 对照组：普通段落按 Shift+Enter 仍应插入硬换行（"  \n"）
 *  2. B1-2 表格「删除行」作用于表头时不得丢数据（A/B 必须仍在）
 *         同时验证：表体行仍能正常删除（修复不得把手功能一起禁掉）
 *  3. B1-3 图片 Typora 尺寸语法 ![alt|300](a.png) 在渲染管线生效
 *         —— 宽度 300 生效，且 alt 不得被污染成 "alt|300"；无后缀图片无回归
 *
 * 用法（本脚本自行启动打包产物，无需手工准备）：
 *   node scripts/real-machine-v0110-b1.mjs
 *
 * 说明：全程通过 WebView2 CDP 驱动，使用真实鼠标/键盘事件（Input.dispatchMouseEvent /
 * dispatchKeyEvent），因此走的是与用户完全相同的输入路径。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0110_B1_PORT || 9228);
const CDP_BASE = `http://127.0.0.1:${PORT}`;

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
  if (!fs.existsSync(EXE)) {
    console.error(`未找到打包产物：${EXE}`);
    console.error("请先执行：cd 'D:\\AI\\markdown view\\lightmd'; npm run tauri build");
    process.exit(3);
  }

  // ── 关键前置：清掉已有实例 ──
  // 应用注册了 tauri-plugin-single-instance：若已有一个 lightmd.exe 在跑，
  // 新进程会把参数转发给它然后立即退出 → 调试端口 9228 永远不会出现。
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    console.log("已清理旧的 lightmd.exe 实例（single-instance 会吞掉新进程）");
    await sleep(1200);
  } catch {
    // 没有在跑的实例，taskkill 返回非零，属正常
  }

  // ── 准备真实文件目录 ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0110-b1-"));
  const fCode = path.join(tmpDir, "代码块.md");
  const fMath = path.join(tmpDir, "公式块.md");
  const fPara = path.join(tmpDir, "普通段落.md");
  const fTable = path.join(tmpDir, "表格.md");
  const fImage = path.join(tmpDir, "图片.md");

  const CODE_SRC = "```js\nconst a = 1\nconst b = 2\n```\n";
  const MATH_SRC = "$$\nx = 1\n$$\n";
  const PARA_SRC = "第一行文字\n\n第二行文字\n";
  const TABLE_SRC = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n";
  const IMAGE_SRC = "![alt|300](a.png)\n\n![plain](b.png)\n";

  fs.writeFileSync(fCode, CODE_SRC);
  fs.writeFileSync(fMath, MATH_SRC);
  fs.writeFileSync(fPara, PARA_SRC);
  fs.writeFileSync(fTable, TABLE_SRC);
  fs.writeFileSync(fImage, IMAGE_SRC);

  console.log(`临时目录: ${tmpDir}`);
  console.log(`启动打包产物: ${EXE}（CDP ${PORT}）`);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
    detached: false,
  });

  let cdp;
  try {
    const target = await findPageTarget();
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    const evalJs = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(
          `eval failed: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`
        );
      }
      return r.result?.result?.value;
    };

    // ── 通用输入原语（真实事件路径）──

    /** 放置折叠光标到 selector 命中的第 nth 个元素内、文本偏移 offset 处 */
    const placeCaret = async (selector, offset, nth = 0) =>
      evalJs(`(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        const el = els[${nth}];
        if (!el) return "no-el";
        el.focus();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n, acc = 0;
        while ((n = walker.nextNode())) {
          if (acc + n.data.length >= ${offset}) {
            const r = document.createRange();
            r.setStart(n, ${offset} - acc);
            r.collapse(true);
            const s = document.getSelection();
            s.removeAllRanges();
            s.addRange(r);
            document.dispatchEvent(new Event("selectionchange"));
            return "ok";
          }
          acc += n.data.length;
        }
        return "offset-oob";
      })()`);

    /** 真实鼠标单击 selector 命中元素的中心 */
    const clickAt = async (selector, nth = 0) => {
      const boxStr = await evalJs(`(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        const el = els[${nth}];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`);
      if (!boxStr) return "no-el";
      const { x, y } = JSON.parse(boxStr);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1,
      });
      await sleep(220);
      return "ok";
    };

    const KEYS = {
      Enter: { code: "Enter", vk: 13, key: "Enter" },
      ArrowDown: { code: "ArrowDown", vk: 40, key: "ArrowDown" },
    };

    /** 真实按键：只发 rawKeyDown + keyUp（不发 char，避免浏览器插入文本） */
    const pressKey = async (name, modifiers = 0) => {
      const k = KEYS[name];
      if (!k) throw new Error(`未支持按键 ${name}`);
      const base = {
        modifiers,
        code: k.code,
        key: k.key,
        windowsVirtualKeyCode: k.vk,
        nativeVirtualKeyCode: k.vk,
      };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(300);
    };

    const runCommand = async (id) => {
      await evalJs(
        `window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); true`
      );
      await sleep(300);
    };

    const openFile = async (p, content) => {
      await evalJs(
        `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(p)},content:${JSON.stringify(content)}}})); true`
      );
      await sleep(600);
    };

    /** 切到源码模式读取当前文档序列化结果（即"将要存盘的内容"） */
    const readBackSource = async () => {
      await runCommand("view.edit");
      await sleep(600);
      const v = await evalJs(
        `(() => { const ta = document.querySelector('textarea.source-editor') || document.querySelector('textarea'); return ta ? ta.value : "NO-TEXTAREA"; })()`
      );
      return v;
    };

    const show = (s) => String(s).replace(/\n/g, "\\n").replace(/\r/g, "\\r");

    // ══════════════════════════════════════════════════════════
    // 0. 环境自检：编辑器与代码块 NodeView 是否就绪
    // ══════════════════════════════════════════════════════════
    await runCommand("view.preview");
    await openFile(fCode, CODE_SRC);
    const envSniff = await evalJs(`JSON.stringify({
      proseMirror: document.querySelectorAll('.ProseMirror').length,
      codeWrapper: document.querySelectorAll('.code-block-wrapper').length,
      codeEditable: document.querySelectorAll('.code-block-wrapper code[contenteditable="true"]').length,
      codeText: (document.querySelector('.code-block-wrapper code[contenteditable="true"]') || {}).textContent ?? null,
    })`);
    const env = JSON.parse(envSniff);
    check(
      "环境自检：代码块 NodeView 与可编辑层就绪",
      env.proseMirror >= 1 && env.codeWrapper === 1 && env.codeEditable === 1,
      envSniff
    );

    // ══════════════════════════════════════════════════════════
    // 1. B1-1 代码块内 Shift+Enter 不得腰斩
    // ══════════════════════════════════════════════════════════
    const caret1 = await placeCaret('.code-block-wrapper code[contenteditable="true"]', 8);
    await sleep(250);
    await pressKey("Enter", 8 /* Shift */);

    const afterCodeDom = await evalJs(`JSON.stringify({
      codeWrapper: document.querySelectorAll('.code-block-wrapper').length,
      codeText: (document.querySelector('.code-block-wrapper code[contenteditable="true"]') || {}).textContent ?? null,
      paragraphs: document.querySelectorAll('.ProseMirror p').length,
    })`);
    const codeSrc = await readBackSource();
    check(
      "B1-1 代码块内 Shift+Enter：块未被腰斩且存盘逐字节一致",
      codeSrc === CODE_SRC && JSON.parse(afterCodeDom).codeWrapper === 1,
      `caret=${caret1} dom=${afterCodeDom} 存盘=${show(codeSrc)}`
    );

    // ── 对照组：普通段落 Shift+Enter 仍插入硬换行（"  \n"）──
    await runCommand("view.preview");
    await openFile(fPara, PARA_SRC);
    await placeCaret(".ProseMirror p", 4);
    await sleep(250);
    await pressKey("Enter", 8 /* Shift */);
    const paraDom = await evalJs(
      `JSON.stringify({ br: document.querySelectorAll('.ProseMirror p br').length })`
    );
    const paraSrc = await readBackSource();
    check(
      "B1-1 对照组：普通段落内 Shift+Enter 仍插入硬换行（未误伤）",
      JSON.parse(paraDom).br >= 1 && paraSrc.includes("  \n"),
      `dom=${paraDom} 存盘=${show(paraSrc)}`
    );

    // ── 公式块 ──
    await runCommand("view.preview");
    await openFile(fMath, MATH_SRC);
    // 块级公式默认是 KaTeX 预览态，需双击进入编辑态
    await evalJs(`(() => {
      const el = document.querySelector('.math-block-wrapper');
      if (!el) return "no-el";
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return "ok";
    })()`);
    await sleep(400);
    const caretM = await placeCaret(".math-block-content", 3);
    await sleep(250);
    await pressKey("Enter", 8 /* Shift */);
    const mathSrc = await readBackSource();
    check(
      "B1-1 公式块内 Shift+Enter：块未被腰斩且存盘逐字节一致",
      mathSrc === MATH_SRC,
      `caret=${caretM} 存盘=${show(mathSrc)}`
    );

    // ══════════════════════════════════════════════════════════
    // 2. B1-2 表格删除行不得作用于表头导致丢数据
    // ══════════════════════════════════════════════════════════
    await runCommand("view.preview");
    await openFile(fTable, TABLE_SRC);
    await sleep(400);

    const readToolbar = async () =>
      JSON.parse(
        await evalJs(`(() => {
          const tb = document.querySelector('.table-toolbar');
          if (!tb) return JSON.stringify({ present: false });
          const btns = [...tb.querySelectorAll('button')];
          const del = btns.find(b => b.textContent.trim() === '↕');
          return JSON.stringify({
            present: true,
            count: btns.length,
            found: !!del,
            disabled: del ? !!del.disabled : null,
            title: del ? del.title : null,
          });
        })()`)
      );

    // 2a. 光标入表头 → 删除行按钮必须置灰且给出说明
    const thClick = await clickAt(".ProseMirror th", 0);
    await sleep(400);
    const tbHead = await readToolbar();
    check(
      "B1-2 光标在表头时「删除行」按钮已置灰并有说明",
      tbHead.present && tbHead.found && tbHead.disabled === true && /表头/.test(tbHead.title || ""),
      `click=${thClick} ${JSON.stringify(tbHead)}`
    );

    // 2b. 即便强行派发 click，表头与数据都不得丢失（双保险的最后一层）
    await evalJs(`(() => {
      const tb = document.querySelector('.table-toolbar');
      if (!tb) return 'no-toolbar';
      const del = [...tb.querySelectorAll('button')].find(b => b.textContent.trim() === '↕');
      if (!del) return 'no-btn';
      del.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'dispatched';
    })()`);
    await sleep(350);
    const afterForce = await readBackSource();
    check(
      "B1-2 强行触发删除行后表头 A/B 与数据行均未丢失",
      afterForce.includes("A") && afterForce.includes("B") && afterForce.includes("| 1 | 2 |"),
      `存盘=${show(afterForce)}`
    );

    // 2c. 表体行仍能正常删除（修复不得禁用正常功能）
    await runCommand("view.preview");
    await openFile(fTable, TABLE_SRC);
    await sleep(400);
    // 先点表体行，再点删除行按钮
    await clickAt(".ProseMirror td", 0);
    await sleep(400);
    const tbBodyBefore = await readToolbar();
    await evalJs(`(() => {
      const tb = document.querySelector('.table-toolbar');
      if (!tb) return 'no-toolbar';
      const del = [...tb.querySelectorAll('button')].find(b => b.textContent.trim() === '↕');
      if (!del) return 'no-btn';
      del.click();
      return 'ok';
    })()`);
    await sleep(400);
    const afterBodyDelete = await readBackSource();
    check(
      "B1-2 表体行仍可正常删除（功能未误伤）",
      tbBodyBefore.present && tbBodyBefore.disabled === false && !afterBodyDelete.includes("| 1 | 2 |"),
      `按钮=${JSON.stringify(tbBodyBefore)} 存盘=${show(afterBodyDelete)}`
    );

    // 2d. 表头 → 表体 表格内切换时按钮态是否更新（潜在陈旧态问题）
    await runCommand("view.preview");
    await openFile(fTable, TABLE_SRC);
    await sleep(400);
    await clickAt(".ProseMirror th", 0);
    await sleep(350);
    const staleHead = await readToolbar();
    await clickAt(".ProseMirror td", 0);
    await sleep(350);
    const staleBody = await readToolbar();
    check(
      "B1-2 表格内 表头↔表体 切换后按钮禁用态同步更新（无陈旧态）",
      !(staleHead.disabled === true && staleBody.disabled === true),
      `表头=${JSON.stringify(staleHead)} 表体=${JSON.stringify(staleBody)}`
    );

    // ══════════════════════════════════════════════════════════
    // 3. B1-3 图片 |W 尺寸语法在渲染管线生效
    // ══════════════════════════════════════════════════════════
    await runCommand("view.preview");
    await openFile(fImage, IMAGE_SRC);
    await sleep(400);
    await runCommand("view.split");
    await sleep(1400); // 等 iframe 渲染

    let imgState = "no-iframe";
    for (let i = 0; i < 10; i++) {
      imgState = await evalJs(`(() => {
        const f = document.querySelector('iframe');
        if (!f || !f.contentDocument) return "no-iframe";
        const imgs = [...f.contentDocument.querySelectorAll('img')];
        if (imgs.length === 0) return "no-img";
        const sized = imgs.find(im => (im.getAttribute('src') || '').includes('a.png'));
        const plain = imgs.find(im => (im.getAttribute('src') || '').includes('b.png'));
        return JSON.stringify({
          sizedFound: !!sized,
          sizedAlt: sized ? sized.getAttribute('alt') : null,
          sizedWidthAttr: sized ? sized.getAttribute('width') : null,
          sizedStyleWidth: sized ? sized.style.width : null,
          sizedRenderedWidth: sized ? Math.round(sized.getBoundingClientRect().width) : null,
          plainFound: !!plain,
          plainAlt: plain ? plain.getAttribute('alt') : null,
          plainWidthAttr: plain ? plain.getAttribute('width') : null,
        });
      })()`);
      if (imgState !== "no-iframe" && imgState !== "no-img") break;
      await sleep(400);
    }
    let img = {};
    try {
      img = JSON.parse(imgState);
    } catch {
      /* 保持空对象，断言会失败并打印原始值 */
    }
    check(
      "B1-3 带 |300 的图片宽度生效（渲染宽 300px）",
      img.sizedFound === true && Number(img.sizedRenderedWidth) === 300,
      imgState
    );
    check(
      "B1-3 带 |300 的图片 alt 未被污染（应为 alt 而非 alt|300）",
      img.sizedAlt === "alt",
      imgState
    );
    check(
      "B1-3 无尺寸后缀的图片无回归（alt=plain 且无 width）",
      img.plainFound === true && img.plainAlt === "plain" && !img.plainWidthAttr,
      imgState
    );

    // ═══ 汇总 ═══
    console.log("");
    console.log("=== LightMD v0.11.0 B1 三项 P0 实机验证结果 ===");
    for (const line of results) console.log(line);
    console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("验证脚本执行失败:", err);
  process.exit(2);
});
